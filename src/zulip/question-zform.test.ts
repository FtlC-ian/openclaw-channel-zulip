import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAskUserQuestionId: vi.fn((payload: { channelData?: { askUser?: { questionId?: string } } }) =>
    payload.channelData?.askUser?.questionId,
  ),
  registerChannelDelivery: vi.fn(),
  resolveOption: vi.fn(),
  sendZulipPrivateMessage: vi.fn(async () => ({ id: 9101 })),
  sendZulipStreamMessage: vi.fn(async () => ({ id: 9102 })),
  deleteZulipMessage: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: {
    readAskUserQuestionId: mocks.readAskUserQuestionId,
    registerChannelDelivery: mocks.registerChannelDelivery,
    resolveOption: mocks.resolveOption,
  },
}));

vi.mock("./client.js", () => ({
  sendZulipPrivateMessage: mocks.sendZulipPrivateMessage,
  sendZulipStreamMessage: mocks.sendZulipStreamMessage,
  deleteZulipMessage: mocks.deleteZulipMessage,
}));

import { ZulipQuestionZformStore } from "./question-zform.js";
import { DurableBindings, durableBindings, bindingHash, type DurableRecord } from "./durable-bindings.js";

it.each(["source deletion", "record removal", "deletion checkpoint", "ambiguous send", "concurrent recovery"])("does not replay terminal question notices after %s", async (fault) => {
  const key = "question:default:abcdefghijklmnopqrstuv";
  let row: DurableRecord | undefined = { kind: "question", accountId: "default", scope: "hash", generation: "old", messageId: "9001", id: "ask_0123456789abcdef0123456789abcdef", nonce: "abcdefghijklmnopqrstuv", senderHash: bindingHash("alice@example.test"), optionHashes: [bindingHash("staging")], expiresAt: Date.now() + 60000, conversation: { kind: "stream", stream: "18", topic: "restart" } };
  let fail = true;
  const storage = {
    lookup: async () => row && structuredClone(row),
    entries: async () => row ? [{ key, value: structuredClone(row) }] : [],
    update: async (_key: string, fn: (current: DurableRecord | undefined) => DurableRecord | undefined) => {
      const next = fn(row && structuredClone(row));
      if (!next) return false;
      if (fault === "deletion checkpoint" && next.terminalState === "source-deleted" && fail) { fail = false; throw new Error("checkpoint failed"); }
      row = structuredClone(next); return true;
    },
    deleteIf: async (_key: string, predicate: (current: DurableRecord) => boolean) => {
      if (!row || !predicate(row)) return false;
      if (fault === "record removal" && fail) { fail = false; throw new Error("remove failed"); }
      row = undefined; return true;
    },
  };
  const bindings = new DurableBindings(async () => storage);
  const spies = [vi.spyOn(durableBindings, "records").mockImplementation(async () => row ? [{ key, record: structuredClone(row) }] : []), ...(["claim", "save", "current", "remove"] as const).map(method => vi.spyOn(durableBindings, method).mockImplementation(bindings[method].bind(bindings) as never))];
  const params = { cfg: {}, accountId: "default", client: {} as never, hostVersion: "2026.10.1-beta.2" };
  try {
    mocks.resolveOption.mockResolvedValue({ status: "already-terminal" });
    if (fault === "source deletion") mocks.deleteZulipMessage.mockRejectedValueOnce(new Error("delete failed"));
    if (fault === "deletion checkpoint") mocks.deleteZulipMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error("Invalid message(s)"), { status: 400 }));
    if (fault === "ambiguous send") mocks.sendZulipStreamMessage.mockRejectedValueOnce(new Error("connection lost after POST"));
    if (fault === "concurrent recovery") await Promise.all([new ZulipQuestionZformStore().restore(params), new ZulipQuestionZformStore().restore(params)]);
    else await new ZulipQuestionZformStore().restore(params).catch(() => undefined);
    await new ZulipQuestionZformStore().restore(params);
    await new ZulipQuestionZformStore().restore(params);
    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxRetries: 0 }));
    expect(mocks.deleteZulipMessage).toHaveBeenCalledTimes(fault === "source deletion" || fault === "deletion checkpoint" ? 2 : 1);
    expect(row).toBeUndefined();
  } finally { for (const spy of spies) spy.mockRestore(); }
});

it.each(["2026.9.6", "2026.10.1-beta.2", "2026.9.3"])("reconciles a question restart safely on %s", async (hostVersion) => {
  const nonce = "abcdefghijklmnopqrstuv";
  const record: DurableRecord = { kind: "question", accountId: "default", scope: "hash", generation: "old", messageId: "9001", id: "ask_0123456789abcdef0123456789abcdef", nonce, senderHash: bindingHash("alice@example.test"), optionHashes: [bindingHash("staging"), bindingHash("production")], expiresAt: Date.now() + 60000, conversation: { kind: "stream", stream: "18", topic: "restart" } };
  const spies = [vi.spyOn(durableBindings, "records").mockResolvedValue([{ key: `question:default:${nonce}`, record }]), vi.spyOn(durableBindings, "claim").mockImplementation(async (_key, value) => ({ ...value, generation: "new" })), vi.spyOn(durableBindings, "save").mockResolvedValue(true), vi.spyOn(durableBindings, "current").mockResolvedValue(true), vi.spyOn(durableBindings, "remove").mockResolvedValue()];
  const store = new ZulipQuestionZformStore();
  try {
    mocks.resolveOption.mockResolvedValue({ status: "denied" });
    await store.restore({ cfg: {}, accountId: "default", client: {} as never, hostVersion });
    if (hostVersion === "2026.9.3") { expect(mocks.resolveOption).not.toHaveBeenCalled(); expect(mocks.deleteZulipMessage).toHaveBeenCalledWith(expect.anything(), { messageId: "9001" }); return; }
    expect(await mocks.resolveOption.mock.calls[0][0].authorize()).toBe(false);
    expect(durableBindings.claim).toHaveBeenCalledWith(`question:default:${nonce}`, expect.objectContaining({ senderHash: record.senderHash, optionHashes: record.optionHashes, expiresAt: record.expiresAt }), "old");
    mocks.resolveOption.mockResolvedValue({ status: "answered", optionValue: "Staging" });
    const message = { accountId: "default", conversation: record.conversation!, senderId: "alice@example.test", text: `ocq1:${nonce}:0` };
    expect((await store.intercept({ cfg: {}, message }))).toMatchObject({ status: "answered", optionValue: "Staging" });
    expect(mocks.resolveOption).toHaveBeenLastCalledWith(expect.objectContaining({ optionIndex: 0, authorize: expect.any(Function) }));
    expect((await store.intercept({ cfg: {}, message }))).toMatchObject({ status: "stale" });
    expect(mocks.resolveOption).toHaveBeenCalledTimes(2);
  } finally { store.clear(); for (const spy of spies) spy.mockRestore(); }
});

const questionId = "ask_0123456789abcdef0123456789abcdef";
it("drops a lost question recovery claim and fences its registered terminal callback", async () => {
  const nonce = "abcdefghijklmnopqrstuv";
  const record: DurableRecord = { kind: "question", accountId: "default", scope: "hash", generation: "old", messageId: "9001", id: questionId, nonce, senderHash: bindingHash("alice@example.test"), optionHashes: [bindingHash("staging"), bindingHash("production")], expiresAt: Date.now() + 60000, conversation: { kind: "stream", stream: "18", topic: "restart" } };
  const spies = [vi.spyOn(durableBindings, "records").mockResolvedValue([{ key: `question:default:${nonce}`, record }]), vi.spyOn(durableBindings, "claim").mockResolvedValue(undefined)];
  const store = new ZulipQuestionZformStore();
  try {
    mocks.resolveOption.mockResolvedValue({ status: "denied" });
    await store.restore({ cfg: {}, accountId: "default", client: {} as never, hostVersion: "2026.10.1-beta.2" });
    expect(await store.intercept({ cfg: {}, message: { accountId: "default", conversation: record.conversation!, senderId: "alice@example.test", text: `ocq1:${nonce}:0` } })).toMatchObject({ status: "stale" });
    expect(mocks.resolveOption).toHaveBeenCalledTimes(1);
    await mocks.registerChannelDelivery.mock.calls[0][0].finalize("Answered");
    expect(mocks.sendZulipStreamMessage).not.toHaveBeenCalled();
    expect(mocks.deleteZulipMessage).not.toHaveBeenCalled();
  } finally { store.clear(); for (const spy of spies) spy.mockRestore(); }
});
const options = ["Staging", "Production"];

function payload(overrides: Record<string, unknown> = {}) {
  return {
    text: "Question for you:\n\nWhere should this deploy?\n1. Staging\n2. Production",
    channelData: { askUser: { questionId, optionValues: options } },
    presentation: {
      blocks: [
        { type: "text" as const, text: "Where should this deploy?" },
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Production",
              action: { type: "question" as const, questionId, optionValue: "Production" },
            },
            {
              label: "Staging",
              action: { type: "question" as const, questionId, optionValue: "Staging" },
            },
            {
              label: "Other…",
              action: { type: "question" as const, questionId, intent: "custom-input" as const },
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function register(
  store: ZulipQuestionZformStore,
  overrides: {
    payload?: Record<string, unknown>;
    sourceMessageId?: string;
    conversation?:
      | { kind: "dm"; recipient: string }
      | { kind: "stream"; stream: string; topic: string };
    logDebug?: (message: string) => void;
  } = {},
) {
  const preparedPayload = payload(overrides.payload);
  const preparation = store.prepare(preparedPayload)!;
  expect(
    store.register({
      preparation,
      accountId: "default",
      conversation: overrides.conversation ?? {
        kind: "stream",
        stream: "debbie",
        topic: "deploys",
      },
      authorizedSenderId: "alice@example.test",
      sourceMessageId: overrides.sourceMessageId ?? "9001",
      sourceText: preparedPayload.text,
      client: {} as never,
      logDebug: overrides.logDebug,
    }),
  ).toBe(true);
  return preparation;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOption.mockResolvedValue({
    status: "answered",
    questionId,
    optionValue: "Staging",
  });
});

describe("ZulipQuestionZformStore rendering", () => {
  it("renders canonical option order with opaque bounded replies and no Gateway id", () => {
    const store = new ZulipQuestionZformStore();
    const preparation = store.prepare(payload());

    expect(preparation).toBeDefined();
    expect(preparation?.widgetContent.extra_data.choices.map((choice) => choice.short_name)).toEqual(
      options,
    );
    for (const [index, choice] of preparation!.widgetContent.extra_data.choices.entries()) {
      expect(choice.reply).toMatch(new RegExp(`^ocq1:[A-Za-z0-9_-]{22}:${index}$`, "u"));
      expect(choice.reply).not.toContain(questionId);
      expect(choice.reply.length).toBeLessThan(40);
    }
  });

  it.each([
    ["missing canonical metadata", { channelData: { askUser: { questionId } } }],
    [
      "malformed question id",
      {
        channelData: { askUser: { questionId: "ask_NOT_CANONICAL", optionValues: options } },
        presentation: {
          ...payload().presentation,
          blocks: payload().presentation.blocks.map((block) =>
            block.type === "buttons"
              ? {
                  ...block,
                  buttons: block.buttons.map((button) => ({
                    ...button,
                    action: { ...button.action, questionId: "ask_NOT_CANONICAL" },
                  })),
                }
              : block,
          ),
        },
      },
    ],
    [
      "more than four options",
      { channelData: { askUser: { questionId, optionValues: ["1", "2", "3", "4", "5"] } } },
    ],
    [
      "multi-question presentation",
      {
        presentation: {
          blocks: [
            ...payload().presentation.blocks,
            {
              type: "buttons",
              buttons: [
                {
                  label: "Another",
                  action: { type: "question", questionId: "another", optionValue: "Another" },
                },
              ],
            },
          ],
        },
      },
    ],
    [
      "custom-input-only presentation",
      {
        presentation: {
          blocks: [
            { type: "text", text: "Type an answer" },
            {
              type: "buttons",
              buttons: [
                {
                  label: "Other…",
                  action: { type: "question", questionId, intent: "custom-input" },
                },
              ],
            },
          ],
        },
      },
    ],
  ])("keeps %s on text fallback", (_name, override) => {
    expect(new ZulipQuestionZformStore().prepare(payload(override))).toBeUndefined();
  });
});

describe("ZulipQuestionZformStore resolution", () => {
  it("binds the bot source receipt and resolves the canonical option through the public runtime", async () => {
    const store = new ZulipQuestionZformStore();
    const preparation = register(store);
    const token = preparation.widgetContent.extra_data.choices[0]!.reply;

    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: token,
        },
        cfg: {},
        gatewayUrl: "ws://127.0.0.1:18789",
      }),
    ).resolves.toEqual({ recognized: true, status: "answered", optionValue: "Staging" });

    expect(mocks.registerChannelDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId,
        deliveryId: "zulip-zform:default:9001",
      }),
    );
    expect(mocks.resolveOption).toHaveBeenCalledWith({
      cfg: {},
      questionId,
      optionValue: "Staging",
      authorize: expect.any(Function),
      senderId: "alice@example.test",
      gatewayUrl: "ws://127.0.0.1:18789",
      clientDisplayName: "Zulip question (alice@example.test)",
    });
  });

  it("accepts an exact control token preceded by the expected stripped Zulip bot mention", async () => {
    const store = new ZulipQuestionZformStore();
    const preparation = register(store);
    const token = preparation.widgetContent.extra_data.choices[0]!.reply;

    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: `@Debbie-Main ${token}`,
          expectedBotMention: "Debbie-Main",
        },
        cfg: {},
      }),
    ).resolves.toEqual({ recognized: true, status: "answered", optionValue: "Staging" });
    expect(mocks.resolveOption).toHaveBeenCalledOnce();
  });

  it.each([
    ["canonical ordered-list fallback", "Production", '<ol start="2"><li>Production</li></ol>', "Production"],
    ["bare numbered fallback", "2", undefined, "Production"],
    ["dotted numbered fallback", "2.", undefined, "Production"],
    ["numbered canonical fallback", "2. Production", undefined, "Production"],
    ["canonical option fallback", "production", undefined, "Production"],
  ])("resolves %s through the public runtime", async (_name, text, html, optionValue) => {
    const store = new ZulipQuestionZformStore();
    register(store);
    mocks.resolveOption.mockResolvedValueOnce({ status: "answered", questionId, optionValue });

    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text,
          html,
        },
        cfg: {},
      }),
    ).resolves.toEqual({ recognized: true, status: "answered", optionValue });
    expect(mocks.resolveOption).toHaveBeenCalledWith(expect.objectContaining({ optionValue }));
  });

  it.each([
    ["index/value disagreement", "2. Staging", undefined, true],
    ["ordered-list index/value disagreement", "Staging", '<ol start="2"><li>Staging</li></ol>', true],
    ["unrelated single-item ordered list", "It’s just text.", '<ol start="2"><li>It’s just text.</li></ol>', false],
    ["plain prose", "I prefer Production", undefined, false],
    ["out-of-range number", "5", undefined, true],
    ["multi-item ordered list", "Production Staging", '<ol start="2"><li>Production</li><li>Staging</li></ol>', true],
    ["malformed ordered list", "Production", '<ol start="2"><li>Production</ol>', true],
  ])("does not resolve %s", async (_name, text, html, recognized) => {
    const store = new ZulipQuestionZformStore();
    register(store);

    const result = await store.intercept({
      message: {
        accountId: "default",
        conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
        senderId: "alice@example.test",
        text,
        html,
      },
      cfg: {},
    });

    expect(result.recognized).toBe(recognized);
    expect(mocks.resolveOption).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous fallback across multiple matching active questions", async () => {
    const store = new ZulipQuestionZformStore();
    register(store, { sourceMessageId: "9001" });
    register(store, { sourceMessageId: "9002" });

    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: "2",
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "rejected" });
    expect(mocks.resolveOption).not.toHaveBeenCalled();
  });

  it("terminalizes fallback answers and consumes duplicate fallback replies as stale", async () => {
    const store = new ZulipQuestionZformStore();
    register(store);
    mocks.resolveOption.mockResolvedValueOnce({
      status: "answered",
      questionId,
      optionValue: "Production",
    });
    const message = {
      accountId: "default",
      conversation: { kind: "stream" as const, stream: "debbie", topic: "deploys" },
      senderId: "alice@example.test",
      text: "2",
    };

    await expect(store.intercept({ message, cfg: {} })).resolves.toMatchObject({
      status: "answered",
    });
    await expect(store.intercept({ message, cfg: {} })).resolves.toMatchObject({
      recognized: true,
      status: "stale",
    });
    expect(mocks.resolveOption).toHaveBeenCalledOnce();
  });

  it("consumes an expired matching fallback without resolving it", async () => {
    vi.useFakeTimers();
    try {
      const store = new ZulipQuestionZformStore();
      register(store);
      vi.advanceTimersByTime(60 * 60 * 1_000 + 1);

      await expect(
        store.intercept({
          message: {
            accountId: "default",
            conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
            senderId: "alice@example.test",
            text: "Production",
          },
          cfg: {},
        }),
      ).resolves.toMatchObject({ recognized: true, status: "stale" });
      expect(mocks.resolveOption).not.toHaveBeenCalled();
      store.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["wrong account", { accountId: "other" }],
    ["wrong sender", { senderId: "mallory@example.test" }],
    ["wrong topic", { conversation: { kind: "stream" as const, stream: "debbie", topic: "other" } }],
    ["wrong stream", { conversation: { kind: "stream" as const, stream: "other", topic: "deploys" } }],
  ])("leaves %s fallback outside the binding unrecognized", async (_name, override) => {
    const store = new ZulipQuestionZformStore();
    register(store);

    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: "2",
          ...override,
        },
        cfg: {},
      }),
    ).resolves.toEqual({ recognized: false });
    expect(mocks.resolveOption).not.toHaveBeenCalled();
  });

  it.each([
    ["unrelated leading mention", (token: string) => `@Other-Bot ${token}`, false],
    ["prose before the token", (token: string) => `@Debbie-Main choose ${token}`, false],
    ["prose after the token", (token: string) => `@Debbie-Main ${token} please`, true],
    ["multiple tokens", (token: string) => `@Debbie-Main ${token} ${token}`, true],
    ["malformed token", () => "@Debbie-Main ocq1:not-a-valid-token:0", true],
  ])("does not accept %s", async (_name, buildText, recognized) => {
    const store = new ZulipQuestionZformStore();
    const preparation = register(store);
    const token = preparation.widgetContent.extra_data.choices[0]!.reply;

    const result = await store.intercept({
      message: {
        accountId: "default",
        conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
        senderId: "alice@example.test",
        text: buildText(token),
        expectedBotMention: "Debbie-Main",
      },
      cfg: {},
    });

    expect(result.recognized).toBe(recognized);
    if (recognized) {
      expect(result).toMatchObject({ status: "rejected" });
    }
    expect(mocks.resolveOption).not.toHaveBeenCalled();
  });

  it("rejects a malformed question id defensively at registration", () => {
    const store = new ZulipQuestionZformStore();
    const preparation = store.prepare(payload())!;

    expect(
      store.register({
        preparation: { ...preparation, questionId: "ask_NOT_CANONICAL" },
        accountId: "default",
        conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
        authorizedSenderId: "alice@example.test",
        sourceMessageId: "9001",
        sourceText: payload().text,
        client: {} as never,
      }),
    ).toBe(false);
    expect(mocks.registerChannelDelivery).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-account", { accountId: "other" }],
    ["wrong sender", { senderId: "mallory@example.test" }],
    ["cross-stream", { conversation: { kind: "stream" as const, stream: "other", topic: "deploys" } }],
    [
      "cross-topic",
      { conversation: { kind: "stream" as const, stream: "debbie", topic: "other-topic" } },
    ],
  ])("rejects and consumes %s controls without resolving", async (_name, override) => {
    const store = new ZulipQuestionZformStore();
    const preparation = register(store);
    const token = preparation.widgetContent.extra_data.choices[0]!.reply;
    const message = {
      accountId: "default",
      conversation: { kind: "stream" as const, stream: "debbie", topic: "deploys" },
      senderId: "alice@example.test",
      text: token,
      ...override,
    };

    await expect(store.intercept({ message, cfg: {} })).resolves.toMatchObject({
      recognized: true,
      status: "rejected",
    });
    expect(mocks.resolveOption).not.toHaveBeenCalled();
  });

  it("preserves stream and topic case while trimming their boundaries", async () => {
    const store = new ZulipQuestionZformStore();
    const preparation = register(store, {
      conversation: { kind: "stream", stream: " Debbie ", topic: " Deploys " },
    });
    const token = preparation.widgetContent.extra_data.choices[0]!.reply;

    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: token,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "rejected" });
    expect(mocks.resolveOption).not.toHaveBeenCalled();

    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "Debbie", topic: "Deploys" },
          senderId: "alice@example.test",
          text: token,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "answered" });
  });

  it("prunes expired bindings and clears their timers before admitting replacements", () => {
    vi.useFakeTimers();
    try {
      const store = new ZulipQuestionZformStore(1);
      register(store, { sourceMessageId: "9001" });
      expect(vi.getTimerCount()).toBe(1);

      const now = Date.now();
      vi.setSystemTime(now + 60 * 60 * 1_000 + 1);
      register(store, { sourceMessageId: "9002" });

      expect(mocks.registerChannelDelivery).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
      store.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest terminal binding before any active question", async () => {
    const store = new ZulipQuestionZformStore(3);
    const first = register(store, { sourceMessageId: "9001" });
    const second = register(store, { sourceMessageId: "9002" });
    const active = register(store, { sourceMessageId: "9003" });
    const firstFinalize = mocks.registerChannelDelivery.mock.calls[0]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;
    const secondFinalize = mocks.registerChannelDelivery.mock.calls[1]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;
    await firstFinalize("Answered: Staging");
    await secondFinalize("Answered: Staging");
    const admitted = register(store, { sourceMessageId: "9004" });

    const bindings = (store as unknown as { bindings: Map<string, unknown> }).bindings;
    expect(bindings.has(first.nonce)).toBe(false);
    expect(bindings.has(second.nonce)).toBe(true);
    expect(bindings.has(active.nonce)).toBe(true);
    expect(bindings.has(admitted.nonce)).toBe(true);
    expect(mocks.registerChannelDelivery).toHaveBeenCalledTimes(4);
    for (const preparation of [active, admitted]) {
      await expect(
        store.intercept({
          message: {
            accountId: "default",
            conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
            senderId: "alice@example.test",
            text: preparation.widgetContent.extra_data.choices[0]!.reply,
          },
          cfg: {},
        }),
      ).resolves.toMatchObject({ recognized: true, status: "answered" });
    }
  });

  it("rejects registration when the bounded store contains only active questions", () => {
    const store = new ZulipQuestionZformStore(1);
    register(store, { sourceMessageId: "9001" });
    const preparation = store.prepare(payload())!;

    expect(
      store.register({
        preparation,
        accountId: "default",
        conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
        authorizedSenderId: "alice@example.test",
        sourceMessageId: "9002",
        sourceText: payload().text,
        client: {} as never,
      }),
    ).toBe(false);
    expect(mocks.registerChannelDelivery).toHaveBeenCalledOnce();
    store.clear();
  });

  it("terminalizes one-shot controls and consumes duplicate replay", async () => {
    const store = new ZulipQuestionZformStore();
    const preparation = register(store);
    const message = {
      accountId: "default",
      conversation: { kind: "stream" as const, stream: "debbie", topic: "deploys" },
      senderId: "alice@example.test",
      text: preparation.widgetContent.extra_data.choices[0]!.reply,
    };

    await expect(store.intercept({ message, cfg: {} })).resolves.toMatchObject({ status: "answered" });
    await expect(store.intercept({ message, cfg: {} })).resolves.toMatchObject({
      recognized: true,
      status: "stale",
    });
    expect(mocks.resolveOption).toHaveBeenCalledOnce();
  });

  it("fails closed for malformed, tampered, and option-mismatch controls", async () => {
    const store = new ZulipQuestionZformStore();
    const preparation = register(store);
    const nonce = preparation.nonce;

    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: "ocq1:not-a-valid-control",
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "rejected" });
    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: `ocq1:${"A".repeat(22)}:0`,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "stale" });
    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: `ocq1:${nonce}:3`,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "rejected" });
    expect(mocks.resolveOption).not.toHaveBeenCalled();
  });

  it("replaces a finalized stream question before deleting its widget source", async () => {
    const store = new ZulipQuestionZformStore();
    const preparation = register(store);
    const finalize = mocks.registerChannelDelivery.mock.calls[0]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;

    await finalize("Answered: Staging");

    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.anything(),
      {
        stream: "debbie",
        topic: "deploys",
        content: `${payload().text}\n\n> ✅ Answered: Staging`,
      },
    );
    expect(mocks.sendZulipPrivateMessage).not.toHaveBeenCalled();
    expect(mocks.deleteZulipMessage).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      messageId: "9001",
    });
    expect(mocks.sendZulipStreamMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteZulipMessage.mock.invocationCallOrder[0]!,
    );
    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: preparation.widgetContent.extra_data.choices[0]!.reply,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "stale" });
  });

  it("routes a terminal replacement to the exact DM before deleting its widget source", async () => {
    const store = new ZulipQuestionZformStore();
    register(store, {
      conversation: { kind: "dm", recipient: "Alice@Example.Test" },
    });
    const finalize = mocks.registerChannelDelivery.mock.calls[0]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;

    await finalize("Answered: Production");

    expect(mocks.sendZulipPrivateMessage).toHaveBeenCalledWith(expect.anything(), {
      to: "alice@example.test",
      content: `${payload().text}\n\n> ✅ Answered: Production`,
    });
    expect(mocks.sendZulipStreamMessage).not.toHaveBeenCalled();
    expect(mocks.sendZulipPrivateMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteZulipMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("retains the widget source when terminal replacement delivery fails", async () => {
    const logDebug = vi.fn();
    mocks.sendZulipStreamMessage.mockRejectedValueOnce(new Error("synthetic send failure"));
    const store = new ZulipQuestionZformStore();
    const preparation = register(store, { logDebug });
    const finalize = mocks.registerChannelDelivery.mock.calls[0]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;

    await expect(finalize("Answered: Staging")).resolves.toBeUndefined();

    expect(mocks.deleteZulipMessage).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("synthetic send failure"));
    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: preparation.widgetContent.extra_data.choices[0]!.reply,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "stale" });
  });

  it("retains the widget source when replacement delivery returns no message id", async () => {
    const logDebug = vi.fn();
    mocks.sendZulipStreamMessage.mockResolvedValueOnce({});
    const store = new ZulipQuestionZformStore();
    const preparation = register(store, { logDebug });
    const finalize = mocks.registerChannelDelivery.mock.calls[0]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;

    await finalize("Answered: Staging");

    expect(mocks.deleteZulipMessage).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("returned no message id"));
    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: preparation.widgetContent.extra_data.choices[0]!.reply,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "stale" });
  });

  it("cleans up the replacement when deleting the widget source fails", async () => {
    const logDebug = vi.fn();
    mocks.deleteZulipMessage.mockRejectedValueOnce(new Error("synthetic source delete failure"));
    const store = new ZulipQuestionZformStore();
    const preparation = register(store, { logDebug });
    const finalize = mocks.registerChannelDelivery.mock.calls[0]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;

    await expect(finalize("Answered: Staging")).resolves.toBeUndefined();

    expect(mocks.deleteZulipMessage).toHaveBeenNthCalledWith(1, expect.anything(), {
      messageId: "9001",
    });
    expect(mocks.deleteZulipMessage).toHaveBeenNthCalledWith(2, expect.anything(), {
      messageId: "9102",
    });
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("synthetic source delete failure"));
    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: preparation.widgetContent.extra_data.choices[0]!.reply,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "stale" });
  });

  it("logs replacement cleanup failure after widget source deletion fails", async () => {
    const logDebug = vi.fn();
    mocks.deleteZulipMessage
      .mockRejectedValueOnce(new Error("synthetic source delete failure"))
      .mockRejectedValueOnce(new Error("synthetic cleanup delete failure"));
    const store = new ZulipQuestionZformStore();
    const preparation = register(store, { logDebug });
    const finalize = mocks.registerChannelDelivery.mock.calls[0]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;

    await expect(finalize("Answered: Staging")).resolves.toBeUndefined();

    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("synthetic source delete failure"));
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("synthetic cleanup delete failure"));
    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "stream", stream: "debbie", topic: "deploys" },
          senderId: "alice@example.test",
          text: preparation.widgetContent.extra_data.choices[0]!.reply,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({ recognized: true, status: "stale" });
  });

  it.each([
    ["Timed out", "⏳"],
    ["Cancelled", "❌"],
    ["Closed", "ℹ️"],
  ])("uses a clean Markdown terminal marker for %s questions", async (statusLine, icon) => {
    const store = new ZulipQuestionZformStore();
    register(store);
    const finalize = mocks.registerChannelDelivery.mock.calls[0]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;

    await finalize(statusLine);

    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: `${payload().text}\n\n> ${icon} ${statusLine}` }),
    );
  });

  it("bounds the complete rendered terminal suffix to 512 characters", async () => {
    const store = new ZulipQuestionZformStore();
    register(store);
    const finalize = mocks.registerChannelDelivery.mock.calls[0]![0].finalize as (
      statusLine: string,
    ) => Promise<void>;

    await finalize(`Answered: ${"x".repeat(1_000)}`);

    const content = mocks.sendZulipStreamMessage.mock.calls[0]![1].content as string;
    const suffix = content.slice(content.lastIndexOf("\n\n") + 2);
    expect(suffix).toHaveLength(512);
    expect(suffix).toMatch(/^> ✅ Answered: /u);
  });

  it("lets unrelated ordinary messages continue to the normal agent path", async () => {
    const store = new ZulipQuestionZformStore();
    await expect(
      store.intercept({
        message: {
          accountId: "default",
          conversation: { kind: "dm", recipient: "alice@example.test" },
          senderId: "alice@example.test",
          text: "Production",
        },
        cfg: {},
      }),
    ).resolves.toEqual({ recognized: false });
  });
});

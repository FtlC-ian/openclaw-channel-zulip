import type { OpenClawConfig } from "./sdk.js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  splitStreamTarget,
  ZULIP_ADVERTISED_ACTIONS,
  zulipMessageActions,
} from "./actions.js";

type CoreAction = Parameters<NonNullable<typeof zulipMessageActions.handleAction>>[0]["action"];
type HiddenAction =
  | "channel-subscribe"
  | "invite"
  | "resolve-topic"
  | "user-presence"
  | "user-deactivate"
  | "user-reactivate"
  | "org-settings"
  | "org-settings-edit";
type AnyAction = CoreAction | HiddenAction;
type FetchMock = Mock<typeof fetch>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const cfg: OpenClawConfig = {
  channels: {
    zulip: {
      apiKey: "secret",
      email: "bot@example.test",
      url: "https://zulip.example.test",
    },
  },
};

async function runReactAction(
  params: Record<string, unknown>,
  options?: { dryRun?: boolean; fetchImpl?: FetchMock },
) {
  const fetchImpl =
    options?.fetchImpl ??
    vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success", msg: "" }));
  vi.stubGlobal("fetch", fetchImpl);
  const result = await zulipMessageActions.handleAction?.({
    channel: "zulip",
    action: "react",
    cfg,
    params,
    dryRun: options?.dryRun,
  });
  return { result: result as { details?: unknown }, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function runAction(
  action: AnyAction,
  params: Record<string, unknown>,
  options?: {
    accountId?: string;
    cfg?: OpenClawConfig;
    dryRun?: boolean;
    fetchImpl?: FetchMock;
  },
) {
  const fetchImpl =
    options?.fetchImpl ??
    vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success", msg: "" }));
  vi.stubGlobal("fetch", fetchImpl);
  const result = await zulipMessageActions.handleAction?.({
    channel: "zulip",
    action: action as CoreAction,
    cfg: options?.cfg ?? cfg,
    accountId: options?.accountId,
    params,
    dryRun: options?.dryRun,
  });
  return { result: result as { details?: unknown } | undefined, fetchImpl };
}

async function expectRejectedWithoutFetch(
  action: AnyAction,
  params: Record<string, unknown>,
): Promise<void> {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(runAction(action, params, { fetchImpl })).rejects.toThrow("confirm: true");
  expect(fetchImpl).not.toHaveBeenCalled();
}

describe("destructive action confirmation", () => {
  it.each(["delete", "unsend"] as const)("rejects %s without confirm", async (action) => {
    await expectRejectedWithoutFetch(action, { messageId: "123" });
  });

  it("rejects channel-delete without confirm", async () => {
    await expectRejectedWithoutFetch("channel-delete", { streamId: "general" });
  });

  it("rejects delete when confirm is false", async () => {
    await expectRejectedWithoutFetch("delete", { messageId: "123", confirm: false });
  });

  it("rejects delete when confirm is a string", async () => {
    await expectRejectedWithoutFetch("delete", { messageId: "123", confirm: "yes" });
  });

  it("scopes the confirmation schema to advertised destructive actions", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg });
    expect(discovery?.schema).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actions: ["channel-delete", "delete", "unsend"],
          properties: { confirm: expect.objectContaining({ type: "boolean" }) },
        }),
      ]),
    );
  });

  it.each([
    ["delete", { messageId: "123", confirm: true }],
    ["unsend", { messageId: "123", confirm: true }],
    ["channel-delete", { streamId: "general", confirm: true }],
  ] as const)("does not send Zulip requests for %s dry runs", async (action, params) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = await runAction(action, params, { dryRun: true, fetchImpl });
    expect(result?.details).toMatchObject({ ok: true, dryRun: true, action });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["delete", "unsend"] as const)(
    "succeeds %s when confirm is true and all other gates pass",
    async (action) => {
      const { result, fetchImpl } = await runAction(action, {
        messageId: "123",
        confirm: true,
      });
      expect(result?.details).toMatchObject({ ok: true, deleted: "123" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(String(url)).toContain("/messages/123");
      expect(init?.method).toBe("DELETE");
    },
  );

  it("succeeds channel-delete when confirm is true and all other gates pass", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes("/streams")) {
          return jsonResponse({
            result: "success",
            streams: [{ stream_id: 7, name: "general" }],
          });
        }
        return jsonResponse({ result: "success" });
      });
    const { result } = await runAction(
      "channel-delete",
      { streamId: "general", confirm: true },
      { fetchImpl },
    );
    expect(result?.details).toMatchObject({ ok: true, streamId: "7" });
  });

  it.each<HiddenAction>([
    "channel-subscribe",
    "invite",
    "resolve-topic",
    "user-presence",
    "user-deactivate",
    "user-reactivate",
    "org-settings",
    "org-settings-edit",
  ])("rejects hidden action %s before calling Zulip", async (action) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(runAction(action, {}, { fetchImpl })).rejects.toThrow(
      `Action ${action} is not supported`,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("action capability consistency", () => {
  it("advertises the shared action list and supports exactly plugin-handled actions", () => {
    expect(zulipMessageActions.describeMessageTool({ cfg }).actions).toEqual(
      ZULIP_ADVERTISED_ACTIONS,
    );
    for (const action of ZULIP_ADVERTISED_ACTIONS) {
      expect(zulipMessageActions.supportsAction?.({ action })).toBe(action !== "poll");
    }
  });

  it.each(["ban", "rename-group", "set-group-icon"] as CoreAction[])(
    "does not claim unadvertised canonical action %s",
    (action) => {
      expect(zulipMessageActions.supportsAction?.({ action })).toBe(false);
    },
  );

  it("rejects the core-owned poll action before credential or network access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runAction("poll", {}, { cfg: {}, fetchImpl }),
    ).rejects.toThrow("Action poll is not supported");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("discovers actions for the requested configured account", () => {
    const namedAccountConfig: OpenClawConfig = {
      channels: {
        zulip: {
          accounts: {
            primary: {
              apiKey: "named-secret",
              email: "named@example.test",
              url: "https://named.example.test",
            },
          },
        },
      },
    };
    expect(
      zulipMessageActions.describeMessageTool({
        cfg: namedAccountConfig,
        accountId: "primary",
      }).actions,
    ).toEqual(ZULIP_ADVERTISED_ACTIONS);
    expect(zulipMessageActions.describeMessageTool({ cfg: namedAccountConfig }).actions).toEqual(
      [],
    );
  });

  it("contributes every Zulip-only handler parameter under its action scope", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg });
    const contributions = Array.isArray(discovery?.schema) ? discovery.schema : [];
    const propertiesFor = (action: CoreAction) =>
      Object.assign(
        {},
        ...contributions
          .filter((entry) => entry.actions?.includes(action))
          .map((entry) => entry.properties),
      ) as Record<string, unknown>;

    expect(propertiesFor("channel-list")).toHaveProperty("includeAllPublic");
    expect(propertiesFor("channel-create")).toMatchObject({
      description: { type: "string" },
      principals: { type: "array" },
      announce: { type: "boolean" },
      inviteOnly: { type: "boolean" },
      isWebPublic: { type: "boolean" },
      isDefaultStream: { type: "boolean" },
      historyPublicToSubscribers: { type: "boolean" },
    });
    expect(propertiesFor("channel-edit")).toMatchObject({
      description: { type: "string" },
      newName: { type: "string" },
      isPrivate: { type: "boolean" },
      isWebPublic: { type: "boolean" },
      isDefaultStream: { type: "boolean" },
      historyPublicToSubscribers: { type: "boolean" },
    });
    expect(propertiesFor("react")).toMatchObject({
      emojiCode: { type: "string" },
      reactionType: { type: "string" },
    });
  });
});

describe("reachable action routes", () => {
  it.each([
    ["send", { to: "user:person@example.test", message: "hello" }],
    ["channel-create", { name: "new-stream", description: "description" }],
    ["channel-edit", { channelId: "7", newName: "renamed" }],
    ["edit", { messageId: "123", message: "replacement" }],
    ["pin", { messageId: "123" }],
    ["unpin", { messageId: "123" }],
  ] as const)("keeps %s dry runs network-free", async (action, params) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = await runAction(action, params, { dryRun: true, fetchImpl });
    expect(result?.details).toMatchObject({ ok: true, dryRun: true, action });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["channel-list", { includeAllPublic: true }, "/users/me/subscriptions"],
    ["read", { to: "stream:general:topic", limit: 3 }, "/messages?"],
    ["member-info", { userId: "42" }, "/users/42"],
    ["search", { query: "needle", stream: "general" }, "/messages?"],
  ] as const)("routes %s to its Zulip read endpoint", async (action, params, path) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        result: "success",
        subscriptions: [],
        streams: [],
        messages: [],
        user: { user_id: 42 },
      }),
    );
    const { result } = await runAction(action, params, { fetchImpl });
    expect(result?.details).toMatchObject({ ok: true });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(path);
  });

  it.each(["pin", "unpin"] as const)(
    "rejects malformed %s message ids without truncating them",
    async (action) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(runAction(action, { messageId: "123junk" }, { fetchImpl })).rejects.toThrow(
        "Invalid messageId: 123junk",
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["send", { to: "user:person@example.test", message: "hello" }, "/messages", "POST"],
    ["channel-create", { name: "new-stream", announce: true }, "/users/me/subscriptions", "POST"],
    ["channel-edit", { channelId: "7", newName: "renamed" }, "/streams/7", "PATCH"],
    ["edit", { messageId: "123", message: "replacement" }, "/messages/123", "PATCH"],
    ["pin", { messageId: "123" }, "/messages/flags", "POST"],
    ["unpin", { messageId: "123" }, "/messages/flags", "POST"],
  ] as const)("routes %s mutations to the expected endpoint", async (action, params, path, method) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ result: "success", id: 99 }));
    await runAction(action, params, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain(path);
    expect(init?.method).toBe(method);
  });
});

describe("splitStreamTarget", () => {
  it("parses canonical stream targets with colon topics", () => {
    expect(splitStreamTarget("stream:debbie:Zulip Plugin PR")).toEqual({
      stream: "debbie",
      topic: "Zulip Plugin PR",
    });
  });

  it("keeps legacy slash topic parsing for unprefixed streams", () => {
    expect(splitStreamTarget("debbie/Zulip Plugin PR")).toEqual({
      stream: "debbie",
      topic: "Zulip Plugin PR",
    });
  });

  it("parses core-inferred stream topic targets without the stream prefix", () => {
    expect(splitStreamTarget("debbie:Zulip Plugin PR")).toEqual({
      stream: "debbie",
      topic: "Zulip Plugin PR",
    });
  });
});

describe("zulipMessageActions react", () => {
  it("adds a named Zulip reaction by message id", async () => {
    const { result, fetchImpl } = await runReactAction({
      messageId: "123",
      emojiName: "octopus",
    });

    expect(result.details).toMatchObject({ ok: true, added: "octopus", messageId: "123" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://zulip.example.test/api/v1/messages/123/reactions");
    expect(init?.method).toBe("POST");
    expect(new URLSearchParams(String(init?.body)).get("emoji_name")).toBe("octopus");
  });

  it("maps common Unicode approval reactions to Zulip unicode emoji parameters", async () => {
    const { fetchImpl } = await runReactAction({
      messageId: 456,
      emoji: "👍",
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("emoji_name")).toBe("thumbs_up");
    expect(body.get("emoji_code")).toBe("1f44d");
    expect(body.get("reaction_type")).toBe("unicode_emoji");
  });

  it("maps common expressive Unicode reactions to Zulip emoji names", async () => {
    const cases = [
      { emoji: "🧠", name: "brain", code: "1f9e0" },
      { emoji: "🤔", name: "thinking", code: "1f914" },
      { emoji: "😂", name: "joy", code: "1f602" },
      { emoji: "🎉", name: "tada", code: "1f389" },
      { emoji: "❤️", name: "heart", code: "2764" },
      { emoji: "🔥", name: "fire", code: "1f525" },
    ];

    for (const { emoji, name, code } of cases) {
      const { fetchImpl } = await runReactAction({
        messageId: 456,
        emoji,
      });

      const [, init] = fetchImpl.mock.calls[0] ?? [];
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("emoji_name")).toBe(name);
      expect(body.get("emoji_code")).toBe(code);
      expect(body.get("reaction_type")).toBe("unicode_emoji");
    }
  });

  it("passes explicit emoji code and reaction type through", async () => {
    const { fetchImpl } = await runReactAction({
      messageId: "789",
      emoji: "custom_party",
      emojiCode: "party_custom_id",
      reactionType: "realm_emoji",
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("emoji_name")).toBe("custom_party");
    expect(body.get("emoji_code")).toBe("party_custom_id");
    expect(body.get("reaction_type")).toBe("realm_emoji");
  });

  it("removes reactions with the same Zulip parameters", async () => {
    const { result, fetchImpl } = await runReactAction({
      messageId: "123",
      emoji: "👎",
      remove: true,
    });

    expect(result.details).toMatchObject({ ok: true, removed: true, messageId: "123" });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.method).toBe("DELETE");
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/api/v1/messages/123/reactions");
    expect(parsed.searchParams.get("emoji_name")).toBe("thumbs_down");
    expect(parsed.searchParams.get("emoji_code")).toBe("1f44e");
    expect(parsed.searchParams.get("reaction_type")).toBe("unicode_emoji");
  });

  it("preserves dry-run behavior without calling Zulip", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success" }));
    const { result } = await runReactAction(
      {
        messageId: "123",
        emoji: "♾️",
      },
      { dryRun: true, fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      ok: true,
      dryRun: true,
      action: "add-reaction",
      messageId: "123",
      emoji: "infinity",
      emojiCode: "267e",
      reactionType: "unicode_emoji",
    });
  });

  it("uses the current inbound message id when no explicit message id is given", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success" }));
    vi.stubGlobal("fetch", fetchImpl);

    await zulipMessageActions.handleAction?.({
      channel: "zulip",
      action: "react",
      cfg,
      params: { emoji: "+1" },
      toolContext: { currentMessageId: "current-1" },
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://zulip.example.test/api/v1/messages/current-1/reactions",
    );
  });
});

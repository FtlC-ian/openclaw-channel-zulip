import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { RuntimeEnv } from "../sdk.js";

const state = vi.hoisted(() => {
  const createMemoryKeyedStore = <T>(maxEntries = Number.MAX_SAFE_INTEGER) => {
    const values = new Map<string, { key: string; value: T; createdAt: number }>();
    const enforceLimit = (key: string) => {
      if (!values.has(key) && values.size >= maxEntries) {
        throw new Error("PLUGIN_STATE_LIMIT_EXCEEDED");
      }
    };
    return {
      maxEntries,
      register: vi.fn(async (key: string, value: T) => {
        enforceLimit(key);
        values.set(key, { key, value, createdAt: Date.now() });
      }),
      registerIfAbsent: vi.fn(async (key: string, value: T) => {
        if (values.has(key)) {
          return false;
        }
        enforceLimit(key);
        values.set(key, { key, value, createdAt: Date.now() });
        return true;
      }),
      lookup: vi.fn(async (key: string) => values.get(key)?.value),
      consume: vi.fn(async (key: string) => {
        const value = values.get(key)?.value;
        values.delete(key);
        return value;
      }),
      delete: vi.fn(async (key: string) => values.delete(key)),
      entries: vi.fn(async () => Array.from(values.values())),
      clear: vi.fn(async () => {
        values.clear();
      }),
    };
  };

  const createCore = () => ({
    config: {
      channels: {
        zulip: {},
      },
      commands: {},
      session: {},
    },
    logging: {
      getChildLogger: () => ({ debug: vi.fn() }),
      shouldLogVerbose: () => false,
    },
    state: undefined as
      | undefined
      | {
          openKeyedStore: ReturnType<typeof vi.fn>;
        },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
    agent: {
      session: {
        resolveStorePath: vi.fn((_store?: string, _options?: { agentId: string }) => "/tmp/openclaw-session-store.json"),
      },
    },
    channel: {
      media: {
        saveMediaBuffer: vi.fn(),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionPatterns: vi.fn(() => false),
      },
      commands: {
        shouldHandleTextCommands: vi.fn(() => false),
      },
      text: {
        hasControlCommand: vi.fn(() => false),
        resolveTextChunkLimit: vi.fn(() => 4000),
        resolveMarkdownTableMode: vi.fn(() => "preserve"),
        resolveChunkMode: vi.fn(() => "none"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        convertMarkdownTables: vi.fn((text: string) => text),
      },
      groups: {
        resolveRequireMention: vi.fn(() => false),
      },
      activity: {
        record: vi.fn(),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "debbie",
          accountId: "default",
          sessionKey: "agent:debbie:zulip:channel:4",
          mainSessionKey: "agent:debbie:main",
        })),
      },
      inbound: {
        buildContext: vi.fn(),
      },
      reply: {
        resolveHumanDelayConfig: vi.fn(() => undefined),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
      },
      session: {
        updateLastRoute: vi.fn(async () => {}),
      },
      pairing: {
        buildPairingReply: vi.fn(() => "pairing reply"),
      },
    },
  });

  return {
    createMemoryKeyedStore,
    abortController: undefined as AbortController | undefined,
    autoAbort: true,
    durableStores: new Map<string, ReturnType<typeof createMemoryKeyedStore>>(),
    pollResponses: [] as Array<Record<string, unknown>>,
    pairingAllowFrom: [] as string[],
    pairingUpsertError: undefined as Error | undefined,
    upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: false })),
    streamSubscriptions: [] as Array<Record<string, unknown>>,
    streamLookups: new Map<string, Record<string, unknown> | Error>(),
    downloadedUploads: [] as Array<{ buffer: Buffer; contentType: string; filename: string }>,
    extractedUploadUrls: [] as string[],
    editZulipMessage: vi.fn(async () => {}),
    deleteZulipMessage: vi.fn(async () => {}),
    addZulipReaction: vi.fn(async () => {}),
    removeZulipReaction: vi.fn(async () => {}),
    sendMessageZulip: vi.fn(async () => ({ messageId: "outbound-1", channelId: "debbie" })),
    client: { authHeader: "fake-auth" },
    botUser: {
      id: 999,
      email: "debbie-bot@zlp.pubnerd.app",
      full_name: "Debbie",
    },
    account: {
      accountId: "default",
      apiKey: "test-key",
      email: "debbie-bot@zlp.pubnerd.app",
      baseUrl: "https://zlp.pubnerd.app",
      streams: ["debbie"],
      requireMention: false,
      chatmode: "normal",
      config: {
        dmPolicy: "open",
        groupPolicy: "open",
        reactions: { enabled: false },
      },
    },
    core: createCore(),
    createCore,
  };
});

vi.mock("../runtime.js", () => ({
  getZulipRuntime: () => state.core,
}));

const registerZulipQueueMock = vi.fn(async () => ({ queueId: "queue-1", lastEventId: 0 }));
const getZulipEventsWithRetryMock = vi.fn(async () => {
  const next = state.pollResponses.shift() ?? { result: "success", events: [] };
  if (state.autoAbort && state.abortController && state.pollResponses.length === 0) {
    const controller = state.abortController;
    setTimeout(() => controller.abort(), 0);
  }
  return next;
});
const deleteZulipQueueMock = vi.fn(async () => {});
const fetchZulipSubscriptionsMock = vi.fn(async () => state.streamSubscriptions);
const fetchZulipStreamMock = vi.fn(async (_client: unknown, streamId: string) => {
  const result = state.streamLookups.get(String(streamId));
  if (result instanceof Error) {
    throw result;
  }
  if (result) {
    return result;
  }
  const subscription = state.streamSubscriptions.find(
    (entry) => String(entry.stream_id ?? entry.id ?? "") === String(streamId),
  );
  if (subscription) {
    return subscription;
  }
  throw new Error(`unexpected stream metadata lookup: ${streamId}`);
});

vi.mock("./client.js", () => ({
  createZulipClient: vi.fn(() => state.client),
  fetchZulipMe: vi.fn(async () => state.botUser),
  fetchZulipStream: fetchZulipStreamMock,
  fetchZulipSubscriptions: fetchZulipSubscriptionsMock,
  normalizeZulipBaseUrl: vi.fn((url?: string) => url ?? ""),
  registerZulipQueue: registerZulipQueueMock,
  getZulipEventsWithRetry: getZulipEventsWithRetryMock,
  deleteZulipQueue: deleteZulipQueueMock,
  sendZulipTyping: vi.fn(async () => {}),
  addZulipReaction: state.addZulipReaction,
  removeZulipReaction: state.removeZulipReaction,
  editZulipMessage: state.editZulipMessage,
  deleteZulipMessage: state.deleteZulipMessage,
}));

vi.mock("./accounts.js", () => ({
  resolveZulipRuntimeAccount: vi.fn(async () => state.account),
}));

vi.mock("./send.js", () => ({
  sendMessageZulip: state.sendMessageZulip,
}));

const downloadZulipUploadMock = vi.fn(async () => {
  const next = state.downloadedUploads.shift();
  if (!next) {
    throw new Error("unexpected upload download in test");
  }
  return next;
});
const extractZulipUploadUrlsMock = vi.fn(() => state.extractedUploadUrls);

vi.mock("./uploads.js", () => ({
  downloadZulipUpload: downloadZulipUploadMock,
  extractZulipUploadUrls: extractZulipUploadUrlsMock,
  normalizeZulipEmojiName: vi.fn((name: string) => name),
  sanitizeUploadFilename: vi.fn((name: string) =>
    name
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[\\/]+/g, "_")
      .split(/_+/g)
      .filter((part) => part && part !== "." && part !== "..")
      .join("_")
      .replace(/\s+/g, " ")
      .trim() || "upload.bin",
  ),
}));

const typingCallbacksMock = vi.fn(() => ({
  onReplyStart: vi.fn(),
  onIdle: vi.fn(),
}));

vi.mock("../sdk.js", () => ({
  createChannelPairingController: vi.fn(() => ({
    upsertPairingRequest: state.upsertPairingRequest,
    readStoreForDmPolicy: vi.fn(async () => state.pairingAllowFrom),
  })),
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => ({
  ...await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>(),
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: vi.fn() })),
  createTypingCallbacks: typingCallbacksMock,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>(),
  formatInboundEnvelope: vi.fn(({ body }: { body: string }) => body),
  logInboundDrop: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", async (importOriginal) => ({
  ...await importOriginal<typeof import("openclaw/plugin-sdk/channel-feedback")>(),
  logTypingFailure: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp"),
}));

function makeChannelMessage(id: number) {
  return {
    id,
    sender_id: 123,
    sender_email: "user8@zlp.pubnerd.app",
    sender_full_name: "Ian F",
    type: "stream",
    stream_id: 4,
    display_recipient: "debbie",
    subject: "zulip-plugin-pr",
    content: "ping test",
    timestamp: 1_750_000_000,
  };
}

function makePrivateMessage(id: number, senderEmail = "user8@zlp.pubnerd.app") {
  return {
    id,
    sender_id: 123,
    sender_email: senderEmail,
    sender_full_name: "Ian F",
    type: "private",
    display_recipient: [
      { id: 123, email: senderEmail, full_name: "Ian F" },
      {
        id: 999,
        email: "debbie-bot@zlp.pubnerd.app",
        full_name: "Debbie",
      },
    ],
    content: "ping dm",
    timestamp: 1_750_000_000,
  };
}

async function runMonitorOnce(
  controller = new AbortController(),
  runtime?: RuntimeEnv,
  options: { statusSink?: (patch: Record<string, unknown>) => void } = {},
) {
  const { monitorZulipProvider } = await import("./monitor.js");
  state.abortController = controller;
  await monitorZulipProvider({
    config: state.core.config,
    runtime,
    abortSignal: state.abortController.signal,
    statusSink: options.statusSink,
  });
}

function enableDurableInboundJournal() {
  state.durableStores = new Map();
  state.core.state = {
    openKeyedStore: vi.fn((options: { namespace: string }) => {
      const existing = state.durableStores.get(options.namespace);
      if (existing) {
        return existing;
      }
      const store = state.createMemoryKeyedStore(options.maxEntries);
      state.durableStores.set(options.namespace, store);
      return store;
    }),
  };
}

describe("monitorZulipProvider", () => {
  beforeEach(async () => {
    const { startZulipMonitorReactionLifecycles } = await import("./monitor.js");
    startZulipMonitorReactionLifecycles();
    state.core = state.createCore();
    state.core.channel.inbound.buildContext.mockImplementation(buildChannelInboundEventContext);
    state.durableStores = new Map();
    state.pairingAllowFrom = [];
    state.pairingUpsertError = undefined;
    state.upsertPairingRequest.mockReset().mockImplementation(async () => {
      if (state.pairingUpsertError) {
        throw state.pairingUpsertError;
      }
      return { code: "123456", created: false };
    });
    state.account.streams = ["debbie"];
    state.account.requireMention = false;
    state.account.chatmode = "normal";
    state.account.config = {
      dmPolicy: "open",
      groupPolicy: "open",
      reactions: { enabled: false },
    };
    state.pollResponses = [];
    state.streamSubscriptions = [
      {
        stream_id: 4,
        name: "debbie",
        invite_only: false,
        is_web_public: false,
        history_public_to_subscribers: true,
        subscribers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      },
    ];
    state.streamLookups = new Map();
    state.downloadedUploads = [];
    state.extractedUploadUrls = [];
    state.abortController = undefined;
    state.autoAbort = true;
    state.editZulipMessage.mockReset();
    state.deleteZulipMessage.mockReset();
    state.addZulipReaction.mockReset();
    state.removeZulipReaction.mockReset();
    state.sendMessageZulip.mockReset();
    state.sendMessageZulip.mockResolvedValue({ messageId: "outbound-1", channelId: "debbie" });
    downloadZulipUploadMock.mockClear();
    extractZulipUploadUrlsMock.mockClear();
    registerZulipQueueMock.mockClear();
    getZulipEventsWithRetryMock.mockClear();
    deleteZulipQueueMock.mockClear();
    fetchZulipSubscriptionsMock.mockClear();
    fetchZulipStreamMock.mockClear();
    state.addZulipReaction.mockReset().mockResolvedValue(undefined);
    state.removeZulipReaction.mockReset().mockResolvedValue(undefined);
    typingCallbacksMock.mockClear();
  });

  it("wires typing idle cleanup into the reply dispatcher", async () => {
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1000) }],
      },
    ];

    await runMonitorOnce();

    const dispatcherCall = state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.dispatcherOptions;
    const typingCallbacks = typingCallbacksMock.mock.results[0]?.value;
    await dispatcherCall?.onReplyStart?.();
    expect(typingCallbacks?.onReplyStart).toHaveBeenCalledTimes(1);
    expect(dispatcherCall?.onIdle).toBe(typingCallbacks?.onIdle);
  });

  it("reports real lifecycle states and cancels an existing terminal hold on stop", async () => {
    state.autoAbort = false;
    state.account.config.reactions = {
      enabled: true,
      timing: {
        debounceMs: 0,
        stallSoftMs: 60_000,
        stallHardMs: 120_000,
        doneHoldMs: 40,
      },
    };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await dispatcherOptions.onReplyStart?.();
        await new Promise((resolve) => setTimeout(resolve, 1));
        await replyOptions.onToolStart?.({ name: "exec", phase: "start" });
        await new Promise((resolve) => setTimeout(resolve, 1));
        await replyOptions.onToolStart?.({ name: "exec", phase: "end" });
        await new Promise((resolve) => setTimeout(resolve, 1));
        await replyOptions.onCompactionStart?.();
        await new Promise((resolve) => setTimeout(resolve, 1));
        await replyOptions.onCompactionEnd?.();
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    );
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1098) }],
      },
    ];

    const monitorPromise = runMonitorOnce();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (state.addZulipReaction.mock.calls.some((call) => call[1].emojiName === "check")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    state.abortController?.abort();
    await monitorPromise;

    const addedNames = state.addZulipReaction.mock.calls.map((call) => call[1].emojiName);
    expect(addedNames).toEqual(expect.arrayContaining([
      "eyes",
      "brain",
      "computer",
      "compression",
      "check",
    ]));
    expect(state.removeZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1098", emojiName: "eyes" }),
    );
    expect(state.removeZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1098", emojiName: "check" }),
    );
    const reactionCallCount =
      state.addZulipReaction.mock.calls.length + state.removeZulipReaction.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(
      state.addZulipReaction.mock.calls.length + state.removeZulipReaction.mock.calls.length,
    ).toBe(reactionCallCount);
  });

  it("uses the terminal error state when reply dispatch throws", async () => {
    state.account.config.reactions = { enabled: true };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(
      new Error("synthetic dispatch failure"),
    );
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1097) }],
      },
    ];

    await runMonitorOnce();

    expect(
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).toHaveBeenCalledTimes(1);
    expect(state.addZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1097", emojiName: "cross_mark" }),
    );
  });

  it("uses the terminal error state when final delivery resolves as failed", async () => {
    state.account.config.reactions = { enabled: true, clearOnFinish: false };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      failedCounts: { final: 1 },
    });
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1095) }],
      },
    ];

    await runMonitorOnce();

    expect(
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).toHaveBeenCalledTimes(1);
    expect(state.addZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1095", emojiName: "cross_mark" }),
    );
    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1095", emojiName: "check" }),
    );
  });

  it("aborts active replies and clears reactions when the monitor stops", async () => {
    state.autoAbort = false;
    state.account.config.reactions = {
      enabled: true,
      timing: { doneHoldMs: 500 },
    };
    let dispatched!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions.abortSignal).toBe(state.abortController?.signal);
        await dispatcherOptions.onReplyStart?.();
        await replyOptions.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions.onCompactionStart?.();
        dispatched();
        await new Promise<void>((resolve) => {
          replyOptions.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {};
      },
    );
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1094) }],
      },
    ];

    const monitorPromise = runMonitorOnce();
    await dispatchStarted;
    state.abortController?.abort();
    await monitorPromise;

    expect(state.removeZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1094", emojiName: "eyes" }),
    );
    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1094", emojiName: "check" }),
    );
    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1094", emojiName: "cross_mark" }),
    );
  });

  it("retries a transient placeholder deletion failure during ordinary abort", async () => {
    state.autoAbort = false;
    state.account.config.thinkingPlaceholder = { enabled: true };
    state.deleteZulipMessage
      .mockRejectedValueOnce(new Error("transient delete failure"))
      .mockResolvedValueOnce(undefined);
    let dispatchStarted!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ replyOptions }) => {
        dispatchStarted();
        await new Promise<void>((resolve) => {
          replyOptions.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {};
      },
    );
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: makeChannelMessage(1199) }],
    }];

    const monitorPromise = runMonitorOnce();
    await dispatched;
    state.abortController?.abort();
    await monitorPromise;

    expect(state.deleteZulipMessage).toHaveBeenCalledTimes(2);
    expect(state.deleteZulipMessage).toHaveBeenNthCalledWith(1, state.client, {
      messageId: "outbound-1",
    });
    expect(state.deleteZulipMessage).toHaveBeenNthCalledWith(2, state.client, {
      messageId: "outbound-1",
    });
  });

  it("clears active reactions through the gateway-stop hook", async () => {
    state.autoAbort = false;
    state.account.config.reactions = { enabled: true, clearOnFinish: false };
    let dispatched!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    let removalStarted!: () => void;
    const removalAttempted = new Promise<void>((resolve) => {
      removalStarted = resolve;
    });
    let releaseRemoval!: () => void;
    const removalAllowed = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    state.removeZulipReaction.mockImplementation(async (_client, reaction) => {
      if (reaction.messageId === "1092" && reaction.emojiName === "eyes") {
        removalStarted();
        await removalAllowed;
      }
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await dispatcherOptions.onReplyStart?.();
        await replyOptions.onToolStart?.({ name: "exec", phase: "start" });
        dispatched();
        await new Promise<void>((resolve) => {
          replyOptions.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {};
      },
    );
    state.pollResponses = [
      {
        result: "success",
        events: [
          { id: 1, type: "message", message: makeChannelMessage(1092) },
          { id: 2, type: "message", message: makeChannelMessage(1093) },
        ],
      },
    ];

    const monitorPromise = runMonitorOnce();
    await dispatchStarted;
    const {
      clearActiveZulipMonitorReactionLifecycles,
      registerZulipMonitorReactionHooks,
      startZulipMonitorReactionLifecycles,
    } = await import("./monitor.js");
    const on = vi.fn();
    registerZulipMonitorReactionHooks({ on } as never);
    expect(on).toHaveBeenCalledWith("gateway_start", startZulipMonitorReactionLifecycles);
    expect(on).toHaveBeenCalledWith(
      "gateway_stop",
      clearActiveZulipMonitorReactionLifecycles,
    );

    const gatewayCleanup = clearActiveZulipMonitorReactionLifecycles();
    await removalAttempted;
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseRemoval();
    await gatewayCleanup;

    expect(state.removeZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1092", emojiName: "eyes" }),
    );
    expect(
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).toHaveBeenCalledTimes(1);
    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1093" }),
    );
    state.abortController?.abort();
    await monitorPromise;
    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1092", emojiName: "check" }),
    );
    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1092", emojiName: "cross_mark" }),
    );
  });

  it("bounds persistent placeholder deletion failure during gateway stop", async () => {
    state.autoAbort = false;
    state.account.config.thinkingPlaceholder = { enabled: true };
    let creationStarted!: () => void;
    const creating = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    let allowCreation!: () => void;
    const creationAllowed = new Promise<void>((resolve) => {
      allowCreation = resolve;
    });
    state.sendMessageZulip.mockImplementationOnce(async () => {
      creationStarted();
      await creationAllowed;
      return { messageId: "pending-placeholder", channelId: "debbie" };
    });
    state.deleteZulipMessage.mockRejectedValue(new Error("permission denied"));
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async () => {
      throw new Error("dispatch must not start during gateway shutdown");
    });
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: makeChannelMessage(1099) }],
    }];

    const runtimeError = vi.fn();
    const monitorPromise = runMonitorOnce(new AbortController(), {
      log: vi.fn(),
      error: runtimeError,
      exit: vi.fn(),
    });
    await creating;
    const { clearActiveZulipMonitorReactionLifecycles } = await import("./monitor.js");
    let cleanupSettled = false;
    const cleanup = clearActiveZulipMonitorReactionLifecycles().then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(state.deleteZulipMessage).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    allowCreation();
    await expect(Promise.race([
      cleanup.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ])).resolves.toBe("settled");

    expect(state.deleteZulipMessage).toHaveBeenCalledTimes(3);
    expect(state.deleteZulipMessage).toHaveBeenNthCalledWith(1, state.client, {
      messageId: "pending-placeholder",
    });
    expect(runtimeError).toHaveBeenCalledWith(
      "zulip: thinking placeholder cleanup failed after 3 attempts",
    );
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    state.abortController?.abort();
    await monitorPromise;
  });

  it("does not add a terminal reaction when abort races subagent settlement", async () => {
    state.autoAbort = false;
    state.account.config.reactions = { enabled: true, clearOnFinish: false };
    let subagentHideStarted!: () => void;
    const hideStarted = new Promise<void>((resolve) => {
      subagentHideStarted = resolve;
    });
    let releaseSubagentHide!: () => void;
    const allowHide = new Promise<void>((resolve) => {
      releaseSubagentHide = resolve;
    });
    state.removeZulipReaction.mockImplementation(async (_client, reaction) => {
      if (reaction.emojiName === "robot") {
        subagentHideStarted();
        await allowHide;
      }
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ ctx }) => {
        const { handleZulipSubagentEnded, handleZulipSubagentSpawned } =
          await import("./subagent-reactions.js");
        const requesterSessionKey = String(ctx.SessionKey);
        await handleZulipSubagentSpawned(
          {
            runId: "finish-race-run",
            childSessionKey: "finish-race-child",
            requester: { channel: "zulip" },
          },
          { requesterSessionKey },
        );
        void handleZulipSubagentEnded(
          { runId: "finish-race-run", targetSessionKey: "finish-race-child" },
          { childSessionKey: "finish-race-child" },
        );
        return {};
      },
    );
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1093) }],
      },
    ];

    const monitorPromise = runMonitorOnce();
    await hideStarted;
    state.abortController?.abort();
    releaseSubagentHide();
    await monitorPromise;

    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1093", emojiName: "check" }),
    );
    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1093", emojiName: "cross_mark" }),
    );
  });

  it("stops promptly when aborted during retry backoff", async () => {
    state.autoAbort = false;
    getZulipEventsWithRetryMock.mockRejectedValueOnce(
      Object.assign(new Error("synthetic rate limit"), { retryAfterMs: 120_000 }),
    );
    const controller = new AbortController();
    const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
    let abortListenerRegistrations = 0;
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(
      (type, listener, options) => {
        abortListenerRegistrations += 1;
        if (abortListenerRegistrations === 2) {
          controller.abort();
        }
        originalAddEventListener(type, listener, options);
      },
    );

    const monitorPromise = runMonitorOnce(controller);

    await expect(
      Promise.race([
        monitorPromise.then(() => "stopped"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 250)),
      ]),
    ).resolves.toBe("stopped");
  });

  it("does not start the next event when aborted during batch pacing", async () => {
    state.autoAbort = false;
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async () => {
        state.abortController?.abort();
        return {};
      },
    );
    state.pollResponses = [
      {
        result: "success",
        events: [
          { id: 1, type: "message", message: makeChannelMessage(1092) },
          { id: 2, type: "message", message: makeChannelMessage(1091) },
        ],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("reports status adapter failures and continues reply dispatch", async () => {
    state.account.config.reactions = { enabled: true };
    state.addZulipReaction.mockRejectedValueOnce(new Error("reaction unavailable"));
    const runtimeError = vi.fn();
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1096) }],
      },
    ];

    await runMonitorOnce(new AbortController(), {
      log: vi.fn(),
      error: runtimeError,
      exit: vi.fn(),
    });

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("zulip: status reaction update failed: Error: reaction unavailable"),
    );
    expect(state.addZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "1096", emojiName: "eyes" }),
    );
  });

  it("replaces a stream thinking placeholder with the first text chunk", async () => {
    state.account.config.thinkingPlaceholder = { enabled: true, text: "Thinking…" };
    state.core.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["first chunk", "second chunk"]);
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "reply text" });
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(4001) }] }];

    await runMonitorOnce();

    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(1, "stream:debbie:zulip-plugin-pr", "Thinking…", expect.objectContaining({ topic: "zulip-plugin-pr" }));
    expect(state.editZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1", content: "first chunk" });
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(2, "stream:debbie:zulip-plugin-pr", "second chunk", expect.any(Object));
    expect(state.deleteZulipMessage).not.toHaveBeenCalled();
  });

  it("removes a DM thinking placeholder after a silent turn", async () => {
    state.account.config.thinkingPlaceholder = { enabled: true };
    const statusSink = vi.fn();
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makePrivateMessage(4002) }] }];

    await runMonitorOnce(new AbortController(), undefined, { statusSink });

    expect(state.sendMessageZulip).toHaveBeenCalledWith("user:user8@zlp.pubnerd.app", "Thinking…", expect.any(Object));
    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1" });
    expect(state.editZulipMessage).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lastOutboundAt: expect.any(Number) }));
  });

  it("adds the configured success reaction after a silent turn", async () => {
    state.account.config.reactions = {
      enabled: true,
      clearOnFinish: false,
      onStart: "",
      onSuccess: "check",
    };
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(4010) }] }];

    await runMonitorOnce();

    expect(state.addZulipReaction).toHaveBeenCalledExactlyOnceWith(state.client, {
      messageId: "4010",
      emojiName: "check",
    });
  });

  it("removes the placeholder before a presentation-only reply", async () => {
    state.account.config.thinkingPlaceholder = { enabled: true };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({
        presentation: { blocks: [{ type: "buttons", buttons: [{ label: "Confirm", action: "confirm" }] }] },
      });
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(4003) }] }];

    await runMonitorOnce();

    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1" });
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(2, "stream:debbie:zulip-plugin-pr", "", expect.objectContaining({ presentation: expect.any(Object) }));
  });

  it("removes the placeholder before a media-only reply", async () => {
    state.account.config.thinkingPlaceholder = { enabled: true };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ mediaUrl: "https://example.com/result.png" });
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makePrivateMessage(4006) }] }];

    await runMonitorOnce();

    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1" });
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(2, "user:user8@zlp.pubnerd.app", "", expect.objectContaining({ mediaUrl: "https://example.com/result.png" }));
  });

  it("converts the placeholder to an error when dispatch fails before delivery", async () => {
    state.account.config.thinkingPlaceholder = { enabled: true, errorText: "Turn failed." };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("model failed"));
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(4004) }] }];

    await runMonitorOnce();

    expect(state.editZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1", content: "Turn failed." });
    expect(state.deleteZulipMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "media",
      payload: { mediaUrl: "https://example.com/result.png" },
      editFails: false,
      messageId: 4011,
    },
    {
      name: "presentation-only",
      payload: {
        presentation: { blocks: [{ type: "buttons", buttons: [{ label: "Confirm", action: "confirm" }] }] },
      },
      editFails: false,
      messageId: 4012,
    },
    {
      name: "topic-change",
      payload: { text: "[[zulip_topic: another-topic]] actual reply" },
      editFails: false,
      messageId: 4013,
    },
    {
      name: "text replacement fallback",
      payload: { text: "actual reply" },
      editFails: true,
      messageId: 4014,
    },
  ])("sends configured error text when a $name send fails after placeholder cleanup", async ({ payload, editFails, messageId }) => {
    state.account.config.thinkingPlaceholder = { enabled: true, errorText: "Turn failed." };
    state.account.config.reactions = {
      enabled: true,
      clearOnFinish: false,
      onStart: "",
      onSuccess: "check",
      onError: "warning",
    };
    if (editFails) {
      state.editZulipMessage.mockRejectedValueOnce(new Error("edit denied"));
    }
    state.sendMessageZulip
      .mockResolvedValueOnce({ messageId: "placeholder-1", channelId: "debbie" })
      .mockRejectedValueOnce(new Error("reply send failed"))
      .mockResolvedValueOnce({ messageId: "error-1", channelId: "debbie" });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver(payload);
      } catch (err) {
        dispatcherOptions.onError(err);
      }
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(messageId) }] }];

    await runMonitorOnce();

    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "placeholder-1" });
    expect(state.sendMessageZulip).toHaveBeenCalledTimes(3);
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(
      3,
      "stream:debbie:zulip-plugin-pr",
      "Turn failed.",
      expect.objectContaining({ topic: "zulip-plugin-pr" }),
    );
    expect(state.addZulipReaction).toHaveBeenCalledExactlyOnceWith(state.client, {
      messageId: String(messageId),
      emojiName: "warning",
    });
    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ emojiName: "check" }),
    );
  });

  it.each([
    {
      name: "text chunk",
      payload: { text: "reply text", channelData: { test: true } },
      chunks: ["first chunk", "second chunk"],
      expectedFirstReply: "first chunk",
      expectedFirstReplyOptions: { channelData: { test: true } },
      messageId: 4015,
    },
    {
      name: "media item",
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/first.png", "https://example.com/second.png"],
      },
      chunks: undefined,
      expectedFirstReply: "caption",
      expectedFirstReplyOptions: { mediaUrl: "https://example.com/first.png" },
      messageId: 4016,
    },
  ])("does not append error text after partial $name delivery", async ({
    payload,
    chunks,
    expectedFirstReply,
    expectedFirstReplyOptions,
    messageId,
  }) => {
    state.account.config.thinkingPlaceholder = { enabled: true, errorText: "Turn failed." };
    if (chunks) {
      state.core.channel.text.chunkMarkdownTextWithMode.mockReturnValue(chunks);
    }
    state.sendMessageZulip
      .mockResolvedValueOnce({ messageId: "placeholder-1", channelId: "debbie" })
      .mockResolvedValueOnce({ messageId: "reply-1", channelId: "debbie" })
      .mockRejectedValueOnce(new Error("later reply send failed"));
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver(payload);
      } catch (err) {
        dispatcherOptions.onError(err);
      }
    });
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: makeChannelMessage(messageId) }],
    }];

    await runMonitorOnce();

    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, {
      messageId: "placeholder-1",
    });
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(
      2,
      "stream:debbie:zulip-plugin-pr",
      expectedFirstReply,
      expect.objectContaining(expectedFirstReplyOptions),
    );
    expect(state.sendMessageZulip).toHaveBeenCalledTimes(3);
    expect(state.sendMessageZulip).not.toHaveBeenCalledWith(
      "stream:debbie:zulip-plugin-pr",
      "Turn failed.",
      expect.any(Object),
    );
  });

  it("removes the placeholder when the turn is cancelled", async () => {
    state.account.config.thinkingPlaceholder = { enabled: true };
    const cancelled = new Error("cancelled");
    cancelled.name = "AbortError";
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(cancelled);
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(4007) }] }];

    await runMonitorOnce();

    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1" });
    expect(state.editZulipMessage).not.toHaveBeenCalled();
  });

  it("continues normally when placeholder creation fails", async () => {
    state.account.config.thinkingPlaceholder = { enabled: true };
    state.sendMessageZulip
      .mockRejectedValueOnce(new Error("placeholder rejected"))
      .mockResolvedValueOnce({ messageId: "reply-1", channelId: "debbie" });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "actual reply" });
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(4008) }] }];

    await runMonitorOnce();

    expect(state.sendMessageZulip).toHaveBeenCalledTimes(2);
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(2, "stream:debbie:zulip-plugin-pr", "actual reply", expect.any(Object));
    expect(state.editZulipMessage).not.toHaveBeenCalled();
    expect(state.deleteZulipMessage).not.toHaveBeenCalled();
  });

  it("falls back to a normal send when replacing the placeholder fails", async () => {
    state.account.config.thinkingPlaceholder = { enabled: true };
    state.editZulipMessage.mockRejectedValueOnce(new Error("edit denied"));
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "actual reply" });
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(4005) }] }];

    await runMonitorOnce();

    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1" });
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(2, "stream:debbie:zulip-plugin-pr", "actual reply", expect.any(Object));
  });

  it("forwards presentation and channel data only with the first text chunk", async () => {
    const { sendMessageZulip } = await import("./send.js");
    const sendMessageZulipMock = vi.mocked(sendMessageZulip);
    sendMessageZulipMock.mockClear();
    state.core.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["first chunk", "second chunk"]);
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({
        text: "reply text",
        presentation: { blocks: [{ type: "buttons", buttons: [{ label: "Confirm", action: "confirm" }] }] },
        channelData: { zulip: { widgetContent: { widget_type: "zform" } } },
      });
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(1009) }] }];

    await runMonitorOnce();

    expect(sendMessageZulipMock).toHaveBeenCalledTimes(2);
    expect(sendMessageZulipMock).toHaveBeenNthCalledWith(1, "stream:debbie:zulip-plugin-pr", "first chunk", expect.objectContaining({
      presentation: expect.any(Object),
      channelData: { zulip: { widgetContent: { widget_type: "zform" } } },
    }));
    expect(sendMessageZulipMock).toHaveBeenNthCalledWith(2, "stream:debbie:zulip-plugin-pr", "second chunk", expect.objectContaining({
      presentation: undefined,
      channelData: undefined,
    }));
  });

  it("forwards presentation and channel data only with the first media send", async () => {
    const { sendMessageZulip } = await import("./send.js");
    const sendMessageZulipMock = vi.mocked(sendMessageZulip);
    sendMessageZulipMock.mockClear();
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({
        text: "caption",
        mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
        presentation: { blocks: [{ type: "buttons", buttons: [{ label: "Confirm", action: "confirm" }] }] },
        channelData: { zulip: { widgetContent: { widget_type: "zform" } } },
      });
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(1010) }] }];

    await runMonitorOnce();

    expect(sendMessageZulipMock).toHaveBeenCalledTimes(2);
    expect(sendMessageZulipMock).toHaveBeenNthCalledWith(1, "stream:debbie:zulip-plugin-pr", "caption", expect.objectContaining({
      mediaUrl: "https://example.com/one.png",
      presentation: expect.any(Object),
      channelData: { zulip: { widgetContent: { widget_type: "zform" } } },
    }));
    expect(sendMessageZulipMock).toHaveBeenNthCalledWith(2, "stream:debbie:zulip-plugin-pr", "", expect.objectContaining({
      mediaUrl: "https://example.com/two.png",
      presentation: undefined,
      channelData: undefined,
    }));
  });

  it("sends presentation-only replies instead of treating them as delivered without an outbound send", async () => {
    const { sendMessageZulip } = await import("./send.js");
    const sendMessageZulipMock = vi.mocked(sendMessageZulip);
    sendMessageZulipMock.mockClear();
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({
        presentation: { blocks: [{ type: "buttons", buttons: [{ label: "Confirm", action: "confirm" }] }] },
      });
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(1011) }] }];

    await runMonitorOnce();

    expect(sendMessageZulipMock).toHaveBeenCalledTimes(1);
    expect(sendMessageZulipMock).toHaveBeenCalledWith("stream:debbie:zulip-plugin-pr", "", expect.objectContaining({
      presentation: expect.any(Object),
    }));
  });

  it("surfaces a send failure for channel-data-only replies", async () => {
    const { sendMessageZulip } = await import("./send.js");
    const sendMessageZulipMock = vi.mocked(sendMessageZulip);
    sendMessageZulipMock.mockClear();
    sendMessageZulipMock.mockRejectedValueOnce(new Error("Zulip message is empty"));
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await expect(dispatcherOptions.deliver({
        channelData: { execApproval: { approvalId: "approval-1" } },
      })).rejects.toThrow("Zulip message is empty");
    });
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(1012) }] }];

    await runMonitorOnce();

    expect(sendMessageZulipMock).toHaveBeenCalledTimes(1);
    expect(sendMessageZulipMock).toHaveBeenCalledWith("stream:debbie:zulip-plugin-pr", "", expect.objectContaining({
      channelData: { execApproval: { approvalId: "approval-1" } },
    }));
  });

  it("processes ordinary inbound messages without enqueueing a synthetic system event", async () => {
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1001) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(state.core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("surfaces private invite-only stream metadata while keeping ChatType channel", async () => {
    state.streamSubscriptions = [
      {
        stream_id: 4,
        name: "debbie",
        invite_only: true,
        is_web_public: false,
        history_public_to_subscribers: false,
        subscribers: [123, 999, 1000],
      },
    ];
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1006) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveReturnedWith(
      expect.objectContaining({
        ChatType: "channel",
        ChannelPrivacy: "private",
        IsPrivateChannel: true,
        InviteOnly: true,
        IsWebPublic: false,
        HistoryPublicToSubscribers: false,
        SubscriberCount: 3,
        StreamId: "4",
      }),
    );
    expect(fetchZulipSubscriptionsMock).toHaveBeenCalledWith(state.client, {
      includeAllPublic: true,
      includeSubscribers: true,
    });
    expect(fetchZulipStreamMock).not.toHaveBeenCalled();
  });

  it("surfaces public stream metadata from cached subscriptions", async () => {
    state.streamSubscriptions = [
      {
        stream_id: 4,
        name: "debbie",
        invite_only: false,
        is_web_public: true,
        history_public_to_subscribers: true,
        subscribers: [10, 20, 30, 40],
      },
    ];
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1007) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveReturnedWith(
      expect.objectContaining({
        ChatType: "channel",
        ChannelPrivacy: "public",
        IsPrivateChannel: false,
        InviteOnly: false,
        IsWebPublic: true,
        HistoryPublicToSubscribers: true,
        SubscriberCount: 4,
        StreamId: "4",
      }),
    );
  });

  it("falls back to unknown stream privacy when metadata lookup fails", async () => {
    state.streamSubscriptions = [];
    state.streamLookups.set("404", new Error("metadata unavailable"));
    state.pollResponses = [
      {
        result: "success",
        events: [
          {
            id: 1,
            type: "message",
            message: {
              ...makeChannelMessage(1008),
              stream_id: 404,
              display_recipient: "missing-private",
            },
          },
        ],
      },
    ];

    await runMonitorOnce();

    expect(fetchZulipStreamMock).toHaveBeenCalledWith(state.client, "404");
    expect(state.core.channel.inbound.buildContext).toHaveReturnedWith(
      expect.objectContaining({
        ChatType: "channel",
        ChannelPrivacy: "unknown",
        IsPrivateChannel: undefined,
        StreamId: "404",
      }),
    );
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("falls back to temp-file media storage with a sanitized filename when runtime saveMediaBuffer is unavailable", async () => {
    state.extractedUploadUrls = ["https://zlp.pubnerd.app/user_uploads/2/aa/report.pdf"];
    state.downloadedUploads = [
      { buffer: Buffer.from("synthetic pdf"), contentType: "application/pdf", filename: "../evil/name.pdf" },
    ];
    state.core.channel.media = {};
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1005) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [expect.objectContaining({
          path: expect.stringMatching(/^\/tmp\/zulip-upload-[^/]+\/evil_name\.pdf$/),
          contentType: "application/pdf",
        })],
      }),
    );
  });

  it("downloads Zulip uploads and surfaces saved local media paths to the agent", async () => {
    state.extractedUploadUrls = [
      "https://zlp.pubnerd.app/user_uploads/2/aa/song.mp3",
      "https://zlp.pubnerd.app/user_uploads/2/bb/image.png",
      "https://zlp.pubnerd.app/user_uploads/2/cc/report.pdf",
    ];
    state.downloadedUploads = [
      { buffer: Buffer.from("synthetic mp3"), contentType: "audio/mpeg", filename: "song.mp3" },
      { buffer: Buffer.from("synthetic png"), contentType: "image/png", filename: "image.png" },
      { buffer: Buffer.from("synthetic pdf"), contentType: "application/pdf", filename: "report.pdf" },
    ];
    state.core.channel.media.saveMediaBuffer.mockImplementation(
      async (_buffer: Buffer, contentType: string, _direction: string, _maxBytes: number, filename: string) => ({
        path: `/managed/${filename}`,
        contentType,
      }),
    );
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1004) }],
      },
    ];

    await runMonitorOnce();

    expect(downloadZulipUploadMock).toHaveBeenCalledWith(
      "https://zlp.pubnerd.app/user_uploads/2/aa/song.mp3",
      "https://zlp.pubnerd.app",
      "fake-auth",
      5 * 1024 * 1024,
    );
    expect(state.core.channel.media.saveMediaBuffer).toHaveBeenCalledTimes(3);
    // The stable SDK projects canonical input facts into its older dispatch context.
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx).toMatchObject({
      MediaPaths: ["/managed/song.mp3", "/managed/image.png", "/managed/report.pdf"],
      MediaTypes: ["audio/mpeg", "image/png", "application/pdf"],
    });
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [
          expect.objectContaining({ path: "/managed/song.mp3", contentType: "audio/mpeg" }),
          expect.objectContaining({ path: "/managed/image.png", contentType: "image/png" }),
          expect.objectContaining({ path: "/managed/report.pdf", contentType: "application/pdf" }),
        ],
      }),
    );
  });

  it("stores last-route delivery context for stream-topic messages", async () => {
    state.core.config.session = { store: "/configured/{agentId}/sessions.json" };
    state.core.agent.session.resolveStorePath.mockReturnValue("/resolved/debbie/session-store");
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1002) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.agent.session.resolveStorePath).toHaveBeenCalledExactlyOnceWith(
      "/configured/{agentId}/sessions.json",
      { agentId: "debbie" },
    );
    expect(state.core.channel.session.updateLastRoute).toHaveBeenCalledWith({
      storePath: "/resolved/debbie/session-store",
      sessionKey: "agent:debbie:main",
      deliveryContext: {
        channel: "zulip",
        to: "stream:debbie:zulip-plugin-pr",
        accountId: "default",
      },
    });
  });

  it("for private messages, stores user:<sender_email> in context and last-route when sender_email exists", async () => {
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makePrivateMessage(1100) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveReturnedWith(
      expect.objectContaining({
        To: "user:user8@zlp.pubnerd.app",
        OriginatingTo: "user:user8@zlp.pubnerd.app",
      }),
    );
    expect(state.core.channel.session.updateLastRoute).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:debbie:main",
      deliveryContext: {
        channel: "zulip",
        to: "user:user8@zlp.pubnerd.app",
        accountId: "default",
      },
    });
  });

  it("for private messages, falls back to sender_id when sender_email is missing", async () => {
    state.pollResponses = [
      {
        result: "success",
        events: [
          {
            id: 1,
            type: "message",
            message: {
              ...makePrivateMessage(1101, ""),
              sender_email: null,
            },
          },
        ],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveReturnedWith(
      expect.objectContaining({
        To: "user:123",
        OriginatingTo: "user:123",
      }),
    );
    expect(state.core.channel.session.updateLastRoute).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:debbie:main",
      deliveryContext: {
        channel: "zulip",
        to: "user:123",
        accountId: "default",
      },
    });
  });

  it("drops stream messages outside the configured global topic filter", async () => {
    state.account.config = {
      ...state.account.config,
      topics: ["allowed-topic"],
    };
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1200) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("processes stream messages inside configured topic filters with case and whitespace normalization", async () => {
    state.account.config = {
      ...state.account.config,
      topics: ["  ZULIP-PLUGIN-PR  "],
      streamTopics: { "  DEBBIE  ": ["  Zulip-Plugin-PR  "] },
    };
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1201) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("drops stream messages outside a configured stream-scoped topic filter", async () => {
    state.account.config = {
      ...state.account.config,
      topics: ["*"],
      streamTopics: { "4": ["another-topic"] },
    };
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1202) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("treats empty and wildcard stream-scoped topic filters as unrestricted", async () => {
    state.account.config = {
      ...state.account.config,
      streamTopics: {
        debbie: [],
        "4": ["*"],
      },
    };
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1203) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("drops disabled stream overrides before durable acceptance or observable inbound work", async () => {
    enableDurableInboundJournal();
    state.account.config = {
      ...state.account.config,
      streams: ["*"],
      streamOverrides: { debbie: { enabled: false } },
      reactions: { enabled: true },
    };
    state.extractedUploadUrls = ["https://zlp.pubnerd.app/user_uploads/2/aa/report.pdf"];
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: makeChannelMessage(1210) }],
    }];

    await runMonitorOnce();

    expect(extractZulipUploadUrlsMock).not.toHaveBeenCalled();
    expect(downloadZulipUploadMock).not.toHaveBeenCalled();
    expect(state.addZulipReaction).not.toHaveBeenCalled();
    expect(typingCallbacksMock).not.toHaveBeenCalled();
    expect(state.core.channel.activity.record).not.toHaveBeenCalled();
    expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    for (const store of state.durableStores.values()) {
      await expect(store.entries()).resolves.toEqual([]);
    }
  });

  it("drops mention-gated stream messages before durable acceptance or attachment work", async () => {
    enableDurableInboundJournal();
    state.account.requireMention = false;
    state.account.config = {
      ...state.account.config,
      streamOverrides: { "4": { requireMention: true } },
      reactions: { enabled: true },
    };
    state.core.channel.groups.resolveRequireMention.mockImplementation(
      ({ requireMentionOverride }: { requireMentionOverride?: boolean }) =>
        requireMentionOverride ?? false,
    );
    state.extractedUploadUrls = ["https://zlp.pubnerd.app/user_uploads/2/aa/report.pdf"];
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: makeChannelMessage(1213) }],
    }];

    await runMonitorOnce();

    expect(extractZulipUploadUrlsMock).not.toHaveBeenCalled();
    expect(downloadZulipUploadMock).not.toHaveBeenCalled();
    expect(state.core.channel.media.saveMediaBuffer).not.toHaveBeenCalled();
    expect(state.addZulipReaction).not.toHaveBeenCalled();
    expect(typingCallbacksMock).not.toHaveBeenCalled();
    expect(state.core.channel.activity.record).not.toHaveBeenCalled();
    expect(state.core.channel.routing.resolveAgentRoute).not.toHaveBeenCalled();
    expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(state.core.channel.session.updateLastRoute).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    for (const store of state.durableStores.values()) {
      await expect(store.entries()).resolves.toEqual([]);
    }
  });

  it.each([
    { label: "explicitly disabled", requireMention: false, expectedDispatches: 1, messageId: 3101 },
    { label: "explicitly enabled", requireMention: true, expectedDispatches: 0, messageId: 3102 },
    { label: "inherited", requireMention: undefined, expectedDispatches: 0, messageId: 3103 },
  ])(
    "applies onchar gating when per-stream mention policy is $label",
    async ({ requireMention, expectedDispatches, messageId }) => {
      state.account.chatmode = "onchar";
      state.account.config = {
        ...state.account.config,
        streamOverrides: {
          debbie: requireMention === undefined ? {} : { requireMention },
        },
      };
      state.core.channel.groups.resolveRequireMention.mockImplementation(
        ({ requireMentionOverride }: { requireMentionOverride?: boolean }) =>
          requireMentionOverride ?? false,
      );
      state.pollResponses = [{
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(messageId) }],
      }];

      await runMonitorOnce();

      expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
        .toHaveBeenCalledTimes(expectedDispatches);
    },
  );

  it("preserves onchar gating for DMs and its authorized control-command bypass", async () => {
    state.account.chatmode = "onchar";
    state.account.config = {
      ...state.account.config,
      dmPolicy: "pairing",
    };
    state.pairingAllowFrom = ["user8@zlp.pubnerd.app"];
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: makePrivateMessage(3104) }],
    }];

    await runMonitorOnce();

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    state.core.channel.commands.shouldHandleTextCommands.mockReturnValue(true);
    state.core.channel.text.hasControlCommand.mockReturnValue(true);
    state.pollResponses = [{
      result: "success",
      events: [{
        id: 2,
        type: "message",
        message: { ...makeChannelMessage(3105), content: "/status" },
      }],
    }];

    await runMonitorOnce();

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("broadens initial and replacement queues when overrides can enable other streams", async () => {
    state.account.streams = ["debbie"];
    state.account.config = {
      ...state.account.config,
      streams: ["debbie"],
      streamOverrides: { random: { enabled: true } },
    };
    state.pollResponses = [
      { result: "error", code: "BAD_EVENT_QUEUE_ID", msg: "expired" },
      { result: "success", events: [] },
    ];

    await runMonitorOnce();

    expect(registerZulipQueueMock).toHaveBeenCalledTimes(2);
    for (const call of registerZulipQueueMock.mock.calls) {
      expect(call[1]).toEqual({ eventTypes: ["message"], streams: ["*"] });
    }
  });

  it("keeps a narrow queue when an enabled override is already covered by legacy streams", async () => {
    state.account.streams = ["general"];
    state.account.config = {
      ...state.account.config,
      streams: ["general"],
      streamOverrides: { GENERAL: { enabled: true } },
    };

    await runMonitorOnce();

    expect(registerZulipQueueMock).toHaveBeenCalledWith(
      state.client,
      { eventTypes: ["message"], streams: ["general"] },
    );
  });

  it("lets an id override win over a normalized name override for mention and topics", async () => {
    state.account.requireMention = true;
    state.account.config = {
      ...state.account.config,
      streams: ["other"],
      topics: ["blocked-by-account-default"],
      streamOverrides: {
        " DEBBIE ": { enabled: true, requireMention: true, allowedTopics: ["wrong-topic"] },
        "4": { requireMention: false, allowedTopics: ["zulip-plugin-pr"] },
      },
    };
    state.core.channel.groups.resolveRequireMention.mockImplementation(
      ({ requireMentionOverride }: { requireMentionOverride?: boolean }) =>
        requireMentionOverride ?? true,
    );
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: makeChannelMessage(1211) }],
    }];

    await runMonitorOnce();

    expect(state.core.channel.groups.resolveRequireMention).toHaveBeenCalledWith(
      expect.objectContaining({ requireMentionOverride: false }),
    );
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("uses the event's authoritative stream name after a cached stream rename", async () => {
    state.streamSubscriptions = [{
      stream_id: 4,
      name: "old-name",
      invite_only: false,
    }];
    state.account.config = {
      ...state.account.config,
      streamOverrides: {
        "old-name": { enabled: false },
        "new-name": { enabled: true },
      },
    };
    state.pollResponses = [{
      result: "success",
      events: [{
        id: 1,
        type: "message",
        message: { ...makeChannelMessage(1212), display_recipient: "new-name" },
      }],
    }];

    await runMonitorOnce();

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("retains the last good stream metadata snapshot when a later seed fails", async () => {
    state.streamSubscriptions = [{
      stream_id: 4,
      name: "retained-name",
      invite_only: false,
    }];
    await runMonitorOnce();

    fetchZulipSubscriptionsMock.mockRejectedValueOnce(new Error("temporary subscription failure"));
    state.account.streams = ["retained-name"];
    state.account.config = {
      ...state.account.config,
      streams: ["retained-name"],
    };
    state.pollResponses = [{
      result: "success",
      events: [{
        id: 1,
        type: "message",
        message: { ...makeChannelMessage(1216), display_recipient: null },
      }],
    }];

    await runMonitorOnce();

    expect(fetchZulipStreamMock).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "the fresh lookup fails",
      lookup: new Error("temporary stream lookup failure"),
    },
    {
      label: "the fresh lookup has a blank name",
      lookup: { id: 4, name: "   ", invite_only: false },
    },
  ])("keeps replay pending with stale cached metadata when $label", async ({ lookup }) => {
    state.streamSubscriptions = [{ stream_id: 4, name: "old-name", invite_only: false }];
    await runMonitorOnce();

    enableDurableInboundJournal();
    fetchZulipSubscriptionsMock.mockRejectedValueOnce(new Error("temporary subscription failure"));
    state.streamLookups.set("4", lookup);
    state.account.streams = ["old-name"];
    state.account.config = {
      ...state.account.config,
      streams: ["old-name"],
    };
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(1219);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    await journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: Date.now(),
    });

    await runMonitorOnce();

    await expect(journal.pending()).resolves.toEqual([
      expect.objectContaining({
        id: durableId,
        lastError: "Zulip stream metadata unavailable during durable replay",
      }),
    ]);
    expect(fetchZulipStreamMock).toHaveBeenCalledWith(state.client, "4");
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("uses a fresh renamed stream lookup for durable replay policy", async () => {
    state.streamSubscriptions = [{ stream_id: 4, name: "old-name", invite_only: false }];
    await runMonitorOnce();

    enableDurableInboundJournal();
    fetchZulipSubscriptionsMock.mockRejectedValueOnce(new Error("temporary subscription failure"));
    state.streamLookups.set("4", { id: 4, name: "new-name", invite_only: false });
    state.account.streams = ["new-name"];
    state.account.config = {
      ...state.account.config,
      streams: ["new-name"],
      streamOverrides: {
        "old-name": { enabled: false },
        "new-name": { enabled: true },
      },
    };
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(1220);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    await journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: Date.now(),
    });

    await runMonitorOnce();

    await expect(journal.pending()).resolves.toEqual([]);
    expect(fetchZulipStreamMock).toHaveBeenCalledWith(state.client, "4");
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("durably retries a pairing ingress failure without journaling known policy drops", async () => {
    enableDurableInboundJournal();
    state.account.config = {
      ...state.account.config,
      dmPolicy: "pairing",
      streams: ["*"],
      streamOverrides: { debbie: { enabled: false } },
    };
    state.pairingUpsertError = new Error("synthetic pairing persistence failure");
    const filteredMessage = makeChannelMessage(1217);
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: filteredMessage }],
    }];

    await runMonitorOnce();

    for (const store of state.durableStores.values()) {
      await expect(store.entries()).resolves.toEqual([]);
    }

    state.account.config.streamOverrides = { debbie: { enabled: true } };
    const message = makePrivateMessage(1218);
    state.pollResponses = [{
      result: "success",
      events: [{ id: 2, type: "message", message }],
    }];
    await runMonitorOnce();

    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
    } = await import("./durable-receive.js");
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    await expect(journal.pending()).resolves.toEqual([
      expect.objectContaining({
        id: durableId,
        lastError: "Error: synthetic pairing persistence failure",
      }),
    ]);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    state.pairingUpsertError = undefined;
    await runMonitorOnce();

    await expect(journal.pending()).resolves.toEqual([]);
    expect(state.upsertPairingRequest).toHaveBeenCalledTimes(2);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("keeps a legacy-allowlisted replay pending when authoritative stream metadata is unavailable", async () => {
    enableDurableInboundJournal();
    state.streamSubscriptions = [];
    state.streamLookups.set("4", new Error("stream metadata unavailable"));
    state.account.config = {
      ...state.account.config,
      streams: ["debbie"],
    };
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(1214);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    await journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: Date.now(),
    });

    await runMonitorOnce();

    const pending = await journal.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      lastError: "Zulip stream metadata unavailable during durable replay",
    });
    expect(fetchZulipStreamMock).toHaveBeenCalledWith(state.client, "4");
    expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("keeps a replay pending rather than bypassing a name disable when metadata is unavailable", async () => {
    enableDurableInboundJournal();
    state.streamSubscriptions = [];
    state.streamLookups.set("4", new Error("stream metadata unavailable"));
    state.account.config = {
      ...state.account.config,
      streams: ["*"],
      streamOverrides: { debbie: { enabled: false } },
    };
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(1215);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    await journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: Date.now(),
    });

    await runMonitorOnce();

    const pending = await journal.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      lastError: "Zulip stream metadata unavailable during durable replay",
    });
    expect(state.addZulipReaction).not.toHaveBeenCalled();
    expect(state.core.channel.activity.record).not.toHaveBeenCalled();
    expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("ignores duplicate inbound message ids on repeat processing", async () => {
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 2, type: "message", message: makeChannelMessage(2001) }],
      },
    ];
    await runMonitorOnce();

    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 3, type: "message", message: makeChannelMessage(2001) }],
      },
    ];
    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { paired: true, expectedDispatches: 1 },
    { paired: false, expectedDispatches: 0 },
  ])("preserves paired command authorization in open streams (paired=$paired)", async ({ paired, expectedDispatches }) => {
    state.account.config.dmPolicy = "pairing";
    state.pairingAllowFrom = paired ? ["user8@zlp.pubnerd.app"] : [];
    state.core.channel.commands.shouldHandleTextCommands.mockReturnValue(true);
    state.core.channel.text.hasControlCommand.mockReturnValue(true);
    state.pollResponses = [{ result: "success", events: [{
      id: 1, type: "message", message: { ...makeChannelMessage(paired ? 2201 : 2202), content: "/status" },
    }] }];
    await runMonitorOnce();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(expectedDispatches);
    if (paired) {
      expect(state.core.channel.inbound.buildContext).toHaveReturnedWith(expect.objectContaining({ CommandAuthorized: true }));
    }
  });

  it("records and completes durable inbound messages when plugin state is available", async () => {
    enableDurableInboundJournal();
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 2, type: "message", message: makeChannelMessage(2101) }],
      },
    ];

    await runMonitorOnce();

    const pendingStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".pending."),
    )?.[1];
    const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".completed."),
    )?.[1];
    await expect(pendingStore?.entries()).resolves.toEqual([]);
    const completedEntries = await completedStore?.entries();
    expect(completedEntries).toHaveLength(1);
    expect(completedEntries?.[0]?.value).toMatchObject({
      metadata: { queueEventId: 2 },
    });
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
  });

  it("commits edited placeholder error feedback and does not replay it", async () => {
    enableDurableInboundJournal();
    state.account.config.thinkingPlaceholder = { enabled: true, errorText: "Turn failed." };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockRejectedValueOnce(
      new Error("synthetic model failure"),
    );
    const statusSink = vi.fn();
    state.pollResponses = [{
      result: "success",
      events: [{ id: 6, type: "message", message: makeChannelMessage(2111) }],
    }];

    await runMonitorOnce(new AbortController(), undefined, { statusSink });

    const pendingStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".pending."),
    )?.[1];
    const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".completed."),
    )?.[1];
    await expect(pendingStore?.entries()).resolves.toEqual([]);
    await expect(completedStore?.entries()).resolves.toHaveLength(1);
    expect(state.editZulipMessage).toHaveBeenCalledExactlyOnceWith(state.client, {
      messageId: "outbound-1",
      content: "Turn failed.",
    });
    expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });

    await runMonitorOnce();

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(state.editZulipMessage).toHaveBeenCalledTimes(1);
  });

  it("commits fallback error feedback after placeholder cleanup and does not replay it", async () => {
    enableDurableInboundJournal();
    state.account.config.thinkingPlaceholder = { enabled: true, errorText: "Turn failed." };
    state.sendMessageZulip
      .mockResolvedValueOnce({ messageId: "placeholder-1", channelId: "debbie" })
      .mockRejectedValueOnce(new Error("reply send failed"))
      .mockResolvedValueOnce({ messageId: "error-1", channelId: "debbie" });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions }) => {
        try {
          await dispatcherOptions.deliver({
            presentation: {
              blocks: [{ type: "buttons", buttons: [{ label: "Confirm", action: "confirm" }] }],
            },
          });
        } catch (err) {
          dispatcherOptions.onError(err);
        }
      },
    );
    const statusSink = vi.fn();
    state.pollResponses = [{
      result: "success",
      events: [{ id: 7, type: "message", message: makeChannelMessage(2112) }],
    }];

    await runMonitorOnce(new AbortController(), undefined, { statusSink });

    const pendingStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".pending."),
    )?.[1];
    const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".completed."),
    )?.[1];
    await expect(pendingStore?.entries()).resolves.toEqual([]);
    await expect(completedStore?.entries()).resolves.toHaveLength(1);
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(
      3,
      "stream:debbie:zulip-plugin-pr",
      "Turn failed.",
      expect.objectContaining({ topic: "zulip-plugin-pr" }),
    );
    expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });

    await runMonitorOnce();

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(state.sendMessageZulip).toHaveBeenCalledTimes(3);
  });

  it.each([
    { failureMode: "dispatcher rejection", messageId: 2108 },
    { failureMode: "failed final result", messageId: 2109 },
  ])(
    "keeps durable inbound retryable after $failureMode with no visible delivery",
    async ({ failureMode, messageId }) => {
      enableDurableInboundJournal();
      state.account.config.reactions = { enabled: true, clearOnFinish: false };
      let dispatchAttempts = 0;
      if (failureMode === "dispatcher rejection") {
        state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
          async () => {
            dispatchAttempts += 1;
            throw new Error("synthetic durable dispatch failure");
          },
        );
      } else {
        state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
          async () => {
            dispatchAttempts += 1;
            return {
              counts: { tool: 0, block: 0, final: 0 },
              failedCounts: { tool: 0, block: 0, final: 1 },
            };
          },
        );
      }
      state.pollResponses = [
        {
          result: "success",
          events: [{ id: 4, type: "message", message: makeChannelMessage(messageId) }],
        },
      ];

      await runMonitorOnce();

      const pendingStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
        namespace.includes(".pending."),
      )?.[1];
      const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
        namespace.includes(".completed."),
      )?.[1];
      await expect(pendingStore?.entries()).resolves.toHaveLength(1);
      await expect(completedStore?.entries()).resolves.toEqual([]);
      expect(state.addZulipReaction).toHaveBeenCalledWith(
        state.client,
        expect.objectContaining({ messageId: String(messageId), emojiName: "cross_mark" }),
      );
      expect(
        state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      ).toHaveBeenCalledTimes(1);
      expect(dispatchAttempts).toBe(1);

      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher
        .mockReset()
        .mockImplementation(async () => {
          dispatchAttempts += 1;
          return { counts: { tool: 0, block: 0, final: 1 } };
        });
      await runMonitorOnce();

      await expect(pendingStore?.entries()).resolves.toEqual([]);
      await expect(completedStore?.entries()).resolves.toHaveLength(1);
      expect(
        state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      ).toHaveBeenCalledTimes(1);
      expect(dispatchAttempts).toBe(2);
    },
  );

  it("completes durable inbound after a visible partial reply even when final delivery fails", async () => {
    enableDurableInboundJournal();
    state.account.config.reactions = { enabled: true, clearOnFinish: false };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "visible partial reply" });
        return {
          counts: { tool: 0, block: 1, final: 0 },
          failedCounts: { tool: 0, block: 0, final: 1 },
        };
      },
    );
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 5, type: "message", message: makeChannelMessage(2110) }],
      },
    ];

    await runMonitorOnce();

    const pendingStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".pending."),
    )?.[1];
    const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".completed."),
    )?.[1];
    await expect(pendingStore?.entries()).resolves.toEqual([]);
    await expect(completedStore?.entries()).resolves.toHaveLength(1);
    expect(state.addZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "2110", emojiName: "cross_mark" }),
    );
    expect(
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).toHaveBeenCalledTimes(1);
  });

  it("keeps durable journal store caps below the plugin state row limit", async () => {
    enableDurableInboundJournal();
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 2, type: "message", message: makeChannelMessage(2103) }],
      },
    ];

    await runMonitorOnce();

    const storeCaps = Array.from(state.durableStores.values()).map((store) => store.maxEntries);
    expect(storeCaps).toContain(250);
    expect(storeCaps).toContain(700);
    expect(storeCaps.reduce((sum, value) => sum + value, 0)).toBeLessThan(1000);
  });

  it("replays pending durable inbound messages before polling", async () => {
    enableDurableInboundJournal();
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(2102);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    await journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: Date.now(),
    });

    await runMonitorOnce();

    await expect(journal.pending()).resolves.toEqual([]);
    expect(getZulipEventsWithRetryMock).toHaveBeenCalledTimes(1);
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("aborts an active durable replay without starting the next pending record", async () => {
    enableDurableInboundJournal();
    state.autoAbort = false;
    state.account.config.reactions = { enabled: true };
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const firstMessage = makeChannelMessage(2105);
    const secondMessage = makeChannelMessage(2106);
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    for (const message of [firstMessage, secondMessage]) {
      await journal.accept(
        createZulipDurableInboundMessageId({
          accountId: state.account.accountId,
          messageId: String(message.id),
        }),
        {
          message: serializeZulipDurableInboundMessage(message),
          receivedAt: Date.now(),
        },
      );
    }
    let dispatchStarted!: () => void;
    const activeReplayStarted = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ replyOptions }) => {
        dispatchStarted();
        if (!replyOptions.abortSignal?.aborted) {
          await new Promise<void>((resolve) => {
            replyOptions.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return {
          counts: { tool: 0, block: 0, final: 0 },
          failedCounts: { tool: 0, block: 0, final: 1 },
        };
      },
    );

    const monitorPromise = runMonitorOnce();
    await activeReplayStarted;
    state.abortController?.abort();
    await expect(
      Promise.race([
        monitorPromise.then(() => "stopped"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 250)),
      ]),
    ).resolves.toBe("stopped");

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.addZulipReaction).not.toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: String(secondMessage.id) }),
    );
    expect(state.removeZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: String(firstMessage.id), emojiName: "eyes" }),
    );
    await expect(journal.pending()).resolves.toHaveLength(2);
  });

  it("completes a durable reply when abort races post-delivery subagent settlement", async () => {
    enableDurableInboundJournal();
    state.autoAbort = false;
    state.account.config.reactions = { enabled: true, clearOnFinish: false };
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(2107);
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    await journal.accept(
      createZulipDurableInboundMessageId({
        accountId: state.account.accountId,
        messageId: String(message.id),
      }),
      {
        message: serializeZulipDurableInboundMessage(message),
        receivedAt: Date.now(),
      },
    );
    let subagentHideStarted!: () => void;
    const hideStarted = new Promise<void>((resolve) => {
      subagentHideStarted = resolve;
    });
    let releaseSubagentHide!: () => void;
    const allowHide = new Promise<void>((resolve) => {
      releaseSubagentHide = resolve;
    });
    state.removeZulipReaction.mockImplementation(async (_client, reaction) => {
      if (reaction.emojiName === "robot") {
        subagentHideStarted();
        await allowHide;
      }
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ ctx, dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "committed reply" });
        const { handleZulipSubagentEnded, handleZulipSubagentSpawned } =
          await import("./subagent-reactions.js");
        const requesterSessionKey = String(ctx.SessionKey);
        await handleZulipSubagentSpawned(
          {
            runId: "durable-finish-race-run",
            childSessionKey: "durable-finish-race-child",
            requester: { channel: "zulip" },
          },
          { requesterSessionKey },
        );
        void handleZulipSubagentEnded(
          {
            runId: "durable-finish-race-run",
            targetSessionKey: "durable-finish-race-child",
          },
          { childSessionKey: "durable-finish-race-child" },
        );
        return { counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    const monitorPromise = runMonitorOnce();
    await hideStarted;
    state.abortController?.abort();
    releaseSubagentHide();
    await monitorPromise;

    await expect(journal.pending()).resolves.toEqual([]);
    const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".completed."),
    )?.[1];
    await expect(completedStore?.entries()).resolves.toHaveLength(1);

    state.removeZulipReaction.mockResolvedValue(undefined);
    state.autoAbort = true;
    await runMonitorOnce();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("retries same-process durable replay after a handler failure despite volatile dedupe", async () => {
    enableDurableInboundJournal();
    const message = makeChannelMessage(2104);
    let failedOnce = false;
    state.core.channel.session.updateLastRoute.mockImplementation(async () => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("synthetic post-dedupe failure");
      }
    });
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 2, type: "message", message }],
      },
    ];

    await runMonitorOnce();

    const { createZulipDurableInboundMessageId, createZulipDurableInboundReceiveJournal } =
      await import("./durable-receive.js");
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    await expect(journal.pending()).resolves.toEqual([
      expect.objectContaining({ id: durableId, attempts: 1 }),
    ]);

    state.pollResponses = [{ result: "success", events: [] }];
    await runMonitorOnce();

    await expect(journal.pending()).resolves.toEqual([]);
    expect(state.core.channel.session.updateLastRoute).toHaveBeenCalledTimes(2);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(2);
  });

  it("re-registers the Zulip event queue after a BAD_EVENT_QUEUE_ID response and still processes the message", async () => {
    state.pollResponses = [
      {
        result: "error",
        code: "BAD_EVENT_QUEUE_ID",
        msg: "Bad event queue id",
      },
      {
        result: "success",
        events: [{ id: 4, type: "message", message: makeChannelMessage(3001) }],
      },
    ];

    await runMonitorOnce();

    expect(registerZulipQueueMock).toHaveBeenCalledTimes(2);
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});

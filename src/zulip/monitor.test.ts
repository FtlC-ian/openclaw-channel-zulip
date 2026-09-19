import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { RuntimeEnv } from "../sdk.js";

const questionRuntimeMocks = vi.hoisted(() => ({
  registerChannelDelivery: vi.fn(),
  resolveOption: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: {
    readAskUserQuestionId: vi.fn(
      (payload: { channelData?: { askUser?: { questionId?: string } } }) =>
        payload.channelData?.askUser?.questionId,
    ),
    registerChannelDelivery: questionRuntimeMocks.registerChannelDelivery,
    resolveOption: questionRuntimeMocks.resolveOption,
  },
}));

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

  const createMemoryIngressQueue = () => {
    const pending = new Map<string, Record<string, any>>();
    const completed = new Map<string, Record<string, any>>();
    return {
      enqueue: vi.fn(async (
        id: string,
        payload: unknown,
        options: { metadata?: unknown; receivedAt?: number } = {},
      ) => {
        const completedRecord = completed.get(id);
        if (completedRecord) {
          return { kind: "completed", duplicate: true, record: completedRecord };
        }
        const pendingRecord = pending.get(id);
        if (pendingRecord) {
          return { kind: "pending", duplicate: true, record: pendingRecord };
        }
        const receivedAt = options.receivedAt ?? Date.now();
        const record = {
          id,
          channelId: "zulip",
          accountId: "default",
          queueName: "default",
          payload,
          ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
          receivedAt,
          updatedAt: receivedAt,
          attempts: 0,
        };
        pending.set(id, record);
        return { kind: "accepted", duplicate: false, record };
      }),
      listPending: vi.fn(async () => [...pending.values()]),
      listClaims: vi.fn(async () => []),
      claimNext: vi.fn(async () => null),
      claim: vi.fn(async () => null),
      complete: vi.fn(async (
        id: string,
        options: { metadata?: unknown; completedAt?: number } = {},
      ) => {
        if (!pending.has(id) && completed.has(id)) {
          return false;
        }
        pending.delete(id);
        completed.set(id, {
          id,
          channelId: "zulip",
          accountId: "default",
          queueName: "default",
          completedAt: options.completedAt ?? Date.now(),
          ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
        });
        return true;
      }),
      release: vi.fn(async (
        id: string,
        options: { lastError?: string; releasedAt?: number } = {},
      ) => {
        const record = pending.get(id);
        if (!record) {
          return false;
        }
        const releasedAt = options.releasedAt ?? Date.now();
        pending.set(id, {
          ...record,
          updatedAt: releasedAt,
          attempts: Number(record.attempts ?? 0) + 1,
          lastAttemptAt: releasedAt,
          ...(options.lastError === undefined ? {} : { lastError: options.lastError }),
        });
        return true;
      }),
      fail: vi.fn(async () => false),
      delete: vi.fn(async (id: string) => pending.delete(id)),
      recoverStaleClaims: vi.fn(async () => 0),
      prune: vi.fn(async () => 0),
    };
  };

  const createCore = () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => {});
    const dispatch = vi.fn(async ({
      cfg,
      route,
      ctxPayload,
      delivery,
      dispatcherOptions,
      replyOptions,
    }: Record<string, any>) => ({
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload,
      routeSessionKey: route.sessionKey,
      dispatchResult: await dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          ...dispatcherOptions,
          deliver: delivery.deliver,
          onError: delivery.onError,
        },
        replyOptions,
      }),
    }));
    return {
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
          openChannelIngressQueue: ReturnType<typeof vi.fn>;
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
        dispatch,
      },
      reply: {
        resolveHumanDelayConfig: vi.fn(() => undefined),
        dispatchReplyFromConfig: vi.fn(),
        dispatchReplyWithBufferedBlockDispatcher,
      },
      session: {
        recordInboundSession: vi.fn(async () => {}),
      },
      pairing: {
        buildPairingReply: vi.fn(() => "pairing reply"),
      },
      },
    };
  };

  return {
    createMemoryKeyedStore,
    createMemoryIngressQueue,
    abortController: undefined as AbortController | undefined,
    autoAbort: true,
    durableStores: new Map<string, ReturnType<typeof createMemoryKeyedStore>>(),
    durableQueues: new Map<string, ReturnType<typeof createMemoryIngressQueue>>(),
    pollResponses: [] as Array<Record<string, unknown>>,
    nextQuestionMessageId: 59000,
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
    updateZulipMessageFlags: vi.fn(async () => {}),
    sendMessageZulip: vi.fn(async () => ({ messageId: "outbound-1", channelId: "debbie" })),
    client: {
      authHeader: "fake-auth",
      baseUrl: "https://zulip.example.test",
      fetchImpl: vi.fn(async (_url: string, _init?: RequestInit) => new Response("Unexpected offline request", { status: 400 })),
      request: vi.fn(async (_path: string, _options?: { method?: string; body?: string }) => {
        throw new Error("Unexpected offline API request");
      }),
    },
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

vi.mock("./client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./client.js")>(),
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
  createZulipReadBatcher: vi.fn(() => ({
    markRead: (messageId: string | number) => state.updateZulipMessageFlags(state.client, {
      messageIds: [messageId],
      flag: "read",
      op: "add",
    }),
  })),
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

vi.mock("../sdk.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../sdk.js")>(),
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
  options: {
    statusSink?: (patch: Record<string, unknown>) => void;
    email?: string;
    baseUrl?: string;
  } = {},
) {
  const { monitorZulipProvider } = await import("./monitor.js");
  state.abortController = controller;
  await monitorZulipProvider({
    config: state.core.config,
    runtime,
    email: options.email,
    baseUrl: options.baseUrl,
    abortSignal: state.abortController.signal,
    statusSink: options.statusSink,
  });
}

function enableDurableInboundJournal(
  journalOptions: {
    completedLookupFailuresAfterAccept?: number;
    completedLookupFailureIds?: readonly string[];
    deferredPendingListFailures?: number;
    queueCompletionFailures?: number;
  } = {},
) {
  state.durableStores = new Map();
  state.durableQueues = new Map();
  let postAcceptLookupFailed = false;
  state.core.state = {
    openKeyedStore: vi.fn((options: { namespace: string }) => {
      const existing = state.durableStores.get(options.namespace);
      if (existing) {
        return existing;
      }
      const store = state.createMemoryKeyedStore(options.maxEntries);
      if (options.namespace.includes(".completed.")) {
        let failuresRemaining = journalOptions.completedLookupFailuresAfterAccept ?? 0;
        const failureIds = new Set(journalOptions.completedLookupFailureIds ?? []);
        const lookupCounts = new Map<string, number>();
        const lookup = store.lookup.getMockImplementation();
        store.lookup.mockImplementation(async (key: string) => {
          const count = (lookupCounts.get(key) ?? 0) + 1;
          lookupCounts.set(key, count);
          const targetedFailure = count === 2 && failureIds.delete(key);
          if (count === 2 && (targetedFailure || failuresRemaining > 0)) {
            if (!targetedFailure) {
              failuresRemaining -= 1;
            }
            postAcceptLookupFailed = true;
            throw new Error("synthetic legacy lookup failure");
          }
          return await lookup?.(key);
        });
      }
      state.durableStores.set(options.namespace, store);
      return store;
    }),
    openChannelIngressQueue: vi.fn((options: { accountId?: string } = {}) => {
      const accountId = options.accountId ?? "default";
      const existing = state.durableQueues.get(accountId);
      if (existing) {
        return existing;
      }
      const queue = state.createMemoryIngressQueue();
      const complete = queue.complete.getMockImplementation();
      let queueCompletionFailuresRemaining = journalOptions.queueCompletionFailures ?? 0;
      queue.complete.mockImplementation(async (...args) => {
        if (queueCompletionFailuresRemaining > 0) {
          queueCompletionFailuresRemaining -= 1;
          throw new Error("synthetic queue completion failure");
        }
        return await complete?.(...args);
      });
      const listPending = queue.listPending.getMockImplementation();
      let pendingListFailuresRemaining = journalOptions.deferredPendingListFailures ?? 0;
      queue.listPending.mockImplementation(async () => {
        if (postAcceptLookupFailed && pendingListFailuresRemaining > 0) {
          pendingListFailuresRemaining -= 1;
          throw new Error("synthetic deferred pending-list failure");
        }
        return await listPending?.();
      });
      state.durableQueues.set(accountId, queue);
      return queue;
    }),
  };
}

describe("monitorZulipProvider", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(async () => {
    const { startZulipMonitorReactionLifecycles } = await import("./monitor.js");
    startZulipMonitorReactionLifecycles();
    state.core = state.createCore();
    state.core.channel.inbound.buildContext.mockImplementation(buildChannelInboundEventContext);
    state.durableStores = new Map();
    state.durableQueues = new Map();
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
    state.updateZulipMessageFlags.mockReset().mockResolvedValue(undefined);
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

  it("dispatches an accepted inbound message through the channel-turn lifecycle", async () => {
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(9100001) }],
      },
    ];

    await runMonitorOnce();

    const dispatch = state.core.channel.inbound.dispatch;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      channel: "zulip",
      accountId: "default",
      route: expect.objectContaining({ agentId: "debbie" }),
      record: expect.objectContaining({
        updateLastRoute: expect.objectContaining({
          channel: "zulip",
          to: "stream:4:zulip-plugin-pr",
          accountId: "default",
          threadId: "zulip-plugin-pr",
        }),
      }),
      delivery: expect.objectContaining({
        deliver: expect.any(Function),
        onError: expect.any(Function),
      }),
      dispatcherOptions: expect.any(Object),
      replyOptions: expect.any(Object),
      messageId: "9100001",
    }));
  });

  it("keeps the raw topic and reply message ID in their SDK fields", async () => {
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: {
        ...makeChannelMessage(9100002), subject: "Release A / B",
      } }],
    }];

    await runMonitorOnce();

    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledWith(expect.objectContaining({
      conversation: expect.objectContaining({ threadId: "Release A / B" }),
      reply: expect.objectContaining({ replyToId: "9100002", messageThreadId: "Release A / B" }),
    }));
    const ctx = state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx;
    expect(ctx).toMatchObject({ ReplyToId: "9100002", MessageThreadId: "Release A / B" });
  });

  it("dispatches colliding legacy slugs and the empty topic into separate fresh sessions", async () => {
    state.account.config.defaultTopic = "general";
    const topics = ["Release A", "Release-A", "", "general"];
    state.autoAbort = false;
    let turns = 0;
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async () => {
      if (++turns === topics.length) state.abortController?.abort();
      return { counts: { final: 0 } };
    });
    state.pollResponses = [{
      result: "success",
      events: topics.map((subject, index) => ({
        id: index + 1, type: "message", message: { ...makeChannelMessage(95000 + index), subject },
      })),
    }];
    await runMonitorOnce();

    const contexts = state.core.channel.inbound.buildContext.mock.calls.map(([ctx]) => ctx);
    expect(contexts).toHaveLength(4);
    expect(new Set(contexts.map((ctx) => ctx.route.routeSessionKey)).size).toBe(4);
    contexts.forEach((ctx, index) => {
      expect(ctx.route.parentSessionKey).toBeUndefined();
      expect(ctx.reply).toMatchObject({ to: `stream:4:${topics[index]}`, messageThreadId: topics[index] });
      expect(ctx.route.routeSessionKey).toMatch(/^agent:debbie:zulip:channel:4:topic:v2:[0-9a-f]{64}$/);
    });
    const dispatched = state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls.map(([params]) => params.ctx);
    expect(dispatched.map((ctx) => ctx.SessionKey)).toEqual(contexts.map((ctx) => ctx.route.routeSessionKey));
    expect(dispatched.every((ctx) => ctx.ParentSessionKey === undefined)).toBe(true);
  });

  it.each([null, undefined])("rejects a missing observed topic (%j) before accepting or downloading", async (subject) => {
    enableDurableInboundJournal();
    state.extractedUploadUrls = ["https://zulip.example.test/user_uploads/file.txt"];
    state.pollResponses = [{ result: "success", events: [{
      id: 1, type: "message", message: { ...makeChannelMessage(95010), subject },
    }] }];
    await runMonitorOnce();
    expect(downloadZulipUploadMock).not.toHaveBeenCalled();
    expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("coalesces commentary and narration chunks in the task-progress draft before the final reply", async () => {
    vi.useFakeTimers();
    state.autoAbort = false;
    try {
    state.account.config.streaming = {
      mode: "progress",
      progress: { commentary: true, narration: true, toolProgress: true },
    };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions.reasoningPayloadsEnabled).toBe(true);
        expect(replyOptions.commentaryPayloadsEnabled).toBeUndefined();
        expect(replyOptions.shouldDeliverCommentaryPayloads).toBeUndefined();
        expect(replyOptions.onVerboseProgressVisibility).toBeUndefined();
        expect(replyOptions.progressPreambleEnabled).toBe(true);
        expect(replyOptions.suppressDefaultToolProgressMessages).toBe(true);
        await replyOptions.onPlanUpdate?.({
          phase: "update",
          explanation: "Preparing the change",
          steps: [{ step: "Inspect source", status: "in_progress" }],
        });
        await replyOptions.onItemEvent?.({
          itemId: "preamble-1",
          kind: "preamble",
          progressText: "Inspecting the source",
        });
        await replyOptions.onItemEvent?.({
          itemId: "commentary-2",
          kind: "commentary",
          progressText: "Applying the change",
        });
        await replyOptions.onReasoningStream?.({ text: "Checking the implementation" });
        await replyOptions.onNarrationUpdate?.({ text: "Reviewing the change" });
        await replyOptions.onNarrationUpdate?.({ text: "Verifying the change" });
        await replyOptions.onToolStart?.({ itemId: "tool-1", name: "exec", phase: "start" });
        await replyOptions.onCommandOutput?.({
          itemId: "tool-1",
          phase: "end",
          title: "Run verification",
          output: "ok",
        });
        await replyOptions.onPatchSummary?.({
          itemId: "patch-1",
          phase: "end",
          title: "Apply patch",
          modified: ["src/a.ts"],
        });
        await replyOptions.onApprovalEvent?.({
          approvalId: "approval-1",
          phase: "requested",
          title: "Approve change",
        });
        await replyOptions.onCompactionStart?.();
        await replyOptions.onCompactionEnd?.();
        await vi.advanceTimersByTimeAsync(1_000);
        await dispatcherOptions.deliver({ text: "Final answer" });
        state.abortController?.abort();
        return { counts: { final: 1 } };
      },
    );
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: makeChannelMessage(5002) }],
    }];

    await runMonitorOnce();

    expect(state.editZulipMessage).toHaveBeenCalled();
    expect(state.editZulipMessage).toHaveBeenLastCalledWith(
      state.client,
      expect.objectContaining({
        messageId: "outbound-1",
        content: [
          "Verifying the change",
          "",
          "💬 Applying the change",
          "Checking the implementation",
          "Approval required: Approve change",
          "In progress: Inspect source",
        ].join("\n"),
      }),
    );
    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1" });
    expect(state.sendMessageZulip).toHaveBeenLastCalledWith(
      "stream:4:zulip-plugin-pr",
      "Final answer",
      expect.objectContaining({ topic: "zulip-plugin-pr" }),
    );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates a permanent task-progress edit failure at most once and removes every draft before the final reply", async () => {
    vi.useFakeTimers();
    state.autoAbort = false;
    try {
    state.account.config.streaming = {
      mode: "progress",
      progress: { commentary: true, narration: true },
    };
    state.editZulipMessage.mockRejectedValue(new Error("synthetic edit failure"));
    state.sendMessageZulip
      .mockResolvedValueOnce({ messageId: "progress-1", channelId: "debbie" })
      .mockResolvedValueOnce({ messageId: "progress-2", channelId: "debbie" })
      .mockResolvedValueOnce({ messageId: "final-1", channelId: "debbie" });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions.onPlanUpdate?.({
          phase: "update",
          explanation: "Inspecting the implementation",
          steps: [{ step: "Inspect source", status: "in_progress" }],
        });
        await replyOptions.onNarrationUpdate?.({ text: "Applying the change" });
        await vi.advanceTimersByTimeAsync(1_000);
        await replyOptions.onNarrationUpdate?.({ text: "Verifying the change" });
        await vi.advanceTimersByTimeAsync(1_000);
        await dispatcherOptions.deliver({ text: "Final answer" });
        state.abortController?.abort();
        return { counts: { final: 1 } };
      },
    );
    state.pollResponses = [{
      result: "success",
      events: [{ id: 1, type: "message", message: makeChannelMessage(5003) }],
    }];

    await runMonitorOnce();

    expect(state.editZulipMessage).toHaveBeenNthCalledWith(
      1,
      state.client,
      expect.objectContaining({ messageId: "progress-1" }),
    );
    expect(state.editZulipMessage).toHaveBeenNthCalledWith(
      2,
      state.client,
      expect.objectContaining({ messageId: "progress-2" }),
    );
    expect(state.sendMessageZulip).toHaveBeenCalledTimes(3);
    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "progress-1" });
    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "progress-2" });
    expect(state.sendMessageZulip).toHaveBeenLastCalledWith(
      "stream:4:zulip-plugin-pr",
      "Final answer",
      expect.objectContaining({ topic: "zulip-plugin-pr" }),
    );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the existing draft on a 429 and retries only the latest progress text", async () => {
    vi.useFakeTimers();
    state.autoAbort = false;
    try {
      state.account.config.streaming = {
        mode: "progress",
        progress: { commentary: true, narration: true },
      };
      state.editZulipMessage
        .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 5_000 }))
        .mockResolvedValueOnce(undefined);
      state.sendMessageZulip
        .mockResolvedValueOnce({ messageId: "progress-1", channelId: "debbie" })
        .mockResolvedValueOnce({ messageId: "final-1", channelId: "debbie" });
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions.onPlanUpdate?.({
            phase: "update",
            explanation: "Initial progress",
            steps: [{ step: "Inspect source", status: "in_progress" }],
          });
          await replyOptions.onNarrationUpdate?.({ text: "Stale progress" });
          await vi.advanceTimersByTimeAsync(1_000);
          await replyOptions.onNarrationUpdate?.({ text: "Latest progress" });
          expect(state.deleteZulipMessage).not.toHaveBeenCalled();
          expect(state.sendMessageZulip).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(5_000);
          expect(state.editZulipMessage).toHaveBeenCalledTimes(2);
          expect(state.editZulipMessage).toHaveBeenLastCalledWith(
            state.client,
            expect.objectContaining({ messageId: "progress-1", content: expect.stringContaining("Latest progress") }),
          );
          expect(state.deleteZulipMessage).not.toHaveBeenCalled();
          expect(state.sendMessageZulip).toHaveBeenCalledTimes(1);
          await dispatcherOptions.deliver({ text: "Final answer" });
          state.abortController?.abort();
          return { counts: { final: 1 } };
        },
      );
      state.pollResponses = [{
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(5004) }],
      }];

      await runMonitorOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces rapid progress updates so the latest render wins after one interval", async () => {
    vi.useFakeTimers();
    state.autoAbort = false;
    try {
      state.account.config.streaming = {
        mode: "progress",
        progress: { commentary: true, narration: true },
      };
      state.sendMessageZulip
        .mockResolvedValueOnce({ messageId: "progress-1", channelId: "debbie" })
        .mockResolvedValueOnce({ messageId: "final-1", channelId: "debbie" });
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions.onPlanUpdate?.({
            phase: "update",
            explanation: "Initial progress",
            steps: [{ step: "Inspect source", status: "in_progress" }],
          });
          await replyOptions.onNarrationUpdate?.({ text: "First rapid update" });
          await replyOptions.onNarrationUpdate?.({ text: "Latest rapid update" });
          await vi.advanceTimersByTimeAsync(999);
          expect(state.editZulipMessage).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(state.editZulipMessage).toHaveBeenCalledTimes(1);
          expect(state.editZulipMessage).toHaveBeenLastCalledWith(
            state.client,
            expect.objectContaining({ content: expect.stringContaining("Latest rapid update") }),
          );
          await dispatcherOptions.deliver({ text: "Final answer" });
          state.abortController?.abort();
          return { counts: { final: 1 } };
        },
      );
      state.pollResponses = [{
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(5005) }],
      }];

      await runMonitorOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recreate a task-progress draft after cleanup begins during an in-flight edit", async () => {
    vi.useFakeTimers();
    state.autoAbort = false;
    try {
      state.account.config.streaming = {
        mode: "progress",
        progress: { commentary: true, narration: true },
      };
      let releaseEdit: (() => void) | undefined;
      const editStarted = new Promise<void>((resolve) => {
        state.editZulipMessage.mockImplementationOnce(async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseEdit = release;
          });
        });
      });
      state.sendMessageZulip
        .mockResolvedValueOnce({ messageId: "progress-1", channelId: "debbie" })
        .mockResolvedValueOnce({ messageId: "final-1", channelId: "debbie" });
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions.onPlanUpdate?.({
            phase: "update",
            explanation: "Initial progress",
            steps: [{ step: "Inspect source", status: "in_progress" }],
          });
          await vi.advanceTimersByTimeAsync(1_000);
          const update = replyOptions.onNarrationUpdate?.({ text: "In-flight progress" });
          await editStarted;
          const delivery = dispatcherOptions.deliver({ text: "Final answer" });
          releaseEdit?.();
          await update;
          await delivery;
          expect(state.editZulipMessage).toHaveBeenCalledTimes(1);
          expect(state.sendMessageZulip).toHaveBeenCalledTimes(2);
          state.abortController?.abort();
          return { counts: { final: 1 } };
        },
      );
      state.pollResponses = [{
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(5006) }],
      }];

      await runMonitorOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient task-progress deletion a bounded number of times", async () => {
    vi.useFakeTimers();
    state.autoAbort = false;
    try {
      state.account.config.streaming = {
        mode: "progress",
        progress: { commentary: true },
      };
      state.deleteZulipMessage
        .mockRejectedValueOnce(Object.assign(new Error("temporary delete failure"), { status: 503 }))
        .mockRejectedValueOnce(Object.assign(new Error("temporary delete failure"), { status: 503 }))
        .mockResolvedValueOnce(undefined);
      state.sendMessageZulip
        .mockResolvedValueOnce({ messageId: "progress-1", channelId: "debbie" })
        .mockResolvedValueOnce({ messageId: "final-1", channelId: "debbie" });
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions.onApprovalEvent?.({
            approvalId: "approval-1",
            phase: "requested",
            title: "Inspect source",
          });
          const delivery = dispatcherOptions.deliver({ text: "Final answer" });
          await vi.advanceTimersByTimeAsync(0);
          expect(state.deleteZulipMessage).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(100);
          expect(state.deleteZulipMessage).toHaveBeenCalledTimes(2);
          await vi.advanceTimersByTimeAsync(200);
          await delivery;
          expect(state.deleteZulipMessage).toHaveBeenCalledTimes(3);
          state.abortController?.abort();
          return { counts: { final: 1 } };
        },
      );
      state.pollResponses = [{
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(5007) }],
      }];

      await runMonitorOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off repeated edit retries and resets the delay after a successful edit", async () => {
    vi.useFakeTimers();
    state.autoAbort = false;
    try {
      state.account.config.streaming = {
        mode: "progress",
        progress: { commentary: true, narration: true },
      };
      state.editZulipMessage
        .mockRejectedValueOnce(Object.assign(new Error("temporary edit failure"), { status: 503 }))
        .mockRejectedValueOnce(Object.assign(new Error("temporary edit failure"), { status: 503 }))
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(Object.assign(new Error("temporary edit failure"), { status: 503 }));
      state.sendMessageZulip
        .mockResolvedValueOnce({ messageId: "progress-1", channelId: "debbie" })
        .mockResolvedValueOnce({ messageId: "final-1", channelId: "debbie" });
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions.onPlanUpdate?.({
            phase: "update",
            explanation: "Initial progress",
            steps: [{ step: "Inspect source", status: "in_progress" }],
          });
          await vi.advanceTimersByTimeAsync(1_000);
          await replyOptions.onNarrationUpdate?.({ text: "Retry one" });
          expect(state.editZulipMessage).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(999);
          expect(state.editZulipMessage).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(1);
          expect(state.editZulipMessage).toHaveBeenCalledTimes(2);
          await vi.advanceTimersByTimeAsync(1_999);
          expect(state.editZulipMessage).toHaveBeenCalledTimes(2);
          await vi.advanceTimersByTimeAsync(1);
          expect(state.editZulipMessage).toHaveBeenCalledTimes(3);
          await replyOptions.onNarrationUpdate?.({ text: "Retry after success" });
          await vi.advanceTimersByTimeAsync(1_000);
          expect(state.editZulipMessage).toHaveBeenCalledTimes(4);
          await dispatcherOptions.deliver({ text: "Final answer" });
          state.abortController?.abort();
          return { counts: { final: 1 } };
        },
      );
      state.pollResponses = [{
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(5008) }],
      }];

      await runMonitorOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors Retry-After before retrying task-progress deletion", async () => {
    vi.useFakeTimers();
    state.autoAbort = false;
    try {
      state.account.config.streaming = {
        mode: "progress",
        progress: { commentary: true },
      };
      state.deleteZulipMessage
        .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 500 }))
        .mockResolvedValueOnce(undefined);
      state.sendMessageZulip
        .mockResolvedValueOnce({ messageId: "progress-1", channelId: "debbie" })
        .mockResolvedValueOnce({ messageId: "final-1", channelId: "debbie" });
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions.onApprovalEvent?.({
            approvalId: "approval-1",
            phase: "requested",
            title: "Inspect source",
          });
          const delivery = dispatcherOptions.deliver({ text: "Final answer" });
          await vi.advanceTimersByTimeAsync(0);
          expect(state.deleteZulipMessage).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(499);
          expect(state.deleteZulipMessage).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(1);
          await delivery;
          expect(state.deleteZulipMessage).toHaveBeenCalledTimes(2);
          state.abortController?.abort();
          return { counts: { final: 1 } };
        },
      );
      state.pollResponses = [{
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(5009) }],
      }];

      await runMonitorOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a permanent task-progress delete failure", async () => {
    vi.useFakeTimers();
    state.autoAbort = false;
    try {
      state.account.config.streaming = {
        mode: "progress",
        progress: { commentary: true },
      };
      state.deleteZulipMessage.mockRejectedValueOnce(
        Object.assign(new Error("not allowed"), { status: 403 }),
      );
      state.sendMessageZulip
        .mockResolvedValueOnce({ messageId: "progress-1", channelId: "debbie" })
        .mockResolvedValueOnce({ messageId: "final-1", channelId: "debbie" });
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions.onApprovalEvent?.({
            approvalId: "approval-1",
            phase: "requested",
            title: "Inspect source",
          });
          await dispatcherOptions.deliver({ text: "Final answer" });
          expect(state.deleteZulipMessage).toHaveBeenCalledTimes(1);
          state.abortController?.abort();
          return { counts: { final: 1 } };
        },
      );
      state.pollResponses = [{
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(5010) }],
      }];

      await runMonitorOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "off", streaming: { mode: "off" }, legacy: false, progress: false },
    { name: "options without mode", streaming: { progress: { narration: true } }, legacy: false, progress: false },
    { name: "legacy only", streaming: { mode: "off" }, legacy: true, progress: false },
    { name: "legacy with progress options but no mode", streaming: { progress: { narration: true } }, legacy: true, progress: false },
    { name: "progress only", streaming: { mode: "progress" }, legacy: false, progress: true },
    { name: "both enabled", streaming: { mode: "progress" }, legacy: true, progress: true },
  ])("combined feedback precedence: $name", async ({ name, streaming, legacy, progress }) => {
    state.account.config.streaming = streaming;
    state.account.config.thinkingPlaceholder = { enabled: legacy, text: "Legacy draft" };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions.progressPreambleEnabled).toBe(progress ? true : undefined);
        await replyOptions.onApprovalEvent?.({ approvalId: "combined", phase: "requested", title: "Inspect source" });
        await dispatcherOptions.deliver({ text: "Final answer" });
        state.abortController?.abort();
        return { counts: { final: 1 } };
      },
    );
    const ids = ["off", "options without mode", "legacy only", "legacy with progress options but no mode", "progress only", "both enabled"];
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(9410 + ids.indexOf(name)) }] }];
    await runMonitorOnce();
    const texts = state.sendMessageZulip.mock.calls.map((call) => call[1]);
    expect(texts.includes("Legacy draft")).toBe(legacy && !progress);
    expect(texts).toHaveLength(progress ? 2 : 1);
    if (legacy && !progress) {
      expect(state.editZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1", content: "Final answer" });
    } else {
      expect(texts.at(-1)).toBe("Final answer");
    }
    if (progress) {
      expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1" });
      expect(state.deleteZulipMessage.mock.invocationCallOrder[0]).toBeLessThan(state.sendMessageZulip.mock.invocationCallOrder[1]);
    }
  });

  it.each(["error", "cancel", "silent"])("cleans progress with both configured on %s without legacy error feedback", async (outcome) => {
    state.autoAbort = false;
    state.account.config.streaming = { mode: "progress" };
    state.account.config.thinkingPlaceholder = { enabled: true, text: "Legacy draft", errorText: "Legacy error" };
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ replyOptions }) => {
        await replyOptions.onApprovalEvent?.({ approvalId: "combined", phase: "requested", title: "Inspect source" });
        if (outcome === "cancel") state.abortController?.abort();
        if (outcome === "error") throw new Error("synthetic combined dispatch failure");
        return { counts: { final: 0 } };
      },
    );
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(9420 + ["error", "cancel", "silent"].indexOf(outcome)) }] }];
    state.autoAbort = true;
    await runMonitorOnce();
    expect(state.sendMessageZulip).toHaveBeenCalledTimes(1);
    expect(state.sendMessageZulip.mock.calls[0][1]).not.toMatch(/Legacy/);
    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1" });
    expect(state.editZulipMessage).not.toHaveBeenCalled();
  });

  it("cleans progress before question delivery while preserving sender and inbound conversation context", async () => {
    const { getZulipQuestionDeliveryContext } = await import("./question-zform.js");
    state.autoAbort = true;
    state.account.config.streaming = { mode: "progress" };
    state.account.config.thinkingPlaceholder = { enabled: true };
    const question = { text: "Choose one", channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } } };
    let deliveryContext: unknown;
    let questionDelivered = false;
    state.sendMessageZulip.mockImplementation(async (_to, _text, options) => {
      if (options.channelData) {
        deliveryContext = getZulipQuestionDeliveryContext();
      }
      return { messageId: options.channelData ? "question-1" : "progress-1", channelId: "debbie" };
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions.onApprovalEvent?.({ approvalId: "combined", phase: "requested", title: "Inspect source" });
        await dispatcherOptions.deliver(question);
        questionDelivered = true;
        await replyOptions.onToolStart?.({ name: "exec", phase: "end" });
        state.abortController?.abort();
        return { counts: { final: 1 } };
      },
    );
    state.pollResponses = [{ result: "success", events: [{ id: 1, type: "message", message: makeChannelMessage(9403) }] }];
    await runMonitorOnce();
    expect(state.sendMessageZulip).toHaveBeenCalledTimes(2);
    expect(state.deleteZulipMessage.mock.calls.every((call) => call[1].messageId === "progress-1")).toBe(true);
    expect(questionDelivered).toBe(true);
    expect(deliveryContext).toEqual({
      authorizedSenderId: "user8@zlp.pubnerd.app",
      conversation: { kind: "stream", stream: "4", topic: "zulip-plugin-pr" },
    });
    expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "progress-1" });
    expect(state.deleteZulipMessage.mock.invocationCallOrder[0]).toBeLessThan(state.sendMessageZulip.mock.invocationCallOrder[1]);
    expect(getZulipQuestionDeliveryContext()).toBeUndefined();
  });

  it("keeps concurrent progress ownership separate when one run cancels and the other delivers a question", async () => {
    state.autoAbort = false;
    state.account.config.streaming = { mode: "progress" };
    state.account.config.thinkingPlaceholder = { enabled: true };
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    let releaseCancelled!: () => void;
    const cancelledCleanup = new Promise<void>((resolve) => { releaseCancelled = resolve; });
    let started = 0;
    let dispatches = 0;
    let remainingRunDelivered = false;
    let deletedAtCancellation: string[] = [];
    state.sendMessageZulip.mockImplementation(async (_to, _text, options) => ({
      messageId: options.channelData ? "question-b" : `progress-${options.topic}`,
      channelId: "debbie",
    }));
    state.deleteZulipMessage.mockImplementation(async (_client, { messageId }) => {
      if (messageId === "progress-owner-a") {
        deletedAtCancellation = state.deleteZulipMessage.mock.calls.map((call) => call[1].messageId);
        releaseCancelled();
      }
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const ordinal = dispatches++;
        await replyOptions.onApprovalEvent?.({ approvalId: `approval-${ordinal}`, phase: "requested", title: "Inspect source" });
        if (++started === 2) releaseBoth();
        await bothStarted;
        if (ordinal === 0) throw Object.assign(new Error("cancel first run"), { name: "AbortError" });
        await cancelledCleanup;
        await dispatcherOptions.deliver({ text: "Choose one", channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } } });
        remainingRunDelivered = true;
        state.abortController?.abort();
        return { counts: { final: 1 } };
      },
    );
    state.pollResponses = [{ result: "success", events: [
      { id: 1, type: "message", message: { ...makeChannelMessage(9430), subject: "owner-a" } },
      { id: 2, type: "message", message: { ...makeChannelMessage(9431), subject: "owner-b" } },
    ] }];
    await runMonitorOnce();
    expect(dispatches).toBe(2);
    expect(remainingRunDelivered).toBe(true);
    expect(deletedAtCancellation).toEqual(["progress-owner-a"]);
    expect(state.deleteZulipMessage.mock.calls.map((call) => call[1].messageId)).toEqual(["progress-owner-a", "progress-owner-b"]);
    expect(state.sendMessageZulip).toHaveBeenCalledTimes(3);
    expect(state.sendMessageZulip.mock.calls[2][2]).toMatchObject({ topic: "owner-b", channelData: { askUser: expect.anything() } });
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
    enableDurableInboundJournal();
    state.autoAbort = false;
    state.account.config.markHandledRead = true;
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
    expect(state.updateZulipMessageFlags).not.toHaveBeenCalled();
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

    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(1, "stream:4:zulip-plugin-pr", "Thinking…", expect.objectContaining({ topic: "zulip-plugin-pr" }));
    expect(state.editZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "outbound-1", content: "first chunk" });
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(2, "stream:4:zulip-plugin-pr", "second chunk", expect.any(Object));
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
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(2, "stream:4:zulip-plugin-pr", "", expect.objectContaining({ presentation: expect.any(Object) }));
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
      "stream:4:zulip-plugin-pr",
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
      "stream:4:zulip-plugin-pr",
      expectedFirstReply,
      expect.objectContaining(expectedFirstReplyOptions),
    );
    expect(state.sendMessageZulip).toHaveBeenCalledTimes(3);
    expect(state.sendMessageZulip).not.toHaveBeenCalledWith(
      "stream:4:zulip-plugin-pr",
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
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(2, "stream:4:zulip-plugin-pr", "actual reply", expect.any(Object));
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
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(2, "stream:4:zulip-plugin-pr", "actual reply", expect.any(Object));
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
    expect(sendMessageZulipMock).toHaveBeenNthCalledWith(1, "stream:4:zulip-plugin-pr", "first chunk", expect.objectContaining({
      presentation: expect.any(Object),
      channelData: { zulip: { widgetContent: { widget_type: "zform" } } },
    }));
    expect(sendMessageZulipMock).toHaveBeenNthCalledWith(2, "stream:4:zulip-plugin-pr", "second chunk", expect.objectContaining({
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
    expect(sendMessageZulipMock).toHaveBeenNthCalledWith(1, "stream:4:zulip-plugin-pr", "caption", expect.objectContaining({
      mediaUrl: "https://example.com/one.png",
      presentation: expect.any(Object),
      channelData: { zulip: { widgetContent: { widget_type: "zform" } } },
    }));
    expect(sendMessageZulipMock).toHaveBeenNthCalledWith(2, "stream:4:zulip-plugin-pr", "", expect.objectContaining({
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
    expect(sendMessageZulipMock).toHaveBeenCalledWith("stream:4:zulip-plugin-pr", "", expect.objectContaining({
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
    expect(sendMessageZulipMock).toHaveBeenCalledWith("stream:4:zulip-plugin-pr", "", expect.objectContaining({
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

  it("passes the stripped Zulip bot mention to question-control interception and consumes it", async () => {
    state.account.config.allowFrom = ["user8@zlp.pubnerd.app"];
    const { zulipQuestionZformStore } = await import("./question-zform.js");
    const intercept = vi
      .spyOn(zulipQuestionZformStore, "intercept")
      .mockResolvedValueOnce({ recognized: true, status: "answered", optionValue: "Staging" });
    const originalBotName = state.botUser.full_name;
    state.botUser.full_name = "Debbie-Main";
    try {
      state.pollResponses = [
        {
          result: "success",
          events: [
            {
              id: 1,
              type: "message",
              message: {
                ...makeChannelMessage(58252),
                content: "@**Debbie-Main** ocq1:kDU1R53ZTUJxIiMrjEHqww:0",
              },
            },
          ],
        },
      ];

      await runMonitorOnce();

      expect(intercept).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            text: "@Debbie-Main ocq1:kDU1R53ZTUJxIiMrjEHqww:0",
            expectedBotMention: "Debbie-Main",
          }),
        }),
      );
      expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
      expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    } finally {
      state.botUser.full_name = originalBotName;
      intercept.mockRestore();
    }
  });

  it("consumes an exact bare stale question control before ordinary inbound dispatch", async () => {
    state.account.config.allowFrom = ["user8@zlp.pubnerd.app"];
    const { zulipQuestionZformStore } = await import("./question-zform.js");
    const { sendMessageZulip } = await import("./send.js");
    const sendMessageZulipMock = vi.mocked(sendMessageZulip);
    zulipQuestionZformStore.clear();
    sendMessageZulipMock.mockClear();
    state.pollResponses = [
      {
        result: "success",
        events: [
          {
            id: 1,
            type: "message",
            message: {
              ...makeChannelMessage(58253),
              content: "ocq1:kDU1R53ZTUJxIiMrjEHqww:0",
            },
          },
        ],
      },
    ];

    await runMonitorOnce();

    expect(sendMessageZulipMock).toHaveBeenCalledWith(
      "stream:4:zulip-plugin-pr",
      "That question is no longer active.",
      expect.objectContaining({ accountId: "default", topic: "zulip-plugin-pr" }),
    );
    expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("resolves a canonical ZulipFlutter ordered-list fallback before ordinary inbound dispatch", async () => {
    state.account.config.allowFrom = ["user8@zlp.pubnerd.app"];
    const { zulipQuestionZformStore } = await import("./question-zform.js");
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const preparation = zulipQuestionZformStore.prepare({
      channelData: { askUser: { questionId, optionValues: ["Staging", "Production"] } },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Staging", action: { type: "question", questionId, optionValue: "Staging" } },
              { label: "Production", action: { type: "question", questionId, optionValue: "Production" } },
            ],
          },
        ],
      },
    })!;
    zulipQuestionZformStore.clear();
    questionRuntimeMocks.resolveOption.mockResolvedValueOnce({
      status: "answered",
      questionId,
      optionValue: "Production",
    });
    expect(
      zulipQuestionZformStore.register({
        preparation,
        accountId: "default",
        conversation: { kind: "stream", stream: "4", topic: "zulip-plugin-pr" },
        authorizedSenderId: "user8@zlp.pubnerd.app",
        sourceMessageId: "58260",
        sourceText: "Which option?",
        client: state.client,
      }),
    ).toBe(true);
    try {
      state.pollResponses = [
        {
          result: "success",
          events: [
            {
              id: 1,
              type: "message",
              message: {
                ...makeChannelMessage(58261),
                content: '<ol start="2"><li>Production</li></ol>',
              },
            },
          ],
        },
      ];

      await runMonitorOnce();

      expect(questionRuntimeMocks.resolveOption).toHaveBeenCalledWith(
        expect.objectContaining({ questionId, optionValue: "Production" }),
      );
      expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
      expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    } finally {
      zulipQuestionZformStore.clear();
    }
  });

  describe.each(["native", "mobile"] as const)("real outbound to inbound %s question controls", (form) => {
    it.each([
      { policy: "allowed stream", dm: false, allowed: true },
      { policy: "allowed DM", dm: true, allowed: true },
      { policy: "revoked group allowlist", dm: false, allowed: false },
      { policy: "revoked pairing", dm: true, allowed: false },
      { policy: "disabled group", dm: false, allowed: false },
      { policy: "disabled DM", dm: true, allowed: false },
      { policy: "revoked command access", dm: false, allowed: false },
    ])("enforces $policy after delivery", async ({ policy, dm, allowed }) => {
      const { sendMessageZulip } = await vi.importActual<typeof import("./send.js")>("./send.js");
      const { runWithZulipQuestionDeliveryContext, zulipQuestionZformStore } = await import("./question-zform.js");
      const questionId = "ask_0123456789abcdef0123456789abcdef";
      const sender = "user8@zlp.pubnerd.app";
      zulipQuestionZformStore.clear();
      questionRuntimeMocks.resolveOption.mockReset().mockResolvedValue({ status: "answered", questionId, optionValue: "Production" });
      questionRuntimeMocks.registerChannelDelivery.mockClear();
      state.account.config.allowFrom = [sender];
      state.account.config.groupAllowFrom = [sender];
      state.account.config.dmPolicy = "pairing";
      state.account.config.groupPolicy = "allowlist";
      state.pairingAllowFrom = [sender];
      state.client.request.mockReset().mockImplementation(async (path, options) => {
        if (path === "/users/me/subscriptions?include_all_public_streams=true") {
          return { result: "success", subscriptions: state.streamSubscriptions } as never;
        }
        if (path === "/messages" && options?.method === "POST") {
          return { result: "success", id: 9100 } as never;
        }
        throw new Error(`Unexpected offline API request: ${path}`);
      });
      state.client.fetchImpl.mockImplementation(async (url, init) => {
        const parsed = new URL(url);
        const response = await state.client.request(parsed.pathname.replace(/^\/api\/v1/u, "") + parsed.search, {
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return Response.json(response);
      });
      const register = vi.spyOn(zulipQuestionZformStore, "register");
      try {
        await runWithZulipQuestionDeliveryContext({
          authorizedSenderId: sender,
          conversation: { kind: "stream", stream: "999", topic: "wrong-context" },
        }, () => sendMessageZulip(dm ? `user:${sender}` : "stream:debbie:zulip-plugin-pr", "Choose one", {
          cfg: state.core.config,
          channelData: { askUser: { questionId, optionValues: ["Staging", "Production"] } },
          presentation: { blocks: [{ type: "buttons", buttons: [
            { label: "Staging", action: { type: "question", questionId, optionValue: "Staging" } },
            { label: "Production", action: { type: "question", questionId, optionValue: "Production" } },
          ] }] },
        }));
        expect(register).toHaveBeenCalledWith(expect.objectContaining({
          conversation: dm ? { kind: "dm", recipient: sender } : { kind: "stream", stream: "4", topic: "zulip-plugin-pr" },
          deliveryConversation: dm ? { kind: "dm", recipient: sender } : { kind: "stream", stream: "debbie", topic: "zulip-plugin-pr" },
        }));
        const posted = state.client.request.mock.calls.find(([path]) => path === "/messages")!;
        const body = new URLSearchParams(posted[1]!.body);
        const widget = JSON.parse(body.get("widget_content")!);
        const content = form === "native" ? widget.extra_data.choices[1].reply : '<ol start="2"><li>Production</li></ol>';

        if (policy === "revoked group allowlist") state.account.config.groupAllowFrom = ["other@example.test"];
        if (policy === "revoked pairing") {
          state.account.config.allowFrom = [];
          state.pairingAllowFrom = [];
        }
        if (policy === "disabled group") state.account.config.groupPolicy = "disabled";
        if (policy === "disabled DM") state.account.config.dmPolicy = "disabled";
        if (policy === "revoked command access") {
          state.account.config.groupPolicy = "open";
          state.account.config.allowFrom = ["other@example.test"];
          state.account.config.groupAllowFrom = ["other@example.test"];
          state.pairingAllowFrom = [];
        }
        state.sendMessageZulip.mockClear();
        state.client.request.mockClear();
        state.pollResponses = [{ result: "success", events: [1, 2].map((id) => ({
          id, type: "message", message: { ...(dm ? makePrivateMessage(++state.nextQuestionMessageId) : makeChannelMessage(++state.nextQuestionMessageId)), content },
        })) }];
        await runMonitorOnce();
        expect(questionRuntimeMocks.resolveOption).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
        expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
        expect(state.upsertPairingRequest).not.toHaveBeenCalled();
        if (!allowed) {
          expect(state.sendMessageZulip).not.toHaveBeenCalled();
          expect(state.client.request).not.toHaveBeenCalled();
        } else {
          await questionRuntimeMocks.registerChannelDelivery.mock.calls[0]![0].finalize("Answered: Production");
          const replacement = new URLSearchParams(state.client.request.mock.calls.find(([path]) => path === "/messages")![1]!.body);
          expect(replacement.get("to")).toBe(dm ? JSON.stringify([sender]) : "debbie");
          if (!dm) expect(replacement.get("topic")).toBe("zulip-plugin-pr");
          expect(state.deleteZulipMessage).toHaveBeenCalledWith(state.client, { messageId: "9100" });
        }
      } finally {
        register.mockRestore();
        zulipQuestionZformStore.clear();
      }
    });
  });

  it.each([
    { dm: true, policy: "pairing" },
    { dm: true, policy: "allowlist" },
    { dm: true, policy: "disabled" },
    { dm: false, policy: "allowlist" },
    { dm: false, policy: "disabled" },
    { dm: false, policy: "open" },
  ])("silently drops unauthorized unknown and malformed controls: $dm/$policy", async ({ dm, policy }) => {
    const { zulipQuestionZformStore } = await import("./question-zform.js");
    zulipQuestionZformStore.clear();
    questionRuntimeMocks.resolveOption.mockClear();
    state.account.config[dm ? "dmPolicy" : "groupPolicy"] = policy;
    state.account.config.allowFrom = ["other@example.test"];
    state.account.config.groupAllowFrom = ["other@example.test"];
    state.upsertPairingRequest.mockResolvedValue({ code: "123456", created: true });
    const intercept = vi.spyOn(zulipQuestionZformStore, "intercept");
    try {
      state.pollResponses = [{ result: "success", events: [
        "ocq1:kDU1R53ZTUJxIiMrjEHqww:0", "ocq1:malformed", "@**Debbie** ocq1:bad:9",
      ].map((content, index) => ({ id: index + 1, type: "message", message: {
        ...(dm ? makePrivateMessage(++state.nextQuestionMessageId) : makeChannelMessage(++state.nextQuestionMessageId)), content,
      } })) }];
      await runMonitorOnce();
      expect(intercept).not.toHaveBeenCalled();
      expect(questionRuntimeMocks.resolveOption).not.toHaveBeenCalled();
      expect(state.sendMessageZulip).not.toHaveBeenCalled();
      expect(state.upsertPairingRequest).not.toHaveBeenCalled();
      expect(state.core.channel.inbound.buildContext).not.toHaveBeenCalled();
      expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    } finally {
      intercept.mockRestore();
    }
  });

  it("does not consume the unrelated single-item ordered-list content observed in message 58261", async () => {
    const { zulipQuestionZformStore } = await import("./question-zform.js");
    questionRuntimeMocks.resolveOption.mockClear();
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const preparation = zulipQuestionZformStore.prepare({
      channelData: { askUser: { questionId, optionValues: ["Staging", "Production"] } },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Staging", action: { type: "question", questionId, optionValue: "Staging" } },
              { label: "Production", action: { type: "question", questionId, optionValue: "Production" } },
            ],
          },
        ],
      },
    })!;
    zulipQuestionZformStore.clear();
    expect(
      zulipQuestionZformStore.register({
        preparation,
        accountId: "default",
        conversation: { kind: "stream", stream: "4", topic: "zulip-plugin-pr" },
        authorizedSenderId: "user8@zlp.pubnerd.app",
        sourceMessageId: "58260",
        sourceText: "Which option?",
        client: state.client,
      }),
    ).toBe(true);
    try {
      state.pollResponses = [
        {
          result: "success",
          events: [
            {
              id: 1,
              type: "message",
              message: {
                ...makeChannelMessage(58262),
                content: '<ol start="2"><li>It’s just text.</li></ol>',
              },
            },
          ],
        },
      ];

      await runMonitorOnce();

      expect(questionRuntimeMocks.resolveOption).not.toHaveBeenCalled();
      expect(state.core.channel.inbound.buildContext).toHaveBeenCalledOnce();
      expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    } finally {
      zulipQuestionZformStore.clear();
    }
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

    expect(state.core.agent.session.resolveStorePath).not.toHaveBeenCalled();
    expect(state.core.channel.session.recordInboundSession).not.toHaveBeenCalled();
    expect(state.core.channel.inbound.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      cfg: expect.objectContaining({
        session: { store: "/configured/{agentId}/sessions.json" },
      }),
      route: {
        agentId: "debbie",
        sessionKey: expect.stringMatching(/^agent:debbie:zulip:channel:4:topic:v2:[0-9a-f]{64}$/),
      },
      ctxPayload: expect.objectContaining({
        SessionKey: expect.stringMatching(/^agent:debbie:zulip:channel:4:topic:v2:[0-9a-f]{64}$/),
      }),
      record: {
        updateLastRoute: {
          sessionKey: expect.stringMatching(/^agent:debbie:zulip:channel:4:topic:v2:[0-9a-f]{64}$/),
          channel: "zulip",
          to: "stream:4:zulip-plugin-pr",
          accountId: "default",
          threadId: "zulip-plugin-pr",
        },
        onRecordError: expect.any(Function),
      },
    }));
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
    expect(state.core.channel.inbound.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      route: {
        agentId: "debbie",
        sessionKey: expect.stringMatching(
          /^agent:debbie:zulip:default:direct:account-[0-9a-f]{64}:user8@zlp\.pubnerd\.app$/,
        ),
      },
      ctxPayload: expect.objectContaining({
        SessionKey: expect.stringMatching(
          /^agent:debbie:zulip:default:direct:account-[0-9a-f]{64}:user8@zlp\.pubnerd\.app$/,
        ),
      }),
      record: {
        updateLastRoute: {
          sessionKey: expect.stringMatching(
            /^agent:debbie:zulip:default:direct:account-[0-9a-f]{64}:user8@zlp\.pubnerd\.app$/,
          ),
          channel: "zulip",
          to: "user:user8@zlp.pubnerd.app",
          accountId: "default",
        },
        onRecordError: expect.any(Function),
      },
    }));
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
    expect(state.core.channel.inbound.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      route: {
        agentId: "debbie",
        sessionKey: expect.stringMatching(
          /^agent:debbie:zulip:default:direct:account-[0-9a-f]{64}:123$/,
        ),
      },
      ctxPayload: expect.objectContaining({
        SessionKey: expect.stringMatching(
          /^agent:debbie:zulip:default:direct:account-[0-9a-f]{64}:123$/,
        ),
      }),
      record: {
        updateLastRoute: {
          sessionKey: expect.stringMatching(
            /^agent:debbie:zulip:default:direct:account-[0-9a-f]{64}:123$/,
          ),
          channel: "zulip",
          to: "user:123",
          accountId: "default",
        },
        onRecordError: expect.any(Function),
      },
    }));
  });

  it("uses effective connection overrides to isolate private-message sessions", async () => {
    const { buildZulipDirectSessionKey } = await import("../session-conversation.js");
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makePrivateMessage(1102) }],
      },
    ];

    await runMonitorOnce(new AbortController(), undefined, {
      baseUrl: "https://override-realm.example.test",
      email: "override-bot@example.test",
    });

    const expectedSessionKey = buildZulipDirectSessionKey({
      agentId: "debbie",
      accountId: "default",
      baseUrl: "https://override-realm.example.test",
      botIdentity: "override-bot@example.test",
      senderIdentity: "user8@zlp.pubnerd.app",
    });
    expect(state.core.channel.inbound.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      route: { agentId: "debbie", sessionKey: expectedSessionKey },
      ctxPayload: expect.objectContaining({ SessionKey: expectedSessionKey }),
      record: {
        updateLastRoute: {
          sessionKey: expectedSessionKey,
          channel: "zulip",
          to: "user:user8@zlp.pubnerd.app",
          accountId: "default",
        },
        onRecordError: expect.any(Function),
      },
    }));
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

  it("does not pace rejected public-stream traffic ahead of an eligible DM", async () => {
    state.account.config = {
      ...state.account.config,
      streams: ["debbie"],
    };
    const unrelatedEvents = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      type: "message",
      message: {
        ...makeChannelMessage(4000 + index),
        stream_id: 100 + index,
        display_recipient: `unrelated-${index}`,
      },
    }));
    state.pollResponses = [{
      result: "success",
      events: [
        ...unrelatedEvents,
        { id: 21, type: "message", message: makePrivateMessage(4020) },
      ],
    }];

    await runMonitorOnce();

    expect(fetchZulipStreamMock).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
      1,
    );
    expect(state.core.channel.inbound.buildContext).toHaveReturnedWith(
      expect.objectContaining({ ChatType: "direct" }),
    );
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
    expect(state.core.channel.session.recordInboundSession).not.toHaveBeenCalled();
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

  it("keeps configured registration streams when an enabled override is already covered", async () => {
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
  ])("keeps access-group command authorization enabled in open streams (paired=$paired)", async ({ paired, expectedDispatches }) => {
    (state.core.config.commands as { useAccessGroups?: boolean }).useAccessGroups = false;
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

  it("drains legacy keyed-journal records through the queue-backed compatibility journal", async () => {
    enableDurableInboundJournal();
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(2100);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    const pendingStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".pending."),
    )?.[1];
    expect(pendingStore).toBeDefined();
    await pendingStore!.register(durableId, {
      id: durableId,
      payload: {
        message: serializeZulipDurableInboundMessage(message),
        receivedAt: 100,
      },
      receivedAt: 100,
      updatedAt: 100,
      attempts: 2,
      lastAttemptAt: 100,
      lastError: "legacy failure",
    });

    await expect(journal.pending()).resolves.toEqual([
      expect.objectContaining({ id: durableId, attempts: 2, lastError: "legacy failure" }),
    ]);
    await expect(journal.release(durableId, {
      lastError: "retry failure",
      releasedAt: 200,
    })).resolves.toBe(true);
    await expect(journal.pending()).resolves.toEqual([
      expect.objectContaining({ id: durableId, attempts: 3, lastError: "retry failure" }),
    ]);

    await journal.complete(durableId, {
      metadata: { queueEventId: 9 },
      completedAt: 300,
    });
    await expect(journal.pending()).resolves.toEqual([]);
    await expect(journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: 400,
    })).resolves.toEqual(expect.objectContaining({
      kind: "completed",
      duplicate: true,
      record: expect.objectContaining({ completedAt: 300, metadata: { queueEventId: 9 } }),
    }));
  });

  it("does not replay queue records covered by a legacy completion tombstone", async () => {
    enableDurableInboundJournal();
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(2101);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    const queue = state.durableQueues.get(state.account.accountId);
    const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".completed."),
    )?.[1];
    expect(queue).toBeDefined();
    expect(completedStore).toBeDefined();
    await queue!.enqueue(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: 100,
    }, { receivedAt: 100 });
    await completedStore!.register(durableId, {
      id: durableId,
      completedAt: 200,
      metadata: { queueEventId: 10 },
    });
    queue!.complete.mockRejectedValueOnce(new Error("synthetic reconciliation failure"));

    await expect(journal.pending()).resolves.toEqual([]);
    expect(completedStore!.register).toHaveBeenLastCalledWith(
      durableId,
      expect.objectContaining({ completedAt: 200 }),
      { ttlMs: 30 * 24 * 60 * 60 * 1000 },
    );
    expect(queue!.delete).toHaveBeenCalledWith(durableId);
    expect(queue!.complete).toHaveBeenCalledWith(durableId, {
      metadata: { queueEventId: 10 },
      completedAt: 200,
    });
    await expect(journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: 300,
    })).resolves.toEqual(expect.objectContaining({
      kind: "completed",
      duplicate: true,
    }));
  });

  it("suppresses delivery when post-accept legacy completion reconciliation fails", async () => {
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
    const queue = state.durableQueues.get(state.account.accountId);
    const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".completed."),
    )?.[1];
    expect(queue).toBeDefined();
    expect(completedStore).toBeDefined();
    await completedStore!.register(durableId, {
      id: durableId,
      completedAt: 200,
      metadata: { queueEventId: 11 },
    });
    completedStore!.lookup.mockResolvedValueOnce(undefined);
    queue!.complete.mockRejectedValueOnce(new Error("synthetic reconciliation failure"));

    await expect(journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: 300,
    })).resolves.toEqual(expect.objectContaining({
      kind: "completed",
      duplicate: true,
    }));
    await expect(journal.pending()).resolves.toEqual([]);
  });

  it("keeps the queue fallback when completion and tombstone extension fail", async () => {
    enableDurableInboundJournal();
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(2105);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    const queue = state.durableQueues.get(state.account.accountId);
    const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".completed."),
    )?.[1];
    expect(queue).toBeDefined();
    expect(completedStore).toBeDefined();
    await queue!.enqueue(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: 100,
    }, { receivedAt: 100 });
    await completedStore!.register(durableId, {
      id: durableId,
      completedAt: 200,
    });
    queue!.complete.mockRejectedValueOnce(new Error("synthetic completion failure"));
    completedStore!.register.mockRejectedValueOnce(new Error("synthetic extension failure"));

    await expect(journal.pending()).resolves.toEqual([]);
    expect(queue!.delete).not.toHaveBeenCalled();
  });

  it("defers delivery when the post-accept legacy completion lookup fails", async () => {
    enableDurableInboundJournal();
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makeChannelMessage(2103);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
      namespace.includes(".completed."),
    )?.[1];
    expect(completedStore).toBeDefined();
    completedStore!.lookup
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("synthetic legacy lookup failure"));

    await expect(journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: 300,
    })).resolves.toEqual(expect.objectContaining({
      kind: "pending",
      duplicate: true,
    }));
    await expect(journal.pending()).resolves.toEqual([
      expect.objectContaining({ id: durableId }),
    ]);
  });

  it("retries a post-accept legacy lookup deferral without waiting for restart", async () => {
    enableDurableInboundJournal({ completedLookupFailuresAfterAccept: 1 });
    state.autoAbort = false;
    const controller = new AbortController();
    state.pollResponses = [{
      result: "success",
      events: [{ id: 12, type: "message", message: makeChannelMessage(2199) }],
    }];

    const monitorPromise = runMonitorOnce(controller);
    await vi.waitFor(() => {
      const queue = state.durableQueues.get(state.account.accountId);
      expect(queue?.complete).toHaveBeenCalledWith(expect.any(String), {
        metadata: { queueEventId: 12 },
        completedAt: expect.any(Number),
      });
    });
    controller.abort();
    await monitorPromise;

    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
  });

  it("retries only the deferred durable message while another message is in flight", async () => {
    const { createZulipDurableInboundMessageId } = await import("./durable-receive.js");
    const firstMessage = makeChannelMessage(99200);
    const deferredMessage = makeChannelMessage(99201);
    const deferredDurableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(deferredMessage.id),
    });
    enableDurableInboundJournal({ completedLookupFailureIds: [deferredDurableId] });
    state.autoAbort = false;
    const controller = new AbortController();
    let releaseFirstReply!: () => void;
    const firstReplyRelease = new Promise<void>((resolve) => {
      releaseFirstReply = resolve;
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async () => {
        await firstReplyRelease;
        return { counts: { tool: 0, block: 0, final: 1 } };
      })
      .mockImplementationOnce(async () => {
        releaseFirstReply();
        controller.abort();
        return { counts: { tool: 0, block: 0, final: 1 } };
      });
    state.pollResponses = [{
      result: "success",
      events: [
        { id: 15, type: "message", message: firstMessage },
        { id: 16, type: "message", message: deferredMessage },
      ],
    }];

    await runMonitorOnce(controller);

    expect(
      state.core.channel.inbound.buildContext.mock.calls.map(([input]) => input.messageId),
    ).toEqual(["99200", "99201"]);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
  });

  it("retries deferred durable replay after a transient pending-list failure", async () => {
    const { createZulipDurableInboundMessageId } = await import("./durable-receive.js");
    const message = makeChannelMessage(99202);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    enableDurableInboundJournal({
      completedLookupFailureIds: [durableId],
      deferredPendingListFailures: 1,
    });
    state.autoAbort = false;
    const controller = new AbortController();
    const runtimeError = vi.fn();
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async () => {
        controller.abort();
        return { counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    state.pollResponses = [{
      result: "success",
      events: [{ id: 17, type: "message", message }],
    }];

    await runMonitorOnce(controller, {
      log: vi.fn(),
      error: runtimeError,
      exit: vi.fn(),
    });

    const queue = state.durableQueues.get(state.account.accountId);
    expect(queue?.listPending).toHaveBeenCalledTimes(3);
    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("synthetic deferred pending-list failure"),
    );
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying a deferred durable message after transient replay metadata failure", async () => {
    const { createZulipDurableInboundMessageId } = await import("./durable-receive.js");
    const message = makeChannelMessage(99203);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    enableDurableInboundJournal({ completedLookupFailureIds: [durableId] });
    state.autoAbort = false;
    state.streamLookups.set("4", new Error("synthetic replay metadata failure"));
    const controller = new AbortController();
    state.pollResponses = [{
      result: "success",
      events: [{ id: 18, type: "message", message }],
    }];

    const monitorPromise = runMonitorOnce(controller);
    await vi.waitFor(() => {
      const queue = state.durableQueues.get(state.account.accountId);
      expect(queue?.release).toHaveBeenCalledWith(durableId, {
        lastError: "Zulip stream metadata unavailable during durable replay",
      });
    });
    state.streamLookups.set("4", { id: 4, name: "debbie", invite_only: false });
    await vi.waitFor(() => {
      const queue = state.durableQueues.get(state.account.accountId);
      expect(queue?.complete).toHaveBeenCalledWith(durableId, {
        metadata: { queueEventId: 18 },
        completedAt: expect.any(Number),
      });
    });
    controller.abort();
    await monitorPromise;

    expect(fetchZulipStreamMock).toHaveBeenCalledTimes(2);
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("retries only journal completion after a deferred reply was delivered", async () => {
    const { createZulipDurableInboundMessageId } = await import("./durable-receive.js");
    const message = makePrivateMessage(99206);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    enableDurableInboundJournal({
      completedLookupFailureIds: [durableId],
      queueCompletionFailures: 1,
    });
    state.autoAbort = false;
    const controller = new AbortController();
    state.pollResponses = [{
      result: "success",
      events: [{ id: 21, type: "message", message }],
    }];

    const monitorPromise = runMonitorOnce(controller);
    await vi.waitFor(() => {
      const queue = state.durableQueues.get(state.account.accountId);
      expect(queue?.complete).toHaveBeenCalledTimes(2);
    });
    controller.abort();
    await monitorPromise;

    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("retries only journal completion after a live reply was delivered", async () => {
    enableDurableInboundJournal({ queueCompletionFailures: 1 });
    state.autoAbort = false;
    const controller = new AbortController();
    state.pollResponses = [{
      result: "success",
      events: [{ id: 22, type: "message", message: makePrivateMessage(99207) }],
    }];

    const monitorPromise = runMonitorOnce(controller);
    await vi.waitFor(() => {
      const queue = state.durableQueues.get(state.account.accountId);
      expect(queue?.complete).toHaveBeenCalledTimes(2);
    });
    controller.abort();
    await monitorPromise;

    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("does not let one retryable deferred message starve a later ready message", async () => {
    const { createZulipDurableInboundMessageId } = await import("./durable-receive.js");
    const retryableMessage = makeChannelMessage(99204);
    const readyMessage = makePrivateMessage(99205);
    const retryableDurableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(retryableMessage.id),
    });
    const readyDurableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(readyMessage.id),
    });
    enableDurableInboundJournal({
      completedLookupFailureIds: [retryableDurableId, readyDurableId],
    });
    state.autoAbort = false;
    state.streamLookups.set("4", new Error("persistent replay metadata failure"));
    const controller = new AbortController();
    state.pollResponses = [{
      result: "success",
      events: [
        { id: 19, type: "message", message: retryableMessage },
        { id: 20, type: "message", message: readyMessage },
      ],
    }];

    vi.useFakeTimers();
    const startedAt = Date.now();
    const monitorPromise = runMonitorOnce(controller);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const queue = state.durableQueues.get(state.account.accountId);
      expect(queue?.release).toHaveBeenCalledExactlyOnceWith(retryableDurableId, {
        lastError: "Zulip stream metadata unavailable during durable replay",
      });
      expect(queue?.complete).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(queue?.release).toHaveBeenCalledTimes(1);
      expect(queue?.complete).toHaveBeenCalledExactlyOnceWith(readyDurableId, {
        metadata: { queueEventId: 20 },
        completedAt: startedAt + 200,
      });
      expect(
        state.core.channel.inbound.buildContext.mock.calls.map(([input]) => input.messageId),
      ).toEqual(["99205"]);
      expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(49);
      expect(queue?.release).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(queue?.release).toHaveBeenCalledTimes(2);
      expect(queue?.release).toHaveBeenLastCalledWith(retryableDurableId, {
        lastError: "Zulip stream metadata unavailable during durable replay",
      });
      expect(queue?.complete).toHaveBeenCalledTimes(1);
      expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
      expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      try {
        await monitorPromise;
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("serializes deferred durable replay and queues one follow-up pass", async () => {
    enableDurableInboundJournal({ completedLookupFailuresAfterAccept: 2 });
    state.autoAbort = false;
    const controller = new AbortController();
    let releaseFirstReply!: () => void;
    let markFirstReplyStarted!: () => void;
    const firstReplyStarted = new Promise<void>((resolve) => {
      markFirstReplyStarted = resolve;
    });
    const firstReplyRelease = new Promise<void>((resolve) => {
      releaseFirstReply = resolve;
    });
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async () => {
        markFirstReplyStarted();
        await firstReplyRelease;
        return { counts: { tool: 0, block: 0, final: 1 } };
      })
      .mockImplementationOnce(async () => {
        controller.abort();
        return { counts: { tool: 0, block: 0, final: 1 } };
      });
    state.pollResponses = [{
      result: "success",
      events: [
        { id: 13, type: "message", message: makeChannelMessage(99100) },
        { id: 14, type: "message", message: makeChannelMessage(99101) },
      ],
    }];

    const monitorPromise = runMonitorOnce(controller);
    await firstReplyStarted;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    releaseFirstReply();
    await monitorPromise;

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(2);
  });

  it("completes fresh durable inbound messages without filling the legacy tombstone store", async () => {
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
    await expect(completedStore?.entries()).resolves.toEqual([]);
    const queue = state.durableQueues.get(state.account.accountId);
    expect(queue?.complete).toHaveBeenCalledWith(expect.any(String), {
      metadata: { queueEventId: 2 },
      completedAt: expect.any(Number),
    });
    expect(state.core.channel.inbound.buildContext).toHaveBeenCalledTimes(1);
  });

  it("marks an opt-in handled stream message read only after durable completion", async () => {
    enableDurableInboundJournal();
    state.account.config.markHandledRead = true;
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "handled reply" });
        return { counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    state.pollResponses = [{
      result: "success",
      events: [{ id: 23, type: "message", message: makeChannelMessage(2120) }],
    }];

    await runMonitorOnce();

    const queue = state.durableQueues.get(state.account.accountId);
    expect(queue?.complete).toHaveBeenCalledTimes(1);
    expect(state.updateZulipMessageFlags).toHaveBeenCalledExactlyOnceWith(state.client, {
      messageIds: ["2120"],
      flag: "read",
      op: "add",
    });
    expect(queue?.complete.mock.invocationCallOrder[0]).toBeLessThan(
      state.updateZulipMessageFlags.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("marks an opt-in silent DM completion read", async () => {
    enableDurableInboundJournal();
    state.account.config.markHandledRead = true;
    state.pollResponses = [{
      result: "success",
      events: [{ id: 24, type: "message", message: makePrivateMessage(2121) }],
    }];

    await runMonitorOnce();

    expect(state.sendMessageZulip).not.toHaveBeenCalled();
    expect(state.updateZulipMessageFlags).toHaveBeenCalledExactlyOnceWith(state.client, {
      messageIds: ["2121"],
      flag: "read",
      op: "add",
    });
  });

  it("does not mark a failed delivery read", async () => {
    enableDurableInboundJournal();
    state.account.config.markHandledRead = true;
    state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async () => ({
        counts: { tool: 0, block: 0, final: 0 },
        failedCounts: { tool: 0, block: 0, final: 1 },
      }),
    );
    const failed = makeChannelMessage(2122);
    state.pollResponses = [{
      result: "success",
      events: [{ id: 25, type: "message", message: failed }],
    }];

    await runMonitorOnce();

    expect(state.updateZulipMessageFlags).not.toHaveBeenCalled();
  });

  it("does not mark unauthorized, duplicate, or already-read messages newly read", async () => {
    enableDurableInboundJournal();
    state.account.config.markHandledRead = true;
    const alreadyRead = makeChannelMessage(2123);

    state.pollResponses = [{
      result: "success",
      events: [{ id: 26, type: "message", message: alreadyRead, flags: ["read"] }],
    }];
    await runMonitorOnce();
    expect(state.updateZulipMessageFlags).not.toHaveBeenCalled();

    state.account.config.dmPolicy = "disabled";
    state.pollResponses = [{
      result: "success",
      events: [{ id: 27, type: "message", message: makePrivateMessage(2124) }],
    }];
    await runMonitorOnce();
    expect(state.updateZulipMessageFlags).not.toHaveBeenCalled();

    state.account.config.dmPolicy = "open";
    const handled = makePrivateMessage(2127);
    state.pollResponses = [{
      result: "success",
      events: [{ id: 28, type: "message", message: handled }],
    }];
    await runMonitorOnce();
    expect(state.updateZulipMessageFlags).toHaveBeenCalledTimes(1);

    state.pollResponses = [{
      result: "success",
      events: [{ id: 29, type: "message", message: handled }],
    }];
    await runMonitorOnce();
    expect(state.updateZulipMessageFlags).toHaveBeenCalledTimes(1);
  });

  it("keeps mark-read failure observable without replaying a completed reply", async () => {
    enableDurableInboundJournal();
    state.account.config.markHandledRead = true;
    state.updateZulipMessageFlags.mockRejectedValueOnce(new Error("synthetic mark-read failure"));
    const runtimeError = vi.fn();
    state.pollResponses = [{
      result: "success",
      events: [{ id: 31, type: "message", message: makePrivateMessage(2125) }],
    }];

    await runMonitorOnce(new AbortController(), {
      log: vi.fn(),
      error: runtimeError,
      exit: vi.fn(),
    });

    expect(runtimeError).toHaveBeenCalledWith(
      "zulip: failed to mark handled inbound message 2125 read: Error: synthetic mark-read failure",
    );
    const queue = state.durableQueues.get(state.account.accountId);
    expect(queue?.listPending).toHaveBeenCalled();
    await expect(queue?.listPending()).resolves.toEqual([]);

    await runMonitorOnce();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(state.updateZulipMessageFlags).toHaveBeenCalledTimes(1);
  });

  it("marks read once after completion-only retry succeeds without redispatch", async () => {
    enableDurableInboundJournal({ queueCompletionFailures: 1 });
    state.account.config.markHandledRead = true;
    state.autoAbort = false;
    const controller = new AbortController();
    state.pollResponses = [{
      result: "success",
      events: [{ id: 30, type: "message", message: makePrivateMessage(2126) }],
    }];

    const monitorPromise = runMonitorOnce(controller);
    await vi.waitFor(() => {
      const queue = state.durableQueues.get(state.account.accountId);
      expect(queue?.complete).toHaveBeenCalledTimes(2);
      expect(state.updateZulipMessageFlags).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    await monitorPromise;

    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(state.updateZulipMessageFlags).toHaveBeenCalledExactlyOnceWith(state.client, {
      messageIds: ["2126"],
      flag: "read",
      op: "add",
    });
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
    await expect(completedStore?.entries()).resolves.toEqual([]);
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
    await expect(completedStore?.entries()).resolves.toEqual([]);
    expect(state.sendMessageZulip).toHaveBeenNthCalledWith(
      3,
      "stream:4:zulip-plugin-pr",
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

      const { createZulipDurableInboundReceiveJournal } = await import("./durable-receive.js");
      const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
      const completedStore = Array.from(state.durableStores.entries()).find(([namespace]) =>
        namespace.includes(".completed."),
      )?.[1];
      await expect(journal.pending()).resolves.toHaveLength(1);
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

      await expect(journal.pending()).resolves.toEqual([]);
      await expect(completedStore?.entries()).resolves.toEqual([]);
      expect(
        state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      ).toHaveBeenCalledTimes(1);
      expect(dispatchAttempts).toBe(2);
    },
  );

  it("completes durable inbound after a visible partial reply even when final delivery fails", async () => {
    enableDurableInboundJournal();
    state.account.config.markHandledRead = true;
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
    await expect(completedStore?.entries()).resolves.toEqual([]);
    expect(state.addZulipReaction).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ messageId: "2110", emojiName: "cross_mark" }),
    );
    expect(
      state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).toHaveBeenCalledTimes(1);
    expect(state.updateZulipMessageFlags).not.toHaveBeenCalled();
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

  it("retries only journal completion after a startup replay was delivered", async () => {
    enableDurableInboundJournal({ queueCompletionFailures: 1 });
    const {
      createZulipDurableInboundMessageId,
      createZulipDurableInboundReceiveJournal,
      serializeZulipDurableInboundMessage,
    } = await import("./durable-receive.js");
    const message = makePrivateMessage(99208);
    const durableId = createZulipDurableInboundMessageId({
      accountId: state.account.accountId,
      messageId: String(message.id),
    });
    const journal = createZulipDurableInboundReceiveJournal(state.account.accountId);
    await journal.accept(durableId, {
      message: serializeZulipDurableInboundMessage(message),
      receivedAt: Date.now(),
    });
    state.autoAbort = false;
    state.pollResponses = [{ result: "success", events: [] }];
    const controller = new AbortController();

    const monitorPromise = runMonitorOnce(controller);
    await vi.waitFor(() => {
      const queue = state.durableQueues.get(state.account.accountId);
      expect(queue?.complete).toHaveBeenCalledTimes(2);
    });
    controller.abort();
    await monitorPromise;

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
    await expect(completedStore?.entries()).resolves.toEqual([]);

    state.removeZulipReaction.mockResolvedValue(undefined);
    state.autoAbort = true;
    await runMonitorOnce();
    expect(state.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("retries same-process durable replay after a handler failure despite volatile dedupe", async () => {
    enableDurableInboundJournal();
    const message = makeChannelMessage(2104);
    state.core.channel.inbound.dispatch.mockRejectedValueOnce(
      new Error("synthetic post-dedupe failure"),
    );
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
    expect(state.core.channel.inbound.dispatch).toHaveBeenCalledTimes(2);
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

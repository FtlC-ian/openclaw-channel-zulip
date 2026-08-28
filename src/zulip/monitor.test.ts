import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";

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
    durableStores: new Map<string, ReturnType<typeof createMemoryKeyedStore>>(),
    pollResponses: [] as Array<Record<string, unknown>>,
    pairingAllowFrom: [] as string[],
    streamSubscriptions: [] as Array<Record<string, unknown>>,
    streamLookups: new Map<string, Record<string, unknown> | Error>(),
    downloadedUploads: [] as Array<{ buffer: Buffer; contentType: string; filename: string }>,
    extractedUploadUrls: [] as string[],
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
  if (state.abortController && state.pollResponses.length === 0) {
    state.abortController.abort();
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
  addZulipReaction: vi.fn(async () => {}),
  removeZulipReaction: vi.fn(async () => {}),
}));

vi.mock("./accounts.js", () => ({
  resolveZulipRuntimeAccount: vi.fn(async () => state.account),
}));

vi.mock("./send.js", () => ({
  sendMessageZulip: vi.fn(async () => {}),
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
    upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: false })),
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

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
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

async function runMonitorOnce() {
  const { monitorZulipProvider } = await import("./monitor.js");
  state.abortController = new AbortController();
  await monitorZulipProvider({
    config: state.core.config,
    abortSignal: state.abortController.signal,
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
  beforeEach(() => {
    state.core = state.createCore();
    state.core.channel.inbound.buildContext.mockImplementation(buildChannelInboundEventContext);
    state.durableStores = new Map();
    state.pairingAllowFrom = [];
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
    downloadZulipUploadMock.mockClear();
    extractZulipUploadUrlsMock.mockClear();
    registerZulipQueueMock.mockClear();
    getZulipEventsWithRetryMock.mockClear();
    deleteZulipQueueMock.mockClear();
    fetchZulipSubscriptionsMock.mockClear();
    fetchZulipStreamMock.mockClear();
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
    expect(dispatcherCall?.onReplyStart).toBe(typingCallbacks?.onReplyStart);
    expect(dispatcherCall?.onIdle).toBe(typingCallbacks?.onIdle);
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

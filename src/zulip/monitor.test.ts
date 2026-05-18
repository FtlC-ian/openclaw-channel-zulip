import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
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
    system: {
      enqueueSystemEvent: vi.fn(),
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
      reply: {
        formatInboundEnvelope: vi.fn(({ body }: { body: string }) => body),
        finalizeInboundContext: vi.fn((payload: Record<string, unknown>) => payload),
        resolveHumanDelayConfig: vi.fn(() => undefined),
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        dispatchReplyFromConfig: vi.fn(async () => {}),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/openclaw-session-store.json"),
        updateLastRoute: vi.fn(async () => {}),
      },
      pairing: {
        buildPairingReply: vi.fn(() => "pairing reply"),
      },
    },
  });

  return {
    abortController: undefined as AbortController | undefined,
    pollResponses: [] as Array<Record<string, unknown>>,
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
  createScopedPairingAccess: vi.fn(() => ({
    upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: false })),
    readStoreForDmPolicy: vi.fn(async () => []),
  })),
}));

vi.mock("openclaw/plugin-sdk/channel-runtime", () => ({
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: vi.fn() })),
  createTypingCallbacks: typingCallbacksMock,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  logInboundDrop: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  logTypingFailure: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  buildPendingHistoryContextFromMap: vi.fn(() => undefined),
  clearHistoryEntriesIfEnabled: vi.fn(),
  DEFAULT_GROUP_HISTORY_LIMIT: 20,
  recordPendingHistoryEntryIfEnabled: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/command-auth", () => ({
  resolveControlCommandGate: vi.fn(() => ({ shouldBlock: false, commandAuthorized: true })),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  resolveChannelMediaMaxBytes: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp"),
}));

vi.mock("openclaw/plugin-sdk/channel-policy", () => ({
  readStoreAllowFromForDmPolicy: vi.fn(async () => []),
  resolveDmGroupAccessWithLists: vi.fn(
    ({ allowFrom, groupAllowFrom }: { allowFrom: string[]; groupAllowFrom: string[] }) => ({
      effectiveAllowFrom: allowFrom,
      effectiveGroupAllowFrom: groupAllowFrom,
    }),
  ),
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

describe("monitorZulipProvider", () => {
  beforeEach(() => {
    state.core = state.createCore();
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

    const dispatcherCall = state.core.channel.reply.createReplyDispatcherWithTyping.mock.calls[0]?.[0];
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

    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
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

    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
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

    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
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
    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "channel",
        ChannelPrivacy: "unknown",
        IsPrivateChannel: undefined,
        StreamId: "404",
      }),
    );
    expect(state.core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
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

    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaPath: expect.stringMatching(/^\/tmp\/zulip-upload-[^/]+\/evil_name\.pdf$/),
        MediaType: "application/pdf",
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
    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaPath: "/managed/song.mp3",
        MediaPaths: ["/managed/song.mp3", "/managed/image.png", "/managed/report.pdf"],
        MediaUrl: "/managed/song.mp3",
        MediaUrls: ["/managed/song.mp3", "/managed/image.png", "/managed/report.pdf"],
        MediaType: "audio/mpeg",
        MediaTypes: ["audio/mpeg", "image/png", "application/pdf"],
      }),
    );
  });

  it("stores last-route delivery context for stream-topic messages", async () => {
    state.pollResponses = [
      {
        result: "success",
        events: [{ id: 1, type: "message", message: makeChannelMessage(1002) }],
      },
    ];

    await runMonitorOnce();

    expect(state.core.channel.session.updateLastRoute).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-session-store.json",
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

    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
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

    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
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

    expect(state.core.channel.reply.finalizeInboundContext).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
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

    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
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

    expect(state.core.channel.reply.finalizeInboundContext).not.toHaveBeenCalled();
    expect(state.core.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
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

    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
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

    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(state.core.channel.reply.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
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
    expect(state.core.channel.reply.finalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(state.core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});

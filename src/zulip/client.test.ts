import { describe, expect, it, vi } from "vitest";
import {
  addZulipReaction,
  createZulipClient,
  createZulipReadBatcher,
  getZulipEventsWithRetry,
  fetchZulipMessages,
  registerZulipQueue,
  removeZulipReaction,
  searchZulipMessages,
  sendZulipStreamMessage,
  updateZulipMessageFlags,
  zulipRequestWithRetry,
  type ZulipRequestLogger,
} from "./client.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("registerZulipQueue", () => {
  it("does not narrow a single configured stream out of direct-message events", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        result: "success",
        queue_id: "queue-1",
        last_event_id: 17,
      }),
    );
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await expect(
      registerZulipQueue(client, {
        eventTypes: ["message"],
        streams: ["debbie"],
      }),
    ).resolves.toEqual({ queueId: "queue-1", lastEventId: 17 });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(url).toBe("https://zulip.example.test/api/v1/register");
    expect(body.get("event_types")).toBe('["message"]');
    expect(body.get("all_public_streams")).toBe("true");
    expect(JSON.parse(body.get("client_capabilities")!)).toEqual({
      notification_settings_null: false,
      empty_topic_name: true,
    });
    expect(body.has("narrow")).toBe(false);
  });
});

describe("empty-topic history", () => {
  it.each(["read", "search"])("keeps the empty-topic narrow on %s", async (action) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success", messages: [] }));
    const client = createZulipClient({ baseUrl: "https://zulip.example.test", email: "bot@example.test", apiKey: "synthetic", fetchImpl });
    if (action === "read") await fetchZulipMessages(client, { stream: "42", topic: "" });
    else await searchZulipMessages(client, { query: "release", stream: "42", topic: "" });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(JSON.parse(url.searchParams.get("narrow")!)).toContainEqual({ operator: "topic", operand: "" });
    expect(url.searchParams.get("allow_empty_topic_name")).toBe("true");
  });
});

describe("sendZulipStreamMessage", () => {
  it.each([
    { topic: "", allowEmptyTopicName: "true" },
    { topic: "release", allowEmptyTopicName: null },
  ])("sets the empty-topic opt-in only for an empty topic", async ({ topic, allowEmptyTopicName }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ result: "success", id: 42 }),
    );
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test",
      email: "bot@example.test",
      apiKey: "synthetic",
      fetchImpl,
    });

    await sendZulipStreamMessage(client, { stream: "general", topic, content: "hello" });

    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.get("topic")).toBe(topic);
    expect(body.get("allow_empty_topic_name")).toBe(allowEmptyTopicName);
  });
});

describe("createZulipClient", () => {
  it("preserves Retry-After metadata on direct request errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { result: "error", msg: "rate limited" },
        { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "5" } },
      ),
    );
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test",
      email: "bot@example.test",
      apiKey: "***",
      fetchImpl,
    });

    await expect(client.request("/messages/1", { method: "PATCH" })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 5_000,
    });
  });
});

describe("zulipRequestWithRetry", () => {
  it("requests identity encoding so Zulip responses are not parsed while still gzipped", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success", events: [] }));
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await zulipRequestWithRetry(client, "/events", { method: "GET" }, { maxRetries: 0 });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept-Encoding")).toBe("identity");
  });

  it("retries thrown fetch/network exceptions and logs retry events", async () => {
    const retry = vi.fn<NonNullable<ZulipRequestLogger["retry"]>>();
    const failure = vi.fn<NonNullable<ZulipRequestLogger["failure"]>>();
    const networkError = new TypeError("fetch failed");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(jsonResponse({ result: "success", value: 42 }));
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
      log: { retry, failure },
    });

    const result = await zulipRequestWithRetry<{ value: number }>(
      client,
      "/events",
      { method: "GET" },
      { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
    );

    expect(result.value).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledWith({
      path: "/events",
      method: "GET",
      attempt: 0,
      maxRetries: 1,
      waitMs: 0,
      error: "fetch failed",
    });
    expect(failure).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it("logs and rethrows thrown fetch/network exceptions after retries are exhausted", async () => {
    const retry = vi.fn<NonNullable<ZulipRequestLogger["retry"]>>();
    const failure = vi.fn<NonNullable<ZulipRequestLogger["failure"]>>();
    const networkError = new TypeError("socket hang up");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(networkError);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
      log: { retry, failure },
    });

    await expect(
      zulipRequestWithRetry(client, "/events", undefined, {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
    ).rejects.toThrow(networkError);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith({
      path: "/events",
      method: "GET",
      attempt: 1,
      maxRetries: 1,
      error: "socket hang up",
    });
    random.mockRestore();
  });

  it("preserves HTTP retry behavior and logs retry events", async () => {
    const retry = vi.fn<NonNullable<ZulipRequestLogger["retry"]>>();
    const failure = vi.fn<NonNullable<ZulipRequestLogger["failure"]>>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { result: "error", msg: "rate limited" },
          { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "0" } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ result: "success", events: [] }));
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
      log: { retry, failure },
    });

    const result = await zulipRequestWithRetry<{ events: unknown[] }>(client, "/events", undefined, {
      maxRetries: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      rateLimitDelayMs: 0,
    });

    expect(result.events).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledWith({
      path: "/events",
      method: "GET",
      attempt: 0,
      maxRetries: 1,
      status: 429,
      statusText: "Too Many Requests",
      retryAfterMs: 0,
      waitMs: 0,
      detail: "rate limited",
    });
    expect(failure).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it("preserves HTTP failure behavior and logs final failure events", async () => {
    const retry = vi.fn<NonNullable<ZulipRequestLogger["retry"]>>();
    const failure = vi.fn<NonNullable<ZulipRequestLogger["failure"]>>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { result: "error", msg: "bad gateway" },
          { status: 502, statusText: "Bad Gateway" },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { result: "error", msg: "still bad gateway" },
          { status: 502, statusText: "Bad Gateway" },
        ),
      );
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
      log: { retry, failure },
    });

    await expect(
      zulipRequestWithRetry(client, "/events", { method: "POST" }, {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
    ).rejects.toMatchObject({ status: 502 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith({
      path: "/events",
      method: "POST",
      attempt: 1,
      maxRetries: 1,
      status: 502,
      statusText: "Bad Gateway",
      retryAfterMs: undefined,
      detail: "still bad gateway",
    });
    random.mockRestore();
  });
});

describe("Zulip reactions", () => {
  const reactionClient = (body: Record<string, unknown>) => createZulipClient({
    baseUrl: "https://zulip.example.test/",
    email: "bot@example.test",
    apiKey: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body)),
  });
  const ref = { messageId: "123", emojiName: "octopus" };

  it.each([
    { name: "duplicate add", op: addZulipReaction, body: { result: "error", msg: "Reaction already exists" } },
    { name: "already-removed by message", op: removeZulipReaction, body: { result: "error", msg: "Reaction doesn't exist." } },
    { name: "already-removed by code", op: removeZulipReaction, body: { result: "error", code: "REACTION_DOES_NOT_EXIST", msg: "unrecognized wording" } },
  ])("treats $name as idempotent success", async ({ op, body }) => {
    await expect(op(reactionClient(body), ref)).resolves.toBeUndefined();
  });

  it.each([
    { name: "remove", op: removeZulipReaction, msg: "Emoji 'bogus' does not exist" },
    { name: "add", op: addZulipReaction, msg: "Invalid emoji name" },
  ])("still reports non-idempotent $name errors", async ({ name, op, msg }) => {
    await expect(op(reactionClient({ result: "error", msg }), ref)).rejects.toThrow(`Zulip ${name} reaction failed: ${msg}`);
  });
});

describe("Zulip message flags", () => {
  it("updates a safe batch without replacing unrelated message flags", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ result: "success" }),
    );
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await updateZulipMessageFlags(client, {
      messageIds: [101, "102"],
      flag: "read",
      op: "add",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(url).toBe("https://zulip.example.test/api/v1/messages/flags");
    expect(body.get("messages")).toBe("[101,102]");
    expect(body.get("flag")).toBe("read");
    expect(body.get("op")).toBe("add");
  });

  it("rejects invalid or empty batches before requesting Zulip", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await expect(updateZulipMessageFlags(client, {
      messageIds: ["103oops"],
      flag: "read",
      op: "add",
    })).rejects.toThrow("Invalid messageId");
    await expect(updateZulipMessageFlags(client, {
      messageIds: [],
      flag: "read",
      op: "add",
    })).rejects.toThrow("At least one messageId is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("coalesces concurrent read updates and deduplicates message ids", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ result: "success" }),
    );
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });
    const batcher = createZulipReadBatcher(client);

    await Promise.all([
      batcher.markRead("104"),
      batcher.markRead(105),
      batcher.markRead("104"),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("messages")).toBe("[104,105]");
  });
});


describe("event long-poll cancellation", () => {
  it("aborts an in-flight fetch without retrying and removes its signal listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const signal = init!.signal!;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return jsonResponse({ result: "success", events: [] });
    });
    const client = createZulipClient({ baseUrl: "https://zulip.example.test", email: "bot@example.test", apiKey: "test-key", fetchImpl });
    const polling = getZulipEventsWithRetry(client, { queueId: "queue-1", lastEventId: 0, signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(polling).rejects.toThrow("Aborted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes the long-poll abort listener after a successful request", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success", events: [] }));
    const client = createZulipClient({ baseUrl: "https://zulip.example.test", email: "bot@example.test", apiKey: "test-key", fetchImpl });
    await getZulipEventsWithRetry(client, { queueId: "queue-1", lastEventId: 0, signal: controller.signal });
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
  });
});

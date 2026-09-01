import { describe, expect, it, vi } from "vitest";
import {
  addZulipReaction,
  createZulipClient,
  createZulipReadBatcher,
  registerZulipQueue,
  removeZulipReaction,
  updateZulipMessageFlag,
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
    expect(body.has("narrow")).toBe(false);
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
  it("treats duplicate add-reaction responses as idempotent success", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ result: "error", msg: "Reaction already exists" }));
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await expect(
      addZulipReaction(client, { messageId: "123", emojiName: "octopus" }),
    ).resolves.toBeUndefined();
  });

  it("treats already-removed reaction responses as idempotent success", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ result: "error", msg: "Reaction doesn't exist." }));
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await expect(
      removeZulipReaction(client, { messageId: "123", emojiName: "octopus" }),
    ).resolves.toBeUndefined();
  });

  it("treats REACTION_DOES_NOT_EXIST code as idempotent success", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        result: "error",
        code: "REACTION_DOES_NOT_EXIST",
        msg: "Reaction doesn't exist.",
      }),
    );
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await expect(
      removeZulipReaction(client, { messageId: "123", emojiName: "octopus" }),
    ).resolves.toBeUndefined();
  });

  it("does not treat invalid emoji remove errors as idempotent success", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ result: "error", msg: "Emoji 'bogus' does not exist" }));
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await expect(
      removeZulipReaction(client, { messageId: "123", emojiName: "bogus" }),
    ).rejects.toThrow("Zulip remove reaction failed: Emoji 'bogus' does not exist");
  });

  it("still reports non-idempotent reaction errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ result: "error", msg: "Invalid emoji name" }));
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await expect(
      addZulipReaction(client, { messageId: "123", emojiName: "not an emoji" }),
    ).rejects.toThrow("Zulip add reaction failed: Invalid emoji name");
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

  it("keeps the single-message starred action compatible", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ result: "success" }),
    );
    const client = createZulipClient({
      baseUrl: "https://zulip.example.test/",
      email: "bot@example.test",
      apiKey: "secret",
      fetchImpl,
    });

    await updateZulipMessageFlag(client, {
      messageId: "103",
      flag: "starred",
      op: "remove",
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("messages")).toBe("[103]");
    expect(body.get("flag")).toBe("starred");
    expect(body.get("op")).toBe("remove");
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

import { describe, expect, it, vi } from "vitest";
import { createZulipClient, zulipRequestWithRetry, type ZulipRequestLogger } from "./client.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

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

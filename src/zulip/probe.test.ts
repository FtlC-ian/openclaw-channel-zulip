import { describe, expect, it, vi } from "vitest";
import { probeZulip } from "./probe.js";

const sdkState = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: sdkState.fetchWithSsrFGuard,
}));

describe("probeZulip", () => {
  it("requests identity encoding for the Zulip auth probe", async () => {
    const release = vi.fn(async () => {});
    sdkState.fetchWithSsrFGuard.mockResolvedValueOnce({
      release,
      response: new Response(
        JSON.stringify({
          result: "success",
          user_id: 123,
          email: "bot@example.test",
          full_name: "Bot",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    });

    const result = await probeZulip("https://zulip.example.test", "bot@example.test", "secret");

    expect(result.ok).toBe(true);
    expect(sdkState.fetchWithSsrFGuard).toHaveBeenCalledWith({
      url: "https://zulip.example.test/api/v1/users/me",
      init: {
        headers: {
          Authorization: "Basic Ym90QGV4YW1wbGUudGVzdDpzZWNyZXQ=",
          "Accept-Encoding": "identity",
        },
        signal: expect.any(AbortSignal),
      },
    });
    expect(release).toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

// Run the SDK's real SSRF guard, but resolve every hostname to a private address
// and answer requests locally, as a self-hosted Zulip behind split-horizon DNS would.
const guardState = vi.hoisted(() => ({ requested: [] as string[] }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: (async () => [{ address: "10.20.30.40", family: 4 }]) as never,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          guardState.requested.push(url);
          return url.endsWith("/api/v1/users/me")
            ? new Response(JSON.stringify({ result: "success", user_id: 7, email: "bot@zulip.internal.test", full_name: "Bot" }), {
              status: 200, headers: { "content-type": "application/json" },
            })
            : new Response("PNGDATA", { status: 200, headers: { "content-type": "image/png", "content-length": "7" } });
        }) as never,
      }),
  };
});

const { probeZulip } = await import("./probe.js");
const { downloadZulipUpload } = await import("./uploads.js");

afterEach(() => {
  guardState.requested.length = 0;
});

describe("SSRF guard scoped to the configured Zulip origin", () => {
  it("lets the status probe reach a configured server that resolves to a private address", async () => {
    const result = await probeZulip("https://zulip.internal.test", "bot@zulip.internal.test", "secret");
    expect(result.ok).toBe(true);
    expect(guardState.requested).toEqual(["https://zulip.internal.test/api/v1/users/me"]);
  });

  it("lets uploads download from a configured server that resolves to a private address", async () => {
    const result = await downloadZulipUpload(
      "https://zulip.internal.test/user_uploads/2/ab/photo.png",
      "https://zulip.internal.test",
      "encoded-auth",
      1024,
    );
    expect(result.buffer.toString()).toBe("PNGDATA");
    expect(guardState.requested).toEqual(["https://zulip.internal.test/user_uploads/2/ab/photo.png"]);
  });

  it("still blocks a private address on a different origin", async () => {
    const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } = await import("openclaw/plugin-sdk/ssrf-runtime");
    await expect(fetchWithSsrFGuard({
      url: "https://other.internal.test/user_uploads/x.png",
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin("https://zulip.internal.test"),
    })).rejects.toThrow(/private|internal|special-use/i);
    await expect(fetchWithSsrFGuard({
      url: "http://zulip.internal.test/user_uploads/x.png",
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin("https://zulip.internal.test"),
    })).rejects.toThrow(/private|internal|special-use/i);
    expect(guardState.requested).toEqual([]);
  });
});

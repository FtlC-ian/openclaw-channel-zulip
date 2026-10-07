import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "./sdk.js";
import { zulipDirectory, zulipResolver } from "./directory.js";
import { parseZulipTarget } from "./zulip/destination.js";
import { zulipThreading } from "./threading.js";
import { zulipLifecycle } from "./lifecycle.js";

vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", () => ({
  readChannelIngressStoreAllowFromForDmPolicy: vi.fn(async () => []),
}));
import { readChannelIngressStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-ingress-runtime";

const runtime = {} as RuntimeEnv;
const users = [
  { user_id: 7, email: "alice@example.test", full_name: "Alice", is_active: true },
  { user_id: 8, email: "bob@example.test", full_name: "Bob", is_active: true },
  { user_id: 9, email: "inactive@example.test", full_name: "Inactive", is_active: false },
  { user_id: 10, full_name: "Hidden email", is_active: true },
];
const subscriptions = [
  { stream_id: 4, name: "General", description: "not exposed" },
  { stream_id: 5, name: "Engineering" },
  { stream_id: 6, name: "Secret" },
];
function config(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return { channels: { zulip: { url: "https://chat.example.test", email: "bot@example.test", apiKey: "test-key", dmPolicy: "open", groupPolicy: "open", ...overrides } } } as OpenClawConfig;
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(readChannelIngressStoreAllowFromForDmPolicy).mockReset().mockResolvedValue([]);
  fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/users/me")) return Response.json({ result: "success", user_id: 1, email: "bot@example.test", full_name: "Bot" });
    if (path.endsWith("/users")) return Response.json({ result: "success", members: users });
    if (path.endsWith("/users/me/subscriptions")) return Response.json({ result: "success", subscriptions });
    throw new Error(`Unexpected API path: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const peers = (cfg: OpenClawConfig, extra = {}) => zulipDirectory.listPeers!({ cfg, runtime, ...extra });
const groups = (cfg: OpenClawConfig, extra = {}) => zulipDirectory.listGroups!({ cfg, runtime, ...extra });
const resolve = (cfg: OpenClawConfig, kind: "user" | "group", inputs: string[], extra = {}) => zulipResolver.resolveTargets({ cfg, runtime, kind, inputs, ...extra });

describe("Zulip directory and resolver", () => {
  it("lifecycle metadata hooks invalidate every resource only for the affected account and snapshots", async () => {
    const prevCfg = config({ accounts: { first: {}, second: {} } });
    const nextCfg = config({ streams: ["Engineering"], accounts: { first: {}, second: {} } });
    const load = async (cfg: OpenClawConfig, accountId: string) => {
      await peers(cfg, { accountId });
      await groups(cfg, { accountId });
      await zulipDirectory.self!({ cfg, runtime, accountId });
    };
    await load(prevCfg, "first"); await load(prevCfg, "second"); await load(nextCfg, "first");
    expect(fetchMock).toHaveBeenCalledTimes(9);
    await zulipLifecycle.onAccountConfigChanged!({ prevCfg, nextCfg, accountId: "first", runtime });
    await load(prevCfg, "first"); await load(nextCfg, "first"); await load(prevCfg, "second");
    expect(fetchMock).toHaveBeenCalledTimes(15);
    await zulipLifecycle.onAccountRemoved!({ prevCfg, accountId: "first", runtime });
    await load(prevCfg, "first"); await load(prevCfg, "second"); await load(nextCfg, "first");
    expect(fetchMock).toHaveBeenCalledTimes(18);
    Object.assign(prevCfg.channels!.zulip!.accounts!.first!, { dmPolicy: "disabled", groupPolicy: "disabled" });
    expect(await peers(prevCfg, { accountId: "first" })).toEqual([]);
    expect(await groups(prevCfg, { accountId: "first" })).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(18);
  });

  it("lists self, active users with sendable emails, and subscribed streams", async () => {
    const cfg = config();
    expect(await zulipDirectory.self!({ cfg, runtime })).toEqual({ kind: "user", id: "user:bot@example.test", name: "Bot", handle: "bot@example.test" });
    expect(await peers(cfg)).toEqual([
      { kind: "user", id: "user:alice@example.test", name: "Alice", handle: "alice@example.test" },
      { kind: "user", id: "user:bob@example.test", name: "Bob", handle: "bob@example.test" },
    ]);
    expect(await groups(cfg)).toEqual(subscriptions.map(stream => ({ kind: "group", id: `stream:${stream.stream_id}`, name: stream.name })));
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).search)).toEqual(["", "", ""]);
  });

  it("filters query against names/emails/IDs before applying a positive limit", async () => {
    const cfg = config();
    expect(await peers(cfg, { query: "EXAMPLE.TEST", limit: 1 })).toHaveLength(1);
    expect(await groups(cfg, { query: "ENGINE" })).toEqual([{ kind: "group", id: "stream:5", name: "Engineering" }]);
    expect(await groups(cfg, { query: "missing" })).toEqual([]);
    expect(await peers(cfg, { limit: 0 })).toHaveLength(2);
  });

  it("shares concurrent loads, caches each resource, and expires at 60 seconds", async () => {
    vi.useFakeTimers();
    const cfg = config();
    await Promise.all([peers(cfg), peers(cfg), groups(cfg), groups(cfg), zulipDirectory.self!({ cfg, runtime })]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(59_999);
    await peers(cfg); await groups(cfg); await zulipDirectory.self!({ cfg, runtime });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    await peers(cfg); await groups(cfg); await zulipDirectory.self!({ cfg, runtime });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("live variants refresh caches and returned entries cannot poison cached values", async () => {
    const cfg = config();
    (await peers(cfg))[0].name = "poison";
    expect((await peers(cfg))[0].name).toBe("Alice");
    await groups(cfg);
    await zulipDirectory.listPeersLive!({ cfg, runtime });
    await zulipDirectory.listGroupsLive!({ cfg, runtime });
    await peers(cfg); await groups(cfg);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("evicts failed loads and preserves actual API failures", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: "error", msg: "permission denied" }));
    const cfg = config();
    await expect(peers(cfg)).rejects.toThrow("permission denied");
    expect(await peers(cfg)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters DM allowlists by ID, email, and name and reapplies policy on cache hits", async () => {
    const cfg = config({ dmPolicy: "allowlist", allowFrom: ["user:alice@example.test"] });
    expect((await peers(cfg)).map(entry => entry.name)).toEqual(["Alice"]);
    Object.assign(cfg.channels!.zulip!, { allowFrom: [8] });
    expect((await peers(cfg)).map(entry => entry.name)).toEqual(["Bob"]);
    Object.assign(cfg.channels!.zulip!, { allowFrom: ["@Alice"] });
    expect((await peers(cfg)).map(entry => entry.name)).toEqual(["Alice"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await resolve(cfg, "user", ["Bob"])).toEqual([{ input: "Bob", resolved: false, note: "Zulip user not found or not permitted: Bob" }]);
  });

  it("uses account-scoped pairing approvals and hides peers when unapproved", async () => {
    const cfg = config({ dmPolicy: "pairing" });
    expect(await peers(cfg)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.mocked(readChannelIngressStoreAllowFromForDmPolicy).mockResolvedValue(["bob@example.test"]);
    expect((await peers(cfg)).map(entry => entry.name)).toEqual(["Bob"]);
    expect(readChannelIngressStoreAllowFromForDmPolicy).toHaveBeenLastCalledWith({ provider: "zulip", accountId: "default", dmPolicy: "pairing" });
  });

  it("disabled policies make no listing API requests", async () => {
    const cfg = config({ dmPolicy: "disabled", groupPolicy: "disabled" });
    expect(await peers(cfg)).toEqual([]);
    expect(await groups(cfg)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors stream selection, name/ID overrides, and global disabled policy", async () => {
    const cfg = config({ streams: ["General"], streamOverrides: { "5": { enabled: true }, Secret: { enabled: false } } });
    expect((await groups(cfg)).map(entry => entry.id)).toEqual(["stream:4", "stream:5"]);
    Object.assign(cfg.channels!.zulip!, { streamOverrides: { "4": { enabled: false }, "5": { enabled: true, excludedTopics: ["*"] } } });
    expect(await groups(cfg)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await groups({ channels: { defaults: { groupPolicy: "disabled" }, zulip: { ...cfg.channels!.zulip!, groupPolicy: undefined } } } as OpenClawConfig)).toEqual([]);
  });

  it("resolves names and numeric stream IDs while preserving permitted topics", async () => {
    const cfg = config({ topics: ["Planning"] });
    expect(await resolve(cfg, "group", ["General", "#Engineering:Planning", "stream:4:Planning", "General:Other"])).toEqual([
      { input: "General", resolved: true, id: "stream:4", name: "General" },
      { input: "#Engineering:Planning", resolved: true, id: "stream:5:Planning", name: "Engineering" },
      { input: "stream:4:Planning", resolved: true, id: "stream:4:Planning", name: "General" },
      { input: "General:Other", resolved: false, note: "Zulip topic is not permitted" },
    ]);
    expect(await resolve(cfg, "group", ["stream:4:Other"])).toEqual([{ input: "stream:4:Other", resolved: false, note: "Zulip topic is not permitted" }]);
  });

  it("resolves user names, case-insensitive emails, and IDs to email DM destinations", async () => {
    const results = await resolve(config(), "user", ["Alice", "ALICE@EXAMPLE.TEST", "user:7", "@Bob"]);
    expect(results.map(result => result.id)).toEqual(["user:alice@example.test", "user:alice@example.test", "user:alice@example.test", "user:bob@example.test"]);
    for (const result of results) expect(parseZulipTarget(result.id!).kind).toBe("user");
  });

  it("refuses ambiguous user and stream names instead of selecting the first", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: "success", members: [users[0], { ...users[1], full_name: "Alice" }] }));
    const cfg = config();
    expect((await resolve(cfg, "user", ["Alice"]))[0]).toMatchObject({ resolved: false, note: expect.stringContaining("Ambiguous") });
    expect((await resolve(cfg, "user", ["alice@example.test"]))[0].id).toBe("user:alice@example.test");
    fetchMock.mockResolvedValueOnce(Response.json({ result: "success", subscriptions: [subscriptions[0], { ...subscriptions[1], name: "GENERAL" }] }));
    expect((await resolve(cfg, "group", ["General"]))[0]).toMatchObject({ resolved: false, note: expect.stringContaining("Ambiguous") });
    expect((await resolve(cfg, "group", ["stream:4"]))[0].id).toBe("stream:4");
  });

  it("matches user emails and IDs only against their intended fields", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: "success", members: [
      users[0], { ...users[1], full_name: "alice@example.test" },
      { user_id: 11, email: "id-name@example.test", full_name: "7" },
      { user_id: 12, email: "missing-name@example.test", full_name: "victim@example.test" },
      { user_id: 13, email: "missing-id@example.test", full_name: "99" },
    ] }));
    const results = await resolve(config(), "user", ["user:alice@example.test", "user:7", "user:007", "user:victim@example.test", "user:99"]);
    expect(results.map(result => result.id)).toEqual(["user:alice@example.test", "user:alice@example.test", "user:alice@example.test", undefined, undefined]);
    expect(results.map(result => result.resolved)).toEqual([true, true, true, false, false]);
  });

  it("matches zero-normalized stream IDs only against IDs, never numeric names", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: "success", subscriptions: [
      subscriptions[0], { stream_id: 11, name: "4" }, { stream_id: 12, name: "004" }, { stream_id: 13, name: "099" },
    ] }));
    const results = await resolve(config(), "group", ["stream:4", "stream:004", "#004:Planning", "stream:099"]);
    expect(results.map(result => result.id)).toEqual(["stream:4", "stream:4", "stream:4:Planning", undefined]);
    expect(results.map(result => result.resolved)).toEqual([true, true, true, false]);
  });

  it("refuses duplicate real emails and IDs within their own fields", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: "success", members: [users[0], { ...users[1], email: users[0].email }, { ...users[1], user_id: 7 }] }));
    const cfg = config();
    expect((await resolve(cfg, "user", ["user:alice@example.test", "user:007"])).every(result => !result.resolved && result.note?.includes("Ambiguous"))).toBe(true);
    fetchMock.mockResolvedValueOnce(Response.json({ result: "success", subscriptions: [subscriptions[0], { ...subscriptions[1], stream_id: 4 }] }));
    expect((await resolve(cfg, "group", ["stream:004"]))[0]).toMatchObject({ resolved: false, note: expect.stringContaining("Ambiguous") });
  });

  it("includes active bots with sendable emails under the same DM policy as humans", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: "success", members: [
      users[0], { user_id: 20, email: "helper@example.test", full_name: "Helper", is_bot: true, is_active: true },
      { user_id: 21, email: "retired@example.test", full_name: "Retired", is_bot: true, is_active: false },
      { user_id: 22, full_name: "Addressless bot", is_bot: true, is_active: true },
    ] }));
    const cfg = config();
    expect((await peers(cfg)).map(entry => entry.id)).toEqual(["user:alice@example.test", "user:helper@example.test"]);
    expect((await resolve(cfg, "user", ["Helper", "user:20", "helper@example.test"])).map(result => result.id)).toEqual(Array(3).fill("user:helper@example.test"));
    Object.assign(cfg.channels!.zulip!, { dmPolicy: "allowlist", allowFrom: [7] });
    expect((await resolve(cfg, "user", ["helper@example.test"]))[0].resolved).toBe(false);
  });

  it("sweeps expired credential identities even when the current identity is a cache hit", async () => {
    vi.useFakeTimers();
    const cfg = config();
    await peers(cfg);
    vi.advanceTimersByTime(30_000);
    Object.assign(cfg.channels!.zulip!, { apiKey: "rotated" });
    await peers(cfg);
    vi.advanceTimersByTime(30_000);
    const deletedKeys: unknown[] = [];
    const originalDelete = Map.prototype.delete;
    const spy = vi.spyOn(Map.prototype, "delete").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      deletedKeys.push(key);
      return originalDelete.call(this, key);
    });
    try { await peers(cfg); } finally { spy.mockRestore(); }
    expect(deletedKeys.filter(key => typeof key === "string" && /^[a-f0-9]{64}:users$/.test(key))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds cached credential identities per config during rapid rotation", async () => {
    const cfg = config();
    for (let index = 0; index < 33; index++) {
      Object.assign(cfg.channels!.zulip!, { apiKey: `rotation-${index}` });
      await peers(cfg);
    }
    await peers(cfg);
    expect(fetchMock).toHaveBeenCalledTimes(33);
    Object.assign(cfg.channels!.zulip!, { apiKey: "rotation-0" });
    await peers(cfg);
    expect(fetchMock).toHaveBeenCalledTimes(34);
  });

  it("returns clear missing/invalid results without leaking hidden names", async () => {
    const cfg = config({ streams: ["General"] });
    const results = await resolve(cfg, "group", ["Missing", "Secret", "user:alice@example.test", "stream:", "agent:main:zulip:group:4"]);
    expect(results.every(result => !result.resolved && result.note && !result.id && !result.name)).toBe(true);
    expect((await resolve(cfg, "user", ["Missing", "#General", ""])) .every(result => !result.resolved)).toBe(true);
  });

  it("isolates account credentials, defaults, cache data, and policies", async () => {
    const cfg = config({ defaultAccount: "second", accounts: {
      first: { url: "https://first.example.test", email: "one@example.test", apiKey: "key-one", streams: ["General"], dmPolicy: "allowlist", allowFrom: [7] },
      second: { url: "https://second.example.test", email: "two@example.test", apiKey: "key-two", streams: ["Engineering"], dmPolicy: "allowlist", allowFrom: [8] },
    } });
    expect((await peers(cfg, { accountId: "first" }))[0].name).toBe("Alice");
    expect((await peers(cfg))[0].name).toBe("Bob");
    expect((await groups(cfg, { accountId: "first" }))[0].id).toBe("stream:4");
    expect((await resolve(cfg, "group", ["Engineering"]))[0].id).toBe("stream:5");
    await peers(cfg, { accountId: "first" }); await groups(cfg);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(["first.example.test", "second.example.test", "first.example.test", "second.example.test"]);
    const headers = fetchMock.mock.calls.map(([, init]) => new Headers(init.headers).get("Authorization"));
    expect(headers[0]).toBe(`Basic ${Buffer.from("one@example.test:key-one").toString("base64")}`);
    expect(headers[1]).toBe(`Basic ${Buffer.from("two@example.test:key-two").toString("base64")}`);
  });

  it("rejects unknown/disabled/unconfigured accounts and refreshes when credentials change", async () => {
    const cfg = config();
    await expect(peers(cfg, { accountId: "unknown" })).rejects.toThrow("Unknown Zulip account");
    await expect(peers(config({ enabled: false }))).rejects.toThrow("disabled or not configured");
    await expect(peers(config({ url: "", apiKey: "" }))).rejects.toThrow("disabled or not configured");
    expect(fetchMock).not.toHaveBeenCalled();
    await peers(cfg);
    Object.assign(cfg.channels!.zulip!, { apiKey: "rotated-key" });
    await peers(cfg);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("canonical stream resolution supports existing current-topic numeric matching without changing threading", async () => {
    const [result] = await resolve(config(), "group", ["General"]);
    expect(zulipThreading.resolveAutoThreadId!({ cfg: config(), to: result.id!, toolContext: { currentChannelId: "stream:4:Planning", currentChannelProvider: "zulip" } })).toBe("Planning");
  });
});

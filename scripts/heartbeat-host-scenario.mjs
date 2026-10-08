{
  const { ZulipConnection } = await import("./dist/src/zulip/connection.js");
  const heartbeat = zulipPlugin.heartbeat;
  for (const name of ["checkReady", "sendTyping", "sendTypingGuarded", "clearTyping"]) assert.equal(typeof heartbeat[name], "function", name);
  const ready = () => heartbeat.checkReady({ cfg });
  assert.equal((await ready()).ok, false);
  const wire = [];
  const typingClient = createZulipClient({ baseUrl: "https://zulip.test", email: "bot@test", apiKey: "fixture", fetchImpl: async (url, init) => {
    wire.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(init?.body)) });
    return Response.json({ result: "success", members: [{ user_id: 7, email: "person@test" }], subscriptions: [{ stream_id: 42, name: "Engineering" }] });
  } });
  const abort = new AbortController();
  const connection = new ZulipConnection("default", typingClient, () => cfg, abort.signal);
  const typing = () => wire.filter(call => call.url.endsWith("/typing")).map(call => call.body);
  const until = async predicate => {
    for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(predicate(), "typing transport settled");
  };
  try {
    assert.equal((await ready()).ok, false, "registered generation is not ready until polling");
    connection.polling = true;
    assert.equal((await ready()).ok, true);
    assert.equal((await heartbeat.checkReady({ cfg, accountId: "other" })).ok, false);
    const file = readdirSync(distPath).find(file => /\.(mjs|js)$/.test(file) && readFileSync(distPath + "/" + file, "utf8").includes("function createHeartbeatTypingCallbacks("));
    assert.ok(file, "real host heartbeat typing caller");
    const hostRequire = (await import("node:module")).createRequire(distPath + "/../package.json");
    const source = readFileSync(distPath + "/" + file, "utf8")
      .replace(/(from\s+|import\s*)(["'])(\.\/[^"']+)\2/g, (_, prefix, quote, specifier) => prefix + quote + pathToFileURL(distPath + "/" + specifier).href + quote)
      .replace(/(from\s+|import\s*)(["'])([^"']+)\2/g, (whole, prefix, quote, specifier) => specifier.startsWith("node:") || specifier.startsWith("file:") ? whole : prefix + quote + pathToFileURL(hostRequire.resolve(specifier)).href + quote)
      + "\nexport { createHeartbeatTypingCallbacks, isHeartbeatTypingEnabled };";
    const { createHeartbeatTypingCallbacks, isHeartbeatTypingEnabled } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const neverCfg = { ...cfg, agents: { defaults: { typingMode: "never" }, list: [{ id: "special", typingMode: "instant" }] } };
    assert.equal(isHeartbeatTypingEnabled({ cfg: neverCfg, agentId: "main", hasChatDelivery: true }), false, "real core owns never mode");
    assert.equal(isHeartbeatTypingEnabled({ cfg: neverCfg, agentId: "special", hasChatDelivery: true }), true, "adapter must not override an agent's mode with the global default");
    for (const target of [{ channel: "zulip", to: "stream:Engineering:Topic 🧪 / é" }, { channel: "zulip", to: "user:person@test" }]) {
      const before = typing().length;
      const callbacks = createHeartbeatTypingCallbacks({ cfg, plugin: zulipPlugin, target });
      await callbacks.onReplyStart();
      await until(() => typing().length === before + 1);
      callbacks.onCleanup();
      await until(() => typing().length === before + 2);
      assert.equal(typing().at(-2).op, "start");
      assert.equal(typing().at(-1).op, "stop");
      if (target.to.startsWith("stream")) {
        assert.equal(typing().at(-2).stream_id, "42");
        assert.equal(typing().at(-2).topic, "Topic 🧪 / é");
      } else assert.equal(typing().at(-2).to, "[7]");
    }
    const target = { cfg, to: "stream:42:guarded" };
    const canceled = new AbortController();
    await heartbeat.sendTypingGuarded({ ...target, signal: canceled.signal, assertPlatformSendAuthorized() {} });
    canceled.abort();
    await until(() => typing().at(-1).op === "stop");
    const before = typing().length;
    await assert.rejects(() => heartbeat.sendTypingGuarded({ ...target, signal: canceled.signal, assertPlatformSendAuthorized() {} }));
    assert.equal(typing().length, before);
    const owner = connection.claimMonitor({ type: "stream", streamId: 42, topic: "guarded" });
    await heartbeat.sendTyping(target);
    assert.equal(typing().length, before, "monitor ownership blocks competing core starts even before its typing mode starts");
    await owner.start();
    await heartbeat.sendTyping(target);
    await heartbeat.clearTyping(target);
    assert.equal(typing().length, before + 1, "core cleanup cannot stop the monitor owner");
    await owner.close();
    assert.equal(typing().length, before + 2);
    abort.abort();
    await connection.close();
    assert.equal((await ready()).ok, false);
  } finally { await connection.close(); }
}

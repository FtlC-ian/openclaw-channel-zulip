import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const host = process.env.OPENCLAW_DRAIN_HOST;
if (!host) throw new Error("Set OPENCLAW_DRAIN_HOST to an extracted or installed OpenClaw 2026.10.3 package");
const dist = resolve(host, "dist");
async function hostFunction(name) {
  const files = readdirSync(dist).filter(file => /\.mjs$/.test(file));
  const file = files.find(file => readFileSync(resolve(dist, file), "utf8").includes(`function ${name}(`)
    || readFileSync(resolve(dist, file), "utf8").includes(`var ${name} = class`));
  assert.ok(file, `real host module for ${name}`);
  const module = await import(pathToFileURL(resolve(dist, file)));
  const fn = Object.values(module).find(value => typeof value === "function" && value.name === name);
  assert.equal(typeof fn, "function", `exported real host ${name}`);
  return fn;
}
const PluginInstance = await hostFunction("PluginInstance");
const retainRuntimePluginWork = await hostFunction("retainRuntimePluginWork");

test("replacement reservation does not signal the plugin or release core work", async (t) => {
  const instance = new PluginInstance("zulip");
  const release = instance.retainWork();
  const unreserve = instance.reserveReplacement();
  t.after(() => { release(); unreserve(); });
  let disposed = 0;
  instance.lifecycle.onDispose(() => { disposed++; });
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("drain budget exhausted")), 25);
  t.after(() => clearTimeout(timer));
  await assert.rejects(instance.waitForRetainedWork(deadline.signal, { includeConsumers: false }), /drain budget exhausted/);
  assert.equal(instance.lifecycle.signal.aborted, false);
  assert.equal(disposed, 0);
  assert.equal(instance.retainedWorkCount, 1);
  release();
  await instance.waitForRetainedWork(new AbortController().signal);
  assert.equal(instance.retainedWorkCount, 0);
});

test("core prepared-registry custody retains the adopted channel without plugin dispatch", async (t) => {
  const instance = new PluginInstance("zulip");
  const registry = { plugins: [], decisionProviders: [], channels: [{ plugin: instance.adopt({ id: "zulip" }) }],
    tools: [], contextEngines: new Map(), widgetPresenters: [], memoryCorpusSupplements: [],
    memoryPromptPreparations: [], memoryPromptSupplements: [] };
  const release = retainRuntimePluginWork([registry, registry]);
  t.after(release);
  assert.equal(instance.retainedWorkCount, 1);
  const unreserve = instance.reserveReplacement();
  t.after(unreserve);
  assert.throws(() => retainRuntimePluginWork([registry]), /replacement is in progress/);
  release();
  await instance.waitForRetainedWork(new AbortController().signal);
  assert.equal(instance.retainedWorkCount, 0);
});

test("background context does not detach a long turn from instance drain", async (t) => {
  const instance = new PluginInstance("zulip");
  let finish;
  const turn = instance.lifecycle.runInBackgroundContext(() => new Promise(resolve => { finish = resolve; }));
  t.after(async () => { finish(); await turn; });
  const unreserve = instance.reserveReplacement();
  t.after(unreserve);
  assert.equal(instance.ordinaryCallCount, 1);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("drain budget exhausted")), 25);
  t.after(() => clearTimeout(timer));
  await assert.rejects(instance.waitForRetainedWork(deadline.signal, { includeCalls: true }), /drain budget exhausted/);
  assert.equal(instance.lifecycle.signal.aborted, false);
  finish();
  await turn;
  await instance.waitForRetainedWork(new AbortController().signal, { includeCalls: true });
  assert.equal(instance.ordinaryCallCount, 0);
});

import { describe, expect, it } from "vitest";

import { getZulipRuntime, setZulipRuntime } from "./runtime.js";
import type { PluginRuntime } from "./sdk.js";

describe("zulip runtime store", () => {
  it("throws a clear error before initialization", () => {
    expect(() => getZulipRuntime()).toThrow("Zulip runtime not initialized");
  });

  it("returns the runtime after initialization", () => {
    const runtime = { pluginId: "zulip" } as unknown as PluginRuntime;

    setZulipRuntime(runtime);

    expect(getZulipRuntime()).toBe(runtime);
  });
});

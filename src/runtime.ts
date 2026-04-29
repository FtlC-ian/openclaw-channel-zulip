import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

import type { PluginRuntime } from "./sdk.js";

const zulipRuntimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "zulip",
  errorMessage: "Zulip runtime not initialized",
});

export function setZulipRuntime(next: PluginRuntime) {
  zulipRuntimeStore.setRuntime(next);
}

export function getZulipRuntime(): PluginRuntime {
  return zulipRuntimeStore.getRuntime();
}

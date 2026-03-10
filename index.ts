import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { zulipPlugin } from "./src/channel.js";
import { setZulipRuntime } from "./src/runtime.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadZulipEnv(): void {
  // Load credentials from ~/.openclaw/secrets/zulip.env if it exists
  const envPaths = [
    join(process.env.HOME ?? "", ".openclaw", "secrets", "zulip.env"),
    join(process.env.HOME ?? "", ".openclaw", "zulip.env"),
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        // Only set if not already in env (env vars take precedence)
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
      break; // use first found file
    }
  }
}

const plugin = {
  id: "zulip",
  name: "Zulip",
  description: "Zulip channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    loadZulipEnv();
    setZulipRuntime(api.runtime);
    api.registerChannel({ plugin: zulipPlugin });
  },
};

export default plugin;

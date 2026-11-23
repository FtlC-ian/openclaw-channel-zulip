import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { zulipPlugin } from "./src/channel.js";

// Name our own plugin type so declaration emit doesn't reference the SDK's hashed internal chunks.
const setupEntry: { plugin: typeof zulipPlugin } = defineSetupPluginEntry(zulipPlugin);

export default setupEntry;

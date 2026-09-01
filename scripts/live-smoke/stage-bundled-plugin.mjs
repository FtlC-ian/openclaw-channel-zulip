import { randomBytes } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== "--host-root" && name !== "--plugin-root") {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${name}`);
    args[name.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function copyTreeWithoutLinks(source, destination) {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) throw new Error(`Refusing to stage symbolic link: ${source}`);
  if (sourceStat.isFile()) {
    await copyFile(source, destination);
    return;
  }
  if (!sourceStat.isDirectory()) throw new Error(`Refusing to stage non-file entry: ${source}`);
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source)) {
    await copyTreeWithoutLinks(join(source, entry), join(destination, entry));
  }
}

function resolveInstalledOpenClawRoot() {
  const sdkPath = fileURLToPath(import.meta.resolve("openclaw/plugin-sdk"));
  return resolve(dirname(sdkPath), "../..");
}

export async function stageBundledPlugin({
  hostRoot = resolveInstalledOpenClawRoot(),
  pluginRoot = process.cwd(),
} = {}) {
  const resolvedHostRoot = resolve(hostRoot);
  const resolvedPluginRoot = resolve(pluginRoot);
  const hostPackage = await readJson(join(resolvedHostRoot, "package.json"));
  if (hostPackage.name !== "openclaw" || typeof hostPackage.version !== "string") {
    throw new Error("Host root is not an OpenClaw package");
  }

  const pluginPackage = await readJson(join(resolvedPluginRoot, "package.json"));
  const pluginManifest = await readJson(join(resolvedPluginRoot, "openclaw.plugin.json"));
  if (pluginPackage.name !== "openclaw-channel-zulip" || pluginManifest.id !== "zulip") {
    throw new Error("Candidate is not the Zulip channel plugin");
  }
  const extensionEntries = pluginPackage.openclaw?.extensions;
  if (!Array.isArray(extensionEntries) || extensionEntries.length !== 1 || extensionEntries[0] !== "./dist/index.js") {
    throw new Error("Candidate has an unexpected OpenClaw extension entry");
  }
  const builtEntry = join(resolvedPluginRoot, "dist", "index.js");
  if (!(await lstat(builtEntry)).isFile()) throw new Error("Candidate must be built before trusted staging");

  const extensionsRoot = join(resolvedHostRoot, "dist", "extensions");
  const target = join(extensionsRoot, "zulip");
  try {
    await lstat(target);
    throw new Error("OpenClaw host already contains a bundled Zulip plugin");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await mkdir(extensionsRoot, { recursive: true, mode: 0o700 });
  const staging = join(extensionsRoot, `.zulip-stage-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    await copyTreeWithoutLinks(join(resolvedPluginRoot, "dist"), join(staging, "dist"));
    await copyTreeWithoutLinks(join(resolvedPluginRoot, "package.json"), join(staging, "package.json"));
    await copyTreeWithoutLinks(
      join(resolvedPluginRoot, "openclaw.plugin.json"),
      join(staging, "openclaw.plugin.json"),
    );
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    pluginId: "zulip",
    pluginVersion: String(pluginPackage.version),
    openclawVersion: hostPackage.version,
    targetDir: target,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await stageBundledPlugin({
    ...(args["host-root"] ? { hostRoot: args["host-root"] } : {}),
    ...(args["plugin-root"] ? { pluginRoot: args["plugin-root"] } : {}),
  });
  if (process.env.GITHUB_ENV) {
    await appendFile(
      process.env.GITHUB_ENV,
      `SMOKE_OPENCLAW_VERSION=${result.openclawVersion}\nSMOKE_PLUGIN_VERSION=${result.pluginVersion}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  process.stdout.write(
    `Staged ${result.pluginId} ${result.pluginVersion} as bundled on OpenClaw ${result.openclawVersion}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePreferredOpenClawTmpDir } from "../sdk.js";
import type { InteractiveReply, OpenClawConfig } from "../sdk.js";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipRuntimeAccount } from "./accounts.js";
import {
  createZulipClient,
  normalizeZulipBaseUrl,
  sendZulipPrivateMessage,
  sendZulipStreamMessage,
  uploadZulipFile,
} from "./client.js";

type InteractivePayload = InteractiveReply;
type ZulipChannelData = {
  zulip?: {
    widgetContent?: unknown;
  };
  execApproval?: {
    approvalId?: string;
    approvalSlug?: string;
    allowedDecisions?: unknown;
  };
  [key: string]: unknown;
};

type ZulipWidgetChoice = {
  type: "multiple_choice";
  short_name: string;
  long_name: string;
  reply: string;
};

type ZulipWidgetContent = {
  widget_type: "zform";
  extra_data: {
    type: "choices";
    heading: string;
    choices: ZulipWidgetChoice[];
  };
};

export type ZulipSendOpts = {
  cfg: OpenClawConfig;
  apiKey?: string;
  email?: string;
  baseUrl?: string;
  accountId?: string;
  mediaUrl?: string;
  topic?: string;
  interactive?: InteractivePayload;
  channelData?: ZulipChannelData;
};

export type ZulipSendResult = {
  messageId: string;
  channelId: string;
};

type ZulipTarget =
  | { kind: "stream"; stream: string; topic?: string }
  | { kind: "user"; email: string };

const DEFAULT_TOPIC = "general";

const getCore = () => getZulipRuntime();

function interactiveToZulipWidgetContent(
  interactive?: InteractivePayload,
): ZulipWidgetContent | undefined {
  const choices: ZulipWidgetChoice[] = [];
  for (const block of interactive?.blocks ?? []) {
    if (block.type !== "buttons") {
      continue;
    }
    for (const button of block.buttons ?? []) {
      const label = button.label?.trim();
      const reply = button.value?.trim();
      if (!label || !reply) {
        continue;
      }
      choices.push({
        type: "multiple_choice",
        short_name: label,
        long_name: label,
        reply,
      });
    }
  }
  if (choices.length === 0) {
    return undefined;
  }
  const heading =
    interactive?.blocks?.find((block) => block.type === "text")?.text?.trim() || "Choose an action";
  return {
    widget_type: "zform",
    extra_data: {
      type: "choices",
      heading,
      choices,
    },
  };
}

export { interactiveToZulipWidgetContent };

export function resolveZulipWidgetContent(params: {
  interactive?: InteractivePayload;
  channelData?: ZulipChannelData;
}): unknown {
  const interactiveWidget = interactiveToZulipWidgetContent(params.interactive);
  if (interactiveWidget) {
    return interactiveWidget;
  }
  const explicitWidget = params.channelData?.zulip?.widgetContent;
  if (explicitWidget && typeof explicitWidget === "object" && !Array.isArray(explicitWidget)) {
    return explicitWidget;
  }
  return undefined;
}

/**
 * Escape triple backticks in text to prevent breaking Zulip code fences.
 * Uses zero-width space (\u200b) between backticks.
 */
function sanitizeBackticks(text: string): string {
  return text.replace(/```/g, "`\u200b`\u200b`");
}

function normalizeMessage(text: string, mediaUrl?: string): string {
  const trimmed = sanitizeBackticks(text.trim());
  const media = mediaUrl?.trim();
  return [trimmed, media].filter(Boolean).join("\n");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveZulipLocalPath(value: string): string | null {
  if (value.startsWith("file://")) {
    return fileURLToPath(value);
  }
  if (!isHttpUrl(value)) {
    return value;
  }
  return null;
}

async function writeTempFile(
  buffer: Buffer,
  filename: string,
): Promise<{ filePath: string; dir: string }> {
  const dir = await fsPromises.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "zulip-upload-"),
  );
  const filePath = path.join(dir, filename);
  await fsPromises.writeFile(filePath, buffer);
  return { filePath, dir };
}

function normalizeLegacyZulipTarget(raw: string): { normalized: string; convertedFromLegacy: boolean } {
  const trimmed = raw.trim();
  const legacyMatch = trimmed.match(/^(\d+):topic:(.+)$/);
  if (!legacyMatch) {
    return { normalized: trimmed, convertedFromLegacy: false };
  }
  const [, streamId, topic] = legacyMatch;
  return {
    normalized: `stream:${streamId}:${topic.trim()}`,
    convertedFromLegacy: true,
  };
}

export { normalizeLegacyZulipTarget };

function isCanonicalDmEmail(value: string): boolean {
  return /^[^\s@:]+@[^\s@:]+$/.test(value);
}

function parseZulipTarget(raw: string): ZulipTarget {
  const { normalized } = normalizeLegacyZulipTarget(raw);
  const trimmed = normalized.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Zulip sends");
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("stream:")) {
    const rest = trimmed.slice("stream:".length).trim();
    if (!rest) {
      throw new Error("Stream name is required for Zulip sends");
    }
    const colonIdx = rest.indexOf(":");
    const slashIdx = rest.indexOf("/");
    const hashIdx = rest.indexOf("#");
    const sepIdx = [colonIdx, slashIdx, hashIdx].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
    const stream = sepIdx === Infinity ? rest : rest.slice(0, sepIdx);
    const topic = sepIdx === Infinity ? undefined : rest.slice(sepIdx + 1);
    return { kind: "stream", stream: stream.trim(), topic: topic?.trim() };
  }
  if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    const email = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    if (!isCanonicalDmEmail(email)) {
      throw new Error("Invalid Zulip direct-message target; expected an email address");
    }
    return { kind: "user", email };
  }
  if (lower.startsWith("zulip:")) {
    const email = trimmed.slice("zulip:".length).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    if (!isCanonicalDmEmail(email)) {
      throw new Error("Invalid Zulip direct-message target; expected an email address");
    }
    return { kind: "user", email };
  }
  if (trimmed.startsWith("@")) {
    const email = trimmed.slice(1).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    if (!isCanonicalDmEmail(email)) {
      throw new Error("Invalid Zulip direct-message target; expected an email address");
    }
    return { kind: "user", email };
  }
  if (trimmed.startsWith("#")) {
    const rest = trimmed.slice(1).trim();
    const sepIdx2 = [rest.indexOf(":"), rest.indexOf("/")].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
    const stream2 = sepIdx2 === Infinity ? rest : rest.slice(0, sepIdx2);
    const topic2 = sepIdx2 === Infinity ? undefined : rest.slice(sepIdx2 + 1);
    if (!stream2) {
      throw new Error("Stream name is required for Zulip sends");
    }
    return { kind: "stream", stream: stream2.trim(), topic: topic2?.trim() };
  }
  if (isCanonicalDmEmail(trimmed)) {
    return { kind: "user", email: trimmed };
  }
  return { kind: "stream", stream: trimmed };
}

export async function sendMessageZulip(
  to: string,
  text: string,
  opts: ZulipSendOpts,
): Promise<ZulipSendResult> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "zulip" });
  const account = await resolveZulipRuntimeAccount({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const apiKey = opts.apiKey?.trim() || account.apiKey?.trim();
  const email = opts.email?.trim() || account.email?.trim();
  if (!apiKey || !email) {
    throw new Error(
      `Zulip apiKey/email missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.apiKey/email or ZULIP_API_KEY/ZULIP_EMAIL for default).`,
    );
  }
  const baseUrl = normalizeZulipBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Zulip url missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.url or ZULIP_URL for default).`,
    );
  }

  const client = createZulipClient({ baseUrl, email, apiKey });
  const normalizedTarget = normalizeLegacyZulipTarget(to);
  if (normalizedTarget.convertedFromLegacy) {
    logger.warn?.("zulip send received legacy session-key target, auto-converting", {
      originalTo: to,
      normalizedTo: normalizedTarget.normalized,
    });
  }
  const target = parseZulipTarget(normalizedTarget.normalized);
  let message = text?.trim() ?? "";
  const rawMediaUrl = opts.mediaUrl?.trim();
  let mediaUrl = rawMediaUrl;
  let tempFilePath: string | undefined;
  let tempDir: string | undefined;
  let tempFileCleanup = false;

  if (mediaUrl) {
    const localPath = resolveZulipLocalPath(mediaUrl);
    const isZulipHosted = isHttpUrl(mediaUrl) && mediaUrl.startsWith(baseUrl);
    if (localPath && fs.existsSync(localPath)) {
      const upload = await uploadZulipFile(client, localPath);
      mediaUrl = upload.url;
    } else if (isHttpUrl(mediaUrl) && !isZulipHosted) {
      const maxBytes = (opts.cfg.agents?.defaults?.mediaMaxMb ?? 5) * 1024 * 1024;
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: mediaUrl,
        maxBytes,
      });
      const filename = (() => {
        try {
          return path.basename(new URL(mediaUrl).pathname) || "upload.bin";
        } catch {
          return "upload.bin";
        }
      })();
      if (core.channel.media?.saveMediaBuffer) {
        const saved = await core.channel.media.saveMediaBuffer(
          fetched.buffer,
          fetched.contentType ?? "application/octet-stream",
          "outbound",
          maxBytes,
          filename,
        );
        tempFilePath = saved.path;
      } else {
        const temp = await writeTempFile(fetched.buffer, filename);
        tempFilePath = temp.filePath;
        tempDir = temp.dir;
        tempFileCleanup = true;
      }
      const upload = await uploadZulipFile(client, tempFilePath);
      mediaUrl = upload.url;
      if (tempFileCleanup && tempFilePath) {
        await fsPromises.unlink(tempFilePath).catch(() => undefined);
        if (tempDir) {
          await fsPromises.rmdir(tempDir).catch(() => undefined);
        }
      }
    }
    message = normalizeMessage(message, mediaUrl);
  }

  if (message) {
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg: opts.cfg,
      channel: "zulip",
      accountId: account.accountId,
    });
    message = core.channel.text.convertMarkdownTables(message, tableMode);
  }

  const interactiveWidget = interactiveToZulipWidgetContent(opts.interactive);
  const widgetContent = interactiveWidget ?? resolveZulipWidgetContent({
    interactive: undefined,
    channelData: opts.channelData,
  });

  if (!message && !widgetContent) {
    throw new Error("Zulip message is empty");
  }

  const widgetContentSource = interactiveWidget
    ? "interactive"
    : opts.channelData?.zulip?.widgetContent
      ? "channelData"
      : "none";
  logger.debug?.("zulip send payload", {
    targetKind: target.kind,
    hasInteractive: Boolean(opts.interactive?.blocks?.length),
    channelDataKeys: Object.keys(opts.channelData ?? {}),
    hasExecApprovalChannelData: Boolean(opts.channelData?.execApproval),
    hasExplicitWidgetContent: Boolean(opts.channelData?.zulip?.widgetContent),
    hasWidgetContent: Boolean(widgetContent),
    widgetContentSource,
    widgetType:
      widgetContent && typeof widgetContent === "object" && "widget_type" in widgetContent
        ? (widgetContent as { widget_type?: unknown }).widget_type
        : undefined,
    messageLength: message.length,
  });

  let messageId = "unknown";
  if (target.kind === "user") {
    const response = await sendZulipPrivateMessage(client, {
      to: target.email,
      content: message,
      widgetContent,
    });
    messageId = response.id ? String(response.id) : "unknown";
  } else {
    const topic = target.topic || opts.topic || DEFAULT_TOPIC;
    if (!topic) {
      logger.debug?.("zulip send: missing topic for stream message");
    }
    const response = await sendZulipStreamMessage(client, {
      stream: target.stream,
      topic: topic || DEFAULT_TOPIC,
      content: message,
      widgetContent,
    });
    messageId = response.id ? String(response.id) : "unknown";
  }

  logger.debug?.("zulip send success", {
    targetKind: target.kind,
    messageId,
    hadWidget: Boolean(widgetContent),
    widgetContentSource,
  });

  core.channel.activity.record({
    channel: "zulip",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId,
    channelId: target.kind === "stream" ? target.stream : target.email,
  };
}

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadOutboundMediaFromUrl,
  resolveMessagePresentationActionValue,
  resolvePreferredOpenClawTmpDir,
} from "../sdk.js";
import type { MessagePresentation, OpenClawConfig } from "../sdk.js";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipRuntimeAccount } from "./accounts.js";
import { normalizeLegacyZulipTarget, resolveZulipDestination } from "./destination.js";
import {
  createZulipClient,
  normalizeZulipBaseUrl,
  resolveZulipStreamId,
  sendZulipPrivateMessage,
  sendZulipStreamMessage,
  uploadZulipFile,
} from "./client.js";
import {
  getZulipQuestionDeliveryContext,
  zulipQuestionZformStore,
} from "./question-zform.js";

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

type OutboundMediaAccess = {
  localRoots?: readonly string[];
  readFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
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
    max_selections?: number;
    poll?: true;
  };
};

type PollInput = {
  question: string;
  options: string[];
  maxSelections?: number;
};

export type ZulipSendOpts = {
  cfg: OpenClawConfig;
  apiKey?: string;
  email?: string;
  baseUrl?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  topic?: string;
  presentation?: MessagePresentation;
  channelData?: ZulipChannelData;
};

export type ZulipSendResult = {
  messageId: string;
  channelId: string;
};

export { normalizeLegacyZulipTarget, parseZulipTarget, type ZulipTarget } from "./destination.js";

const getCore = () => getZulipRuntime();

function presentationToZulipWidgetContent(
  presentation?: MessagePresentation,
): ZulipWidgetContent | undefined {
  const choices: ZulipWidgetChoice[] = [];
  for (const block of presentation?.blocks ?? []) {
    if (block.type !== "buttons") {
      continue;
    }
    for (const button of block.buttons ?? []) {
      const label = button.label?.trim();
      const reply = resolveMessagePresentationActionValue(button.action)?.trim();
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
    presentation?.title?.trim() ||
    presentation?.blocks.find((block) => block.type === "text")?.text?.trim() || "Choose an action";
  return {
    widget_type: "zform",
    extra_data: {
      type: "choices",
      heading,
      choices,
    },
  };
}

export { presentationToZulipWidgetContent };

export function pollToZulipWidgetContent(poll: PollInput): ZulipWidgetContent {
  const heading = poll.question.trim();
  const choices = poll.options
    .map((option) => option.trim())
    .filter(Boolean)
    .map((option) => ({
      type: "multiple_choice" as const,
      short_name: option,
      long_name: option,
      reply: option,
    }));

  return {
    widget_type: "zform",
    extra_data: {
      type: "choices",
      heading,
      choices,
      poll: true,
      ...(poll.maxSelections && poll.maxSelections > 1
        ? { max_selections: poll.maxSelections }
        : {}),
    },
  };
}

export function resolveZulipWidgetContent(params: {
  presentation?: MessagePresentation;
  channelData?: ZulipChannelData;
}): unknown {
  const presentationWidget = presentationToZulipWidgetContent(params.presentation);
  if (presentationWidget) {
    return presentationWidget;
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

function hasHostMediaAccess(opts: ZulipSendOpts): boolean {
  return Boolean(opts.mediaAccess || opts.mediaLocalRoots?.length || opts.mediaReadFile);
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

  const client = createZulipClient({
    baseUrl,
    email,
    apiKey,
    log: {
      retry: (event) => logger.warn?.("zulip api request retry", event),
      failure: (event) => logger.error?.("zulip api request failed", event),
    },
  });
  const normalizedTarget = normalizeLegacyZulipTarget(to);
  if (normalizedTarget.convertedFromLegacy) {
    logger.warn?.("zulip send received legacy session-key target, auto-converting", {
      originalTo: to,
      normalizedTo: normalizedTarget.normalized,
    });
  }
  const target = resolveZulipDestination(normalizedTarget.normalized, opts.topic, account.config.defaultTopic);
  let message = text?.trim() ?? "";
  const rawMediaUrl = opts.mediaUrl?.trim();
  let mediaUrl = rawMediaUrl;
  let tempFilePath: string | undefined;
  let tempDir: string | undefined;
  let tempFileCleanup = false;

  if (mediaUrl) {
    const localPath = resolveZulipLocalPath(mediaUrl);
    const isZulipHosted = isHttpUrl(mediaUrl) && mediaUrl.startsWith(baseUrl);
    if (hasHostMediaAccess(opts) && !isZulipHosted) {
      const maxBytes = (opts.cfg.agents?.defaults?.mediaMaxMb ?? 5) * 1024 * 1024;
      const loaded = await loadOutboundMediaFromUrl(mediaUrl, {
        maxBytes,
        mediaAccess: opts.mediaAccess,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
      });
      const filename =
        loaded.fileName ||
        (() => {
          try {
            return path.basename(new URL(mediaUrl).pathname) || "upload.bin";
          } catch {
            return path.basename(localPath ?? "") || "upload.bin";
          }
        })();
      const temp = await writeTempFile(loaded.buffer, filename);
      tempFilePath = temp.filePath;
      tempDir = temp.dir;
      tempFileCleanup = true;
      const upload = await uploadZulipFile(client, tempFilePath);
      mediaUrl = upload.url;
      await fsPromises.unlink(tempFilePath).catch(() => undefined);
      await fsPromises.rmdir(tempDir).catch(() => undefined);
    } else if (localPath && fs.existsSync(localPath)) {
      const upload = await uploadZulipFile(client, localPath);
      mediaUrl = upload.url;
    } else if (isHttpUrl(mediaUrl) && !isZulipHosted) {
      const maxBytes = (opts.cfg.agents?.defaults?.mediaMaxMb ?? 5) * 1024 * 1024;
      const fetched = await core.channel.media.readRemoteMediaBuffer({
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

  const preflightTargetSummary = (() => {
    if (target.kind === "user") {
      return { targetKind: target.kind, to: target.email };
    }
    return {
      targetKind: target.kind,
      stream: target.stream,
      topic: target.topic,
    };
  })();

  const questionDeliveryContext = getZulipQuestionDeliveryContext();
  const questionPreparation = questionDeliveryContext
    ? zulipQuestionZformStore.prepare({
        presentation: opts.presentation,
        channelData: opts.channelData,
      })
    : undefined;
  const presentationWidget = questionPreparation
    ? undefined
    : presentationToZulipWidgetContent(opts.presentation);
  const questionStreamId = questionPreparation && target.kind !== "user"
    ? await resolveZulipStreamId(client, target.stream)
    : undefined;
  const widgetContent = questionPreparation?.widgetContent ?? presentationWidget ?? resolveZulipWidgetContent({
    presentation: undefined,
    channelData: opts.channelData,
  });

  if (!message && !widgetContent) {
    throw new Error("Zulip message is empty");
  }

  const widgetContentSource = questionPreparation
    ? "ask_user"
    : presentationWidget
      ? "presentation"
    : opts.channelData?.zulip?.widgetContent
      ? "channelData"
      : "none";
  logger.debug?.("zulip outbound send start", {
    ...preflightTargetSummary,
    accountId: account.accountId,
    hasMedia: Boolean(rawMediaUrl),
    hasPresentation: Boolean(opts.presentation?.blocks?.length),
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
    const response = await sendZulipStreamMessage(client, {
      stream: target.stream,
      topic: target.topic,
      content: message,
      widgetContent,
    });
    messageId = response.id ? String(response.id) : "unknown";
  }

  logger.debug?.("zulip outbound send success", {
    ...preflightTargetSummary,
    accountId: account.accountId,
    messageId,
    hadWidget: Boolean(widgetContent),
    widgetContentSource,
  });

  if (questionPreparation) {
    const conversation =
      target.kind === "user"
        ? { kind: "dm" as const, recipient: target.email }
        : {
            kind: "stream" as const,
            stream: target.stream,
            topic: target.topic,
          };
    if (!zulipQuestionZformStore.register({
      preparation: questionPreparation,
      accountId: account.accountId,
      conversation: conversation.kind === "stream"
        ? { ...conversation, stream: questionStreamId! }
        : conversation,
      deliveryConversation: conversation,
      authorizedSenderId: questionDeliveryContext!.authorizedSenderId,
      sourceMessageId: messageId,
      sourceText: message,
      client,
      logDebug: (detail) => logger.debug?.(detail),
    })) {
      logger.debug?.("zulip ask_user widget sent without native resolution binding", {
        accountId: account.accountId,
        messageId,
      });
    }
  }

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

export async function sendPollZulip(
  to: string,
  poll: PollInput,
  opts: Omit<ZulipSendOpts, "presentation" | "channelData">,
): Promise<ZulipSendResult> {
  return await sendMessageZulip(to, poll.question, {
    ...opts,
    channelData: {
      zulip: {
        widgetContent: pollToZulipWidgetContent(poll),
      },
    },
  });
}

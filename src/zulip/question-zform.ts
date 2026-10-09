import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { bindingHash, bindingScope, durableBindings, type DurableRecord } from "./durable-bindings.js";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { MessagePresentation } from "../sdk.js";
import type { OpenClawConfig, ReplyPayload } from "../sdk.js";
import {
  deleteZulipMessage,
  sendZulipPrivateMessage,
  sendZulipStreamMessage,
  type ZulipClient,
} from "./client.js";

const CONTROL_PREFIX = "ocq1:";
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const QUESTION_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;
const ACTIVE_TTL_MS = 60 * 60 * 1_000;
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_TERMINAL_SUFFIX = 512;
const MAX_BINDINGS = 2_000;

type ZulipQuestionConversation =
  | { kind: "dm"; recipient: string }
  | { kind: "stream"; stream: string; topic: string };

type ZulipQuestionBinding = {
  nonce: string;
  questionId: string;
  optionValues: string[];
  accountId: string;
  conversation: ZulipQuestionConversation;
  authorizedSenderId: string;
  sourceMessageId: string;
  sourceText: string;
  expiresAt: number;
  terminal: boolean;
  resolving: boolean;
  restored?: boolean;
  durable?: DurableRecord;
  durableReady?: Promise<void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

type QuestionButton = {
  label: string;
  optionValue: string;
};

export type ZulipQuestionZformPreparation = {
  nonce: string;
  questionId: string;
  optionValues: string[];
  widgetContent: {
    widget_type: "zform";
    extra_data: {
      type: "choices";
      heading: string;
      choices: Array<{
        type: "multiple_choice";
        short_name: string;
        long_name: string;
        reply: string;
      }>;
    };
  };
};

export type ZulipQuestionControlMessage = {
  accountId: string;
  conversation: ZulipQuestionConversation;
  senderId: string;
  text: string;
  html?: string;
  expectedBotMention?: string;
};

export type ZulipQuestionControlResult =
  | { recognized: false }
  | { recognized: true; status: "answered"; optionValue: string }
  | { recognized: true; status: "rejected"; feedback: string }
  | { recognized: true; status: "stale"; feedback: string };

export type ZulipQuestionDeliveryContext = {
  authorizedSenderId: string;
  conversation: ZulipQuestionConversation;
};

const questionDeliveryContext = new AsyncLocalStorage<ZulipQuestionDeliveryContext>();

export function runWithZulipQuestionDeliveryContext<T>(
  context: ZulipQuestionDeliveryContext,
  fn: () => T,
): T {
  return questionDeliveryContext.run(context, fn);
}

export function getZulipQuestionDeliveryContext(): ZulipQuestionDeliveryContext | undefined {
  return questionDeliveryContext.getStore();
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeConversation(conversation: ZulipQuestionConversation): ZulipQuestionConversation {
  return conversation.kind === "dm"
    ? { kind: "dm", recipient: normalizeIdentity(conversation.recipient) }
    : {
        kind: "stream",
        stream: conversation.stream.trim(),
        topic: conversation.topic.trim(),
      };
}

function conversationsMatch(
  left: ZulipQuestionConversation,
  right: ZulipQuestionConversation,
): boolean {
  const normalizedLeft = normalizeConversation(left);
  const normalizedRight = normalizeConversation(right);
  if (normalizedLeft.kind !== normalizedRight.kind) {
    return false;
  }
  return normalizedLeft.kind === "dm"
    ? normalizedLeft.recipient === (normalizedRight as { kind: "dm"; recipient: string }).recipient
    : normalizedLeft.stream ===
        (normalizedRight as { kind: "stream"; stream: string; topic: string }).stream &&
        normalizedLeft.topic ===
          (normalizedRight as { kind: "stream"; stream: string; topic: string }).topic;
}

function readAskUserBinding(payload: Pick<ReplyPayload, "channelData">):
  | { questionId: string; optionValues: string[] }
  | undefined {
  const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
  const askUser = payload.channelData?.askUser;
  if (
    !questionId ||
    !QUESTION_ID_PATTERN.test(questionId) ||
    !askUser ||
    typeof askUser !== "object" ||
    Array.isArray(askUser)
  ) {
    return undefined;
  }
  const optionValues = (askUser as { optionValues?: unknown }).optionValues;
  if (
    !Array.isArray(optionValues) ||
    optionValues.length < 2 ||
    optionValues.length > 4 ||
    !optionValues.every((value) => typeof value === "string" && value.trim())
  ) {
    return undefined;
  }
  const normalized = optionValues.map((value) => value.trim().toLowerCase());
  if (new Set(normalized).size !== optionValues.length) {
    return undefined;
  }
  return { questionId, optionValues: [...optionValues] };
}

function readQuestionButtons(params: {
  presentation?: MessagePresentation;
  questionId: string;
  optionValues: readonly string[];
}): QuestionButton[] | undefined {
  const buttonBlocks = params.presentation?.blocks.filter((block) => block.type === "buttons") ?? [];
  if (buttonBlocks.length !== 1) {
    return undefined;
  }
  const buttons = new Map<string, QuestionButton>();
  for (const button of buttonBlocks[0]?.buttons ?? []) {
    const action = button.action;
    if (action?.type !== "question" || action.questionId !== params.questionId) {
      return undefined;
    }
    if ("intent" in action) {
      // ask_user keeps its free-form "Other" path in readable text. The zform
      // represents only the complete canonical fixed-choice set, and ordinary
      // text replies continue through the existing Gateway/harness path.
      continue;
    }
    const optionIndex = params.optionValues.findIndex(
      (value) => value.trim().toLowerCase() === action.optionValue.trim().toLowerCase(),
    );
    if (optionIndex < 0 || !button.label.trim()) {
      return undefined;
    }
    const optionValue = params.optionValues[optionIndex]!;
    const key = optionValue.trim().toLowerCase();
    if (buttons.has(key)) {
      return undefined;
    }
    buttons.set(key, { label: button.label.trim(), optionValue });
  }
  if (buttons.size !== params.optionValues.length) {
    return undefined;
  }
  return params.optionValues.map((optionValue) => buttons.get(optionValue.trim().toLowerCase())!);
}

function resolveHeading(presentation: MessagePresentation | undefined): string {
  return (
    presentation?.title?.trim() ||
    presentation?.blocks.find((block) => block.type === "text")?.text.trim() ||
    "Choose an option"
  );
}

function buildControlToken(nonce: string, optionIndex: number): string {
  return `${CONTROL_PREFIX}${nonce}:${optionIndex}`;
}

function stripExpectedBotMention(text: string, expectedBotMention: string | undefined): string {
  const trimmed = text.trim();
  const mention = expectedBotMention?.trim();
  if (!mention) {
    return trimmed;
  }
  const prefix = `@${mention}`;
  if (!trimmed.startsWith(prefix)) {
    return trimmed;
  }
  const remainder = trimmed.slice(prefix.length);
  return /^\s/u.test(remainder) ? remainder.trim() : trimmed;
}

function parseControlToken(text: string, expectedBotMention?: string):
  | { recognized: false }
  | { recognized: true; nonce?: string; optionIndex?: number } {
  const trimmed = stripExpectedBotMention(text, expectedBotMention);
  if (!trimmed.startsWith(CONTROL_PREFIX)) {
    return { recognized: false };
  }
  const match = trimmed.match(/^ocq1:([A-Za-z0-9_-]{22}):([0-3])$/u);
  if (!match || !NONCE_PATTERN.test(match[1] ?? "")) {
    return { recognized: true };
  }
  return { recognized: true, nonce: match[1], optionIndex: Number(match[2]) };
}

type FallbackSelection =
  | { kind: "index"; optionIndex: number; optionText?: string }
  | { kind: "text"; optionText: string }
  | { kind: "invalid" };

function decodeZulipText(text: string): string {
  return text
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .trim();
}

function parseFallbackSelection(params: {
  text: string;
  html?: string;
  expectedBotMention?: string;
}): FallbackSelection | undefined {
  const html = params.html?.trim();
  if (html) {
    const match = html.match(
      /^<ol\s+start=["']([1-4])["']\s*>\s*<li>([^<>]*)<\/li>\s*<\/ol>$/iu,
    );
    if (match) {
      return {
        kind: "index",
        optionIndex: Number(match[1]) - 1,
        optionText: decodeZulipText(match[2] ?? "") || undefined,
      };
    }
    if (/<\/?(?:ol|li)\b/iu.test(html)) {
      return { kind: "invalid" };
    }
  }

  const text = stripExpectedBotMention(params.text, params.expectedBotMention);
  const numbered = text.match(/^(\d+)(?:\.|\))?(?:\s+(.+))?$/u);
  if (numbered) {
    const optionNumber = Number(numbered[1]);
    if (!Number.isSafeInteger(optionNumber) || optionNumber < 1 || optionNumber > 4) {
      return { kind: "invalid" };
    }
    return {
      kind: "index",
      optionIndex: optionNumber - 1,
      optionText: numbered[2]?.trim() || undefined,
    };
  }
  if (!text) {
    return undefined;
  }
  return { kind: "text", optionText: text.trim() };
}

function resolveFallbackOption(
  binding: ZulipQuestionBinding,
  selection: FallbackSelection,
): { kind: "match"; optionValue: string } | { kind: "invalid" } | { kind: "none" } {
  if (selection.kind === "invalid") {
    return { kind: "invalid" };
  }
  if (selection.kind === "text") {
    const optionValue = binding.optionValues.find(
      (value) => value.trim().toLowerCase() === (binding.restored ? bindingHash(selection.optionText.trim().toLowerCase()) : selection.optionText.trim().toLowerCase()),
    );
    return optionValue ? { kind: "match", optionValue } : { kind: "none" };
  }
  const optionValue = binding.optionValues[selection.optionIndex];
  if (!optionValue) {
    return { kind: "invalid" };
  }
  if (!selection.optionText) {
    return { kind: "match", optionValue };
  }
  const selectedText = binding.restored ? bindingHash(selection.optionText.trim().toLowerCase()) : selection.optionText.trim().toLowerCase();
  const namedOption = binding.optionValues.find(
    (value) => value.trim().toLowerCase() === selectedText,
  );
  if (namedOption) {
    return namedOption === optionValue ? { kind: "match", optionValue } : { kind: "invalid" };
  }
  return { kind: "none" };
}

function terminalText(sourceText: string, statusLine: string): string {
  const status = statusLine.trim();
  const icon = /^answered\b/iu.test(status)
    ? "✅"
    : /^(?:expired|timed out)\b/iu.test(status)
      ? "⏳"
      : /^(?:cancelled|canceled)\b/iu.test(status)
        ? "❌"
        : "ℹ️";
  const prefix = `> ${icon} `;
  const suffix = status
    ? `${prefix}${status.slice(0, Math.max(0, MAX_TERMINAL_SUFFIX - prefix.length))}`
    : "";
  return suffix ? `${sourceText.trim()}\n\n${suffix}` : sourceText.trim();
}

async function sendTerminalReplacement(params: {
  client: ZulipClient;
  conversation: ZulipQuestionConversation;
  content: string;
}): Promise<string | undefined> {
  const response =
    params.conversation.kind === "dm"
      ? await sendZulipPrivateMessage(params.client, {
          to: params.conversation.recipient,
          content: params.content,
        })
      : await sendZulipStreamMessage(params.client, {
          stream: params.conversation.stream,
          topic: params.conversation.topic,
          content: params.content,
        });
  return response.id === undefined ? undefined : String(response.id);
}

export class ZulipQuestionZformStore {
  private readonly bindings = new Map<string, ZulipQuestionBinding>();

  constructor(private readonly maxBindings = MAX_BINDINGS) {}

  async restore(params: { cfg: OpenClawConfig; accountId: string; client: ZulipClient; hostVersion?: string }): Promise<void> {
    for (const { key, record } of await durableBindings.records(params.accountId, params.client)) {
      if (record.kind !== "question" || !record.id || !record.nonce || !record.conversation || !record.senderHash || !record.optionHashes || this.bindings.has(record.nonce)) continue;
      // The public authorizer runs after the read and before any write. A denied
      // probe detects pending state without replaying an answer.
      // 9.3 ignores authorize and would submit the probe as a real answer. Its
      // recovery is deliberately inert rather than risking duplicate resolution.
      const version = params.hostVersion?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
      const safeProbe = version && (version[0] > 2026 || version[0] === 2026 && (version[1] > 9 || version[1] === 9 && version[2] >= 6));
      const state = safeProbe ? await questionGatewayRuntime.resolveOption({ cfg: params.cfg, questionId: record.id, optionIndex: 0, authorize: () => false }) : { status: "already-terminal" as const };
      if (record.expiresAt <= Date.now() || state.status === "already-terminal") {
        const replacement = await sendTerminalReplacement({ client: params.client, conversation: record.conversation, content: record.expiresAt <= Date.now() ? "⌛ Question expired" : "Question already resolved or unavailable" });
        if (replacement) { await deleteZulipMessage(params.client, { messageId: record.messageId }); await durableBindings.remove(key, record); }
        continue;
      }
      if (state.status !== "denied") continue;
      this.register({ preparation: { nonce: record.nonce, questionId: record.id, optionValues: record.optionHashes, widgetContent: { widget_type: "zform", extra_data: { type: "choices", heading: "", choices: [] } } }, accountId: params.accountId, conversation: record.conversation, authorizedSenderId: record.senderHash, sourceMessageId: record.messageId, sourceText: "", client: params.client, restoredRecord: record });
      const binding = this.bindings.get(record.nonce);
      if (binding) {
        await binding.durableReady;
        if (!binding.durable) this.deleteBinding(binding);
      }
    }
  }

  prepare(payload: Pick<ReplyPayload, "channelData" | "presentation">):
    | ZulipQuestionZformPreparation
    | undefined {
    const binding = readAskUserBinding(payload);
    if (!binding) {
      return undefined;
    }
    const buttons = readQuestionButtons({
      presentation: payload.presentation,
      questionId: binding.questionId,
      optionValues: binding.optionValues,
    });
    if (!buttons) {
      return undefined;
    }
    const nonce = randomBytes(16).toString("base64url");
    return {
      nonce,
      questionId: binding.questionId,
      optionValues: binding.optionValues,
      widgetContent: {
        widget_type: "zform",
        extra_data: {
          type: "choices",
          heading: resolveHeading(payload.presentation),
          choices: buttons.map((button) => {
            const optionIndex = binding.optionValues.indexOf(button.optionValue);
            return {
              type: "multiple_choice" as const,
              short_name: button.label,
              long_name: button.label,
              reply: buildControlToken(nonce, optionIndex),
            };
          }),
        },
      },
    };
  }

  register(params: {
    preparation: ZulipQuestionZformPreparation;
    accountId: string;
    conversation: ZulipQuestionConversation;
    deliveryConversation?: ZulipQuestionConversation;
    authorizedSenderId: string;
    sourceMessageId: string;
    sourceText: string;
    client: ZulipClient;
    logDebug?: (message: string) => void;
    restoredRecord?: DurableRecord;
  }): boolean {
    const accountId = params.accountId.trim();
    const senderId = normalizeIdentity(params.authorizedSenderId);
    const sourceMessageId = params.sourceMessageId.trim();
    if (
      !QUESTION_ID_PATTERN.test(params.preparation.questionId) ||
      !accountId ||
      !senderId ||
      !sourceMessageId ||
      sourceMessageId === "unknown"
    ) {
      return false;
    }
    this.pruneForRegistration();
    const existing = this.bindings.get(params.preparation.nonce);
    if (existing || this.bindings.size >= this.maxBindings) {
      return false;
    }
    const binding: ZulipQuestionBinding = {
      nonce: params.preparation.nonce,
      questionId: params.preparation.questionId,
      optionValues: [...params.preparation.optionValues],
      accountId,
      conversation: normalizeConversation(params.conversation),
      authorizedSenderId: senderId,
      sourceMessageId,
      sourceText: params.sourceText,
      expiresAt: params.restoredRecord?.expiresAt ?? Date.now() + ACTIVE_TTL_MS,
      terminal: false,
      resolving: false,
      restored: Boolean(params.restoredRecord),
    };
    this.bindings.set(binding.nonce, binding);
    binding.durableReady = durableBindings.claim(`question:${accountId}:${binding.nonce}`, { kind: "question", accountId, scope: bindingScope(params.client), messageId: sourceMessageId, id: binding.questionId, nonce: binding.nonce, conversation: binding.conversation, senderHash: params.restoredRecord?.senderHash ?? bindingHash(senderId), optionHashes: params.restoredRecord?.optionHashes ?? binding.optionValues.map(value => bindingHash(value.trim().toLowerCase())), expiresAt: binding.expiresAt }, params.restoredRecord?.generation).then(record => { binding.durable = record; });
    binding.cleanupTimer = setTimeout(() => this.markTerminal(binding), Math.max(0, binding.expiresAt - Date.now()));
    binding.cleanupTimer.unref?.();
    try {
      questionGatewayRuntime.registerChannelDelivery({
        questionId: binding.questionId,
        deliveryId: `zulip-zform:${accountId}:${sourceMessageId}`,
        finalize: async (statusLine) => {
          await binding.durableReady;
          if (binding.restored && !binding.durable || binding.durable && !await durableBindings.current(`question:${binding.accountId}:${binding.nonce}`, binding.durable)) return;
          this.markTerminal(binding);
          let replacementMessageId: string | undefined;
          try {
            replacementMessageId = await sendTerminalReplacement({
              client: params.client,
              conversation: params.deliveryConversation ?? binding.conversation,
              content: terminalText(binding.sourceText, statusLine),
            });
          } catch (error) {
            params.logDebug?.(
              `zulip: unable to send terminal replacement for ask_user message ${sourceMessageId}: ${String(error)}`,
            );
            return;
          }
          if (!replacementMessageId) {
            params.logDebug?.(
              `zulip: terminal replacement for ask_user message ${sourceMessageId} returned no message id; retaining source widget`,
            );
            return;
          }
          try {
            await deleteZulipMessage(params.client, { messageId: sourceMessageId });
            await binding.durableReady;
            if (binding.durable) await durableBindings.remove(`question:${binding.accountId}:${binding.nonce}`, binding.durable);
          } catch (sourceDeleteError) {
            params.logDebug?.(
              `zulip: unable to delete finalized ask_user source message ${sourceMessageId}: ${String(sourceDeleteError)}`,
            );
            try {
              await deleteZulipMessage(params.client, { messageId: replacementMessageId });
            } catch (cleanupError) {
              params.logDebug?.(
                `zulip: unable to clean up terminal replacement message ${replacementMessageId} after source deletion failed: ${String(cleanupError)}`,
              );
            }
          }
        },
      });
    } catch (error) {
      this.deleteBinding(binding);
      params.logDebug?.(`zulip: unable to register ask_user delivery: ${String(error)}`);
      return false;
    }
    return true;
  }

  recognizes(message: ZulipQuestionControlMessage): boolean {
    if (parseControlToken(message.text, message.expectedBotMention).recognized) {
      return true;
    }
    const selection = parseFallbackSelection(message);
    return Boolean(selection && this.identityBindings(message).some((binding) =>
      resolveFallbackOption(binding, selection).kind !== "none",
    ));
  }

  private identityBindings(message: ZulipQuestionControlMessage): ZulipQuestionBinding[] {
    return [...this.bindings.values()].filter((binding) =>
      binding.accountId === message.accountId.trim() &&
      binding.authorizedSenderId === (binding.restored ? bindingHash(normalizeIdentity(message.senderId)) : normalizeIdentity(message.senderId)) &&
      conversationsMatch(binding.conversation, message.conversation),
    );
  }

  async intercept(params: {
    message: ZulipQuestionControlMessage;
    cfg: OpenClawConfig;
    gatewayUrl?: string;
    logDebug?: (message: string) => void;
  }): Promise<ZulipQuestionControlResult> {
    const parsed = parseControlToken(
      params.message.text,
      params.message.expectedBotMention,
    );
    if (!parsed.recognized) {
      return this.interceptFallback(params);
    }
    if (!parsed.nonce || parsed.optionIndex === undefined) {
      return { recognized: true, status: "rejected", feedback: "That question control is invalid." };
    }
    const binding = this.bindings.get(parsed.nonce);
    await binding?.durableReady;
    if (!binding || binding.terminal || binding.expiresAt <= Date.now()) {
      if (binding) {
        this.markTerminal(binding);
      }
      return { recognized: true, status: "stale", feedback: "That question is no longer active." };
    }
    if (binding.resolving) {
      return { recognized: true, status: "stale", feedback: "That question answer is already being submitted." };
    }
    if (
      binding.accountId !== params.message.accountId.trim() ||
      binding.authorizedSenderId !== (binding.restored ? bindingHash(normalizeIdentity(params.message.senderId)) : normalizeIdentity(params.message.senderId)) ||
      !conversationsMatch(binding.conversation, params.message.conversation)
    ) {
      return { recognized: true, status: "rejected", feedback: "That question control is not valid here." };
    }
    const optionValue = binding.optionValues[parsed.optionIndex];
    if (!optionValue) {
      return { recognized: true, status: "rejected", feedback: "That question option is invalid." };
    }
    binding.resolving = true;
    try {
      const result = await questionGatewayRuntime.resolveOption({
        cfg: params.cfg,
        questionId: binding.questionId,
        ...(binding.restored ? { optionIndex: parsed.optionIndex } : { optionValue }),
        authorize: async () => !binding.terminal && (!binding.durable || await durableBindings.current(`question:${binding.accountId}:${binding.nonce}`, binding.durable)),
        senderId: params.message.senderId,
        gatewayUrl: params.gatewayUrl,
        clientDisplayName: `Zulip question (${params.message.senderId})`,
      });
      if (result.status === "already-terminal") {
        this.markTerminal(binding);
        return { recognized: true, status: "stale", feedback: "That question is no longer active." };
      }
      if (result.status !== "answered" || (!binding.restored && result.optionValue !== optionValue)) {
        this.markTerminal(binding);
        return { recognized: true, status: "rejected", feedback: "That question answer was not accepted." };
      }
      this.markTerminal(binding);
      return { recognized: true, status: "answered", optionValue: result.optionValue };
    } catch (error) {
      if (!binding.terminal) {
        binding.resolving = false;
      }
      params.logDebug?.(`zulip: ask_user option resolution failed: ${String(error)}`);
      return { recognized: true, status: "rejected", feedback: "That question answer could not be submitted." };
    }
  }

  private async interceptFallback(params: {
    message: ZulipQuestionControlMessage;
    cfg: OpenClawConfig;
    gatewayUrl?: string;
    logDebug?: (message: string) => void;
  }): Promise<ZulipQuestionControlResult> {
    const selection = parseFallbackSelection({
      text: params.message.text,
      html: params.message.html,
      expectedBotMention: params.message.expectedBotMention,
    });
    if (!selection) {
      return { recognized: false };
    }

    const identityBindings = this.identityBindings(params.message);
    const now = Date.now();
    const activeBindings = identityBindings.filter(
      (binding) => !binding.terminal && binding.expiresAt > now,
    );
    if (selection.kind === "invalid") {
      return activeBindings.length > 0
        ? { recognized: true, status: "rejected", feedback: "That question option is invalid." }
        : { recognized: false };
    }
    const activeMatches = activeBindings
      .map((binding) => ({ binding, resolution: resolveFallbackOption(binding, selection) }))
      .filter((candidate) => candidate.resolution.kind !== "none");
    if (activeMatches.length > 1) {
      return {
        recognized: true,
        status: "rejected",
        feedback: "That question answer is ambiguous. Please use the question controls.",
      };
    }
    if (activeMatches.length === 0) {
      const terminalMatches = identityBindings
        .filter((binding) => binding.terminal || binding.expiresAt <= now)
        .filter((binding) => resolveFallbackOption(binding, selection).kind !== "none");
      if (terminalMatches.length > 0) {
        for (const binding of terminalMatches) {
          if (!binding.terminal) {
            this.markTerminal(binding);
          }
        }
        return { recognized: true, status: "stale", feedback: "That question is no longer active." };
      }
      return { recognized: false };
    }

    const { binding, resolution } = activeMatches[0]!;
    if (binding.resolving) {
      return {
        recognized: true,
        status: "stale",
        feedback: "That question answer is already being submitted.",
      };
    }
    if (resolution.kind !== "match") {
      return { recognized: true, status: "rejected", feedback: "That question option is invalid." };
    }
    const optionValue = resolution.optionValue;

    await binding.durableReady;
    binding.resolving = true;
    try {
      const result = await questionGatewayRuntime.resolveOption({
        cfg: params.cfg,
        questionId: binding.questionId,
        ...(binding.restored ? { optionIndex: binding.optionValues.indexOf(optionValue) } : { optionValue }),
        authorize: async () => !binding.terminal && (!binding.durable || await durableBindings.current(`question:${binding.accountId}:${binding.nonce}`, binding.durable)),
        senderId: params.message.senderId,
        gatewayUrl: params.gatewayUrl,
        clientDisplayName: `Zulip question (${params.message.senderId})`,
      });
      if (result.status === "already-terminal") {
        this.markTerminal(binding);
        return { recognized: true, status: "stale", feedback: "That question is no longer active." };
      }
      if (result.status !== "answered" || (!binding.restored && result.optionValue !== optionValue)) {
        this.markTerminal(binding);
        return { recognized: true, status: "rejected", feedback: "That question answer was not accepted." };
      }
      this.markTerminal(binding);
      return { recognized: true, status: "answered", optionValue: result.optionValue };
    } catch (error) {
      if (!binding.terminal) {
        binding.resolving = false;
      }
      params.logDebug?.(`zulip: ask_user fallback resolution failed: ${String(error)}`);
      return { recognized: true, status: "rejected", feedback: "That question answer could not be submitted." };
    }
  }

  clear(): void {
    for (const binding of [...this.bindings.values()]) {
      this.deleteBinding(binding);
    }
  }

  private pruneForRegistration(): void {
    const now = Date.now();
    for (const binding of [...this.bindings.values()]) {
      if (binding.expiresAt <= now) {
        this.deleteBinding(binding);
      }
    }
    while (this.bindings.size >= this.maxBindings) {
      const oldestTerminal = [...this.bindings.values()].find((binding) => binding.terminal);
      if (!oldestTerminal) {
        return;
      }
      this.deleteBinding(oldestTerminal);
    }
  }

  private deleteBinding(binding: ZulipQuestionBinding): void {
    if (binding.cleanupTimer) {
      clearTimeout(binding.cleanupTimer);
      binding.cleanupTimer = undefined;
    }
    if (this.bindings.get(binding.nonce) === binding) {
      this.bindings.delete(binding.nonce);
    }
  }

  private markTerminal(binding: ZulipQuestionBinding): void {
    if (binding.terminal) {
      return;
    }
    binding.terminal = true;
    binding.resolving = false;
    binding.expiresAt = Date.now() + TERMINAL_TTL_MS;
    if (binding.cleanupTimer) {
      clearTimeout(binding.cleanupTimer);
      binding.cleanupTimer = undefined;
    }
    if (this.bindings.get(binding.nonce) !== binding) {
      return;
    }
    binding.cleanupTimer = setTimeout(() => {
      this.deleteBinding(binding);
    }, TERMINAL_TTL_MS);
    binding.cleanupTimer.unref?.();
  }
}

export const zulipQuestionZformStore = new ZulipQuestionZformStore();

export type { ZulipQuestionConversation };

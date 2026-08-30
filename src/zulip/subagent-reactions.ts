import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawPluginApi } from "../sdk.js";

type ReactionContext = {
  requesterSessionKey: string;
  activeRunIds: Set<string>;
  indicatorDesired: boolean;
  indicatorShown: boolean;
  indicatorOperation: Promise<void>;
  terminal: boolean;
  closed: boolean;
  resolveClosed: () => void;
  show: () => Promise<void>;
  hide: () => Promise<void>;
};

const currentContextBySession = new Map<string, ReactionContext>();
const contextByRunId = new Map<string, ReactionContext>();
const activeContexts = new Set<ReactionContext>();
const reactionContextStorage = new AsyncLocalStorage<ReactionContext>();

function updateIndicator(context: ReactionContext, visible: boolean): Promise<void> {
  context.indicatorDesired = visible;
  const applyDesiredState = async () => {
    if (context.indicatorDesired === context.indicatorShown) {
      return;
    }
    if (context.indicatorDesired) {
      await context.show();
      context.indicatorShown = true;
      return;
    }
    await context.hide();
    context.indicatorShown = false;
  };
  context.indicatorOperation = context.indicatorOperation.then(applyDesiredState, applyDesiredState);
  return context.indicatorOperation;
}

function resolveRunId(event: { runId?: string }, ctx: { runId?: string }): string {
  return event.runId?.trim() || ctx.runId?.trim() || "";
}

function closeContext(context: ReactionContext): void {
  if (context.closed) {
    return;
  }
  context.closed = true;
  activeContexts.delete(context);
  context.resolveClosed();
}

export function registerZulipSubagentReactionContext(params: {
  requesterSessionKey: string;
  show: () => Promise<void>;
  hide: () => Promise<void>;
}): {
  run: <T>(callback: () => Promise<T>) => Promise<T>;
  finish: () => Promise<void>;
  cancel: () => Promise<void>;
  closed: Promise<void>;
} {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const context: ReactionContext = {
    requesterSessionKey: params.requesterSessionKey,
    activeRunIds: new Set(),
    indicatorDesired: false,
    indicatorShown: false,
    indicatorOperation: Promise.resolve(),
    terminal: false,
    closed: false,
    resolveClosed,
    show: params.show,
    hide: params.hide,
  };
  currentContextBySession.set(params.requesterSessionKey, context);
  activeContexts.add(context);

  return {
    run: (callback) => reactionContextStorage.run(context, callback),
    closed,
    finish: async () => {
      if (context.terminal) {
        return;
      }
      context.terminal = true;
      if (currentContextBySession.get(context.requesterSessionKey) === context) {
        currentContextBySession.delete(context.requesterSessionKey);
      }
      if (context.activeRunIds.size === 0) {
        await updateIndicator(context, false);
        closeContext(context);
      }
    },
    cancel: async () => {
      context.terminal = true;
      if (currentContextBySession.get(context.requesterSessionKey) === context) {
        currentContextBySession.delete(context.requesterSessionKey);
      }
      for (const runId of context.activeRunIds) {
        if (contextByRunId.get(runId) === context) {
          contextByRunId.delete(runId);
        }
      }
      context.activeRunIds.clear();
      await updateIndicator(context, false);
      closeContext(context);
    },
  };
}

export async function handleZulipSubagentSpawned(
  event: { runId: string; requester?: { channel?: string } },
  ctx: { runId?: string; requesterSessionKey?: string },
): Promise<void> {
  if (event.requester?.channel && event.requester.channel !== "zulip") {
    return;
  }
  const runId = resolveRunId(event, ctx);
  const requesterSessionKey = ctx.requesterSessionKey?.trim() ?? "";
  if (!runId || !requesterSessionKey || contextByRunId.has(runId)) {
    return;
  }
  const asyncContext = reactionContextStorage.getStore();
  const context =
    asyncContext?.requesterSessionKey === requesterSessionKey
      ? asyncContext
      : currentContextBySession.get(requesterSessionKey);
  if (!context || context.terminal) {
    return;
  }
  contextByRunId.set(runId, context);
  context.activeRunIds.add(runId);
  if (context.activeRunIds.size === 1) {
    await updateIndicator(context, true);
  }
}

export async function handleZulipSubagentEnded(
  event: { runId?: string },
  ctx: { runId?: string },
): Promise<void> {
  const runId = resolveRunId(event, ctx);
  if (!runId) {
    return;
  }
  const context = contextByRunId.get(runId);
  if (!context) {
    return;
  }
  contextByRunId.delete(runId);
  context.activeRunIds.delete(runId);
  if (context.activeRunIds.size === 0) {
    await updateIndicator(context, false);
    if (context.terminal) {
      closeContext(context);
    }
  }
}

export async function clearZulipSubagentReactionContexts(): Promise<void> {
  const contexts = Array.from(activeContexts);
  currentContextBySession.clear();
  contextByRunId.clear();
  activeContexts.clear();
  for (const context of contexts) {
    context.terminal = true;
    context.activeRunIds.clear();
    await updateIndicator(context, false);
    closeContext(context);
  }
}

export function registerZulipSubagentReactionHooks(api: OpenClawPluginApi): void {
  api.on("subagent_spawned", handleZulipSubagentSpawned);
  api.on("subagent_ended", handleZulipSubagentEnded);
  api.on("gateway_stop", clearZulipSubagentReactionContexts);
}

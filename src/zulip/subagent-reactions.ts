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
const bindingByRunId = new Map<string, { context: ReactionContext; childSessionKey: string }>();
const bindingsByChildSessionKey = new Map<string, Map<string, ReactionContext>>();
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

function resolveChildSessionKey(
  event: { childSessionKey?: string; targetSessionKey?: string },
  ctx: { childSessionKey?: string },
): string {
  return (
    event.childSessionKey?.trim() ||
    event.targetSessionKey?.trim() ||
    ctx.childSessionKey?.trim() ||
    ""
  );
}

function removeRunBinding(runId: string): ReactionContext | undefined {
  const binding = bindingByRunId.get(runId);
  if (!binding) {
    return undefined;
  }
  bindingByRunId.delete(runId);
  binding.context.activeRunIds.delete(runId);
  if (binding.childSessionKey) {
    const childBindings = bindingsByChildSessionKey.get(binding.childSessionKey);
    childBindings?.delete(runId);
    if (childBindings?.size === 0) {
      bindingsByChildSessionKey.delete(binding.childSessionKey);
    }
  }
  return binding.context;
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
      for (const runId of Array.from(context.activeRunIds)) {
        if (bindingByRunId.get(runId)?.context === context) {
          removeRunBinding(runId);
        }
      }
      await updateIndicator(context, false);
      closeContext(context);
    },
  };
}

export async function handleZulipSubagentSpawned(
  event: { runId: string; childSessionKey?: string; requester?: { channel?: string } },
  ctx: { runId?: string; childSessionKey?: string; requesterSessionKey?: string },
): Promise<void> {
  if (event.requester?.channel && event.requester.channel !== "zulip") {
    return;
  }
  const runId = resolveRunId(event, ctx);
  const childSessionKey = resolveChildSessionKey(event, ctx);
  const requesterSessionKey = ctx.requesterSessionKey?.trim() ?? "";
  if (!runId || !requesterSessionKey || bindingByRunId.has(runId)) {
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
  bindingByRunId.set(runId, { context, childSessionKey });
  if (childSessionKey) {
    const childBindings = bindingsByChildSessionKey.get(childSessionKey) ?? new Map();
    childBindings.set(runId, context);
    bindingsByChildSessionKey.set(childSessionKey, childBindings);
  }
  context.activeRunIds.add(runId);
  if (context.activeRunIds.size === 1) {
    await updateIndicator(context, true);
  }
}

export async function handleZulipSubagentEnded(
  event: { runId?: string; targetSessionKey?: string },
  ctx: { runId?: string; childSessionKey?: string },
): Promise<void> {
  const runId = resolveRunId(event, ctx);
  if (runId) {
    const context = removeRunBinding(runId);
    if (!context) {
      return;
    }
    if (context.activeRunIds.size === 0) {
      await updateIndicator(context, false);
      if (context.terminal) {
        closeContext(context);
      }
    }
    return;
  }
  const childSessionKey = resolveChildSessionKey(event, ctx);
  const childBindings = bindingsByChildSessionKey.get(childSessionKey);
  if (!childSessionKey || !childBindings) {
    return;
  }
  const affectedContexts = new Set<ReactionContext>();
  for (const childRunId of Array.from(childBindings.keys())) {
    const context = removeRunBinding(childRunId);
    if (context) {
      affectedContexts.add(context);
    }
  }
  for (const context of affectedContexts) {
    if (context.activeRunIds.size === 0) {
      await updateIndicator(context, false);
      if (context.terminal) {
        closeContext(context);
      }
    }
  }
}

export async function clearZulipSubagentReactionContexts(): Promise<void> {
  const contexts = Array.from(activeContexts);
  currentContextBySession.clear();
  bindingByRunId.clear();
  bindingsByChildSessionKey.clear();
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

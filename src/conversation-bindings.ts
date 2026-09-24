import type { OpenClawConfig } from "./sdk.js";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
} from "./sdk.js";
import { resolveRuntimeConversationBindingRouteAsync } from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";

type AgentRoute = Parameters<typeof resolveConfiguredBindingRoute>[0]["route"];
type Conversation = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};
type RuntimeBindingRouteResolver = (
  params: Parameters<typeof resolveRuntimeConversationBindingRoute>[0],
) => Promise<ReturnType<typeof resolveRuntimeConversationBindingRoute>>;
type BindingDependencies = {
  resolveConfiguredBindingRoute: typeof resolveConfiguredBindingRoute;
  ensureConfiguredBindingRouteReady: typeof ensureConfiguredBindingRouteReady;
  resolveRuntimeConversationBindingRouteAsync: RuntimeBindingRouteResolver;
};

export async function resolveZulipInboundBindingRoute(
  params: {
    cfg: OpenClawConfig;
    route: AgentRoute;
    conversation: Conversation;
  },
  dependencies: BindingDependencies = {
    resolveConfiguredBindingRoute,
    ensureConfiguredBindingRouteReady,
    resolveRuntimeConversationBindingRouteAsync,
  },
) {
  const configured = dependencies.resolveConfiguredBindingRoute(params);
  const runtime = await dependencies.resolveRuntimeConversationBindingRouteAsync({
    route: configured.route,
    conversation: params.conversation,
  });
  const configuredSelected =
    configured.bindingResolution !== null &&
    runtime.bindingOwnerAvailable !== false &&
    runtime.bindingRecord === null;
  if (configuredSelected) {
    const ready = await dependencies.ensureConfiguredBindingRouteReady({
      cfg: params.cfg,
      bindingResolution: configured.bindingResolution,
    });
    if (!ready.ok) {
      throw new Error(`Configured Zulip conversation binding unavailable: ${ready.error}`);
    }
  }
  return {
    ...runtime,
    boundSessionKey:
      runtime.boundSessionKey ?? (configuredSelected ? configured.boundSessionKey : undefined),
  };
}

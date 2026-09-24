import type { OpenClawConfig } from "./sdk.js";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRouteAsync,
} from "./sdk.js";

type AgentRoute = Parameters<typeof resolveConfiguredBindingRoute>[0]["route"];
type Conversation = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

export async function resolveZulipInboundBindingRoute(
  params: {
    cfg: OpenClawConfig;
    route: AgentRoute;
    conversation: Conversation;
  },
  dependencies = {
    resolveConfiguredBindingRoute,
    ensureConfiguredBindingRouteReady,
    resolveRuntimeConversationBindingRouteAsync,
  },
) {
  const configured = dependencies.resolveConfiguredBindingRoute(params);
  if (configured.bindingResolution) {
    const ready = await dependencies.ensureConfiguredBindingRouteReady({
      cfg: params.cfg,
      bindingResolution: configured.bindingResolution,
    });
    if (!ready.ok) {
      throw new Error(`Configured Zulip conversation binding unavailable: ${ready.error}`);
    }
  }
  const runtime = await dependencies.resolveRuntimeConversationBindingRouteAsync({
    route: configured.route,
    conversation: params.conversation,
  });
  return {
    ...runtime,
    boundSessionKey: runtime.boundSessionKey ?? configured.boundSessionKey,
  };
}

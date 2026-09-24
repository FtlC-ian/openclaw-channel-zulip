declare module "openclaw/plugin-sdk/conversation-binding-runtime" {
  import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";

  export function resolveRuntimeConversationBindingRouteAsync(
    params: Parameters<typeof resolveRuntimeConversationBindingRoute>[0],
  ): Promise<ReturnType<typeof resolveRuntimeConversationBindingRoute>>;
}

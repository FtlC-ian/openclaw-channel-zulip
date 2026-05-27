import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-runtime";
import { describe, expect, it } from "vitest";
import { zulipPlugin } from "./channel.js";
import { resolveZulipSessionConversation } from "./session-conversation.js";
import { zulipMessageActions } from "./actions.js";
import { zulipOnboardingAdapter } from "./onboarding.js";
import { resolveZulipAccount } from "./zulip/accounts.js";

describe("zulipPlugin", () => {
  describe("messaging", () => {
    it("normalizes @username targets", () => {
      const normalize = zulipPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("user:Alice");
      expect(normalize("@alice")).toBe("user:alice");
    });

    it("normalizes zulip: prefix to user:", () => {
      const normalize = zulipPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("zulip:USER123")).toBe("user:USER123");
    });

    it("resolves stream topic conversation ids through the canonical session hook", () => {
      expect(resolveZulipSessionConversation({ kind: "channel", rawId: "4:topic:zulip-plugin-pr" })).toEqual({
        id: "4",
        threadId: "zulip-plugin-pr",
        baseConversationId: "4",
        parentConversationCandidates: ["4"],
      });
    });

    it("prefers session lookup for announce target resolution", () => {
      expect(zulipPlugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
    });

    it("avoids reconstructing stream targets from numeric session ids", () => {
      const resolveTarget = zulipPlugin.messaging?.resolveSessionTarget;
      if (!resolveTarget) {
        throw new Error("resolveSessionTarget missing");
      }

      expect(resolveTarget({ kind: "channel", id: "3", threadId: "polymarket" })).toBeUndefined();
      expect(resolveTarget({ kind: "channel", id: "3" })).toBeUndefined();
      expect(resolveTarget({ kind: "group", id: "ian@example.com" })).toBe("user:ian@example.com");
    });

    it("resolves outbound DM session routes with Zulip user targets", () => {
      const resolveRoute = zulipPlugin.messaging?.resolveOutboundSessionRoute as
        | ((params: {
            cfg: OpenClawConfig;
            agentId: string;
            target: string;
          }) => unknown)
        | undefined;
      if (!resolveRoute) {
        throw new Error("resolveOutboundSessionRoute missing");
      }

      expect(
        resolveRoute({
          cfg: {} as OpenClawConfig,
          agentId: "main",
          target: "@ian@example.com",
        }),
      ).toMatchObject({
        peer: { kind: "direct", id: "ian@example.com" },
        chatType: "direct",
        from: "zulip:ian@example.com",
        to: "user:ian@example.com",
      });
    });

    it("resolves outbound stream topic routes using canonical conversation ids", () => {
      const resolveRoute = zulipPlugin.messaging?.resolveOutboundSessionRoute as
        | ((params: {
            cfg: OpenClawConfig;
            agentId: string;
            target: string;
          }) => unknown)
        | undefined;
      if (!resolveRoute) {
        throw new Error("resolveOutboundSessionRoute missing");
      }

      expect(
        resolveRoute({
          cfg: {} as OpenClawConfig,
          agentId: "main",
          target: "#general:Zulip Plugin PR",
        }),
      ).toMatchObject({
        peer: { kind: "channel", id: "general:topic:zulip-plugin-pr" },
        chatType: "channel",
        from: "zulip:channel:general",
        to: "stream:general:Zulip Plugin PR",
        threadId: "Zulip Plugin PR",
      });
    });

    it("preserves existing Zulip thread context when routing stream sends", () => {
      const resolveRoute = zulipPlugin.messaging?.resolveOutboundSessionRoute as
        | ((params: {
            cfg: OpenClawConfig;
            agentId: string;
            target: string;
            threadId?: string;
          }) => unknown)
        | undefined;
      if (!resolveRoute) {
        throw new Error("resolveOutboundSessionRoute missing");
      }

      expect(
        resolveRoute({
          cfg: {} as OpenClawConfig,
          agentId: "main",
          target: "stream:general",
          threadId: "support",
        }),
      ).toMatchObject({
        peer: { kind: "channel", id: "general:topic:support" },
        to: "stream:general:support",
        threadId: "support",
      });
    });

    it("prefers raw Zulip reply topics over sanitized session thread ids", () => {
      const resolveRoute = zulipPlugin.messaging?.resolveOutboundSessionRoute as
        | ((params: {
            cfg: OpenClawConfig;
            agentId: string;
            target: string;
            replyToId?: string;
            threadId?: string;
          }) => unknown)
        | undefined;
      if (!resolveRoute) {
        throw new Error("resolveOutboundSessionRoute missing");
      }

      expect(
        resolveRoute({
          cfg: {} as OpenClawConfig,
          agentId: "main",
          target: "stream:general",
          replyToId: "Zulip Plugin PR",
          threadId: "zulip-plugin-pr",
        }),
      ).toMatchObject({
        peer: { kind: "channel", id: "general:topic:zulip-plugin-pr" },
        to: "stream:general:Zulip Plugin PR",
        threadId: "Zulip Plugin PR",
      });
    });
  });

  describe("message actions", () => {
    it("prepares send payloads for durable core delivery", async () => {
      const payload = {
        text: "hello",
        mediaUrls: ["https://example.test/a.png"],
        channelData: { zulip: { widgetContent: { widget_type: "zform" } } },
      };

      expect(
        await zulipMessageActions.prepareSendPayload?.({
          ctx: {} as never,
          to: "stream:general:topic",
          payload,
          threadId: "topic",
        }),
      ).toBe(payload);
    });

    it("advertises poll while letting core route through outbound.sendPoll", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            apiKey: { source: "env", provider: "default", id: "ZULIP_API_KEY" },
            email: "bot@example.test",
            url: "https://zulip.example.test",
          },
        },
      };

      expect(zulipMessageActions.describeMessageTool({ cfg }).actions).toContain("poll");
      expect(zulipMessageActions.supportsAction?.({ action: "poll" })).toBe(false);
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = zulipPlugin.pairing?.normalizeAllowEntry;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("alice");
      expect(normalize("user:USER123")).toBe("user123");
    });
  });

  describe("config", () => {
    it("formats allowFrom entries", () => {
      const formatAllowFrom = zulipPlugin.config.formatAllowFrom;

      const formatted = formatAllowFrom?.({
        cfg: {} as OpenClawConfig,
        allowFrom: ["@Alice", "user:USER123", "zulip:BOT999"],
      });
      expect(formatted).toEqual(["@alice", "user123", "bot999"]);
    });

    it("uses account responsePrefix overrides", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            responsePrefix: "[Channel]",
            accounts: {
              default: { responsePrefix: "[Account]" },
            },
          },
        },
      };

      const prefixContext = createReplyPrefixOptions({
        cfg,
        agentId: "main",
        channel: "zulip",
        accountId: "default",
      });

      expect(prefixContext.responsePrefix).toBe("[Account]");
    });

    it("prefers account-level site/realm aliases over base-level url", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            url: "https://base.example.com",
            accounts: {
              default: {
                site: "https://account.example.com",
                realm: "https://account-realm.example.com",
              },
            },
          },
        },
      };

      const account = resolveZulipAccount({ cfg, accountId: "default" });
      expect(account.baseUrl).toBe("https://account.example.com");
    });

    it("falls back to base-level aliases when account has no url aliases", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            site: "https://base-site.example.com",
            accounts: {
              default: {
                name: "Primary",
              },
            },
          },
        },
      };

      const account = resolveZulipAccount({ cfg, accountId: "default" });
      expect(account.baseUrl).toBe("https://base-site.example.com");
    });

    it("treats SecretRef-backed apiKeys as configured in inspect-mode surfaces", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            apiKey: { source: "env", provider: "default", id: "ZULIP_API_KEY" },
            email: "bot@example.test",
            url: "https://zulip.example.test",
          },
        },
      };
      const account = resolveZulipAccount({ cfg });

      expect(account.apiKey).toBeUndefined();
      expect(account.apiKeySource).toBe("secretRef");
      expect(zulipPlugin.config.isConfigured?.(account)).toBe(true);
      expect(zulipPlugin.config.describeAccount?.(account)).toMatchObject({ configured: true });
      expect(zulipPlugin.status.buildAccountSnapshot({ account, runtime: undefined, probe: undefined })).toMatchObject({ configured: true });
      expect(zulipMessageActions.describeMessageTool({ cfg }).actions).toContain("send");
      await expect(zulipOnboardingAdapter.getStatus({ cfg })).resolves.toMatchObject({ configured: true });
    });

    it("restricts approvals to normalized allowFrom identities when configured", () => {
      const result = zulipPlugin.approvalCapability?.authorizeActorAction?.({
        cfg: {
          channels: {
            zulip: {
              allowFrom: ["@ian@example.com"],
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        senderId: "ian@example.com",
        action: "approve",
        approvalKind: "exec",
      });

      expect(result).toEqual({ authorized: true });
    });
  });
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-runtime";
import { describe, expect, it } from "vitest";
import { zulipPlugin } from "./channel.js";
import { resolveZulipSessionConversation } from "./session-conversation.js";
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

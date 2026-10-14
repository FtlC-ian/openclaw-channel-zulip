import type { OpenClawConfig } from "./sdk.js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  splitStreamTarget,
  ZULIP_ACTION_TIERS,
  ZULIP_ALWAYS_OFF_ACTIONS,
  zulipMessageActions,
} from "./actions.js";

type CoreAction = Parameters<NonNullable<typeof zulipMessageActions.handleAction>>[0]["action"];
type HiddenAction =
  | "channel-subscribe"
  | "invite"
  | "resolve-topic"
  | "user-presence"
  | "user-deactivate"
  | "user-reactivate"
  | "org-settings"
  | "org-settings-edit";
type AnyAction = CoreAction | HiddenAction;
type FetchMock = Mock<typeof fetch>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const cfg: OpenClawConfig = {
  channels: {
    zulip: {
      apiKey: "***",
      email: "bot@example.test",
      url: "https://zulip.example.test",
    },
  },
};

const defaultsCfg: OpenClawConfig = {
  channels: {
    zulip: {
      apiKey: "***",
      email: "bot@example.test",
      url: "https://zulip.example.test",
      actionTiers: {
        moderation: "on",
        streamAdmin: "on",
      },
    },
  },
};

async function runReactAction(
  params: Record<string, unknown>,
  options?: { dryRun?: boolean; fetchImpl?: FetchMock },
) {
  const fetchImpl =
    options?.fetchImpl ??
    vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success", msg: "" }));
  vi.stubGlobal("fetch", fetchImpl);
  const result = await zulipMessageActions.handleAction?.({
    channel: "zulip",
    action: "react",
    cfg,
    params,
    dryRun: options?.dryRun,
  });
  return { result: result as { details?: unknown }, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function runAction(
  action: AnyAction,
  params: Record<string, unknown>,
  options?: {
    accountId?: string;
    cfg?: OpenClawConfig;
    dryRun?: boolean;
    fetchImpl?: FetchMock;
  },
) {
  const fetchImpl =
    options?.fetchImpl ??
    vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success", msg: "" }));
  vi.stubGlobal("fetch", fetchImpl);
  const result = await zulipMessageActions.handleAction?.({
    channel: "zulip",
    action: action as CoreAction,
    cfg: options?.cfg ?? cfg,
    accountId: options?.accountId,
    params,
    dryRun: options?.dryRun,
  });
  return { result: result as { details?: unknown } | undefined, fetchImpl };
}

describe("gated-off action tier defaults", () => {
  it("starts every configured account from safe defaults", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg });
    expect(discovery?.actions).toEqual([...ZULIP_ACTION_TIERS.messages].sort());
    for (const action of [
      ...ZULIP_ACTION_TIERS.moderation,
      ...ZULIP_ACTION_TIERS.streamAdmin,
      ...ZULIP_ALWAYS_OFF_ACTIONS,
    ]) {
      expect(discovery?.actions).not.toContain(action);
    }
  });

  it.each([...ZULIP_ACTION_TIERS.moderation])(
    "rejects moderation action %s before calling Zulip at the safe default",
    async (action) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const params = action === "edit" ? { messageId: "123", message: "replacement" } : { messageId: "123", confirm: true };
      await expect(runAction(action, params, { fetchImpl })).rejects.toThrow(
        /gated off; set channels\.zulip\.actionTiers\.moderation: "on"/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([...ZULIP_ACTION_TIERS.streamAdmin])(
    "rejects streamAdmin action %s before calling Zulip at the safe default",
    async (action) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const params = action === "channel-list" ? {} : { streamId: "7", confirm: true };
      await expect(runAction(action, params, { fetchImpl })).rejects.toThrow(
        /gated off; set channels\.zulip\.actionTiers\.streamAdmin: "on"/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("accepts the legacy enableAdminActions field without changing enforcement", async () => {
    const legacyCfg: OpenClawConfig = {
      channels: {
        zulip: {
          ...cfg.channels!.zulip,
          enableAdminActions: true,
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runAction("delete", { messageId: "123", confirm: true }, { cfg: legacyCfg, fetchImpl }),
    ).rejects.toThrow(/gated off/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the account cannot be resolved", async () => {
    // An account that throws during resolution (approval-emoji collision) must
    // keep every gated action rejected; the tier check precedes credential I/O.
    const collidingCfg: OpenClawConfig = {
      channels: {
        zulip: {
          ...cfg.channels!.zulip,
          approvalReactions: { approve: ":fast_forward:" },
          reactionTriggers: { enabled: true },
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runAction("delete", { messageId: "123", confirm: true }, { cfg: collidingCfg, fetchImpl }),
    ).rejects.toThrow(/gated off/);
    await expect(
      runAction("channel-create", { name: "new-stream" }, { cfg: collidingCfg, fetchImpl }),
    ).rejects.toThrow(/gated off/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("grants moderation and streamAdmin tiers per account from actionTiers", async () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg: defaultsCfg });
    expect(discovery?.actions).toEqual(
      [
        ...ZULIP_ACTION_TIERS.messages,
        ...ZULIP_ACTION_TIERS.moderation,
        ...ZULIP_ACTION_TIERS.streamAdmin,
      ].sort(),
    );

    const { fetchImpl } = await runAction(
      "delete",
      { messageId: "123", confirm: true },
      { cfg: defaultsCfg },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/messages/123");
  });

  it.each([
    [{ moderation: "on" }, "channel-create"],
    [{ streamAdmin: "on" }, "edit"],
  ] as const)("keeps ungranted tiers gated: %o cannot run %s", async (tiers, action) => {
    const partialCfg: OpenClawConfig = {
      channels: {
        zulip: {
          ...cfg.channels!.zulip,
          actionTiers: { ...tiers },
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const params = action === "edit"
      ? { messageId: "123", message: "replacement" }
      : { streamId: "7", confirm: true };
    await expect(runAction(action, params, { cfg: partialCfg, fetchImpl })).rejects.toThrow(
      /gated off/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never grants the always-off member-info action, even with every tier on", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runAction("member-info", { userId: "42" }, { cfg: defaultsCfg, fetchImpl }),
    ).rejects.toThrow("Action member-info is not supported for provider zulip.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never advertises or handles always-off actions", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg: defaultsCfg });
    for (const action of ZULIP_ALWAYS_OFF_ACTIONS) {
      expect(discovery?.actions).not.toContain(action);
      expect(zulipMessageActions.supportsAction?.({ action })).toBe(false);
    }
  });

  it("omits gated-off actions from the destructive-confirmation schema advertisement", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg });
    const contributions = Array.isArray(discovery?.schema) ? discovery.schema : [];
    const confirmContribution = contributions.find((entry) =>
      Object.hasOwn(entry.properties, "confirm"),
    );
    expect(confirmContribution?.actions).toEqual(["delete", "unsend"]);
    expect(confirmContribution?.actions).not.toContain("channel-delete");
  });

  it("reports unsupported actions before credential resolution", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(runAction("poll", {}, { cfg: {}, fetchImpl })).rejects.toThrow(
      "Action poll is not supported",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("action capability consistency", () => {
  it("keeps supportsAction aligned with the handled action set for every tier state", () => {
    for (const action of [
      ...ZULIP_ACTION_TIERS.messages,
      ...ZULIP_ACTION_TIERS.moderation,
      ...ZULIP_ACTION_TIERS.streamAdmin,
    ]) {
      expect(zulipMessageActions.supportsAction?.({ action })).toBe(true);
    }
    for (const action of ["ban", "rename-group", "set-group-icon", "member-info"] as CoreAction[]) {
      expect(zulipMessageActions.supportsAction?.({ action })).toBe(false);
    }
  });

  it.each(["pin", "unpin"] as CoreAction[])(
    "does not advertise or handle %s because Zulip starred messages are personal",
    async (action) => {
      expect(zulipMessageActions.supportsAction?.({ action })).toBe(false);

      const fetchImpl = vi.fn<typeof fetch>();
      await expect(runAction(action, { messageId: "123" }, { fetchImpl })).rejects.toThrow(
        `Action ${action} is not supported`,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each<HiddenAction>([
    "channel-subscribe",
    "invite",
    "resolve-topic",
    "user-presence",
    "user-deactivate",
    "user-reactivate",
    "org-settings",
    "org-settings-edit",
  ])("rejects hidden action %s before calling Zulip", async (action) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(runAction(action, {}, { fetchImpl })).rejects.toThrow(
      `Action ${action} is not supported`,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("discovers tier-aware actions for the requested configured account", () => {
    const restrictedConfig: OpenClawConfig = {
      channels: {
        zulip: {
          accounts: {
            primary: {
              apiKey: "***",
              email: "named@example.test",
              url: "https://named.example.test",
              actionTiers: { streamAdmin: "on" },
            },
          },
        },
      },
    };
    expect(
      zulipMessageActions.describeMessageTool({
        cfg: restrictedConfig,
        accountId: "primary",
      }).actions,
    ).toEqual(
      [...ZULIP_ACTION_TIERS.messages, ...ZULIP_ACTION_TIERS.streamAdmin].sort(),
    );
    expect(zulipMessageActions.describeMessageTool({ cfg: restrictedConfig }).actions).toEqual(
      [],
    );
  });

  it("contributes every Zulip-only handler parameter under its action scope", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg });
    const contributions = Array.isArray(discovery?.schema) ? discovery.schema : [];
    const propertiesFor = (action: CoreAction) =>
      Object.assign(
        {},
        ...contributions
          .filter((entry) => entry.actions?.includes(action))
          .map((entry) => entry.properties),
      ) as Record<string, unknown>;

    expect(propertiesFor("channel-list")).toHaveProperty("includeAllPublic");
    expect(Object.keys(propertiesFor("channel-create"))).toEqual([]);
    expect(Object.keys(propertiesFor("channel-edit"))).toEqual([]);
    expect(propertiesFor("react")).toMatchObject({
      emojiCode: { type: "string" },
      reactionType: { type: "string" },
    });
  });
});

describe("destructive message actions", () => {
  it.each(["delete", "unsend"] as const)("rejects %s without confirm at an enabled tier", async (action) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runAction(action, { messageId: "123" }, { cfg: defaultsCfg, fetchImpl }),
    ).rejects.toThrow("confirm: true");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["delete", "unsend"] as const)("rejects %s with non-boolean confirm", async (action) => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const confirm of [false, "yes"]) {
      await expect(
        runAction(action, { messageId: "123", confirm }, { cfg: defaultsCfg, fetchImpl }),
      ).rejects.toThrow("confirm: true");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["delete", { messageId: "123", confirm: true }],
    ["unsend", { messageId: "123", confirm: true }],
  ] as const)("does not send Zulip requests for %s dry runs", async (action, params) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = await runAction(action, params, { dryRun: true, fetchImpl, cfg: defaultsCfg });
    expect(result?.details).toMatchObject({ ok: true, dryRun: true, action });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["delete", "unsend"] as const)(
    "succeeds %s when confirm is true and all other gates pass",
    async (action) => {
      const { result, fetchImpl } = await runAction(
        action,
        { messageId: "123", confirm: true },
        { cfg: defaultsCfg },
      );
      expect(result?.details).toMatchObject({ ok: true, deleted: "123" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(String(url)).toContain("/messages/123");
      expect(init?.method).toBe("DELETE");
    },
  );
});

describe("moderation message edits", () => {
  it("succeeds edit when the moderation tier is enabled", async () => {
    const { result, fetchImpl } = await runAction(
      "edit",
      { messageId: "123", message: "replacement" },
      { cfg: defaultsCfg },
    );
    expect(result?.details).toMatchObject({ ok: true, edited: "123" });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/messages/123");
    expect(init?.method).toBe("PATCH");
  });

  it("keeps edit dry runs network-free at an enabled tier", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = await runAction(
      "edit",
      { messageId: "123", message: "replacement" },
      { dryRun: true, fetchImpl, cfg: defaultsCfg },
    );
    expect(result?.details).toMatchObject({ ok: true, dryRun: true, action: "edit" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("stream administration actions", () => {
  it("succeeds channel-create when the streamAdmin tier is enabled", async () => {
    const { fetchImpl } = await runAction(
      "channel-create",
      { name: "new-stream", announce: true },
      { cfg: defaultsCfg },
    );
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/users/me/subscriptions");
    expect(init?.method).toBe("POST");
  });

  it("succeeds channel-edit when the streamAdmin tier is enabled", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes("/streams")) {
          return jsonResponse({
            result: "success",
            streams: [{ stream_id: 7, name: "general" }],
          });
        }
        return jsonResponse({ result: "success" });
      });
    const { result } = await runAction(
      "channel-edit",
      { channelId: "7", newName: "renamed" },
      { cfg: defaultsCfg, fetchImpl },
    );
    expect(result?.details).toMatchObject({ ok: true, streamId: "7", name: "renamed" });
    const patchCall = fetchImpl.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(String(patchCall?.[0])).toContain("/streams/7");
  });

  it("requires confirm for channel-delete and succeeds with it at an enabled tier", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes("/streams")) {
          return jsonResponse({
            result: "success",
            streams: [{ stream_id: 7, name: "general" }],
          });
        }
        return jsonResponse({ result: "success" });
      });
    await expect(
      runAction("channel-delete", { streamId: "general" }, { cfg: defaultsCfg, fetchImpl }),
    ).rejects.toThrow("confirm: true");
    expect(fetchImpl).not.toHaveBeenCalled();

    const { result } = await runAction(
      "channel-delete",
      { streamId: "general", confirm: true },
      { cfg: defaultsCfg, fetchImpl },
    );
    expect(result?.details).toMatchObject({ ok: true, streamId: "7" });
  });
});

describe("reachable action routes", () => {
  it.each([
    { to: "stream:42", threadId: undefined, expected: "Bot replies" },
    { to: "stream:42", threadId: "", expected: "" },
    { to: "stream:42", threadId: 123, expected: "123" },
    { to: "stream: 42 :  Explicit  ", threadId: "inherited", expected: "  Explicit  " },
    { to: "stream:42:", threadId: "inherited", expected: "" },
    { to: "stream:42:Explicit", threadId: "inherited", expected: "Explicit" },
  ])("uses shared topic precedence for sends: $to / $threadId", async ({ to, threadId, expected }) => {
    const sendCfg = { channels: { zulip: { ...cfg.channels!.zulip, defaultTopic: "Bot replies" } } } as OpenClawConfig;
    const { fetchImpl } = await runAction("send", { to, threadId, message: "hello" }, { cfg: sendCfg });
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.get("to")).toBe("42");
    expect(body.get("topic")).toBe(expected);
  });

  it.each([
    ["send", { to: "user:person@example.test", message: "hello" }],
    ["channel-create", { name: "new-stream", description: "description" }],
    ["channel-edit", { channelId: "7", newName: "renamed" }],
    ["edit", { messageId: "123", message: "replacement" }],
  ] as const)("keeps %s dry runs network-free", async (action, params) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = await runAction(action, params, { dryRun: true, fetchImpl, cfg: defaultsCfg });
    expect(result?.details).toMatchObject({ ok: true, dryRun: true, action });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["channel-list", { includeAllPublic: true }, "/users/me/subscriptions"],
    ["read", { to: "stream:general:topic", limit: 3 }, "/messages?"],
    ["search", { query: "needle", stream: "general" }, "/messages?"],
  ] as const)("routes %s to its Zulip read endpoint", async (action, params, path) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        result: "success",
        subscriptions: [],
        streams: [],
        messages: [],
        user: { user_id: 42 },
      }),
    );
    const { result } = await runAction(action, params, { fetchImpl });
    expect(result?.details).toMatchObject({ ok: true });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(path);
  });

  it.each([
    ["send", { to: "user:person@example.test", message: "hello" }, "/messages", "POST"],
    ["channel-create", { name: "new-stream", announce: true }, "/users/me/subscriptions", "POST"],
    ["channel-edit", { channelId: "7", newName: "renamed" }, "/streams/7", "PATCH"],
  ] as const)("routes %s mutations to the expected endpoint", async (action, params, path, method) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ result: "success", id: 99 }));
    await runAction(action, params, { fetchImpl, cfg: defaultsCfg });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain(path);
    expect(init?.method).toBe(method);
  });
});

describe("splitStreamTarget", () => {
  it("parses canonical, legacy slash, and core-inferred unprefixed stream targets", () => {
    for (const raw of ["stream:debbie:Zulip Plugin PR", "debbie/Zulip Plugin PR", "debbie:Zulip Plugin PR"]) {
      expect(splitStreamTarget(raw), raw).toEqual({ stream: "debbie", topic: "Zulip Plugin PR" });
    }
  });
});

describe("zulipMessageActions react", () => {
  it("adds a named Zulip reaction by message id", async () => {
    const { result, fetchImpl } = await runReactAction({
      messageId: "123",
      emojiName: "octopus",
    });

    expect(result.details).toMatchObject({ ok: true, added: "octopus", messageId: "123" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://zulip.example.test/api/v1/messages/123/reactions");
    expect(init?.method).toBe("POST");
    expect(new URLSearchParams(String(init?.body)).get("emoji_name")).toBe("octopus");
  });

  it("maps Unicode reactions to Zulip unicode emoji parameters", async () => {
    const cases = [
      { emoji: "👍", name: "thumbs_up", code: "1f44d" },
      { emoji: "🧠", name: "brain", code: "1f9e0" },
      { emoji: "🤔", name: "thinking", code: "1f914" },
      { emoji: "😂", name: "joy", code: "1f602" },
      { emoji: "🎉", name: "tada", code: "1f389" },
      { emoji: "❤️", name: "heart", code: "2764" },
      { emoji: "🔥", name: "fire", code: "1f525" },
    ];

    for (const { emoji, name, code } of cases) {
      const { fetchImpl } = await runReactAction({ messageId: 456, emoji });
      const [, init] = fetchImpl.mock.calls[0] ?? [];
      const body = new URLSearchParams(String(init?.body));
      expect([emoji, body.get("emoji_name"), body.get("emoji_code"), body.get("reaction_type")])
        .toEqual([emoji, name, code, "unicode_emoji"]);
    }
  });

  it("passes explicit emoji code and reaction type through", async () => {
    const { fetchImpl } = await runReactAction({
      messageId: "789",
      emoji: "custom_party",
      emojiCode: "party_custom_id",
      reactionType: "realm_emoji",
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("emoji_name")).toBe("custom_party");
    expect(body.get("emoji_code")).toBe("party_custom_id");
    expect(body.get("reaction_type")).toBe("realm_emoji");
  });

  it("removes reactions with the same Zulip parameters", async () => {
    const { result, fetchImpl } = await runReactAction({
      messageId: "123",
      emoji: "👎",
      remove: true,
    });

    expect(result.details).toMatchObject({ ok: true, removed: true, messageId: "123" });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.method).toBe("DELETE");
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/api/v1/messages/123/reactions");
    expect(parsed.searchParams.get("emoji_name")).toBe("thumbs_down");
    expect(parsed.searchParams.get("emoji_code")).toBe("1f44e");
    expect(parsed.searchParams.get("reaction_type")).toBe("unicode_emoji");
  });

  it("preserves dry-run behavior without calling Zulip", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success" }));
    const { result } = await runReactAction(
      {
        messageId: "123",
        emoji: "♾️",
      },
      { dryRun: true, fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      ok: true,
      dryRun: true,
      action: "add-reaction",
      messageId: "123",
      emoji: "infinity",
      emojiCode: "267e",
      reactionType: "unicode_emoji",
    });
  });

  it("uses the current inbound message id when no explicit message id is given", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success" }));
    vi.stubGlobal("fetch", fetchImpl);

    await zulipMessageActions.handleAction?.({
      channel: "zulip",
      action: "react",
      cfg,
      params: { emoji: "+1" },
      toolContext: { currentMessageId: "current-1" },
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://zulip.example.test/api/v1/messages/current-1/reactions",
    );
  });
});
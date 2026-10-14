import type { OpenClawConfig } from "./sdk.js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  splitStreamTarget,
  ZULIP_ACTION_TIERS,
  ZULIP_ADVERTISED_ACTIONS,
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

async function expectRejectedWithoutFetch(
  action: AnyAction,
  params: Record<string, unknown>,
): Promise<void> {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(runAction(action, params, { fetchImpl, cfg: defaultsCfg })).rejects.toThrow(
    "confirm: true",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
}

describe("gated-off action tier defaults", () => {
  it("starts every configured account from safe defaults", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg });
    expect(discovery?.actions).toEqual(
      ZULIP_ADVERTISED_ACTIONS.filter((action) =>
        ["send", "read", "search", "react", "channel-list", "poll"].includes(action),
      ),
    );
    for (const action of ["edit", "delete", "unsend", "member-info", "channel-create", "channel-edit", "channel-delete"]) {
      expect(discovery?.actions).not.toContain(action);
    }
  });

  it.each([...ZULIP_ACTION_TIERS.moderation] as const)(
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

  it.each([...ZULIP_ACTION_TIERS.streamAdmin] as const)(
    "rejects streamAdmin action %s before calling Zulip at the safe default",
    async (action) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const params = { streamId: "7", confirm: true };
      await expect(runAction(action, params, { fetchImpl })).rejects.toThrow(
        /gated off; set channels\.zulip\.actionTiers\.streamAdmin: "on"/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects every action with an inert all-off tier map, including messages", async () => {
    const offCfg: OpenClawConfig = {
      channels: {
        zulip: {
          ...cfg.channels!.zulip,
          actionTiers: { messages: "off", moderation: "off", streamAdmin: "off" },
        },
      },
    };
    const discovery = zulipMessageActions.describeMessageTool({ cfg: offCfg });
    expect(discovery?.actions).toEqual([]);

    const fetchImpl = vi.fn<typeof fetch>();
    for (const [action, params] of [
      ["send", { to: "user:person@example.test", message: "hello" }],
      ["read", { to: "stream:general" }],
      ["search", { query: "needle" }],
      ["react", { messageId: "123", emoji: "octopus" }],
      ["channel-list", {}],
    ] as const) {
      await expect(runAction(action, { ...params }, { cfg: offCfg, fetchImpl })).rejects.toThrow(
        new RegExp(`gated off; set channels\\.zulip\\.actionTiers\\.(messages|moderation|streamAdmin)`),
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();

    // Core-owned poll stays unhandled by the plugin in every tier state; with
    // an all-off discovery list, core also excludes it from the shared tool.
    const pollFetch = vi.fn<typeof fetch>();
    await expect(runAction("poll", {}, { cfg: offCfg, fetchImpl: pollFetch })).rejects.toThrow(
      "Action poll is not supported",
    );
    expect(pollFetch).not.toHaveBeenCalled();
  });

  it("rejects send at the safe default when the messages tier is off", async () => {
    const offCfg: OpenClawConfig = {
      channels: {
        zulip: {
          ...cfg.channels!.zulip,
          actionTiers: { messages: "off" },
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runAction("send", { to: "user:person@example.test", message: "hello" }, { cfg: offCfg, fetchImpl }),
    ).rejects.toThrow(/gated off; set channels\.zulip\.actionTiers\.messages: "on"/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

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
    await expect(
      runAction("send", { to: "user:person@example.test", message: "hello" }, { cfg: collidingCfg, fetchImpl }),
    ).rejects.toThrow(/gated off/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("grants moderation and streamAdmin tiers per account from actionTiers", async () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg: defaultsCfg });
    expect(discovery?.actions).toEqual(ZULIP_ADVERTISED_ACTIONS);

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

  it("gates member-info behind the moderation tier", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runAction("member-info", { userId: "42" }, { fetchImpl }),
    ).rejects.toThrow(/gated off; set channels\.zulip\.actionTiers\.moderation: "on"/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("omits gated-off actions from schema contributions at the safe default", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg });
    const contributions = Array.isArray(discovery?.schema) ? discovery.schema : [];
    for (const entry of contributions) {
      for (const action of entry.actions ?? []) {
        expect(["edit", "delete", "unsend", "member-info", "channel-create", "channel-edit", "channel-delete"]).not.toContain(action);
      }
    }
    expect(zulipMessageActions.supportsAction?.({ action: "edit" })).toBe(true);
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
  it("advertises the shared action list and supports exactly plugin-handled actions", () => {
    expect(zulipMessageActions.describeMessageTool({ cfg: defaultsCfg }).actions).toEqual(
      ZULIP_ADVERTISED_ACTIONS,
    );
    for (const action of ZULIP_ADVERTISED_ACTIONS) {
      expect(zulipMessageActions.supportsAction?.({ action })).toBe(action !== "poll");
    }
  });

  it.each(["ban", "rename-group", "set-group-icon"] as CoreAction[])(
    "does not claim unadvertised canonical action %s",
    (action) => {
      expect(zulipMessageActions.supportsAction?.({ action })).toBe(false);
    },
  );

  it.each(["pin", "unpin"] as CoreAction[])(
    "does not advertise or handle %s because Zulip starred messages are personal",
    async (action) => {
      expect(ZULIP_ADVERTISED_ACTIONS).not.toContain(action);
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
      ZULIP_ADVERTISED_ACTIONS.filter((action) =>
        ["send", "read", "search", "react", "channel-list", "poll", "channel-create", "channel-edit", "channel-delete"].includes(action),
      ),
    );
    expect(zulipMessageActions.describeMessageTool({ cfg: restrictedConfig }).actions).toEqual(
      [],
    );
  });

  it("contributes every Zulip-only handler parameter under its action scope", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg: defaultsCfg });
    const contributions = Array.isArray(discovery?.schema) ? discovery.schema : [];
    const propertiesFor = (action: CoreAction) =>
      Object.assign(
        {},
        ...contributions
          .filter((entry) => entry.actions?.includes(action))
          .map((entry) => entry.properties),
      ) as Record<string, unknown>;

    expect(propertiesFor("channel-list")).toHaveProperty("includeAllPublic");
    expect(propertiesFor("channel-create")).toMatchObject({
      description: { type: "string" },
      principals: { type: "array" },
      announce: { type: "boolean" },
      inviteOnly: { type: "boolean" },
      isPrivate: { type: "boolean" },
      isWebPublic: { type: "boolean" },
      isDefaultStream: { type: "boolean" },
      historyPublicToSubscribers: { type: "boolean" },
    });
    expect(propertiesFor("channel-edit")).toMatchObject({
      description: { type: "string" },
      newName: { type: "string" },
      isPrivate: { type: "boolean" },
      isWebPublic: { type: "boolean" },
      isDefaultStream: { type: "boolean" },
      historyPublicToSubscribers: { type: "boolean" },
    });
    expect(propertiesFor("react")).toMatchObject({
      emojiCode: { type: "string" },
      reactionType: { type: "string" },
    });
  });

  it("scopes the confirmation schema to advertised destructive actions at full opt-in", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg: defaultsCfg });
    expect(discovery?.schema).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actions: ["channel-delete", "delete", "unsend"],
          properties: { confirm: expect.objectContaining({ type: "boolean" }) },
        }),
      ]),
    );
  });

  it("omits streamAdmin schema fragments while that tier is gated off", () => {
    const discovery = zulipMessageActions.describeMessageTool({ cfg });
    const contributions = Array.isArray(discovery?.schema) ? discovery.schema : [];
    const propertiesFor = (action: CoreAction) =>
      Object.assign(
        {},
        ...contributions
          .filter((entry) => entry.actions?.includes(action))
          .map((entry) => entry.properties),
      ) as Record<string, unknown>;
    expect(Object.keys(propertiesFor("channel-create"))).toEqual([]);
    expect(Object.keys(propertiesFor("channel-edit"))).toEqual([]);
    expect(Object.keys(propertiesFor("delete"))).toEqual([]);
  });
});

describe("destructive action confirmation", () => {
  it.each(["delete", "unsend"] as const)("rejects %s without confirm", async (action) => {
    await expectRejectedWithoutFetch(action, { messageId: "123" });
  });

  it("rejects channel-delete without confirm", async () => {
    await expectRejectedWithoutFetch("channel-delete", { streamId: "general" });
  });

  it("rejects delete when confirm is false", async () => {
    await expectRejectedWithoutFetch("delete", { messageId: "123", confirm: false });
  });

  it("rejects delete when confirm is a string", async () => {
    await expectRejectedWithoutFetch("delete", { messageId: "123", confirm: "yes" });
  });

  it.each([
    ["delete", { messageId: "123", confirm: true }],
    ["unsend", { messageId: "123", confirm: true }],
    ["channel-delete", { streamId: "general", confirm: true }],
  ] as const)("does not send Zulip requests for %s dry runs", async (action, params) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = await runAction(action, params, { dryRun: true, fetchImpl, cfg: defaultsCfg });
    expect(result?.details).toMatchObject({ ok: true, dryRun: true, action });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["delete", "unsend"] as const)(
    "succeeds %s when confirm is true and all other gates pass",
    async (action) => {
      const { result, fetchImpl } = await runAction(action, {
        messageId: "123",
        confirm: true,
      }, { cfg: defaultsCfg });
      expect(result?.details).toMatchObject({ ok: true, deleted: "123" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(String(url)).toContain("/messages/123");
      expect(init?.method).toBe("DELETE");
    },
  );

  it("succeeds channel-delete when confirm is true and all other gates pass", async () => {
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
      "channel-delete",
      { streamId: "general", confirm: true },
      { fetchImpl, cfg: defaultsCfg },
    );
    expect(result?.details).toMatchObject({ ok: true, streamId: "7" });
  });
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

describe("member-info behavior", () => {
  it("routes member lookups to the Zulip user endpoint at an enabled tier", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        jsonResponse({
          result: "success",
          user: { user_id: 42, email: "member@example.test", full_name: "Member" },
        }),
      );
    const { result } = await runAction("member-info", { userId: "42" }, { cfg: defaultsCfg, fetchImpl });
    expect(result?.details).toMatchObject({ ok: true });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/users/42");
  });

  it("resolves the bot identity for member-info without a user id", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        jsonResponse({
          result: "success",
          user_id: 99,
          email: "bot@example.test",
          full_name: "Bot",
          is_admin: false,
        }),
      );
    const { result } = await runAction("member-info", {}, { cfg: defaultsCfg, fetchImpl });
    expect(result?.details).toMatchObject({ ok: true });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/users/me");
  });

  it("keeps member-info gated off outside moderation even when other tiers are on", async () => {
    const narrowCfg: OpenClawConfig = {
      channels: {
        zulip: {
          ...cfg.channels!.zulip,
          actionTiers: { streamAdmin: "on" },
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runAction("member-info", { userId: "42" }, { cfg: narrowCfg, fetchImpl }),
    ).rejects.toThrow(/gated off; set channels\.zulip\.actionTiers\.moderation: "on"/);
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
    ["member-info", { userId: "42" }, "/users/42"],
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
    const { result } = await runAction(action, params, { fetchImpl, cfg: defaultsCfg });
    expect(result?.details).toMatchObject({ ok: true });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(path);
  });

  it.each([
    ["send", { to: "user:person@example.test", message: "hello" }, "/messages", "POST"],
    ["channel-create", { name: "new-stream", announce: true }, "/users/me/subscriptions", "POST"],
    ["channel-edit", { channelId: "7", newName: "renamed" }, "/streams/7", "PATCH"],
    ["edit", { messageId: "123", message: "replacement" }, "/messages/123", "PATCH"],
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
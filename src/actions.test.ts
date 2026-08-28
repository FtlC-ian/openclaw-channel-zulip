import type { OpenClawConfig } from "./sdk.js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { splitStreamTarget, zulipMessageActions } from "./actions.js";

type CoreAction = Parameters<NonNullable<typeof zulipMessageActions.handleAction>>[0]["action"];
type AnyAction = CoreAction | "user-deactivate" | "org-settings-edit";
type FetchMock = Mock<typeof fetch>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const cfg: OpenClawConfig = {
  channels: {
    zulip: {
      apiKey: "secret",
      email: "bot@example.test",
      url: "https://zulip.example.test",
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
  options?: { dryRun?: boolean; fetchImpl?: FetchMock },
) {
  const fetchImpl =
    options?.fetchImpl ??
    vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ result: "success", msg: "" }));
  vi.stubGlobal("fetch", fetchImpl);
  const result = await zulipMessageActions.handleAction?.({
    channel: "zulip",
    action: action as CoreAction,
    cfg,
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
  await expect(runAction(action, params, { fetchImpl })).rejects.toThrow("confirm: true");
  expect(fetchImpl).not.toHaveBeenCalled();
}

describe("destructive action confirmation", () => {
  it("rejects delete without confirm", async () => {
    await expectRejectedWithoutFetch("delete", { messageId: "123" });
  });

  it("rejects channel-delete without confirm", async () => {
    await expectRejectedWithoutFetch("channel-delete", { streamId: "general" });
  });

  it("rejects user-deactivate without confirm", async () => {
    await expectRejectedWithoutFetch("user-deactivate", { userId: "42" });
  });

  it("rejects org-settings-edit without confirm", async () => {
    await expectRejectedWithoutFetch("org-settings-edit", { settings: { name: "X" } });
  });

  it("rejects delete when confirm is false", async () => {
    await expectRejectedWithoutFetch("delete", { messageId: "123", confirm: false });
  });

  it("rejects delete when confirm is a string", async () => {
    await expectRejectedWithoutFetch("delete", { messageId: "123", confirm: "yes" });
  });

  it("scopes the confirmation schema to advertised destructive actions", () => {
    expect(zulipMessageActions.describeMessageTool({ cfg })).toMatchObject({
      schema: {
        actions: ["channel-delete", "delete"],
        properties: { confirm: { type: "boolean" } },
      },
    });
  });

  it.each([
    ["delete", { messageId: "123", confirm: true }],
    ["channel-delete", { streamId: "general", confirm: true }],
  ] as const)("does not send Zulip requests for %s dry runs", async (action, params) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = await runAction(action, params, { dryRun: true, fetchImpl });
    expect(result?.details).toMatchObject({ ok: true, dryRun: true, action });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["user-deactivate", { userId: "42", confirm: true }],
    ["org-settings-edit", { settings: { name: "X" }, confirm: true }],
  ] as const)("does not send Zulip requests for hidden %s dry runs", async (action, params) => {
    const adminCfg: OpenClawConfig = {
      channels: {
        zulip: {
          apiKey: "secret",
          email: "bot@example.test",
          url: "https://zulip.example.test",
          enableAdminActions: true,
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    const result = await zulipMessageActions.handleAction?.({
      channel: "zulip",
      action: action as CoreAction,
      cfg: adminCfg,
      params,
      dryRun: true,
    });
    expect(result?.details).toMatchObject({ ok: true, dryRun: true, action });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("succeeds delete when confirm is true and all other gates pass", async () => {
    const { result, fetchImpl } = await runAction("delete", {
      messageId: "123",
      confirm: true,
    });
    expect(result?.details).toMatchObject({ ok: true, deleted: "123" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/messages/123");
    expect(init?.method).toBe("DELETE");
  });

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
      { fetchImpl },
    );
    expect(result?.details).toMatchObject({ ok: true, streamId: "7" });
  });

  it("cannot bypass admin check via confirmation on user-deactivate", async () => {
    const adminCfg: OpenClawConfig = {
      channels: {
        zulip: {
          apiKey: "secret",
          email: "bot@example.test",
          url: "https://zulip.example.test",
          enableAdminActions: true,
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        result: "success",
        user: { user_id: 1, is_admin: false },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    await expect(
      zulipMessageActions.handleAction?.({
        channel: "zulip",
        action: "user-deactivate" as CoreAction,
        cfg: adminCfg,
        params: { userId: "42", confirm: true },
      }),
    ).rejects.toThrow("admin privileges");
  });

  it("cannot bypass enableAdminActions via confirmation on org-settings-edit", async () => {
    const lockedCfg: OpenClawConfig = {
      channels: {
        zulip: {
          apiKey: "secret",
          email: "bot@example.test",
          url: "https://zulip.example.test",
          enableAdminActions: false,
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ result: "success", user: { user_id: 1, is_admin: true } }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    await expect(
      zulipMessageActions.handleAction?.({
        channel: "zulip",
        action: "org-settings-edit" as CoreAction,
        cfg: lockedCfg,
        params: { settings: { name: "X" }, confirm: true },
      }),
    ).rejects.toThrow("enableAdminActions");
  });

  it("cannot bypass enableAdminActions via confirmation on user-deactivate", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    await expect(
      zulipMessageActions.handleAction?.({
        channel: "zulip",
        action: "user-deactivate" as CoreAction,
        cfg,
        params: { userId: "42", confirm: true },
      }),
    ).rejects.toThrow("enableAdminActions");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cannot bypass Zulip admin check via confirmation on org-settings-edit", async () => {
    const adminCfg: OpenClawConfig = {
      channels: {
        zulip: {
          apiKey: "secret",
          email: "bot@example.test",
          url: "https://zulip.example.test",
          enableAdminActions: true,
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ result: "success", user: { user_id: 1, is_admin: false } }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    await expect(
      zulipMessageActions.handleAction?.({
        channel: "zulip",
        action: "org-settings-edit" as CoreAction,
        cfg: adminCfg,
        params: { settings: { name: "X" }, confirm: true },
      }),
    ).rejects.toThrow("admin privileges");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("splitStreamTarget", () => {
  it("parses canonical stream targets with colon topics", () => {
    expect(splitStreamTarget("stream:debbie:Zulip Plugin PR")).toEqual({
      stream: "debbie",
      topic: "Zulip Plugin PR",
    });
  });

  it("keeps legacy slash topic parsing for unprefixed streams", () => {
    expect(splitStreamTarget("debbie/Zulip Plugin PR")).toEqual({
      stream: "debbie",
      topic: "Zulip Plugin PR",
    });
  });

  it("parses core-inferred stream topic targets without the stream prefix", () => {
    expect(splitStreamTarget("debbie:Zulip Plugin PR")).toEqual({
      stream: "debbie",
      topic: "Zulip Plugin PR",
    });
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

  it("maps common Unicode approval reactions to Zulip unicode emoji parameters", async () => {
    const { fetchImpl } = await runReactAction({
      messageId: 456,
      emoji: "👍",
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("emoji_name")).toBe("thumbs_up");
    expect(body.get("emoji_code")).toBe("1f44d");
    expect(body.get("reaction_type")).toBe("unicode_emoji");
  });

  it("maps common expressive Unicode reactions to Zulip emoji names", async () => {
    const cases = [
      { emoji: "🧠", name: "brain", code: "1f9e0" },
      { emoji: "🤔", name: "thinking", code: "1f914" },
      { emoji: "😂", name: "joy", code: "1f602" },
      { emoji: "🎉", name: "tada", code: "1f389" },
      { emoji: "❤️", name: "heart", code: "2764" },
      { emoji: "🔥", name: "fire", code: "1f525" },
    ];

    for (const { emoji, name, code } of cases) {
      const { fetchImpl } = await runReactAction({
        messageId: 456,
        emoji,
      });

      const [, init] = fetchImpl.mock.calls[0] ?? [];
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("emoji_name")).toBe(name);
      expect(body.get("emoji_code")).toBe(code);
      expect(body.get("reaction_type")).toBe("unicode_emoji");
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

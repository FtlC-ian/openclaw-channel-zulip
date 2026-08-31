import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearZulipSubagentReactionContexts,
  handleZulipSubagentEnded,
  handleZulipSubagentSpawned,
  registerZulipSubagentReactionContext,
} from "./subagent-reactions.js";

describe("Zulip subagent reaction correlation", () => {
  afterEach(async () => {
    await clearZulipSubagentReactionContexts();
  });

  it("uses the exact requester session fallback outside async turn context", async () => {
    const show = vi.fn(async () => {});
    const hide = vi.fn(async () => {});
    const context = registerZulipSubagentReactionContext({ requesterSessionKey: "requester", show, hide });

    await handleZulipSubagentSpawned(
      { runId: "run-1", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );
    await handleZulipSubagentSpawned(
      { runId: "run-2", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );
    await context.finish();
    await handleZulipSubagentEnded({ runId: "run-1" }, {});

    expect(show).toHaveBeenCalledTimes(1);
    expect(hide).not.toHaveBeenCalled();

    await handleZulipSubagentEnded({ runId: "run-2" }, {});
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("uses the active Zulip async context when the hook route key differs", async () => {
    const show = vi.fn(async () => {});
    const hide = vi.fn(async () => {});
    const context = registerZulipSubagentReactionContext({
      requesterSessionKey: "agent:main:main",
      show,
      hide,
    });

    await context.run(() =>
      handleZulipSubagentSpawned(
        {
          runId: "routed-run",
          childSessionKey: "routed-child",
          requester: { channel: "zulip" },
        },
        { requesterSessionKey: "agent:main:zulip:default:direct:user11@example.com" },
      ));

    expect(show).toHaveBeenCalledTimes(1);
    await handleZulipSubagentEnded({ runId: "routed-run" }, {});
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("keeps mismatched Zulip async contexts isolated across concurrent turns", async () => {
    const first = { show: vi.fn(async () => {}), hide: vi.fn(async () => {}) };
    const second = { show: vi.fn(async () => {}), hide: vi.fn(async () => {}) };
    const firstContext = registerZulipSubagentReactionContext({
      requesterSessionKey: "agent:first:main",
      ...first,
    });
    const secondContext = registerZulipSubagentReactionContext({
      requesterSessionKey: "agent:second:main",
      ...second,
    });

    await Promise.all([
      firstContext.run(() =>
        handleZulipSubagentSpawned(
          { runId: "first-run", requester: { channel: "zulip" } },
          { requesterSessionKey: "agent:main:zulip:default:direct:first@example.com" },
        )),
      secondContext.run(() =>
        handleZulipSubagentSpawned(
          { runId: "second-run", requester: { channel: "zulip" } },
          { requesterSessionKey: "agent:main:zulip:default:direct:second@example.com" },
        )),
    ]);

    expect(first.show).toHaveBeenCalledTimes(1);
    expect(second.show).toHaveBeenCalledTimes(1);
    await handleZulipSubagentEnded({ runId: "first-run" }, {});
    expect(first.hide).toHaveBeenCalledTimes(1);
    expect(second.hide).not.toHaveBeenCalled();
    await handleZulipSubagentEnded({ runId: "second-run" }, {});
    expect(second.hide).toHaveBeenCalledTimes(1);
  });

  it("binds run completion to the exact inbound context active at spawn time", async () => {
    const first = { show: vi.fn(async () => {}), hide: vi.fn(async () => {}) };
    const second = { show: vi.fn(async () => {}), hide: vi.fn(async () => {}) };
    registerZulipSubagentReactionContext({ requesterSessionKey: "requester", ...first });
    await handleZulipSubagentSpawned(
      { runId: "old-run", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );

    registerZulipSubagentReactionContext({ requesterSessionKey: "requester", ...second });
    await handleZulipSubagentSpawned(
      { runId: "new-run", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );
    await handleZulipSubagentEnded({ runId: "old-run" }, {});

    expect(first.hide).toHaveBeenCalledTimes(1);
    expect(second.hide).not.toHaveBeenCalled();

    await handleZulipSubagentEnded({ runId: "new-run" }, {});
    expect(second.hide).toHaveBeenCalledTimes(1);
  });

  it("uses async turn context when a newer inbound turn is already current", async () => {
    const first = { show: vi.fn(async () => {}), hide: vi.fn(async () => {}) };
    const second = { show: vi.fn(async () => {}), hide: vi.fn(async () => {}) };
    const firstContext = registerZulipSubagentReactionContext({
      requesterSessionKey: "requester",
      ...first,
    });

    await firstContext.run(async () => {
      registerZulipSubagentReactionContext({ requesterSessionKey: "requester", ...second });
      await handleZulipSubagentSpawned(
        { runId: "old-turn-run", requester: { channel: "zulip" } },
        { requesterSessionKey: "requester" },
      );
    });

    expect(first.show).toHaveBeenCalledTimes(1);
    expect(second.show).not.toHaveBeenCalled();

    await handleZulipSubagentEnded({ runId: "old-turn-run" }, {});
    expect(first.hide).toHaveBeenCalledTimes(1);
    expect(second.hide).not.toHaveBeenCalled();
  });

  it("keeps active children visible after the requester turn completes", async () => {
    const show = vi.fn(async () => {});
    const hide = vi.fn(async () => {});
    const context = registerZulipSubagentReactionContext({
      requesterSessionKey: "requester",
      show,
      hide,
    });
    await handleZulipSubagentSpawned(
      { runId: "run-1", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );

    await context.finish();
    expect(hide).not.toHaveBeenCalled();

    await handleZulipSubagentEnded({ runId: "run-1" }, {});

    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("cleans active indicators on gateway shutdown", async () => {
    const hide = vi.fn(async () => {});
    registerZulipSubagentReactionContext({
      requesterSessionKey: "requester",
      show: vi.fn(async () => {}),
      hide,
    });
    await handleZulipSubagentSpawned(
      { runId: "run-1", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );

    await clearZulipSubagentReactionContexts();
    await handleZulipSubagentEnded({ runId: "run-1" }, {});

    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("cancels active run bindings during account monitor shutdown", async () => {
    const hide = vi.fn(async () => {});
    const context = registerZulipSubagentReactionContext({
      requesterSessionKey: "requester",
      show: vi.fn(async () => {}),
      hide,
    });
    await handleZulipSubagentSpawned(
      { runId: "run-1", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );

    await context.cancel();
    await expect(context.closed).resolves.toBeUndefined();
    await handleZulipSubagentEnded({ runId: "run-1" }, {});

    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("ends every generation bound to a reset child session without touching other children", async () => {
    const show = vi.fn(async () => {});
    const hide = vi.fn(async () => {});
    const context = registerZulipSubagentReactionContext({
      requesterSessionKey: "requester",
      show,
      hide,
    });
    await handleZulipSubagentSpawned(
      { runId: "old-run", childSessionKey: "child-reset", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );
    await handleZulipSubagentSpawned(
      { runId: "new-run", childSessionKey: "child-reset", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );
    await handleZulipSubagentSpawned(
      { runId: "other-run", childSessionKey: "child-active", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );
    await context.finish();

    await handleZulipSubagentEnded(
      { targetSessionKey: "child-reset" },
      { childSessionKey: "child-reset" },
    );
    expect(hide).not.toHaveBeenCalled();

    await handleZulipSubagentEnded({ runId: "other-run" }, {});
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("does not use child fallback for an ended event carrying an unknown stale run id", async () => {
    const hide = vi.fn(async () => {});
    const context = registerZulipSubagentReactionContext({
      requesterSessionKey: "requester",
      show: vi.fn(async () => {}),
      hide,
    });
    await handleZulipSubagentSpawned(
      { runId: "current-run", childSessionKey: "shared-child", requester: { channel: "zulip" } },
      { requesterSessionKey: "requester" },
    );
    await context.finish();

    await handleZulipSubagentEnded(
      { runId: "stale-run", targetSessionKey: "shared-child" },
      { childSessionKey: "shared-child" },
    );
    expect(hide).not.toHaveBeenCalled();

    await handleZulipSubagentEnded({ runId: "current-run" }, {});
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("ignores non-Zulip spawns even inside an active Zulip async context", async () => {
    const show = vi.fn(async () => {});
    const hide = vi.fn(async () => {});
    const context = registerZulipSubagentReactionContext({ requesterSessionKey: "requester", show, hide });

    await context.run(() =>
      handleZulipSubagentSpawned(
        { runId: "discord-run", childSessionKey: "discord-child", requester: { channel: "discord" } },
        { requesterSessionKey: "requester" },
      ));
    await handleZulipSubagentEnded(
      { targetSessionKey: "discord-child" },
      { childSessionKey: "discord-child" },
    );

    expect(show).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });
});

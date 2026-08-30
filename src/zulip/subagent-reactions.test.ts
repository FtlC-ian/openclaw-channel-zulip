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

  it("keeps the indicator visible until every concurrently bound child ends", async () => {
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
});

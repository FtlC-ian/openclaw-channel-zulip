import { describe, expect, it } from "vitest";
import { splitStreamTarget } from "./actions.js";

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
});

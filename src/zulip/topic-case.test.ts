import { describe, expect, it } from "vitest";
import { canonicalizeZulipTopic, ZULIP_TOPIC_CASE_VERSION } from "./topic-case.js";

describe("Unicode 16 topic canonicalization", () => {
  it("names the persisted identity contract", () => {
    expect(ZULIP_TOPIC_CASE_VERSION).toBe("zulip-topic-lower-u16-v1");
  });

  it.each([
    ["Release A", "release a"],
    ["Release-A", "release-a"],
    ["Release--A", "release--a"],
    [" Release / A? ", " release / a? "],
    ["", ""],
    ["general", "general"],
    ["///", "///"],
    [" \t\n", " \t\n"],
    ["ÉTÉ", "été"],
    ["ПЛАН", "план"],
    ["İ", "i\u0307"],
    ["I\u0307", "i\u0307"],
    ["I\u0301", "i\u0301"],
    ["Straße", "straße"],
    ["STRASSE", "strasse"],
    ["CAFÉ", "café"],
    ["CAFE\u0301", "cafe\u0301"],
    ["Ａ", "ａ"],
    ["\uA7CB", "\u0264"],
    ["\uA7CE", "\uA7CE"],
    ["\uA7CF", "\uA7CF"],
    ["\u{10400}", "\u{10428}"],
    ["A🙂B", "a🙂b"],
    ["Σ", "σ"],
    ["ΟΣ", "ος"],
    ["ΟΣΑ", "οσα"],
    ["ΣΣ", "σς"],
    ["AΣ\u0301", "aς\u0301"],
    ["A\u0301Σ", "a\u0301ς"],
    ["AΣ\u0301B", "aσ\u0301b"],
    ["AΣ'B", "aσ'b"],
    ["AΣ B", "aς b"],
    ["\u0345Σ", "\u0345σ"],
    ["AΣ\u0345", "aς\u0345"],
    ["A\u0345Σ", "a\u0345ς"],
    ["AΣ\u0345B", "aσ\u0345b"],
    ["A".repeat(201), "a".repeat(201)],
  ])("maps %j without changing topic punctuation or presentation", (topic, expected) => {
    expect(canonicalizeZulipTopic(topic)).toBe(expected);
  });

  it.each(["\ud800", "\udfff", "A\ud800B", "A\udfffB", "\udc00\ud800"])(
    "rejects ill-formed UTF-16 %j",
    (topic) => expect(() => canonicalizeZulipTopic(topic)).toThrow("unpaired UTF-16 surrogate"),
  );

  it.each([undefined, null, 42])("rejects missing or non-string topics: %j", (topic) => {
    expect(() => canonicalizeZulipTopic(topic as unknown as string)).toThrow("must be a string");
  });
});

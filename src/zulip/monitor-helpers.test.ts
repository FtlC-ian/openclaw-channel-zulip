import { describe, expect, it } from "vitest";
import {
  createDedupeCache,
  formatInboundFromLabel,
} from "./monitor-helpers.js";

// ---------------------------------------------------------------------------
// createDedupeCache
// ---------------------------------------------------------------------------
describe("createDedupeCache", () => {
  it("returns true on a duplicate within the TTL window", () => {
    const cache = createDedupeCache({ ttlMs: 60_000, maxSize: 100 });
    const now = Date.now();
    cache.check("msg:1", now);
    expect(cache.check("msg:1", now + 1_000)).toBe(true);
  });

  it("returns false after the TTL has expired", () => {
    const cache = createDedupeCache({ ttlMs: 500, maxSize: 100 });
    const t0 = 1_000_000;
    cache.check("msg:2", t0);
    expect(cache.check("msg:2", t0 + 1_000)).toBe(false);
  });

  it("treats null/undefined key as non-duplicate (always false)", () => {
    const cache = createDedupeCache({ ttlMs: 60_000, maxSize: 100 });
    expect(cache.check(null)).toBe(false);
    expect(cache.check(undefined)).toBe(false);
  });

  it("different keys are tracked independently", () => {
    const cache = createDedupeCache({ ttlMs: 60_000, maxSize: 100 });
    const now = Date.now();
    cache.check("msg:A", now);
    // A is a dup, B is new
    expect(cache.check("msg:A", now + 100)).toBe(true);
    expect(cache.check("msg:B", now + 100)).toBe(false);
  });

  it("evicts the oldest entry when maxSize is exceeded", () => {
    const cache = createDedupeCache({ ttlMs: 60_000, maxSize: 2 });
    const now = Date.now();
    cache.check("msg:1", now);
    cache.check("msg:2", now + 1);
    cache.check("msg:3", now + 2); // evicts msg:1
    expect(cache.check("msg:3", now + 3)).toBe(true);
    expect(cache.check("msg:2", now + 3)).toBe(true);
    expect(cache.check("msg:1", now + 3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatInboundFromLabel
// ---------------------------------------------------------------------------
describe("formatInboundFromLabel", () => {
  it.each([
    ["group label with id", { isGroup: true, groupLabel: "#general", groupId: "42", directLabel: "Alice" }, "#general id:42"],
    ["plain group label without groupId", { isGroup: true, groupLabel: "#general", directLabel: "Alice" }, "#general"],
    [
      "groupFallback when groupLabel is empty",
      { isGroup: true, groupLabel: "", groupId: "99", directLabel: "Alice", groupFallback: "Stream" },
      "Stream id:99",
    ],
    [
      "plain directLabel when directId matches label",
      { isGroup: false, directLabel: "alice@example.com", directId: "alice@example.com" },
      "alice@example.com",
    ],
    [
      "directId appended when it differs from label",
      { isGroup: false, directLabel: "Alice", directId: "alice@example.com" },
      "Alice id:alice@example.com",
    ],
    ["plain directLabel without directId", { isGroup: false, directLabel: "Alice" }, "Alice"],
  ])("%s", (_name, params, expected) => {
    expect(formatInboundFromLabel(params)).toBe(expected);
  });
});

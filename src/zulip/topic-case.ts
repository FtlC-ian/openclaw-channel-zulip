import { CASED_RANGES, CASE_IGNORABLE_RANGES, LOWERCASE_MAPPINGS } from "./topic-case-data.js";

export const ZULIP_TOPIC_CASE_VERSION = "zulip-topic-lower-u16-v1";

function containsCodePoint(ranges: readonly number[], codePoint: number): boolean {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (codePoint < ranges[middle * 2]) {
      high = middle - 1;
    } else if (codePoint > ranges[middle * 2 + 1]) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

export function canonicalizeZulipTopic(topic: string): string {
  if (typeof topic !== "string") {
    throw new TypeError("Zulip topic must be a string");
  }
  const codePoints = Array.from(topic, (character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new TypeError("Zulip topic contains an unpaired UTF-16 surrogate");
    }
    return codePoint;
  });
  let precededByCased = false;
  return codePoints.map((codePoint, index) => {
    let lowercase = LOWERCASE_MAPPINGS[codePoint] ?? String.fromCodePoint(codePoint);
    if (codePoint === 0x03a3 && precededByCased) {
      let next = index + 1;
      while (next < codePoints.length && containsCodePoint(CASE_IGNORABLE_RANGES, codePoints[next])) {
        next += 1;
      }
      if (next === codePoints.length || !containsCodePoint(CASED_RANGES, codePoints[next])) {
        lowercase = "\u03c2";
      }
    }
    if (!containsCodePoint(CASE_IGNORABLE_RANGES, codePoint)) {
      precededByCased = containsCodePoint(CASED_RANGES, codePoint);
    }
    return lowercase;
  }).join("");
}

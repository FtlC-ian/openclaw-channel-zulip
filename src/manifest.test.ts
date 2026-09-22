import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));

describe("plugin manifest", () => {
  it("declares that Zulip has no Doctor state migrations", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest.doctorContract?.stateMigrations).toEqual([]);
  });
});

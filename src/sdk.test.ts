import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadOutboundMediaFromUrl } from "./sdk.js";

it("loads outbound media through host roots and enforces the byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "zulip-outbound-media-"));
  try {
    const file = join(root, "report.txt");
    await writeFile(file, "outbound report");
    const options = { mediaLocalRoots: [root], maxBytes: 1024 };
    const loaded = await loadOutboundMediaFromUrl(file, options);
    expect(loaded.buffer.toString()).toBe("outbound report");
    expect(loaded.fileName).toBe("report.txt");
    await expect(loadOutboundMediaFromUrl(file, { ...options, maxBytes: 1 })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

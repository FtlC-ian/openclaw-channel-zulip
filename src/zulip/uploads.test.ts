import { describe, expect, it, vi } from "vitest";
import { downloadZulipUpload, extractZulipUploadUrls } from "./uploads.js";

const sdkState = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../sdk.js", () => ({
  fetchWithSsrFGuard: sdkState.fetchWithSsrFGuard,
}));

describe("extractZulipUploadUrls", () => {
  it("extracts Zulip upload links from common image, audio, and document HTML", () => {
    const html = [
      '<p><a href="/user_uploads/2/f4/image.png">image.png</a></p>',
      '<p><a href="https://zlp.pubnerd.app/user_uploads/2/ab/song.mp3">song.mp3</a></p>',
      '<p><a href="/user_uploads/2/cd/report.pdf?download=1&amp;foo=bar">report.pdf</a></p>',
    ].join("\n");

    expect(extractZulipUploadUrls(html, "https://zlp.pubnerd.app")).toEqual([
      "https://zlp.pubnerd.app/user_uploads/2/f4/image.png",
      "https://zlp.pubnerd.app/user_uploads/2/ab/song.mp3",
      "https://zlp.pubnerd.app/user_uploads/2/cd/report.pdf?download=1&foo=bar",
    ]);
  });

  it("ignores non-Zulip origins and trims markdown punctuation", () => {
    const html =
      "see https://zlp.pubnerd.app/user_uploads/2/ab/song.mp3), " +
      "and https://evil.test/user_uploads/2/ab/secret.mp3";

    expect(extractZulipUploadUrls(html, "https://zlp.pubnerd.app")).toEqual([
      "https://zlp.pubnerd.app/user_uploads/2/ab/song.mp3",
    ]);
  });
});

describe("downloadZulipUpload", () => {
  it("uses Zulip basic auth, keeps PDF-ish metadata, and decodes filenames", async () => {
    const release = vi.fn(async () => {});
    sdkState.fetchWithSsrFGuard.mockResolvedValueOnce({
      release,
      response: new Response(Buffer.from("%PDF-1.7"), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-length": "8",
          "content-disposition": "attachment; filename*=UTF-8''Quarterly%20Report.pdf",
        },
      }),
    });

    const result = await downloadZulipUpload(
      "https://zlp.pubnerd.app/user_uploads/2/ab/Quarterly%20Report.pdf",
      "https://zlp.pubnerd.app",
      "encoded-auth",
      1024,
    );

    expect(sdkState.fetchWithSsrFGuard).toHaveBeenCalledWith({
      url: "https://zlp.pubnerd.app/user_uploads/2/ab/Quarterly%20Report.pdf",
      init: { headers: { Authorization: "Basic encoded-auth" } },
    });
    expect(result.filename).toBe("Quarterly Report.pdf");
    expect(result.contentType).toBe("application/pdf");
    expect(result.buffer.toString()).toBe("%PDF-1.7");
    expect(release).toHaveBeenCalled();
  });

  it("rejects uploads above the configured max size before buffering", async () => {
    const release = vi.fn(async () => {});
    sdkState.fetchWithSsrFGuard.mockResolvedValueOnce({
      release,
      response: new Response("too big", {
        status: 200,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": "10485761",
        },
      }),
    });

    await expect(
      downloadZulipUpload(
        "https://zlp.pubnerd.app/user_uploads/2/ab/song.mp3",
        "https://zlp.pubnerd.app",
        "encoded-auth",
        10 * 1024 * 1024,
      ),
    ).rejects.toThrow("Zulip upload exceeds max size");
    expect(release).toHaveBeenCalled();
  });
});

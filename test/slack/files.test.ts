import { describe, it, expect, vi } from "vitest";
import { isSupportedImageFile, downloadSlackImages, type SlackFile } from "../../src/slack/files.js";

function okResponse(body: string): Response {
  return {
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

describe("isSupportedImageFile", () => {
  it("accepts the four supported image types", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isSupportedImageFile({ mimetype: m })).toBe(true);
    }
  });

  it("rejects non-image and missing mimetypes", () => {
    expect(isSupportedImageFile({ mimetype: "application/pdf" })).toBe(false);
    expect(isSupportedImageFile({ mimetype: "text/plain" })).toBe(false);
    expect(isSupportedImageFile({})).toBe(false);
  });
});

describe("downloadSlackImages", () => {
  const file = (over: Partial<SlackFile> = {}): SlackFile => ({
    mimetype: "image/png",
    url_private_download: "https://files.slack.com/x.png",
    size: 1000,
    ...over,
  });

  it("fetches with a bearer auth header and base64-encodes the body", async () => {
    const fetchFn = vi.fn(async () => okResponse("abc"));
    const out = await downloadSlackImages([file()], "xoxb-tok", fetchFn as unknown as typeof fetch);

    expect(fetchFn).toHaveBeenCalledWith("https://files.slack.com/x.png", {
      headers: { Authorization: "Bearer xoxb-tok" },
    });
    expect(out).toEqual([{ mediaType: "image/png", data: "YWJj" }]); // base64("abc")
  });

  it("skips files larger than 5 MB", async () => {
    const fetchFn = vi.fn(async () => okResponse("abc"));
    const out = await downloadSlackImages([file({ size: 6 * 1024 * 1024 })], "t", fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("ignores non-image files", async () => {
    const fetchFn = vi.fn(async () => okResponse("abc"));
    const out = await downloadSlackImages([file({ mimetype: "application/pdf" })], "t", fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("caps at 20 images", async () => {
    const fetchFn = vi.fn(async () => okResponse("abc"));
    const files = Array.from({ length: 25 }, () => file());
    const out = await downloadSlackImages(files, "t", fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(20);
    expect(out).toHaveLength(20);
  });

  it("tolerates a per-file failure and returns the rest", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce(okResponse("abc"));
    const out = await downloadSlackImages([file(), file()], "t", fetchFn as unknown as typeof fetch);
    expect(out).toEqual([{ mediaType: "image/png", data: "YWJj" }]);
  });
});

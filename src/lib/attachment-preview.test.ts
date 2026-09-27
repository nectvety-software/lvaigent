import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  mimeOf,
  previewDataUrl,
  previewText,
  textExcerpt,
} from "./attachment-preview";

/**
 * The hover card must never block composing or half-load a picture, so the
 * interesting behaviour is what it returns when data is missing — not the CSS.
 */
describe("attachment hover previews", () => {
  /** The data-URL cache is module-level, so each case uses a fresh path. */
  let n = 0;
  const freshPath = (ext: string) => `D:/preview-case-${n++}.${ext}`;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("labels a picture with the mime its extension promises", () => {
    expect(mimeOf("D:/a/photo.JPG")).toBe("image/jpeg");
    expect(mimeOf("D:/a/icon.svg")).toBe("image/svg+xml");
    expect(mimeOf("D:/a/main.lua")).toBeNull();
  });

  it("cuts a text excerpt at a line boundary, never mid-line", () => {
    expect(textExcerpt("alpha\nbravo\ncharlie", 12)).toBe("alpha\nbravo\n…");
    expect(textExcerpt("short", 12)).toBe("short");
  });

  it("reads image bytes once, however many hovers follow", async () => {
    invokeMock.mockResolvedValue("aGk=");
    const path = freshPath("png");

    const first = await previewDataUrl(path);
    const second = await previewDataUrl(path);

    expect(first).toBe("data:image/png;base64,aGk=");
    expect(second).toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("read_file_preview", {
      path,
      maxBytes: 3_000_000,
    });
  });

  it("shows nothing rather than a half-loaded image or a failed read", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await previewDataUrl(freshPath("png"))).toBeNull();

    invokeMock.mockRejectedValue(new Error("os error 2"));
    expect(await previewDataUrl(freshPath("png"))).toBeNull();

    // A text file has no thumbnail path at all, and costs no IPC.
    expect(await previewDataUrl(freshPath("lua"))).toBeNull();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "read_file_preview")).toHaveLength(2);
  });

  it("previews a folder as its listing, not as the contents of its files", async () => {
    invokeMock.mockResolvedValue([
      { name: "main.lua", path: "D:/g/main.lua", is_dir: false },
      {
        name: "assets",
        path: "D:/g/assets",
        is_dir: true,
        children: [{ name: "hero.png", path: "D:/g/assets/hero.png", is_dir: false }],
      },
    ]);

    const text = await previewText("D:/g", "folder");

    expect(invokeMock).toHaveBeenCalledWith("read_project_tree", { path: "D:/g" });
    expect(text).toContain("main.lua");
    expect(text).toContain("assets/");
    expect(text).toContain("  hero.png");
  });

  it("falls back to the file reader for a text attachment", async () => {
    invokeMock.mockResolvedValue("print('hi')\n");
    const path = freshPath("lua");

    expect(await previewText(path, "file")).toContain("print('hi')");
    expect(invokeMock).toHaveBeenCalledWith("read_file_chunk", {
      path,
      maxChars: 700,
    });
  });
});

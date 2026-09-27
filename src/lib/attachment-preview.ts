import { invoke } from "@tauri-apps/api/core";
import type { AttachmentKind, FileNode } from "../types";

/**
 * Data behind the composer's hover previews.
 *
 * Images are the only part that needs the backend: the webview cannot read a
 * `file://` path from an http origin, so the bytes come over IPC as base64.
 */

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

/** How much of a text file one hover reveals. */
export const PREVIEW_CHARS = 700;
const PREVIEW_LISTING_LINES = 30;

export function mimeOf(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME[ext] ?? null;
}

/** First `maxChars` of `content`, cut at a line boundary so no half line shows. */
export function textExcerpt(content: string, maxChars = PREVIEW_CHARS): string {
  if (content.length <= maxChars) return content;
  const cut = content.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  return `${cut.slice(0, lastBreak > 0 ? lastBreak : maxChars).trimEnd()}\n…`;
}

const dataUrls = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** Cached data URL for an image, or null when it is unreadable or too large. */
export async function previewDataUrl(path: string): Promise<string | null> {
  const cached = dataUrls.get(path);
  if (cached) return cached;
  const mime = mimeOf(path);
  if (!mime) return null;
  let pending = inflight.get(path);
  if (!pending) {
    pending = invoke<string | null>("read_file_preview", { path, maxBytes: 3_000_000 })
      .then((b64) => (b64 ? `data:${mime};base64,${b64}` : null))
      .catch(() => null);
    inflight.set(path, pending);
  }
  const url = await pending;
  inflight.delete(path);
  if (url) dataUrls.set(path, url);
  return url;
}

function flattenListing(nodes: FileNode[], depth: number, out: string[]): void {
  for (const n of nodes) {
    if (out.length >= PREVIEW_LISTING_LINES) return;
    out.push(`${"  ".repeat(depth)}${n.is_dir ? n.name + "/" : n.name}`);
    if (n.is_dir) flattenListing(n.children ?? [], depth + 1, out);
  }
}

/**
 * Text preview for a non-image attachment: the file's own text, or a folder's
 * listing. Null means "nothing worth showing", never an error to shout about.
 */
export async function previewText(
  path: string,
  kind: AttachmentKind
): Promise<string | null> {
  if (kind === "folder") {
    const nodes = await invoke<FileNode[]>("read_project_tree", { path }).catch(
      () => null
    );
    if (!nodes) return null;
    const lines: string[] = [];
    flattenListing(nodes, 0, lines);
    return lines.length ? lines.join("\n") : null;
  }
  const raw = await invoke<string>("read_file_chunk", {
    path,
    maxChars: PREVIEW_CHARS,
  }).catch(() => null);
  return raw && raw.trim() ? textExcerpt(raw) : null;
}

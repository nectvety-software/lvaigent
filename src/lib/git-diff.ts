/**
 * Parse `git diff` unified-diff text into renderable hunks.
 * Reuses the DiffLine shape from diff.ts so the review panel can render both
 * snapshot and Git sources with the same component.
 */

import type { DiffLine } from "./diff";

export interface GitHunk {
  /** 1-based start line in the old file (0 for new files). */
  aStart: number;
  /** 1-based start line in the new file (0 for deleted files). */
  bStart: number;
  lines: DiffLine[];
}

export interface ParsedGitDiff {
  hunks: GitHunk[];
  added: number;
  removed: number;
  binary: boolean;
}

/** Parse `@@ -a,b +c,d @@` headers (the ,b / ,d parts are optional). */
function parseHunkHeader(line: string): { aStart: number; bStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { aStart: parseInt(m[1], 10), bStart: parseInt(m[2], 10) };
}

export function parseUnifiedDiff(diffText: string): ParsedGitDiff {
  const result: ParsedGitDiff = { hunks: [], added: 0, removed: 0, binary: false };
  if (!diffText || !diffText.trim()) return result;
  if (/^Binary files .* differ/m.test(diffText)) {
    result.binary = true;
    return result;
  }

  const lines = diffText.split("\n");
  let current: GitHunk | null = null;
  let a = 0;
  let b = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      current = null; // next file section; per-file diffs arrive one at a time
      continue;
    }
    const header = parseHunkHeader(line);
    if (header) {
      current = { aStart: header.aStart, bStart: header.bStart, lines: [] };
      result.hunks.push(current);
      a = header.aStart;
      b = header.bStart;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      current.lines.push({ type: "add", b, text: line.slice(1) });
      result.added++;
      b++;
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", a, text: line.slice(1) });
      result.removed++;
      a++;
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "ctx", a, b, text: line.slice(1) });
      a++;
      b++;
    }
    // "\" (no newline at end of file) and everything else: ignored.
  }
  return result;
}

/** Flatten hunks into one DiffLine list with gap info the panel can render. */
export function hunksToRows(hunks: GitHunk[]): (DiffLine | { type: "gap"; count: number })[] {
  const rows: (DiffLine | { type: "gap"; count: number })[] = [];
  let prevEnd = 0; // last old-file line shown
  for (const h of hunks) {
    const start = h.aStart > 0 ? h.aStart : h.bStart;
    if (start > prevEnd + 1 && rows.length > 0) {
      rows.push({ type: "gap", count: start - prevEnd - 1 });
    }
    for (const l of h.lines) {
      rows.push(l);
      if (l.a && l.a > prevEnd) prevEnd = l.a;
    }
  }
  return rows;
}

/**
 * Lightweight line diff (LCS) for the opencode-style review panel.
 * No dependency: files are capped at a few thousand lines so the O(n*m) DP
 * table stays fast (<50ms typical).
 */

export interface DiffLine {
  type: "add" | "del" | "ctx";
  /** 1-based line number in the old file (undefined for add lines). */
  a?: number;
  /** 1-based line number in the new file (undefined for del lines). */
  b?: number;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Normalize line endings so CRLF files diff cleanly. */
function normalize(s: string): string[] {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/**
 * Classic LCS diff over lines. `cap` bounds each side so huge files degrade
 * gracefully instead of freezing the UI.
 */
export function diffLines(aText: string, bText: string, cap = 4000): DiffResult {
  // An empty string means "no lines" (created/deleted file), not one empty line.
  const a = aText === "" ? [] : normalize(aText);
  const b = bText === "" ? [] : normalize(bText);
  const truncated = a.length > cap || b.length > cap;
  const A = a.slice(0, cap);
  const B = b.slice(0, cap);
  const n = A.length;
  const m = B.length;

  // LCS DP table.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      lines.push({ type: "ctx", a: i + 1, b: j + 1, text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: "del", a: i + 1, text: A[i] });
      removed++;
      i++;
    } else {
      lines.push({ type: "add", b: j + 1, text: B[j] });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ type: "del", a: i + 1, text: A[i] });
    removed++;
    i++;
  }
  while (j < m) {
    lines.push({ type: "add", b: j + 1, text: B[j] });
    added++;
    j++;
  }

  if (truncated) {
    lines.push({
      type: "ctx",
      text: `… (diff rút gọn — hiển thị ${cap} dòng mỗi file)`,
    });
  }
  return { lines, added, removed };
}

/** Collapse long runs of unchanged lines around edits, like a GitHub diff. */
export function collapseContext(lines: DiffLine[], pad = 3): (DiffLine | { type: "gap"; count: number })[] {
  // No edits at all -> show everything (nothing to focus on).
  if (!lines.some((l) => l.type !== "ctx")) return [...lines];
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.type === "ctx") return;
    for (let k = Math.max(0, idx - pad); k <= Math.min(lines.length - 1, idx + pad); k++) {
      keep[k] = true;
    }
  });
  const out: (DiffLine | { type: "gap"; count: number })[] = [];
  let gap = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    if (keep[idx]) {
      if (gap > 0) {
        out.push({ type: "gap", count: gap });
        gap = 0;
      }
      out.push(lines[idx]);
    } else {
      gap++;
    }
  }
  if (gap > 0) out.push({ type: "gap", count: gap });
  return out;
}

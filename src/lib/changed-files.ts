/**
 * Aggregate every edit transaction of a conversation into per-file
 * "original -> latest" pairs for the "Tác nhân đã thay đổi tệp" view.
 * Pure functions only so they stay unit-testable outside Tauri.
 */

import type { ReviewFile, FileEdit } from "../types";
import { diffLines } from "./diff";

/** Shape subset of the store's UndoTx needed here (keeps this module pure). */
export interface ChangedTx {
  startedAt: number;
  before: { path: string; prevContent: string; afterContent: string }[];
  created: { path: string; afterContent: string }[];
}

/**
 * For each line index of `afterText`, find the turn that introduced it by
 * chaining pairwise diffs. `segments[i]` maps line numbers (1-based) of the
 * i-th turn's `after` to line numbers of the (i+1)-th turn's `after`; lines
 * absent there were dropped and re-added by a later turn (re-tagged).
 * Returns a 0-based turn index per final line, or -1 when pre-existing.
 */
function computeLineTurns(before: string, edits: { before: string; after: string }[]): number[] {
  const n = afterTextLineCount(before, edits);
  const tags = new Array<number>(n).fill(-1);
  // lines of the "current" state, tagged -1 (pre-existing) initially.
  let currentTags = tags.slice();
  let currentText = before;
  edits.forEach((edit, turnIdx) => {
    const d = diffLines(currentText, edit.after);
    const nextTags: number[] = [];
    let cursor = 0; // line index into edit.after (0-based)
    for (const line of d.lines) {
      if (line.type === "ctx") {
        // copy the tag from the matching current-state line
        nextTags[cursor] = currentTags[(line.b ?? 1) - 1] ?? -1;
        cursor++;
      } else if (line.type === "add") {
        nextTags[cursor] = turnIdx;
        cursor++;
      }
      // "del" lines vanish — their tags die with them.
    }
    currentTags = nextTags;
    currentText = edit.after;
  });
  return currentTags;
}

function afterTextLineCount(before: string, edits: { before: string; after: string }[]): number {
  return edits.length > 0 ? countLines(edits[edits.length - 1].after) : countLines(before);
}

function countLines(s: string): number {
  return s === "" ? 0 : s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
}

/**
 * Merge transactions (oldest first) into one ReviewFile per path:
 * the FIRST prevContent is kept as `before`, the LAST afterContent as
 * `after`. A file created by the agent keeps created=true even when later
 * transactions modify it. Each file also carries an `edits` timeline (one
 * milestone per send with timestamp, line delta and full before/after for
 * per-turn diffs) plus `lineTurns` markers. Output is sorted by path.
 */
export function mergeChangedFiles(txs: ChangedTx[]): ReviewFile[] {
  const byPath = new Map<string, ReviewFile>();
  const upsert = (path: string, created: boolean, before: string, after: string, at: number) => {
    let found = byPath.get(path);
    if (!found) {
      found = { path, created, added: 0, removed: 0, before, after, edits: [] };
      byPath.set(path, found);
    }
    const turnBefore = found.edits && found.edits.length > 0 ? found.after : before;
    const d = diffLines(turnBefore, after);
    found.edits!.push({ at, added: d.added, removed: d.removed, before: turnBefore, after });
    found.after = after;
  };
  for (const tx of txs) {
    for (const e of tx.before) upsert(e.path, false, e.prevContent, e.afterContent, tx.startedAt);
    for (const c of tx.created) upsert(c.path, true, "", c.afterContent, tx.startedAt);
  }
  for (const f of byPath.values()) {
    const d = diffLines(f.before, f.after);
    f.added = d.added;
    f.removed = d.removed;
    f.lineTurns = computeLineTurns(f.before, f.edits ?? []);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Structured multi-file patch — port of ZCode's ApplyPatch tool.
 *
 * ZCode's flagship editing tool takes one `patch_text` in the classic
 * "*** Begin Patch" format and applies adds/updates/deletes/moves across
 * several files in a single call, returning a structured diff summary.
 *
 * Why it matters here: with only edit_file (one exact string at a time), a
 * refactor touching five files costs five round-trips and five chances to
 * drift. The patch format expresses the whole change at once, with `@@`
 * anchors that tell the matcher WHERE in the file each hunk belongs.
 *
 * Format (what the system prompt shows the model):
 *
 *   *** Begin Patch
 *   *** Update File: src/a.ts
 *   @@ function greet() {
 *   -  console.log("hi");
 *   +  console.log("hello");
 *   *** Add File: src/new.ts
 *   +export const x = 1;
 *   *** Delete File: old.txt
 *   *** Move File: from/a.txt
 *   *** To File: to/a.txt
 *   *** End Patch
 *
 * Hunk line prefixes: ` ` context (must match), `-` must match and is removed,
 * `+` inserted, `@@` starts a hunk and carries an anchor annotation.
 *
 * Application is validate-then-apply: every file is read and every hunk
 * matched BEFORE anything is written, so a broken hunk in the third file
 * cannot leave the first two half-applied.
 */

export type PatchOpType = "add" | "update" | "delete" | "move";

/** One ordered line op inside a hunk. */
export interface PatchHunkLine {
  kind: "context" | "delete" | "add";
  text: string;
}

export interface PatchHunk {
  /** Text after `@@ ` — an anchor annotation (usually a def/class signature). */
  context: string;
  /** Ordered ops. context/delete lines must match the file in this order. */
  lines: PatchHunkLine[];
}

export interface PatchOp {
  type: PatchOpType;
  /** Path as written in the patch (project-relative or absolute). */
  path: string;
  /** Destination for a move. */
  moveTo?: string;
  /** Update/move hunks (a move may also rewrite the file). */
  hunks?: PatchHunk[];
  /** Add-file content lines ('+' lines). */
  addLines?: string[];
}

export interface PatchParseResult {
  ops: PatchOp[];
  /** Non-null when the patch text could not be understood at all. */
  error: string | null;
}

/** Thrown while applying one hunk; carries everything the model needs to retry. */
export class PatchApplyError extends Error {
  constructor(
    public readonly file: string,
    public readonly detail: string
  ) {
    super(detail);
    this.name = "PatchApplyError";
  }
}

const HEADER_RES: Array<{ re: RegExp; type: PatchOpType }> = [
  { re: /^[ \t]*\*\*\*[ \t]*Add File:[ \t]*(.+?)[ \t]*$/, type: "add" },
  { re: /^[ \t]*\*\*\*[ \t]*Update File:[ \t]*(.+?)[ \t]*$/, type: "update" },
  { re: /^[ \t]*\*\*\*[ \t]*Delete File:[ \t]*(.+?)[ \t]*$/, type: "delete" },
  { re: /^[ \t]*\*\*\*[ \t]*Move File:[ \t]*(.+?)[ \t]*$/, type: "move" },
];
const TO_FILE_RE = /^[ \t]*\*\*\*[ \t]*To File:[ \t]*(.+?)[ \t]*$/;
const BEGIN_RE = /^[ \t]*\*\*\*[ \t]*Begin Patch[ \t]*$/;
const END_RE = /^[ \t]*\*\*\*[ \t]*End Patch[ \t]*$/;

/**
 * Parse a patch body into ordered file operations.
 *
 * Tolerant where tolerant is safe (blank lines inside hunks are empty context
 * lines; header whitespace) and strict where a wrong guess would corrupt a
 * file: unknown headers, body lines before any file header, and a missing
 * terminator are errors, never silent skips.
 */
export function parsePatch(text: string): PatchParseResult {
  const fail = (error: string): PatchParseResult => ({ ops: [], error });
  // Normalize newlines and drop the single trailing empty element a final
  // newline produces — otherwise it lands as a phantom context line in the
  // last hunk.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let i = 0;
  while (i < lines.length && !BEGIN_RE.test(lines[i])) i++;
  if (i >= lines.length) return fail("patch does not contain a '*** Begin Patch' header");

  const ops: PatchOp[] = [];
  let current: PatchOp | null = null;
  let hunk: PatchHunk | null = null;
  let sawEnd = false;

  for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (END_RE.test(line)) {
      sawEnd = true;
      break;
    }
    const header = HEADER_RES.find((h) => h.re.test(line));
    if (header) {
      const m = header.re.exec(line);
      const path = (m?.[1] ?? "").trim();
      if (!path) return fail(`'${header.type}' header on line ${i + 1} has no file path`);
      current =
        header.type === "add"
          ? { type: "add", path, addLines: [] }
          : header.type === "update"
            ? { type: "update", path, hunks: [] }
            : header.type === "move"
              ? { type: "move", path, hunks: [] }
              : { type: "delete", path };
      ops.push(current);
      hunk = null;
      continue;
    }
    const toFile = TO_FILE_RE.exec(line);
    if (toFile) {
      if (!current || current.type !== "move") {
        return fail(`'*** To File:' on line ${i + 1} must follow a '*** Move File:'`);
      }
      current.moveTo = (toFile[1] ?? "").trim();
      if (!current.moveTo) return fail(`'To File' on line ${i + 1} has no destination path`);
      continue;
    }
    if (/^[ \t]*\*\*\*/.test(line)) {
      return fail(`unrecognized patch header on line ${i + 1}: ${line.trim()}`);
    }
    if (!current) {
      if (line.trim() === "") continue;
      return fail(`line ${i + 1} has content before any '*** Add/Update/Delete/Move File:' header`);
    }

    if (current.type === "add") {
      // An empty line is an added empty line — blank lines in new files are
      // legitimate content, and requiring '+' everywhere makes models fumble.
      if (line.startsWith("+")) current.addLines!.push(line.slice(1));
      else if (line === "") current.addLines!.push("");
      else {
        return fail(
          `Add File lines must start with '+' (line ${i + 1}): ${JSON.stringify(line)}`
        );
      }
      continue;
    }
    if (current.type === "delete") {
      if (line.trim() !== "") {
        return fail(`'Delete File: ${current.path}' takes no body (line ${i + 1})`);
      }
      continue;
    }

    // update / move hunks
    if (/^@@/.test(line)) {
      hunk = { context: line.slice(2).trim(), lines: [] };
      current.hunks!.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line.trim() === "") continue;
      return fail(`'${current.path}' has content on line ${i + 1} before the first '@@' hunk`);
    }
    if (line.startsWith("+")) hunk.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) hunk.lines.push({ kind: "delete", text: line.slice(1) });
    else if (line.startsWith(" ")) hunk.lines.push({ kind: "context", text: line.slice(1) });
    else if (line === "") hunk.lines.push({ kind: "context", text: "" });
    else {
      return fail(
        `hunk lines must start with ' ', '+', '-' or '@@' (line ${i + 1}): ${JSON.stringify(line)}`
      );
    }
  }

  if (!sawEnd) return fail("patch does not contain a '*** End Patch' terminator");
  if (ops.length === 0) return fail("patch contains no file operations");
  for (const op of ops) {
    if (op.type === "move" && !op.moveTo) {
      return fail(`'Move File: ${op.path}' has no '*** To File:' destination`);
    }
    if (op.type === "update" && (op.hunks ?? []).length === 0) {
      return fail(`'Update File: ${op.path}' has no hunks`);
    }
    if (op.type === "add" && (op.addLines ?? []).length === 0) {
      return fail(`'Add File: ${op.path}' has no content ('+' lines)`);
    }
  }
  return { ops, error: null };
}

/** The lines a hunk must find in the file, in order (context + deletions). */
function hunkBefore(h: PatchHunk): string[] {
  return h.lines.filter((l) => l.kind !== "add").map((l) => l.text);
}

/**
 * Where a hunk applies: the index of the first source line it consumes.
 *
 * Exact match first (trailing-whitespace drift tolerated as a fallback — the
 * one fuzziness that cannot pick the wrong region). An additions-only hunk
 * falls back to its `@@` annotation as an anchor and inserts after it, or to
 * end-of-file when there is no annotation either.
 */
function locateHunk(lines: readonly string[], from: number, h: PatchHunk, file: string): number {
  const before = hunkBefore(h);
  if (before.length === 0) {
    const anchor = h.context.trim();
    if (anchor) {
      for (let i = from; i < lines.length; i++) {
        if (lines[i].includes(anchor)) return i + 1;
      }
      throw new PatchApplyError(
        file,
        `the '@@ ${h.context}' anchor was not found in the rest of the file`
      );
    }
    return lines.length;
  }
  for (let i = from; i + before.length <= lines.length; i++) {
    if (before.every((t, k) => lines[i + k] === t)) return i;
  }
  for (let i = from; i + before.length <= lines.length; i++) {
    if (before.every((t, k) => lines[i + k].replace(/\s+$/, "") === t.replace(/\s+$/, ""))) {
      return i;
    }
  }
  const expected = before[0] ?? "";
  const nearby = lines
    .slice(from, from + 40)
    .map((l) => JSON.stringify(l))
    .join(", ");
  throw new PatchApplyError(
    file,
    `the hunk starting with ${JSON.stringify(expected)} was not found after that point. ` +
      `Copy the exact text (indentation included) or re-read the file. Nearby lines: ${nearby}`
  );
}

/**
 * Apply every hunk to `content` in order.
 *
 * Hunks apply forward-only, exactly like ZCode's edit: hunk N+1 is searched
 * from the end of hunk N. Each context/deletion line consumes one source
 * line, so additions land exactly where the patch put them instead of being
 * re-ordered to the end of the hunk.
 *
 * Pure: the only effect is the returned string (or a PatchApplyError), which
 * is what makes the executor's validate-all-then-apply flow testable.
 */
export function applyHunks(content: string, hunks: readonly PatchHunk[], file: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const h of hunks) {
    const at = locateHunk(lines, cursor, h, file);
    out.push(...lines.slice(cursor, at));
    let src = at;
    for (const op of h.lines) {
      if (op.kind === "add") {
        out.push(op.text);
      } else {
        // locateHunk already verified the sequence; a defensive check keeps
        // the invariant loud if that ever changes. Same trailing-whitespace
        // tolerance as the matcher, or a drift match would throw here.
        const actual = lines[src];
        if (
          actual !== op.text &&
          actual.replace(/\s+$/, "") !== op.text.replace(/\s+$/, "")
        ) {
          throw new PatchApplyError(
            file,
            `internal mismatch at ${file}:${src + 1} (${JSON.stringify(op.text)})`
          );
        }
        // A context line is a pass-through: re-emit the line as it exists in
        // the file (not as the patch spelled it), so a whitespace-drift match
        // keeps the file's own bytes. A deletion just consumes the line.
        if (op.kind === "context") out.push(lines[src]);
        src++;
      }
    }
    cursor = src;
  }
  out.push(...lines.slice(cursor));
  return out.join("\n");
}

/** Line counts for the patch summary (+additions / −deletions). */
export function patchLineCounts(ops: readonly PatchOp[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const op of ops) {
    if (op.type === "add") added += (op.addLines ?? []).length;
    for (const h of op.hunks ?? []) {
      for (const l of h.lines) {
        if (l.kind === "add") added++;
        if (l.kind === "delete") deleted++;
      }
    }
  }
  return { added, deleted };
}

/** The final content of an Add File op (always newline-terminated). */
export function addFileContent(op: PatchOp): string {
  return `${(op.addLines ?? []).join("\n")}\n`;
}

import { describe, expect, it } from "vitest";
import {
  PatchApplyError,
  addFileContent,
  applyHunks,
  patchLineCounts,
  parsePatch,
} from "./patch";

/**
 * The patch format is the agent's most expensive tool to get wrong: one bad
 * hunk silently corrupts a source file. These tests pin the parser's
 * tolerance boundaries and the matcher's forward-only semantics with the
 * interleaving case that a naive "replace before with additions" rebuild
 * gets wrong.
 */

const FULL_PATCH = `*** Begin Patch
*** Update File: src/a.ts
@@ function greet() {
-  console.log("hi");
+  console.log("hello");
*** Add File: src/new.ts
+export const x = 1;
*** Delete File: old.txt
*** Move File: from/a.txt
*** To File: to/a.txt
*** End Patch`;

describe("parsePatch", () => {
  it("parses all four operation kinds in order", () => {
    const { ops, error } = parsePatch(FULL_PATCH);
    expect(error).toBeNull();
    expect(ops.map((o) => o.type)).toEqual(["update", "add", "delete", "move"]);
    expect(ops[0].path).toBe("src/a.ts");
    expect(ops[0].hunks).toHaveLength(1);
    expect(ops[0].hunks![0].context).toBe("function greet() {");
    expect(ops[0].hunks![0].lines).toEqual([
      { kind: "delete", text: `  console.log("hi");` },
      { kind: "add", text: `  console.log("hello");` },
    ]);
    expect(ops[1].addLines).toEqual(["export const x = 1;"]);
    expect(ops[3].moveTo).toBe("to/a.txt");
  });

  it("tolerates CRLF and the trailing-newline artifact", () => {
    const { ops, error } = parsePatch(FULL_PATCH.replace(/\n/g, "\r\n"));
    expect(error).toBeNull();
    expect(ops).toHaveLength(4);
    expect(ops[0].hunks![0].lines).toHaveLength(2);
  });

  it("keeps blank lines inside patches as content", () => {
    const { ops, error } = parsePatch(`*** Begin Patch
*** Update File: a.txt
@@
-one

+two

 three
*** End Patch`);
    expect(error).toBeNull();
    // A blank line inside a hunk is an empty CONTEXT line (classic semantics),
    // not an addition; the leading space of a context line is the prefix.
    expect(ops[0].hunks![0].lines).toEqual([
      { kind: "delete", text: "one" },
      { kind: "context", text: "" },
      { kind: "add", text: "two" },
      { kind: "context", text: "" },
      { kind: "context", text: "three" },
    ]);
  });

  it("rejects a patch without Begin Patch", () => {
    expect(parsePatch("*** Update File: a\n@@\n-x\n+y\n*** End Patch").error).toMatch(
      /Begin Patch/
    );
  });

  it("rejects a patch without End Patch", () => {
    expect(parsePatch("*** Begin Patch\n*** Delete File: a.txt").error).toMatch(/End Patch/);
  });

  it("rejects unknown headers", () => {
    expect(
      parsePatch("*** Begin Patch\n*** Rename File: a\n*** b\n*** End Patch").error
    ).toMatch(/unrecognized patch header/);
  });

  it("rejects content before any file header", () => {
    expect(parsePatch("*** Begin Patch\n+stray line\n*** End Patch").error).toMatch(
      /before any/
    );
  });

  it("rejects Add File lines without the + prefix", () => {
    expect(
      parsePatch("*** Begin Patch\n*** Add File: a.txt\nplain text\n*** End Patch").error
    ).toMatch(/must start with/);
  });

  it("rejects an Update File with no hunks and a Move with no destination", () => {
    expect(
      parsePatch("*** Begin Patch\n*** Update File: a.txt\n*** End Patch").error
    ).toMatch(/no hunks/);
    expect(
      parsePatch("*** Begin Patch\n*** Move File: a.txt\n*** End Patch").error
    ).toMatch(/To File/);
  });

  it("rejects an Add File with no content", () => {
    expect(parsePatch("*** Begin Patch\n*** Add File: a.txt\n*** End Patch").error).toMatch(
      /no content/
    );
  });
});

describe("applyHunks", () => {
  it("replaces a hunk in the middle of a file", () => {
    const file = ["import x;", "", "function greet() {", '  console.log("hi");', "}", ""].join(
      "\n"
    );
    const { ops } = parsePatch(FULL_PATCH);
    const out = applyHunks(file, ops[0].hunks!, "src/a.ts");
    expect(out).toBe(
      ["import x;", "", "function greet() {", '  console.log("hello");', "}", ""].join("\n")
    );
  });

  it("keeps additions interleaved with context instead of appending them", () => {
    // -A +X | B | +Y | -C +Z  must become  X B Y Z — the classic naive
    // "replace the before-block with the additions" rebuild yields X Y Z
    // (or, worse, drops B).
    const { ops } = parsePatch(`*** Begin Patch
*** Update File: f.txt
@@
-A
+X
 B
+Y
-C
+Z
*** End Patch`);
    expect(applyHunks("A\nB\nC", ops[0].hunks!, "f.txt")).toBe("X\nB\nY\nZ");
  });

  it("applies hunks forward-only", () => {
    const { ops } = parsePatch(`*** Begin Patch
*** Update File: f.txt
@@ mark
-one
+ONE
@@ mark
-one
+ONE-2
*** End Patch`);
    expect(applyHunks("mark\none\nmark\none", ops[0].hunks!, "f.txt")).toBe(
      "mark\nONE\nmark\nONE-2"
    );
  });

  it("inserts an additions-only hunk after its @@ anchor", () => {
    const { ops } = parsePatch(`*** Begin Patch
*** Update File: f.txt
@@ function greet() {
+  return 1;
*** End Patch`);
    expect(applyHunks("function greet() {\n}\n", ops[0].hunks!, "f.txt")).toBe(
      "function greet() {\n  return 1;\n}\n"
    );
  });

  it("appends an anchorless additions-only hunk at end of file", () => {
    const { ops } = parsePatch(`*** Begin Patch
*** Update File: f.txt
@@
+last line
*** End Patch`);
    expect(applyHunks("a\nb", ops[0].hunks!, "f.txt")).toBe("a\nb\nlast line");
  });

  it("tolerates trailing-whitespace drift in context lines", () => {
    const { ops } = parsePatch(`*** Begin Patch
*** Update File: f.txt
@@
-indent
+fixed
*** End Patch`);
    expect(applyHunks("indent   \nafter", ops[0].hunks!, "f.txt")).toBe("fixed\nafter");
  });

  it("throws a PatchApplyError naming the file when a hunk does not match", () => {
    const { ops } = parsePatch(`*** Begin Patch
*** Update File: missing.ts
@@
-nope
+yep
*** End Patch`);
    expect(() => applyHunks("something else", ops[0].hunks!, "missing.ts")).toThrow(
      PatchApplyError
    );
    try {
      applyHunks("something else", ops[0].hunks!, "missing.ts");
    } catch (e) {
      expect((e as PatchApplyError).file).toBe("missing.ts");
      expect((e as PatchApplyError).message).toMatch(/was not found/);
    }
  });

  it("refuses to apply the same hunk twice (forward-only)", () => {
    const { ops } = parsePatch(`*** Begin Patch
*** Update File: f.txt
@@
-only
+ONE
*** End Patch`);
    expect(() => applyHunks("a\nonly", ops[0].hunks!, "f.txt")).not.toThrow();
    // "only" appears once, so a second request for the same region fails.
    const { ops: ops2 } = parsePatch(`*** Begin Patch
*** Update File: f.txt
@@
-only
+ONE
@@
-only
+ONE-2
*** End Patch`);
    expect(() => applyHunks("only", ops2[0].hunks!, "f.txt")).toThrow(PatchApplyError);
  });
});

describe("counts and content", () => {
  it("counts additions and deletions across ops", () => {
    const { ops } = parsePatch(FULL_PATCH);
    expect(patchLineCounts(ops)).toEqual({ added: 2, deleted: 1 });
  });

  it("renders Add File content newline-terminated", () => {
    const { ops } = parsePatch(FULL_PATCH);
    expect(addFileContent(ops[1])).toBe("export const x = 1;\n");
  });
});

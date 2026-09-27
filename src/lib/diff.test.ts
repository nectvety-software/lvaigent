import { describe, expect, it } from "vitest";
import { collapseContext, diffLines } from "./diff";

describe("diffLines", () => {
  it("returns empty diff for identical inputs", () => {
    const r = diffLines("a\nb\nc", "a\nb\nc");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.lines.every((l) => l.type === "ctx")).toBe(true);
  });

  it("marks added lines with 1-based new-file numbers", () => {
    const r = diffLines("a\nc", "a\nb\nc");
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
    const add = r.lines.find((l) => l.type === "add");
    expect(add?.text).toBe("b");
    expect(add?.b).toBe(2);
    expect(add?.a).toBeUndefined();
  });

  it("marks removed lines with 1-based old-file numbers", () => {
    const r = diffLines("a\nb\nc", "a\nc");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(1);
    const del = r.lines.find((l) => l.type === "del");
    expect(del?.text).toBe("b");
    expect(del?.a).toBe(2);
    expect(del?.b).toBeUndefined();
  });

  it("treats replaced blocks as paired del/add", () => {
    const r = diffLines("old1\nold2", "new1\nnew2");
    expect(r.removed).toBe(2);
    expect(r.added).toBe(2);
  });

  it("normalizes CRLF line endings before diffing", () => {
    const r = diffLines("a\r\nb\r\n", "a\nb\n");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it("handles empty old file as all-add (created file)", () => {
    const r = diffLines("", "hello\nworld");
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.lines.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["hello", "world"]);
  });

  it("handles empty new file as all-remove (emptied file)", () => {
    const r = diffLines("x\ny", "");
    expect(r.removed).toBe(2);
    expect(r.added).toBe(0);
  });

  it("appends a truncation note when over the cap", () => {
    const big = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    const r = diffLines(big, big, 10);
    expect(r.lines[r.lines.length - 1].text).toContain("rút gọn");
  });

  it("keeps common prefix/suffix context around an edit", () => {
    const r = diffLines("start\nA\nB\nend", "start\nA\nX\nend");
    const types = r.lines.map((l) => l.type).join(",");
    // start, A | -B +X | end
    expect(types).toBe("ctx,ctx,del,add,ctx");
  });
});

describe("collapseContext", () => {
  it("keeps unchanged-only diffs fully visible", () => {
    const r = diffLines("a\nb", "a\nb");
    expect(collapseContext(r.lines, 3)).toEqual(r.lines);
  });

  it("collapses far-away context into gaps and preserves order", () => {
    const old = ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10", "EDIT", "h12"].join("\n");
    const neu = ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10", "edit", "h12"].join("\n");
    const view = collapseContext(diffLines(old, neu).lines, 1);
    const gap = view.find((v) => v.type === "gap") as { type: "gap"; count: number };
    expect(gap).toBeDefined();
    expect(gap.count).toBeGreaterThan(0);
    // h1 stays collapsed away, the edit lines remain.
    expect(view.some((v) => v.type !== "gap" && v.text === "edit")).toBe(true);
    expect(view.some((v) => v.type !== "gap" && v.text === "h1")).toBe(false);
  });

  it("with pad >= length, nothing is collapsed", () => {
    const r = diffLines("a\nb\nc", "a\nx\nc");
    expect(collapseContext(r.lines, 99)).toEqual(r.lines);
  });
});

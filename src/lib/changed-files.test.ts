import { describe, expect, it } from "vitest";
import { mergeChangedFiles } from "./changed-files";

describe("mergeChangedFiles", () => {
  it("records a timeline milestone per transaction with line deltas", () => {
    const files = mergeChangedFiles([
      { startedAt: 1000, before: [{ path: "a.ts", prevContent: "v1", afterContent: "v1\nv2" }], created: [] },
      { startedAt: 2000, before: [{ path: "a.ts", prevContent: "v1\nv2", afterContent: "x\nv2\nv3" }], created: [] },
    ]);
    expect(files[0].edits).toHaveLength(2);
    expect(files[0].edits![0]).toMatchObject({ at: 1000, added: 1, removed: 0 });
    // v1->x is one del+add pair, plus a new v3 line.
    expect(files[0].edits![1]).toMatchObject({ at: 2000, added: 2, removed: 1 });
    // Aggregates still hold.
    expect(files[0].added).toBe(3);
    expect(files[0].removed).toBe(1);
  });

  it("per-transaction delta is relative to the previous state, not the original", () => {
    const files = mergeChangedFiles([
      { startedAt: 1, before: [{ path: "f", prevContent: "a", afterContent: "a\nb\nc\nd" }], created: [] },
      { startedAt: 2, before: [{ path: "f", prevContent: "a\nb\nc\nd", afterContent: "a\nb\nc\nd\ne" }], created: [] },
    ]);
    expect(files[0].edits![0].added).toBe(3);
    expect(files[0].edits![1].added).toBe(1);
  });

  it("keeps per-turn before/after for isolated turn diffs", () => {
    const files = mergeChangedFiles([
      { startedAt: 1, before: [{ path: "f", prevContent: "one", afterContent: "one\ntwo" }], created: [] },
      { startedAt: 2, before: [{ path: "f", prevContent: "one\ntwo", afterContent: "one\ntwo\nthree" }], created: [] },
    ]);
    const [t1, t2] = files[0].edits!;
    expect(t1.before).toBe("one");
    expect(t1.after).toBe("one\ntwo");
    expect(t2.before).toBe("one\ntwo");
    expect(t2.after).toBe("one\ntwo\nthree");
  });

  it("tags each final line with the turn that introduced it", () => {
    // turn0: a -> a,b | turn1: a,b -> a,b,c | final: a b c
    const files = mergeChangedFiles([
      { startedAt: 1, before: [{ path: "f", prevContent: "a", afterContent: "a\nb" }], created: [] },
      { startedAt: 2, before: [{ path: "f", prevContent: "a\nb", afterContent: "a\nb\nc" }], created: [] },
    ]);
    expect(files[0].lineTurns).toEqual([-1, 0, 1]);
  });

  it("re-tags lines dropped and re-added by a later turn", () => {
    // turn0: A -> X | turn1: X -> X,Y then X removed? Simplest: X->Y then Y->X
    const files = mergeChangedFiles([
      { startedAt: 1, before: [{ path: "f", prevContent: "A", afterContent: "X" }], created: [] },
      { startedAt: 2, before: [{ path: "f", prevContent: "X", afterContent: "A" }], created: [] },
    ]);
    // Final "A" was re-added by turn 1 (not pre-existing).
    expect(files[0].lineTurns).toEqual([1]);
  });

  it("merges multiple transactions per file keeping first before and last after", () => {
    const files = mergeChangedFiles([
      {
        startedAt: 1000,
        before: [{ path: "a.ts", prevContent: "v1", afterContent: "v2" }],
        created: [],
      },
      {
        startedAt: 2000,
        before: [{ path: "a.ts", prevContent: "v2", afterContent: "v3" }],
        created: [],
      },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].before).toBe("v1");
    expect(files[0].after).toBe("v3");
    expect(files[0].created).toBe(false);
  });

  it("marks agent-created files and counts added lines from empty", () => {
    const files = mergeChangedFiles([
      { startedAt: 1, before: [], created: [{ path: "new.ts", afterContent: "hello\nworld" }] },
    ]);
    expect(files[0].created).toBe(true);
    expect(files[0].added).toBe(2);
    expect(files[0].removed).toBe(0);
    expect(files[0].before).toBe("");
  });

  it("a created file stays created when later transactions edit it", () => {
    const files = mergeChangedFiles([
      { startedAt: 1, before: [], created: [{ path: "n.ts", afterContent: "one" }] },
      { startedAt: 2, before: [{ path: "n.ts", prevContent: "one", afterContent: "two" }], created: [] },
    ]);
    expect(files[0].created).toBe(true);
    expect(files[0].before).toBe("");
    expect(files[0].after).toBe("two");
  });

  it("returns empty for no transactions", () => {
    expect(mergeChangedFiles([])).toEqual([]);
  });

  it("computes removed lines when a file is emptied", () => {
    const files = mergeChangedFiles([
      { startedAt: 5, before: [{ path: "x.ts", prevContent: "a\nb\nc", afterContent: "" }], created: [] },
    ]);
    expect(files[0].removed).toBe(3);
    expect(files[0].added).toBe(0);
  });

  it("sorts output by path", () => {
    const files = mergeChangedFiles([
      {
        startedAt: 9,
        before: [
          { path: "z.ts", prevContent: "1", afterContent: "1" },
          { path: "a.ts", prevContent: "2", afterContent: "2" },
        ],
        created: [{ path: "m.ts", afterContent: "3" }],
      },
    ]);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

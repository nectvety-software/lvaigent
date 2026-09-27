import { describe, expect, it } from "vitest";
import { hunksToRows, parseUnifiedDiff } from "./git-diff";

const SAMPLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " ctx1",
  "-old",
  "+new1",
  "+new2",
  " ctx2",
  "+tail",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses hunks with correct line numbers and counts", () => {
    const r = parseUnifiedDiff(SAMPLE);
    expect(r.hunks).toHaveLength(1);
    expect(r.added).toBe(3);
    expect(r.removed).toBe(1);
    expect(r.binary).toBe(false);
    const h = r.hunks[0];
    expect(h.aStart).toBe(1);
    expect(h.bStart).toBe(1);
    expect(h.lines.map((l) => l.type)).toEqual(["ctx", "del", "add", "add", "ctx", "add"]);
    // ctx1 consumed old line 1, so the removed "old" line is old line 2;
    // the first added line lands on new line 2 after ctx1.
    expect(h.lines[1].a).toBe(2);
    expect(h.lines[2].b).toBe(2);
    expect(h.lines[3].b).toBe(3);
  });

  it("handles multiple hunks and resets numbering per hunk", () => {
    const two = [
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -10,2 +10,2 @@",
      " x",
      "-y",
      "+Y",
    ].join("\n");
    const r = parseUnifiedDiff(two);
    expect(r.hunks).toHaveLength(2);
    expect(r.hunks[1].aStart).toBe(10);
    expect(r.added).toBe(2);
    expect(r.removed).toBe(2);
  });

  it("detects binary diffs", () => {
    const r = parseUnifiedDiff("Binary files a/logo.png and b/logo.png differ\n");
    expect(r.binary).toBe(true);
    expect(r.hunks).toHaveLength(0);
  });

  it("returns empty result for empty input", () => {
    expect(parseUnifiedDiff("").added).toBe(0);
    expect(parseUnifiedDiff("").hunks).toHaveLength(0);
  });

  it("ignores the no-newline-at-eof marker", () => {
    const withMarker = SAMPLE + "\n\\ No newline at end of file";
    const r = parseUnifiedDiff(withMarker);
    expect(r.added).toBe(3);
  });
});

describe("hunksToRows", () => {
  it("inserts a gap between hunks with the skipped line count", () => {
    const two = ["@@ -1,2 +1,2 @@", " a", "+a2", "@@ -5,2 +5,2 @@", " e", "+e2"].join("\n");
    const r = parseUnifiedDiff(two);
    const rows = hunksToRows(r.hunks);
    const gaps = rows.filter((x) => x.type === "gap") as { type: "gap"; count: number }[];
    expect(gaps).toHaveLength(1);
    expect(gaps[0].count).toBe(3); // lines 2..4 skipped (old numbering)
  });

  it("does not lead with a gap for the first hunk", () => {
    const r = parseUnifiedDiff(SAMPLE);
    const rows = hunksToRows(r.hunks);
    expect(rows[0].type).not.toBe("gap");
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_BLOCK_CHARS,
  mergeImportedSkills,
  parseSkillsMarkdown,
  pruneDisabledSkills,
  renderImportedSkills,
  skillBlockId,
} from "./imported-skills";

/**
 * The imported `.md` blocks are the agent's instructions verbatim, so these tests
 * hold the two contracts that matter: a heading boundary must never swallow the
 * text above it, and a disabled block must produce no prompt bytes at all.
 */

describe("parseSkillsMarkdown", () => {
  it("splits on level-2 headings and keeps body text intact", () => {
    const skills = parseSkillsMarkdown(
      "# Rules\n\nintro line\n\n## Naming\nOne component per file\n\n## Testing\nUse vitest\n",
      "D:/docs/rules.md"
    );
    expect(skills.map((s) => s.name)).toEqual(["Naming", "Testing"]);
    expect(skills[0].content).toBe("One component per file");
    expect(skills[1].content).toContain("Use vitest");
  });

  it("falls back to one block named from the frontmatter when there are no ## headings", () => {
    const [only] = parseSkillsMarkdown("---\nname: React rules\ndescription: repo conventions\n---\nAlways use function components.\n", "D:/a/react.md");
    expect(only.name).toBe("React rules");
    expect(only.description).toBe("repo conventions");
    expect(only.content).toBe("Always use function components.");
  });

  it("uses the file stem when nothing names the block, and ignores an empty file", () => {
    expect(parseSkillsMarkdown("just text", "D:/x/my-skills.md")[0].name).toBe("my-skills");
    expect(parseSkillsMarkdown("   \n", "D:/x/empty.md")).toEqual([]);
  });

  it("normalizes CRLF and truncates an oversized block", () => {
    const huge = "x".repeat(MAX_SKILL_BLOCK_CHARS + 500);
    const [s] = parseSkillsMarkdown(`## Big\r\n${huge}`, "D:/x/big.md");
    expect(s.content).toHaveLength(MAX_SKILL_BLOCK_CHARS);
    expect(s.truncated).toBe(true);
  });

  it("gives the same block the same id across re-imports", () => {
    const a = parseSkillsMarkdown("## Naming\none\n", "D:/p/rules.md", 1);
    const b = parseSkillsMarkdown("## Naming\ntwo\n", "D:/p/rules.md", 9999);
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).toBe(skillBlockId("D:/p/rules.md", "Naming"));
  });
});

describe("renderImportedSkills", () => {
  const skills = parseSkillsMarkdown("## A\nfirst\n\n## B\nsecond\n", "D:/p/s.md");

  it("labels each block and keeps order", () => {
    const out = renderImportedSkills(skills, []);
    expect(out).toContain("[imported_skill: A]\nfirst");
    expect(out.indexOf("A")).toBeLessThan(out.indexOf("B"));
  });

  it("omits disabled blocks entirely", () => {
    const out = renderImportedSkills(skills, [skills[1].id]);
    expect(out).toContain("first");
    expect(out).not.toContain("second");
  });

  it("returns no text when nothing is imported or everything is off", () => {
    expect(renderImportedSkills(undefined, undefined)).toBe("");
    expect(renderImportedSkills([], [])).toBe("");
    expect(renderImportedSkills(skills, skills.map((s) => s.id))).toBe("");
  });
});

describe("mergeImportedSkills", () => {
  it("replaces the same file's blocks and keeps other files", () => {
    const rulesV1 = parseSkillsMarkdown("## A\none\n\n## Gone\ntwo\n", "D:/p/rules.md");
    const other = parseSkillsMarkdown("## Keep\nthree\n", "D:/p/other.md");
    const rulesV2 = parseSkillsMarkdown("## A\nupdated\n\n## New\nfour\n", "D:/p/rules.md");

    const merged = mergeImportedSkills([...rulesV1, ...other], rulesV2);
    expect(merged.map((m) => m.name)).toEqual(["Keep", "A", "New"]);
    expect(merged.find((m) => m.name === "A")?.content).toBe("updated");
    expect(merged.some((m) => m.name === "Gone")).toBe(false);
  });

  it("caps the list so a huge import cannot grow settings forever", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `id${i}`,
      name: `n${i}`,
      description: "",
      content: "c",
      sourcePath: "D:/p/many.md",
      addedAt: 1,
    }));
    expect(mergeImportedSkills([], many)).toHaveLength(40);
  });
});

describe("pruneDisabledSkills", () => {
  it("drops ids whose block no longer exists so the disabled list cannot leak", () => {
    const alive = parseSkillsMarkdown("## A\none\n", "D:/p/a.md");
    expect(pruneDisabledSkills([alive[0].id, "stale"], alive)).toEqual([alive[0].id]);
  });
});

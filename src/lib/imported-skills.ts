/**
 * Imported "Skills & Prompt" markdown.
 *
 * A `.md` file is split into named blocks that are appended to the agent's
 * system prompt, so project conventions can be handed to the agent as a document
 * instead of being retyped into chat. The format mirrors the one the app already
 * uses for custom commands (`src/lib/custom-commands.ts`): an optional
 * frontmatter block plus `## ` headings as block boundaries.
 *
 *   ---
 *   name: React rules
 *   description: Conventions for components in this repo
 *   ---
 *   ## Naming
 *   One component per file…
 *
 *   ## Testing
 *   Every lib gets a `.test.ts`…
 *
 * A file with no `## ` headings becomes one block named from the frontmatter
 * `name:`, the `# ` title, or the filename, in that order.
 *
 * Parsing lives here rather than in the Settings component because the store
 * reads these blocks while composing a prompt, and store -> component -> store
 * would be a cycle.
 */

import type { ImportedSkill } from "../types";

/** Per-block and total caps: this text is stored in localStorage and sent every turn. */
export const MAX_SKILL_BLOCK_CHARS = 20_000;
export const MAX_IMPORTED_SKILLS = 40;
export const MAX_IMPORTED_TOTAL_CHARS = 200_000;

/** Stable id so toggles survive re-imports of the same file. */
export function skillBlockId(sourcePath: string, name: string): string {
  const file = sourcePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? sourcePath;
  return `${file}::${name}`.toLowerCase();
}

function stripFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const meta: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: m ? raw.slice(m[0].length) : raw };
}

/** Last-resort block name: the file's stem, without the `.md`. */
export function nameFromPath(path: string): string {
  const file = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  return file.replace(/\.(md|markdown)$/i, "").trim() || "Kỹ năng import";
}

/** First non-heading, non-empty line — used as the Settings row description. */
function firstLineOf(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    return t.replace(/^[-*]\s+/, "").slice(0, 120);
  }
  return "";
}

/**
 * Turn one markdown file into importable blocks.
 *
 * Returns [] only for an empty file: a file with content but no `## ` headings is
 * still one block, because "paste my rules as one document" is the common case.
 */
export function parseSkillsMarkdown(
  raw: string,
  sourcePath: string,
  addedAt = Date.now()
): ImportedSkill[] {
  const { meta, body } = stripFrontmatter(raw.replace(/\r\n?/g, "\n").trim());
  if (!body.trim()) return [];

  const fallbackName = meta["name"] || firstLineOf(body.split(/\r?\n/).filter((l) => /^#\s/.test(l)).join("\n")) || nameFromPath(sourcePath);

  const blocks: { name: string; body: string }[] = [];
  const headingRe = /^##\s+(.+?)\s*$/;
  let current: { name: string; lines: string[] } | null = null;
  for (const line of body.split("\n")) {
    const h = headingRe.exec(line);
    if (h) {
      if (current) blocks.push({ name: current.name, body: current.lines.join("\n").trim() });
      current = { name: h[1].trim(), lines: [] };
      continue;
    }
    // A single `# ` title names the file's blocks but is not itself a block.
    if (/^#\s+/.test(line) && current === null) continue;
    current?.lines.push(line);
  }
  if (current) blocks.push({ name: current.name, body: current.lines.join("\n").trim() });

  const list = blocks.length > 0 ? blocks : [{ name: fallbackName, body: body.trim() }];
  return list
    .filter((b) => b.body.length > 0)
    .map((b) => ({
      id: skillBlockId(sourcePath, b.name),
      name: b.name,
      description: meta["description"] || firstLineOf(b.body) || `${b.body.length} ký tự`,
      content: b.body.slice(0, MAX_SKILL_BLOCK_CHARS),
      truncated: b.body.length > MAX_SKILL_BLOCK_CHARS,
      sourcePath,
      addedAt,
    }));
}

/** Enabled blocks as prompt text; "" when nothing is on. */
export function renderImportedSkills(
  skills: readonly ImportedSkill[] | undefined,
  disabledIds: readonly string[] | undefined
): string {
  const off = new Set(disabledIds ?? []);
  const on = (skills ?? []).filter((s) => !off.has(s.id));
  if (on.length === 0) return "";
  let used = 0;
  const parts: string[] = [];
  for (const s of on) {
    if (used >= MAX_IMPORTED_TOTAL_CHARS) break;
    used += s.content.length;
    parts.push(`[imported_skill: ${s.name}]\n${s.content}`);
  }
  return `[imported_skills]\n${parts.join("\n\n")}`;
}

/** Merge a re-import over old blocks of the same file, dropping vanished ones. */
export function mergeImportedSkills(
  existing: readonly ImportedSkill[],
  incoming: readonly ImportedSkill[]
): ImportedSkill[] {
  if (incoming.length === 0) return [...existing];
  const file = incoming[0].sourcePath;
  const kept = existing.filter((s) => s.sourcePath !== file);
  return [...kept, ...incoming].slice(-MAX_IMPORTED_SKILLS);
}

/** Ids that stop existing after a removal; keeps `disabledSkills` from growing forever. */
export function pruneDisabledSkills(
  disabled: readonly string[] | undefined,
  alive: readonly ImportedSkill[]
): string[] {
  const ids = new Set(alive.map((s) => s.id));
  return (disabled ?? []).filter((id) => ids.has(id));
}

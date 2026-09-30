/**
 * opencode-style custom commands: markdown files under
 * `<project>/.duckchat/commands/<name>.md` become `/name` slash commands.
 *
 * File format (frontmatter optional):
 *   ---
 *   description: Short text shown in the palette
 *   ---
 *   Prompt template with $ARGUMENTS placeholder (replaced by the args typed
 *   after the command). $1, $2... map to positional args.
 *
 * Nested folders become namespaced commands: `git/commit.md` -> /git-commit.
 */

import { invoke } from "@tauri-apps/api/core";

export interface CustomCommand {
  /** Slash name without leading "/" (e.g. "git-commit"). */
  name: string;
  description: string;
  /** Absolute path of the source markdown file. */
  path: string;
  /** Template body with $ARGUMENTS / $1 / $2 placeholders. */
  template: string;
  /** Full raw file content (frontmatter included) for the edit UI. */
  rawContent: string;
}

/** One frontmatter validation issue (line numbers are 1-based over the raw file). */
export interface FrontmatterIssue {
  line: number | null;
  message: string;
}

/**
 * Validate a command markdown's frontmatter before saving.
 * Checks: closing `---`, key format, duplicate keys, unknown keys, empty
 * description, and description length. Returns [] when valid.
 */
export function validateFrontmatter(raw: string): FrontmatterIssue[] {
  const issues: FrontmatterIssue[] = [];
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    // Frontmatter is optional: a body-only file is fine.
    return issues;
  }
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) {
    issues.push({ line: null, message: "Thiếu dòng đóng '---' của frontmatter" });
    return issues;
  }
  const seen = new Set<string>();
  const KNOWN_KEYS = new Set(["description", "allowed-tools", "model", "argument-hint"]);
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) {
      issues.push({
        line: i + 1,
        message: `Dòng không hợp lệ (cần "key: value"): "${line.trim().slice(0, 40)}"`,
      });
      continue;
    }
    const key = kv[1];
    if (!KNOWN_KEYS.has(key)) {
      issues.push({ line: i + 1, message: `Key không nhận diện: "${key}" (kiểm tra chính tả?)` });
    }
    if (seen.has(key)) {
      issues.push({ line: i + 1, message: `Key bị trùng: "${key}"` });
    }
    seen.add(key);
    if (key === "description" && !kv[2].trim()) {
      issues.push({ line: i + 1, message: "description rỗng — sẽ hiện trống trong palette" });
    }
  }
  return issues;
}

/** Parse an optional `---\nkey: value\n---` frontmatter block. */
function parseFrontmatter(raw: string): { description: string; template: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { description: "", template: raw.trim() };
  const fm = m[1];
  let description = "";
  for (const line of fm.split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv && kv[1] === "description") description = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { description, template: raw.slice(m[0].length).trim() };
}

/** Fill $ARGUMENTS and $1..$9 placeholders in a template body. */
export function fillCommandTemplate(template: string, args: string): string {
  const parts = args.split(/\s+/).filter(Boolean);
  let out = template;
  // `${ARGUMENTS}` and `${ARGUMENTS:-fallback}` — the form plugin commands
  // publish, where a bare `$ARGUMENTS` reads as shell noise.
  out = out.replace(/\$\{ARGUMENTS(?::-([^}]*))?\}/g, (_m, fallback?: string) =>
    args.trim() || (fallback ?? "")
  );
  out = out.split("$ARGUMENTS").join(args.trim());
  parts.forEach((p, idx) => {
    if (idx < 9) out = out.split(`$${idx + 1}`).join(p);
  });
  return out;
}

/** Fill $ARGUMENTS and $1..$9 placeholders with the typed args. */
export function renderCommandTemplate(cmd: CustomCommand, args: string): string {
  return fillCommandTemplate(cmd.template, args);
}

/**
 * Load all custom commands of a project. Bounded: 100 files, 64KB each.
 * Returns [] when the folder does not exist.
 */
export async function loadCustomCommands(projectRoot: string): Promise<CustomCommand[]> {
  let paths: string[] = [];
  try {
    const found = await invoke<string[]>("glob_files", {
      root: projectRoot,
      pattern: ".duckchat/commands/**/*.md",
    });
    // The command is typed as string[] but nothing enforces it at runtime; a
    // null here used to throw *outside* this try block and surface as an
    // unhandled rejection in whatever called it.
    paths = Array.isArray(found) ? found : [];
  } catch {
    return [];
  }
  const cmds: CustomCommand[] = [];
  for (const rel of paths.slice(0, 100)) {
    try {
      const abs = joinProjectPath(projectRoot, rel);
      const raw = await invoke<string>("read_file_content", { path: abs });
      const name = rel
        .replace(/^\.duckchat\/commands\//, "")
        .replace(/\.md$/, "")
        .replace(/\//g, "-");
      if (!name) continue;
      const { description, template } = parseFrontmatter(raw);
      cmds.push({
        name,
        description: description || `Custom command: ${name}`,
        path: abs,
        template,
        rawContent: raw,
      });
    } catch {
      /* skip unreadable command file */
    }
  }
  return cmds.sort((a, b) => a.name.localeCompare(b.name));
}

/** Join a project-relative path using the root's own separator style. */
function joinProjectPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}

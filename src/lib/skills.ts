import type { AppSettings, PromptSectionId, SkillId } from "../types";

/**
 * Registry of the agent's capabilities and of the prompt sections.
 *
 * One source of truth for three consumers, so they can never disagree:
 *   - the Settings UI (labels, descriptions, order)
 *   - the system-prompt builder (`syntax` is the literal example line the model
 *     is shown, and must stay byte-identical to what `executeTool` accepts)
 *   - the tool executor (the `id` is the `<tool name="…">` value)
 *
 * Enablement is stored as a list of *disabled* ids, so "everything on" needs no
 * settings entry at all and a capability added later defaults to on.
 */

export interface SkillDef {
  id: SkillId;
  /** Row title in Settings. */
  name: string;
  /** One-line explanation of what the agent may do. */
  description: string;
  /** True for skills that change the project or run code on the machine. */
  mutating: boolean;
  /**
   * The `<tool …>` example shown to the model, exactly as it appears in the
   * system prompt. `null` for skills documented as a multi-line block instead
   * of a self-closing tag (write_file).
   */
  syntax: string | null;
}

/** Order here is the order the tools are documented in the system prompt. */
export const SKILLS: readonly SkillDef[] = [
  {
    id: "list_files",
    name: "list_files",
    description: "Liệt kê file và thư mục trong project.",
    mutating: false,
    syntax: '  <tool name="list_files" />',
  },
  {
    id: "glob",
    name: "glob",
    description: "Tìm file theo mẫu glob (vd: src/**/*.ts).",
    mutating: false,
    syntax: '  <tool name="glob" pattern="<glob like src/**/*.ts>" />',
  },
  {
    id: "read_file",
    name: "read_file",
    description: "Đọc nội dung file, có số dòng, đọc tiếp bằng start_line.",
    mutating: false,
    syntax:
      '  <tool name="read_file" path="<path>" start_line="<optional 0-based line to continue from>" />',
  },
  {
    id: "grep",
    name: "grep",
    description: "Tìm text trong toàn bộ project.",
    mutating: false,
    syntax: '  <tool name="grep" query="<text to search>" />',
  },
  {
    id: "write_file",
    name: "write_file",
    description: "Ghi/sửa file — thay thế toàn bộ nội dung file.",
    mutating: true,
    syntax: null, // documented as a <content> block, see agent.ts
  },
  {
    id: "run_command",
    name: "run_command",
    description: "Chạy lệnh shell trong project (build, test, lint).",
    mutating: true,
    syntax:
      '  <tool name="run_command" command="<shell command>" cwd="<optional subdir under project>" />',
  },
] as const;

export const ALL_SKILL_IDS: readonly SkillId[] = SKILLS.map((s) => s.id);

export function skillById(id: string): SkillDef | undefined {
  return SKILLS.find((s) => s.id === id);
}

export interface PromptSectionDef {
  id: PromptSectionId;
  name: string;
  description: string;
}

export const PROMPT_SECTIONS: readonly PromptSectionDef[] = [
  {
    id: "system",
    name: "System prompt",
    description: "Vai trò của agent, cú pháp tool và quy tắc làm việc.",
  },
  {
    id: "codebase",
    name: "Codebase map",
    description: "Cây file, config chính và lệnh verify của project.",
  },
  {
    id: "agentsMd",
    name: "AGENTS.md",
    description: "Hướng dẫn riêng của project (file AGENTS.md ở thư mục gốc).",
  },
  {
    id: "attachments",
    name: "File đính kèm",
    description: "Nội dung các file bạn ghim vào prompt.",
  },
  {
    id: "planRules",
    name: "Luật Plan mode",
    description: "Ràng buộc chỉ-đọc áp dụng khi agent ở chế độ Plan.",
  },
] as const;

export const ALL_PROMPT_SECTION_IDS: readonly PromptSectionId[] = PROMPT_SECTIONS.map(
  (p) => p.id
);

/** True unless the user explicitly turned this skill off. */
export function isSkillEnabled(settings: AppSettings, id: SkillId): boolean {
  return !(settings.disabledSkills ?? []).includes(id);
}

/** True unless the user explicitly turned this section off. */
export function isPromptEnabled(settings: AppSettings, id: PromptSectionId): boolean {
  return !(settings.disabledPrompts ?? []).includes(id);
}

/** The enabled skill ids, in the registry's canonical order. */
export function enabledSkillIds(settings: AppSettings): SkillId[] {
  return ALL_SKILL_IDS.filter((id) => isSkillEnabled(settings, id));
}

/** The enabled prompt sections, in the registry's canonical order. */
export function enabledPromptSectionIds(settings: AppSettings): PromptSectionId[] {
  return ALL_PROMPT_SECTION_IDS.filter((id) => isPromptEnabled(settings, id));
}

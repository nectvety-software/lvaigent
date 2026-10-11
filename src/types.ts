import type { InstalledPlugin } from "./lib/plugins";

/** Agent mode, mirroring opencode: build edits files, plan is read-only. */
export type AgentMode = "build" | "plan";

/**
 * Answer to a tool permission request.
 *
 * Mirrors ZCode's option kinds (`permissionRequest.ts` → `sortPermissionOptions`),
 * extended with the two "always" scopes ZCode also ships:
 *   - allowOnce (0) · allowFullAccess (1.5) · allowAlways (1)
 *   - rejectOnce (2) · rejectAlways (3)
 *
 * `allowAlways` / `rejectAlways` are the scoped rules ZCode installs via
 * `permissionUpdates: addRules` — "always allow `bash(npm run test:*)`". This app
 * has no rule engine, so they are stored as a plain tool-id list; the scope
 * (a command prefix) is deliberately not faked.
 */
export type ApprovalDecision =
  | "allowOnce"
  | "allowFullAccess"
  | "allowAlways"
  | "rejectOnce"
  | "rejectAlways";

/**
 * Sort priority of a permission option, matching ZCode
 * (`getPermissionOptionSortPriority` + the 1.5 for the full-access option).
 * Keep in sync with `PermissionPrompt`'s OPTIONS order.
 */
export const PERMISSION_OPTION_PRIORITY: Record<ApprovalDecision, number> = {
  allowOnce: 0,
  allowAlways: 1,
  allowFullAccess: 1.5,
  rejectOnce: 2,
  rejectAlways: 3,
};

/** One executed agent tool call, rendered as a collapsible step row. */
export interface AgentStep {
  id: string;
  tool: string;
  args: Record<string, string>;
  /** One-line human summary (e.g. "3 matches", "128 bytes written"). */
  summary: string;
  /** Full tool output shown when the step is expanded. */
  detail?: string;
  status: "running" | "done" | "denied" | "error";
  startedAt: number;
  endedAt?: number;
  /** Set on successful write_file steps: quick diff stats for the step row. */
  write?: { path: string; added: number; removed: number };
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  model?: string;
  reasoning?: string;
  attachments?: Attachment[];
  /** Files attached to this message (content was injected into the prompt). */
  fileRefs?: FileRef[];
  /** Tool calls executed while producing this reply. */
  steps?: AgentStep[];
  /** Live status line shown while streaming ("đang gửi prompt · 5s"). */
  statusText?: string;
  isStreaming?: boolean;
  /** Agent mode used for this reply (build / plan). */
  mode?: AgentMode;
  /** True when the user stopped this reply mid-stream. */
  stopped?: boolean;
}

export type AttachmentKind = "file" | "image" | "folder";

export interface FileRef {
  name: string;
  path: string;
  kind?: AttachmentKind;
}

/**
 * One imported item attached to the next prompts; content is injected into the
 * prompt. `path` is always absolute, so imports are not limited to the project.
 */
export interface AttachedFile {
  name: string;
  path: string;
  content: string;
  truncated: boolean;
  kind: AttachmentKind;
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url?: string;
  content?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  /**
   * The **workspace** this session belongs to, i.e. `WorkspaceEntry.path`.
   *
   * The workspace owns the project folder, so a session does not carry a folder
   * of its own: every session in a workspace shares the one open project, and
   * switching sessions inside a workspace does not change it. Undefined means
   * the session belongs to no workspace ("no project" chats).
   *
   * Older builds stored the same value as `projectPath`; `sanitizeConversation`
   * migrates it on load, so only read `workspacePath` from here on.
   */
  workspacePath?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  enabled: boolean;
  supportsImage?: boolean;
}

export type ApiFormat = "chat" | "openai" | "anthropic" | "responses";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
  models: ProviderModel[];
  status: "unknown" | "connected" | "error";
  /** Optional extra headers (e.g. OpenRouter referer). */
  extraHeaders?: Record<string, string>;
}

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
  size?: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  type?: string;
  fileCount?: number;
  dirCount?: number;
  files?: FileNode[];
  openedAt: number;
}

/** One numbered page of a text file (1-based numbers shown to the model). */
export interface ReadChunk {
  content: string;
  total_lines: number;
  start_line: number;
  end_line: number;
  truncated: boolean;
}

/** Compact codebase map produced by the Rust `project_overview` command. */
export interface OverviewFile {
  path: string;
  lines: number;
  size: number;
}

export interface OverviewLang {
  ext: string;
  files: number;
  lines: number;
}

export interface OverviewConfig {
  path: string;
  content: string;
}

export interface ProjectOverview {
  files: OverviewFile[];
  total_files: number;
  total_lines: number;
  langs: OverviewLang[];
  configs: OverviewConfig[];
  hints: string[];
}

/** One milestone in a file's edit timeline ("Tác nhân đã thay đổi tệp"). */
export interface FileEdit {
  /** Unix ms of the agent send that produced this change. */
  at: number;
  added: number;
  removed: number;
  /** Content before this turn (chain-linked: equals the previous turn's after). */
  before: string;
  /** Content after this turn. */
  after: string;
}

/** One file the agent changed in its most recent send (for the review diff). */
export interface ReviewFile {
  /** Project-relative path. */
  path: string;
  /** True when the agent created the file (undo deletes it). */
  created: boolean;
  added: number;
  removed: number;
  /** Snapshot source: full previous content ("" for created files). */
  before: string;
  /** Snapshot source: full new content. */
  after: string;
  /** Git source: parsed hunks (rendered directly, no LCS recompute). */
  hunks?: import("./lib/git-diff").GitHunk[];
  /** True when the Git diff says the file is binary. */
  binary?: boolean;
  /** Session scope: chronological per-send deltas for this file. */
  edits?: FileEdit[];
  /** Session scope: for each line of the final file, the turn index (0-based)
   *  that introduced it; -1 = pre-existing before the first turn. */
  lineTurns?: number[];
}

/**
 * One prompt block imported from a `.md` file (Settings → Skills & Prompt).
 * `id` is derived from the source path + heading, so re-importing the same file
 * updates the block instead of piling up duplicates.
 */
export interface ImportedSkill {
  id: string;
  /** Heading text, shown as the row title. */
  name: string;
  description: string;
  content: string;
  /** True when `content` was cut to the size cap. */
  truncated?: boolean;
  sourcePath: string;
  addedAt: number;
}

export interface AppSettings {
  /** Agent mode: build edits files, plan only proposes changes. */
  agentMode: AgentMode;
  selectedModel: string;
  /** Active provider id: "provider_duckai" keeps the duck.ai transport. */
  selectedProvider: string;
  language: string;
  /**
   * Full access. When on, the agent runs tools without asking for approval —
   * ZCode's `fullAccess` permission option ("grant the agent full access
   * without further confirmation"), made persistent instead of per-request.
   *
   * The field name predates the ZCode port and is kept so already-saved
   * settings keep working. The UI calls it "Full access".
   */
  autoAcceptPermissions: boolean;
  terminalShell: string;
  /**
   * Folders `run_command` searches BEFORE the system PATH.
   *
   * A toolchain installed outside PATH (a Lua/MRE emulator ships its interpreter
   * in its own folder) otherwise reads to the agent as "máy chưa cài Lua".
   */
  extraPathDirs?: string[];
  showReasoning: boolean;
  agentProfile: string;
  theme: "dark";
  duckaiCookies?: string;
  /** Where the review panel takes its diff from. */
  reviewSource: "snapshot" | "git";
  /**
   * Skills the user turned OFF (Settings → Skills & Prompt).
   *
   * Stores the *disabled* ids, not the enabled ones, on purpose: a missing or
   * empty list means "everything on", which is the default and means a skill
   * added in a future version is enabled without a settings migration.
   */
  disabledSkills?: SkillId[];
  /** Prompt sections the user turned OFF. Same "absent = enabled" contract. */
  disabledPrompts?: PromptSectionId[];
  /**
   * Prompt blocks imported from `.md` files (Settings → Skills & Prompt).
   * Absent = nothing imported, which renders as no extra prompt text.
   */
  importedSkills?: ImportedSkill[];
  /** Imported block ids the user turned OFF. Same "absent = enabled" contract. */
  disabledImportedSkills?: string[];
  /**
   * Tools the user chose "always allow" for (ZCode's `allowAlways` scope).
   *
   * Per-tool rather than per-command-prefix: ZCode installs a rule like
   * `bash(npm run test:*)`, this app has no rule engine, and pretending to
   * offer a narrower scope than we can honour would be worse than a coarse one
   * that is actually enforced. Absent = nothing is blanket-allowed.
   */
  alwaysAllowTools?: string[];
  /**
   * Tools the user chose "always deny" for (ZCode's `rejectAlways`).
   *
   * A deny rule outranks Full access: turning the agent loose must not be a way
   * to override a tool the user explicitly blocked.
   */
  alwaysDenyTools?: string[];
  /**
   * Plugins installed from a ZCode-format marketplace (Settings → Plugins).
   *
   * Only the record is stored here: the skill/command text stays on disk under
   * `<app data>/plugins/<name>` and is read back at boot, so localStorage does
   * not carry several megabytes of third-party markdown.
   */
  installedPlugins?: InstalledPlugin[];
  /** Plugin names the user turned OFF. Same "absent = enabled" contract. */
  disabledPlugins?: string[];
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  icon: string;
}

/**
 * An agent capability: one of the tools the model is allowed to emit.
 * Turning one off removes it from the system prompt's tool syntax AND blocks
 * execution, so a model that emits it anyway is refused rather than obeyed.
 */
export type SkillId =
  | "list_files"
  | "glob"
  | "read_file"
  | "grep"
  | "web_read"
  | "web_search"
  | "write_file"
  | "run_command";

/**
 * A section of the assembled prompt. Turning one off omits it entirely, so the
 * user can trim context (and tokens) without losing the agent itself.
 */
export type PromptSectionId =
  | "system"
  | "codebase"
  | "agentsMd"
  | "attachments"
  | "planRules";

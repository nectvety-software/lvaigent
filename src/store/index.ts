import { create } from "zustand";
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Message,
  Conversation,
  Provider,
  Project,
  FileNode,
  AttachedFile,
  AttachmentKind,
  AppSettings,
  ProjectOverview,
  AgentStep,
  AgentMode,
  ApprovalDecision,
  PromptSectionId,
  SkillId,
  ImportedSkill,
  ReviewFile,
} from "../types";
import {
  ensureVqdHash,
  invalidateVqdHash,
  getFeSignals,
  generateDurableStream,
} from "../lib/duckai";
import { getDriver } from "../lib/duckai-driver";
import { streamApiChat, type ApiChatMessage } from "../lib/api-chat";
import {
  AGENT_SYS_PROMPT,
  INIT_PROMPT,
  MAX_TOOL_REFUSAL_RETRY_TURNS,
  PLAN_MODE_RULES,
  buildAgentSysPrompt,
  buildToolProtocolReminder,
  composeAgentRequest,
  looksLikeToolRefusal,
  parseToolCalls,
  stripToolBlocks,
  executeTool,
  resolveProjectPath,
  toolRefusalExhaustedNotice,
} from "../lib/agent";
import {
  ALL_PROMPT_SECTION_IDS,
  ALL_SKILL_IDS,
  enabledPromptSectionIds,
  enabledSkillIds,
} from "../lib/skills";
import { diffLines } from "../lib/diff";
import {
  MAX_NAMED_FILES,
  MAX_NAMED_FILE_CHARS,
  buildIntentBrief,
  extractUserSignals,
  stepBudgetFor,
} from "../lib/user-signals";
import {
  loadCustomCommands,
  renderCommandTemplate,
  type CustomCommand,
} from "../lib/custom-commands";
import {
  mergeImportedSkills,
  pruneDisabledSkills,
  renderImportedSkills,
} from "../lib/imported-skills";
import { parseUnifiedDiff } from "../lib/git-diff";
import { setPendingCaptchaRetry } from "../lib/bridge-watcher";

interface StreamMsg {
  event: "delta" | "title" | "done";
  data?: { text?: string; title?: string };
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * The single real-SPA duck.ai thread this session, and the prompt it was built
 * with. Non-null means a thread exists; later messages continue it.
 *
 * The signature matters as much as the id. The thread lives inside duck.ai's page
 * for the whole app session, and DuckChat's side of it only survives as this
 * variable — so when the agent prompt changes (a code update, a Skills toggle,
 * a switch between Build and Plan) the old thread still carries the OLD prompt
 * and, worse, any earlier turns where the model claimed it had no tools. Every
 * later message continues that history, so the model keeps answering from it and
 * no amount of re-stating the protocol in the new turn helps.
 *
 * Comparing a signature of the prompt is what makes the fix observable: a stale
 * thread is abandoned and a fresh one opened, carrying the current prompt.
 */
let spaThreadOwner: string | null = null;
let spaThreadSignature: string | null = null;

/**
 * Cheap fingerprint of the part of the prompt that is the SAME for every send.
 *
 * Deliberately excludes the per-message extras (buildIntentBrief, the PLAN-mode
 * rules): those change on every turn by design, and including them made the
 * signature differ each time - so a fresh thread was opened for every message and
 * follow-ups like "tiep tuc" lost all their context.
 *
 * What must be captured is the agent prompt itself plus the agent mode, because
 * those decide which tools the model is told it has. Length plus the head and
 * tail is enough: it only has to change when the prompt does, and this runs once
 * per send.
 */
function promptSignature(baseSys: string | null, mode: AgentMode): string {
  // `baseSys` is null when the user turned the System prompt section off. That
  // is itself a prompt change, so it has to be distinguishable from any prompt.
  const p = baseSys ?? "";
  return `${mode} ${p.length} ${p.slice(0, 80)} ${p.slice(-80)}`;
}

/**
 * Forget the current duck.ai thread, so the next send opens a fresh one.
 *
 * Exported because this module-level state is exactly the kind that leaks
 * between tests and outlives what it should: a test that seeds a thread makes
 * the next test start on it, and a project switch would otherwise keep typing
 * into a thread describing a different folder.
 */
export function resetSpaThread(): void {
  spaThreadOwner = null;
  spaThreadSignature = null;
}

/** Tracks the in-flight agent send so Stop can interrupt the loop. */
let activeRun: { conversationId: string; aborted: boolean } | null = null;
/** True while the bridge window was auto-docked for a captcha challenge. */
let bridgeAutoDocked = false;

// ---------------------------------------------------------------------------
// Undo/redo of agent file edits (opencode-style /undo · /redo), in memory.
// ---------------------------------------------------------------------------

interface UndoEntry {
  path: string;
  /** Project-relative path as written by the agent (for logs). */
  projectPath: string;
  prevContent: string;
  afterContent: string;
}

interface UndoTx {
  id: string;
  conversationId: string;
  projectRoot: string | null;
  startedAt: number;
  /** Files that existed and were modified: restore prevContent on undo. */
  before: UndoEntry[];
  /** Files created by the agent: delete on undo, recreate on redo. */
  created: { path: string; afterContent: string }[];
}

// UndoEntry.path is ALSO the project-relative path now (single key per file).
// The absolute path is recomputed via joinRoot(root, path) when restoring.

const undoStacks = new Map<string, UndoTx[]>();
const redoStacks = new Map<string, UndoTx[]>();
const MAX_UNDO_TXS = 20;

/** Most recent edit tx per conversation, for the opencode-style review diff. */
const lastEditTx = new Map<string, UndoTx>();

/** Maps an edit tx id to the assistant message whose tool steps it belongs to. */
const messageTargets = new Map<string, { conversationId: string; messageId: string }>();
let txSeq = 0;

/** Store-level custom commands (loaded from .duckchat/commands when a project opens). */
let customCommands: CustomCommand[] = [];
export function getCustomCommands(): CustomCommand[] {
  return customCommands;
}

/** Join a project-relative path using the root's own separator style. */
function joinRoot(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}

/** Record one write into the undo tx, keeping the FIRST prevContent per file. */
function recordWrite(
  tx: UndoTx,
  abs: string,
  rel: string,
  content: string,
  existed: boolean,
  prev: string | null
): void {
  if (existed) {
    const found = tx.before.find((e) => e.path === rel);
    if (found) found.afterContent = content;
    else tx.before.push({ path: rel, projectPath: rel, prevContent: prev ?? "", afterContent: content });
  } else {
    const found = tx.created.find((c) => c.path === rel);
    if (found) found.afterContent = content;
    else tx.created.push({ path: rel, afterContent: content });
  }
}

const CONVERSATIONS_STORE_KEY = "duckchat.conversations";
const MAX_STORED_CONVERSATIONS = 60;
/** Session pointer so a restart restores the last conversation + project. */
const SESSION_KEY = "duckchat.session";

function loadSavedSession(): { activeConversationId: string | null } {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { activeConversationId: null };
    const parsed = JSON.parse(raw) as { activeConversationId?: string | null };
    return { activeConversationId: parsed.activeConversationId ?? null };
  } catch {
    return { activeConversationId: null };
  }
}

/** Write-through session pointer (project path comes from the conversation). */
function persistSession(conversations: Conversation[], activeId: string | null): void {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        activeConversationId: activeId,
        savedAt: Date.now(),
      })
    );
  } catch {
    /* quota errors ignored */
  }
  void conversations; // kept for signature symmetry
}

// ---------------------------------------------------------------------------
// Recent projects / workspaces ("Spaces"): quick-open list for the sidebar.
// ---------------------------------------------------------------------------

const WORKSPACES_STORE_KEY = "duckchat.workspaces";
const MAX_RECENT_PROJECTS = 10;

export interface WorkspaceEntry {
  /** Absolute project folder path (the identity key). */
  path: string;
  /** Display name — defaults to the folder name, renameable ("Space"). */
  name?: string;
  /** Unix ms of the last time this project was opened. */
  lastOpenedAt: number;
  /** Pinned workspaces stay at the top of the rail (Freebuff-style). */
  pinned?: boolean;
}

interface WorkspacesPayload {
  recents: WorkspaceEntry[];
}

function loadWorkspaces(): WorkspacesPayload {
  try {
    const raw = localStorage.getItem(WORKSPACES_STORE_KEY);
    if (!raw) return { recents: [] };
    const parsed = JSON.parse(raw) as WorkspacesPayload;
    if (!Array.isArray(parsed.recents)) return { recents: [] };
    return {
      recents: parsed.recents.filter((r) => r && typeof r.path === "string").slice(0, MAX_RECENT_PROJECTS),
    };
  } catch {
    return { recents: [] };
  }
}

function persistWorkspaces(recents: WorkspaceEntry[]): void {
  try {
    localStorage.setItem(WORKSPACES_STORE_KEY, JSON.stringify({ recents }));
  } catch {
    /* quota errors ignored */
  }
}

const initialWorkspaces = loadWorkspaces();

/** Drop half-finished/empty assistant placeholders before restoring. */
/**
 * Normalise one stored conversation, including the `projectPath` →
 * `workspacePath` migration. Exported because it is the only place legacy data
 * is rewritten, so it is worth asserting on directly.
 */
export function sanitizeConversation(c: Conversation): Conversation {
  // `projectPath` was this session's own folder before the workspace took
  // ownership of it. The path itself is unchanged — it is the same key either
  // way, because `WorkspaceEntry.path` *is* the folder — so the migration is a
  // rename. Drop the old key so it stops being written back out.
  const { projectPath: legacyPath, ...rest } = c as Conversation & { projectPath?: string };
  return {
    ...rest,
    workspacePath: rest.workspacePath ?? legacyPath,
    messages: (rest.messages ?? []).filter(
      (m) => m.role !== "assistant" || m.content.trim().length > 0
    ),
  };
}

function loadConversations(): { conversations: Conversation[]; activeConversationId: string | null } {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_STORE_KEY);
    if (!raw) return { conversations: [], activeConversationId: null };
    const parsed = JSON.parse(raw) as Conversation[];
    if (!Array.isArray(parsed)) return { conversations: [], activeConversationId: null };
    const conversations = parsed
      .filter((c) => c && typeof c.id === "string")
      .map(sanitizeConversation)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, MAX_STORED_CONVERSATIONS);
    return { conversations, activeConversationId: conversations[0]?.id ?? null };
  } catch {
    return { conversations: [], activeConversationId: null };
  }
}

function persistConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(
      CONVERSATIONS_STORE_KEY,
      JSON.stringify(
        conversations
          .slice()
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, MAX_STORED_CONVERSATIONS)
      )
    );
  } catch {
    /* quota errors ignored */
  }
}

const initialSession = loadConversations();
const initialActiveId = loadSavedSession().activeConversationId ?? initialSession.activeConversationId;
/** Absolute path of the project to reopen at boot (resolved in App bootstrap). */
export function getInitialProjectPath(): string | null {
  const saved = initialSession.conversations.find((c) => c.id === initialActiveId);
  const byRecency = initialSession.conversations[0];
  return (
    saved?.workspacePath ?? byRecency?.workspacePath ?? initialWorkspaces.recents[0]?.path ?? null
  );
}

/**
 * The workspace selected at boot.
 *
 * Deliberately *only* the active session's workspace — not the recents
 * fallback. `getInitialProjectPath()` may still reopen a folder from the recents
 * list, and `openProject` then selects that workspace, so the two stay
 * consistent without guessing here. Starting from the session avoids selecting a
 * workspace whose sessions the user is not looking at.
 */
function getInitialWorkspacePath(): string | null {
  const saved = initialSession.conversations.find((c) => c.id === initialActiveId);
  return saved?.workspacePath ?? null;
}

/**
 * Where the "which project should be open" reconciliation stands.
 *
 * `idle` is the honest "nothing to restore" state — only then does the UI show
 * the "no project open" warning. `error` carries the real reason, because the
 * bug this replaced was a silent failure: the app knew the folder, failed to
 * open it, and kept nagging the user to open one.
 */
export interface ProjectSyncState {
  status: "idle" | "loading" | "ready" | "error";
  /** Path being opened (or the one that failed). */
  path: string | null;
  /** Failure message from the backend, shown verbatim in the banner. */
  error: string | null;
}

const IDLE_PROJECT_SYNC: ProjectSyncState = { status: "idle", path: null, error: null };

/**
 * The project the given state wants open, in priority order:
 *   1. the active conversation's own binding — the authoritative one
 *   2. the most recently opened workspace — so a fresh install with history but
 *      no active session still comes back where the user left off
 * Returns null only when the app genuinely has no idea where to work.
 */
/**
 * Which project folder should be open, given the current state.
 *
 * The workspace is authoritative: the selected workspace *is* the folder, and
 * sessions inherit it rather than naming their own. The session's
 * `workspacePath` is the fallback for the boot case where a session was restored
 * before any workspace was selected.
 */
export function resolveDesiredProjectPath(state: {
  conversations: Conversation[];
  activeConversationId: string | null;
  recentProjects: WorkspaceEntry[];
  activeWorkspacePath?: string | null;
}): string | null {
  if (state.activeWorkspacePath) return state.activeWorkspacePath;
  const active = state.conversations.find((c) => c.id === state.activeConversationId);
  return active?.workspacePath ?? state.recentProjects[0]?.path ?? null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Which session should be active after the user enters workspace `path`.
 *
 * Kept pure and exported so the four rules can be tested without a DOM — the
 * sidebar's filtering makes the wrong choice visible as "the chat I am reading
 * is not in the list", which is easy to miss by eye.
 *
 *   1. the active session already belongs here → keep it
 *   2. some session belongs here → the most recently updated one
 *   3. the active session is empty → move it (a second empty session helps nobody)
 *   4. otherwise → create one, so the workspace is usable immediately
 */
export function pickSessionForWorkspace(state: {
  conversations: Conversation[];
  activeConversationId: string | null;
  path: string;
}):
  | { kind: "keep" }
  | { kind: "switch"; id: string }
  | { kind: "adopt" }
  | { kind: "create" } {
  const active = state.conversations.find((c) => c.id === state.activeConversationId);
  if (active && active.workspacePath === state.path) return { kind: "keep" };

  const here = state.conversations
    .filter((c) => c.workspacePath === state.path)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (here.length > 0) return { kind: "switch", id: here[0].id };

  // "adopt" re-stamps the active session, so it is only an option when there is
  // one — with nothing active, entering a workspace must create a session or the
  // user lands in a workspace with no session to type in.
  if (active && active.messages.length === 0) return { kind: "adopt" };
  return { kind: "create" };
}

interface AppState {
  conversations: Conversation[];
  activeConversationId: string | null;
  createConversation: () => string;
  setActiveConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  setConversationTitle: (id: string, title: string) => void;
  addMessage: (conversationId: string, message: Message) => void;
  updateMessage: (conversationId: string, messageId: string, content: string) => void;
  /** Insert or update one agent step on the given assistant message. */
  upsertStep: (conversationId: string, messageId: string, step: AgentStep) => void;
  /** Set the live status line on a streaming assistant message. */
  setMessageStatus: (conversationId: string, messageId: string, statusText: string | null) => void;
  setStreaming: (conversationId: string, messageId: string, isStreaming: boolean) => void;

  /** Terminal lines shown in the right panel; agent commands are mirrored here. */
  terminalLines: { id: string; kind: "cmd" | "out" | "err" | "info"; text: string }[];
  appendTerminal: (kind: "cmd" | "out" | "err" | "info", text: string) => void;
  clearTerminal: () => void;
  /** Run a shell command in the project root (user-initiated or agent mirror). */
  runShell: (command: string, opts?: { mirrorToTerminal?: boolean }) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;

  /** Permission prompt for run_command while a send loop is awaiting. */
  pendingApproval: {
    id: string;
    tool: string;
    args: Record<string, string>;
    resolve: (approved: boolean) => void;
  } | null;
  /** Show the permission prompt and wait for the user (or auto-accept). */
  requestApproval: (tool: string, args: Record<string, string>) => Promise<boolean>;
  /** Resolve a pending permission prompt shown in the UI. */
  answerApproval: (id: string, decision: ApprovalDecision) => void;
  /**
   * Turn Full access on or off. On = the agent runs tools without asking
   * (ZCode's `fullAccess` permission option, held persistently here).
   */
  setFullAccess: (on: boolean) => void;
  /**
   * Persist an "always allow" / "always deny" rule for one tool
   * (ZCode's `allowAlways` / `rejectAlways` options).
   *
   * Setting one behaviour clears the other for the same tool, so the two lists
   * can never both contain a tool.
   */
  addAlwaysRule: (tool: string, behavior: "allow" | "deny") => void;
  /** Drop any always-allow / always-deny rule for one tool. */
  clearAlwaysRule: (tool: string) => void;

  /** Turn one agent skill (tool) on or off. */
  setSkillEnabled: (id: SkillId, enabled: boolean) => void;
  /** Turn one prompt section on or off. */
  setPromptSectionEnabled: (id: PromptSectionId, enabled: boolean) => void;
  /** Bulk "bật tất cả" / "tắt tất cả" for the Skills & Prompt tab. */
  setAllSkillsEnabled: (enabled: boolean) => void;
  setAllPromptSectionsEnabled: (enabled: boolean) => void;
  /**
   * Store blocks parsed from an imported `.md` file. Re-importing the same file
   * replaces its blocks (ids are derived from path + heading) and leaves other
   * files alone.
   */
  importSkills: (skills: ImportedSkill[]) => void;
  /** Turn one imported block on or off. */
  setImportedSkillEnabled: (id: string, enabled: boolean) => void;
  /** Drop every block that came from one source file. */
  removeImportedSkillFile: (sourcePath: string) => void;

  providers: Provider[];
  updateProvider: (id: string, updates: Partial<Provider>) => void;
  /** Create (or replace) a provider from a preset/custom fields. */
  addProvider: (p: Provider) => void;
  removeProvider: (id: string) => void;
  /** The provider currently used for sending. */
  activeProvider: () => Provider;

  currentProject: Project | null;
  /**
   * Open a project folder. Resolves `true` on success, `false` when the folder
   * could not be read — the caller (not a fire-and-forget toast) decides how to
   * report it. Pass `silent` to suppress the toast for automatic restores.
   */
  openProject: (path: string, opts?: { silent?: boolean }) => Promise<boolean>;
  closeProject: () => void;
  /** Reopen the most recent conversation's project (boot restore). */
  restoreLastProject: () => Promise<void>;
  /**
   * Reconcile "which project should be open" with "which project is open".
   *
   * The workspace is the source of truth: the selected workspace *is* the open
   * folder, so the app must never claim "no project open" while a workspace is
   * selected. Idempotent, and safe to call on every conversation switch — it
   * does nothing when the right project is already open.
   */
  ensureProjectOpen: (opts?: { force?: boolean }) => Promise<void>;
  /** Live state of that reconciliation, so the UI can explain itself. */
  projectSync: ProjectSyncState;
  /**
   * Path the user deliberately closed. Blocks the auto-restorer from undoing
   * that decision until they open a project or pick another conversation.
   */
  projectRestoreSuppressedPath: string | null;
  /**
   * The selected workspace — and therefore the project folder that is open.
   *
   * The workspace owns the folder (ZCode's model): sessions inherit it instead
   * of naming their own, so the sidebar can scope its session list to one
   * workspace. `null` means no workspace is selected.
   */
  activeWorkspacePath: string | null;
  /**
   * Select a workspace: opens its folder and re-stamps the active session so it
   * belongs to it. Passing `null` clears the selection and closes the project.
   */
  setActiveWorkspace: (path: string | null) => void;
  /** Move one session into a workspace (or out of all of them) and persist it. */
  setConversationWorkspace: (id: string | null, path: string | null) => void;
  /**
   * Give the active session a workspace if it has none. Never moves a session
   * that already belongs to one, so it is safe to call on every folder open.
   */
  adoptOrphanActiveSession: (path: string) => void;
  /** Recently opened projects, most recent first (sidebar quick-open). */
  recentProjects: WorkspaceEntry[];
  /** Rename a workspace entry ("New Space" display name). */
  renameWorkspace: (path: string, name: string) => void;
  /** Remove one entry from the recent list. */
  forgetWorkspace: (path: string) => void;
  /** Pin/unpin a workspace (pinned sort first on the rail). */
  pinWorkspace: (path: string, pinned: boolean) => void;
  /** Reorder the rail by moving one workspace onto another (drag & drop). */
  moveWorkspace: (fromPath: string, ontoPath: string) => void;

  /** Cached codebase map for the open project (refreshed on open + writes). */
  projectOverview: ProjectOverview | null;
  overviewPath: string | null;
  refreshOverview: () => Promise<void>;

  /** Files attached to the next prompt(s); content injected into the payload. */
  attachedFiles: AttachedFile[];
  attachFile: (path: string) => Promise<void>;
  /** Import picked images/files (absolute paths) straight from disk. */
  attachFromPaths: (paths: readonly string[]) => Promise<void>;
  /** Import a folder: bounded tree listing plus the text files inside it. */
  attachFolder: (path: string) => Promise<void>;
  detachFile: (path: string) => void;
  clearAttachedFiles: () => void;

  settings: AppSettings;
  updateSettings: (updates: Partial<AppSettings>) => void;

  /** Agent mode applied to the NEXT prompt: build edits files, plan proposes. */
  agentMode: AgentMode;
  setAgentMode: (mode: AgentMode) => void;
  toggleAgentMode: () => void;

  /** Undo the last agent file-edit transaction in this conversation. */
  undoLastEdit: (conversationId: string) => Promise<void>;
  /** Re-apply the most recently undone agent edit transaction. */
  redoLastEdit: (conversationId: string) => void;
  /** True when the conversation has at least one undoable edit transaction. */
  canUndo: (conversationId: string) => boolean;
  canRedo: (conversationId: string) => boolean;

  /** Diffable view of the files changed by the agent's most recent send. */
  getReviewFiles: (conversationId: string) => Promise<ReviewFile[]>;
  /** Every edit tx of this conversation, oldest first ("Tác nhân đã thay đổi tệp"). */
  getConversationEditTxs: (conversationId: string) => {
    startedAt: number;
    before: { path: string; prevContent: string; afterContent: string }[];
    created: { path: string; afterContent: string }[];
  }[];
  /** Files changed by the agent's most recent send (for the "Xem thay đổi" chip). */
  reviewAvailable: (conversationId: string) => boolean;
  /** Show the review-diff modal for the current conversation. */
  showReview: boolean;
  setShowReview: (show: boolean) => void;
  /** Bumped whenever a new edit tx commits, so UI re-renders the review chip. */
  reviewUpdatedAt: number;
  /** File to open expanded when the review panel next mounts (step-row click). */
  reviewFocusPath: string | null;
  setReviewFocusPath: (path: string | null) => void;
  /** Re-read Git diffs + custom commands after the user edits them on disk. */
  reloadProjectData: () => Promise<void>;

  vqdStatus: "unknown" | "solving" | "ready" | "error";
  vqdSolvedAt: number | null;
  setVqdStatus: (s: AppState["vqdStatus"], ts?: number | null) => void;
  sendDuckChat: (conversationId: string, userContent: string, forceLegacy?: boolean, opts?: { systemPromptOverride?: string | null; mode?: AgentMode }) => Promise<void>;
  /** Abort the in-flight agent send (opencode-style stop). */
  stopAgent: () => void;

  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  rightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;

  toasts: { id: string; message: string; type: "success" | "error" | "info" }[];
  addToast: (message: string, type?: "success" | "error" | "info") => void;
  removeToast: (id: string) => void;
}

const generateId = () => Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

// Free-tier models (entityHasAccess includes "free" on /duckchat/v1/models).
const MODELS = [
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "mistral-small-2603", name: "Mistral Small 4" },
  { id: "tinfoil/gpt-oss-120b", name: "gpt-oss 120B" },
  { id: "tinfoil/gemma4-31b", name: "Gemma 4 31B" },
];

const defaultProvider: Provider = {
  id: "provider_duckai",
  name: "Duckai",
  baseUrl: "https://duck.ai/duckchat/v1",
  apiKey: "",
  apiFormat: "openai",
  models: MODELS.map((m) => ({ id: m.id, name: m.name, enabled: true })),
  status: "unknown",
};

const defaultSettings: AppSettings = {
  agentMode: "build",
  reviewSource: "git",
  selectedModel: "gpt-5.4-mini",
  selectedProvider: "provider_duckai",
  language: "en",
  autoAcceptPermissions: false,
  terminalShell: "powershell",
  showReasoning: false,
  agentProfile: "coding",
  theme: "dark",
  duckaiCookies: "",
};

const SETTINGS_STORE_KEY = "duckchat.settings";
const PROVIDERS_STORE_KEY = "duckchat.providers";

/**
 * Always returns a *complete* AppSettings.
 *
 * This used to `return {}` on a fresh install and cast the result to
 * AppSettings, so every field was `undefined` until the user happened to change
 * something. That was invisible while the UI used native `<select>`s — the
 * browser silently falls back to the first option, so a missing `selectedModel`
 * still *looked* populated while the store held `undefined` and the next request
 * went out with no model. A custom dropdown cannot paper over it, so the defaults
 * have to be real.
 */
function loadSavedSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORE_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...defaultSettings, ...parsed };
  } catch {
    return { ...defaultSettings };
  }
}

const initialSettings: AppSettings = loadSavedSettings();

/** Restore user-added providers; the duck.ai default is always present. */
function loadProviders(): Provider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_STORE_KEY);
    const saved: Provider[] = raw ? (JSON.parse(raw) as Provider[]) : [];
    const custom = saved.filter((p) => p && p.id !== defaultProvider.id);
    return [defaultProvider, ...custom];
  } catch {
    return [defaultProvider];
  }
}

function persistProviders(providers: Provider[]): void {
  try {
    localStorage.setItem(
      PROVIDERS_STORE_KEY,
      JSON.stringify(providers.filter((p) => p.id !== defaultProvider.id))
    );
  } catch {
    /* ignore */
  }
}

const MAX_FILE_CHARS = 8000;
const MAX_TREE_LINES = 100;
const MAX_INDEX_FILES = 200;

/** Flatten the project tree into an indented listing for the prompt. */
function flattenTree(nodes: FileNode[] | undefined, depth: number, out: string[]): void {
  if (!nodes) return;
  for (const n of nodes) {
    if (out.length >= MAX_TREE_LINES) {
      out.push("... (truncated)");
      return;
    }
    out.push(`${"  ".repeat(depth)}${n.is_dir ? n.name + "/" : n.name}`);
    if (n.is_dir) flattenTree(n.children, depth + 1, out);
  }
}

function langOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", java: "java", cs: "csharp",
    cpp: "cpp", c: "c", h: "c", html: "html", css: "css",
    json: "json", md: "markdown", yml: "yaml", yaml: "yaml",
    toml: "toml", sh: "bash", ps1: "powershell", sql: "sql",
  };
  return map[ext] ?? "";
}

/**
 * Extensions the composer imports as a picture rather than as source.
 *
 * SVG is deliberately absent: it is text, so the model can read the drawing.
 */
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tiff", "heic",
]);

export const MAX_ATTACHMENTS = 12;
const MAX_FOLDER_FILES = 12;
const MAX_FOLDER_FILE_CHARS = 4000;
const MAX_FOLDER_TOTAL_CHARS = 24000;

export function attachmentKindFor(path: string): AttachmentKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext) ? "image" : "file";
}

/** `D:/assets/logo.png` (and the trailing-slash form) -> `logo.png`. */
function baseNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[/\\]/).pop() ?? trimmed;
}

/** Every file in a `read_project_tree` result, in tree order. */
function collectTreeFiles(nodes: FileNode[] | undefined, out: FileNode[] = []): FileNode[] {
  for (const n of nodes ?? []) {
    if (n.is_dir) collectTreeFiles(n.children, out);
    else out.push(n);
  }
  return out;
}

/** Render the cached overview as the [Codebase] block the agent reads. */
function formatOverview(project: Project, ov: ProjectOverview): string {
  const parts: string[] = [];
  const langSummary = ov.langs
    .map((l) => `${l.ext}(${l.files}f/${l.lines}L)`)
    .join(", ");
  parts.push(
    `[Codebase: ${project.name}${project.type ? ` (${project.type})` : ""}]\n` +
      `${ov.total_files} files · ${ov.total_lines} lines` +
      (langSummary ? ` · langs: ${langSummary}` : "")
  );
  if (ov.hints.length > 0) {
    parts.push(`Verify: ${ov.hints.join(" · ")}`);
  }
  const lines: string[] = [];
  flattenTree(project.files, 0, lines);
  const treeShown = lines.slice(0, 60);
  if (ov.files.length > 0) {
    treeShown.push("... (see file index below)");
  }
  parts.push(`Structure:\n${treeShown.join("\n")}`);
  for (const cfg of ov.configs.slice(0, 3)) {
    parts.push(`[${cfg.path}]\n${cfg.content}`);
  }
  const index = ov.files.slice(0, MAX_INDEX_FILES).map((f) => `${f.path} · ${f.lines}L`);
  if (ov.files.length > MAX_INDEX_FILES) {
    index.push(`... (+${ov.files.length - MAX_INDEX_FILES} more)`);
  }
  parts.push(`File index (project-relative paths with line counts):\n${index.join("\n")}`);
  return parts.join("\n\n");
}

/**
 * Build the project-context block prepended to the first user message.
 * Exported for tests: it is pure, and the Skills & Prompt toggles decide which
 * sections it may include.
 *
 * `namedFiles` are files the *user's own message* named, already read by the
 * caller. They go first and carry their content, because that is the code the
 * request is actually about — the map below is only orientation.
 */
export function buildContextBlock(
  project: Project | null,
  attached: AttachedFile[],
  overview: ProjectOverview | null,
  agentsMd: string | null,
  /** Prompt sections the user turned on (Settings → Skills & Prompt). */
  sections: readonly PromptSectionId[] = ALL_PROMPT_SECTION_IDS,
  namedFiles: readonly { path: string; content: string; truncated?: boolean }[] = []
): string | null {
  const parts: string[] = [];
  const on = (id: PromptSectionId) => sections.includes(id);

  if (project && on("codebase") && namedFiles.length > 0) {
    for (const f of namedFiles) {
      parts.push(
        `[Relevant file: ${f.path}]\n\`\`\`${langOf(f.path)}\n${f.content}\n\`\`\`${
          f.truncated ? "\n(truncated)" : ""
        }`
      );
    }
  }

  if (project && on("codebase")) {
    if (overview) {
      parts.push(formatOverview(project, overview));
    } else {
      const lines: string[] = [];
      flattenTree(project.files, 0, lines);
      parts.push(
        `[Project: ${project.name}${project.type ? ` (${project.type})` : ""}]\nPath: ${project.path}\nFiles:\n${lines.join("\n")}`
      );
    }
  }
  // opencode-style: AGENTS.md is the project's persistent agent instructions.
  if (agentsMd && on("agentsMd")) {
    parts.push(`[AGENTS.md]\n${agentsMd}`);
  }
  if (on("attachments")) {
    for (const f of attached) {
      if (f.kind === "image") {
        parts.push(
          `[Image on the user's disk: ${f.path}]\n` +
            "Only the path reached you, not the picture — you have not seen it. " +
            "Use the path when referencing or copying the file into the project."
        );
        continue;
      }
      if (f.kind === "folder") {
        parts.push(
          `[Folder: ${f.path}]\n${f.content}${f.truncated ? "\n(truncated)" : ""}`
        );
        continue;
      }
      parts.push(
        `[File: ${f.path}]\n\`\`\`${langOf(f.name)}\n${f.content}\n\`\`\`${f.truncated ? "\n(truncated)" : ""}`
      );
    }
  }
  if (parts.length === 0) return null;
  return (
    "You are lvaigent, an expert AI coding assistant. " +
    "Use the project context below when answering. " +
    "When showing code, use markdown code blocks with language tags.\n\n" +
    parts.join("\n\n")
  );
}

/**
 * Every project-relative path we can vouch for.
 *
 * This is the allow-list `extractUserSignals` validates the user's message
 * against: a path the user typed from memory must not become a fabricated file
 * in the context block.
 */
export function knownProjectPaths(
  project: Project | null,
  overview: ProjectOverview | null
): string[] {
  if (overview && overview.files.length > 0) return overview.files.map((f) => f.path);
  const out: string[] = [];
  const walk = (nodes: FileNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.is_dir) walk(n.children);
      else out.push(n.path);
    }
  };
  walk(project?.files);
  return out;
}

/**
 * Read the files the user named so the agent starts with the right code in hand.
 *
 * Best-effort and bounded: a file that vanished between the index and the read is
 * skipped rather than failing the send, and only the first
 * `MAX_NAMED_FILES`/`MAX_NAMED_FILE_CHARS` are taken so a message naming a huge
 * generated file cannot blow the context window.
 */
async function readNamedFiles(
  paths: readonly string[],
  projectRoot: string | null
): Promise<{ path: string; content: string; truncated?: boolean }[]> {
  if (!projectRoot || paths.length === 0) return [];
  const out: { path: string; content: string; truncated?: boolean }[] = [];
  for (const rel of paths.slice(0, MAX_NAMED_FILES)) {
    try {
      const raw = await invoke<string>("read_file_content", {
        path: resolveProjectPath(rel, projectRoot),
      });
      if (!raw) continue;
      const truncated = raw.length > MAX_NAMED_FILE_CHARS;
      out.push({
        path: rel,
        content: truncated ? raw.slice(0, MAX_NAMED_FILE_CHARS) : raw,
        truncated,
      });
    } catch {
      /* the file moved or is unreadable — the map below still lists it */
    }
  }
  return out;
}

/** AGENTS.md cache: project path -> { content, loadedAt }. */
const agentsMdCache = new Map<string, { content: string | null; loadedAt: number }>();
const AGENTS_MD_TTL = 30_000;

/** Project-level agent instructions (opencode-style AGENTS.md), best-effort. */
async function loadAgentsMd(projectPath: string): Promise<string | null> {
  const cached = agentsMdCache.get(projectPath);
  if (cached && Date.now() - cached.loadedAt < AGENTS_MD_TTL) return cached.content;
  let content: string | null = null;
  try {
    const raw = await invoke<string>("read_file_content", {
      path: joinRoot(projectPath, "AGENTS.md"),
    });
    if (raw && raw.trim()) content = raw.trim().slice(0, 4000);
  } catch {
    content = null;
  }
  agentsMdCache.set(projectPath, { content, loadedAt: Date.now() });
  return content;
}

/** Sync snapshot used while composing prompts (may be one turn stale). */
let agentsMdMemo: string | null = null;
let agentsMdMemoPath: string | null = null;

/** Drop the AGENTS.md cache (after the agent writes it or the project changes). */
function invalidateAgentsMd(projectPath?: string): void {
  if (projectPath) agentsMdCache.delete(projectPath);
  else agentsMdCache.clear();
  agentsMdMemo = null;
  agentsMdMemoPath = null;
}

function agentsMd(): string | null {
  const project = useStore.getState().currentProject;
  if (!project) return null;
  if (agentsMdMemoPath !== project.path) {
    agentsMdMemoPath = project.path;
    agentsMdMemo = null;
    void loadAgentsMd(project.path).then((c) => {
      agentsMdMemo = c;
    });
  }
  return agentsMdMemo;
}

export const useStore = create<AppState>((set, get) => ({
  conversations: initialSession.conversations,
  // Boot on the saved session when it still exists, so the project restore below
  // resolves against the conversation the user was actually in — not merely the
  // most recently touched one.
  activeConversationId:
    initialActiveId && initialSession.conversations.some((c) => c.id === initialActiveId)
      ? initialActiveId
      : initialSession.activeConversationId,

  createConversation: () => {
    const id = generateId();
    const now = Date.now();
    const conversation: Conversation = {
      id,
      title: "New Chat",
      messages: [],
      model: get().settings.selectedModel,
      createdAt: now,
      updatedAt: now,
      projectId: get().currentProject?.id,
      // Stamped from the selected workspace, not from the open project: the
      // workspace owns the folder, and the two are kept in step by openProject.
      workspacePath: get().activeWorkspacePath ?? undefined,
    };
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeConversationId: id,
    }));
    persistSession(get().conversations, id);
    return id;
  },

  setActiveConversation: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    // Selecting a session that names a workspace *is* the user asking for that
    // workspace, so it clears the "they closed this on purpose" suppression.
    // Clicking an unbound session carries no such intent — leave the choice be,
    // otherwise the recent-workspace fallback would resurrect the closed folder.
    set({
      activeConversationId: id,
      // Follow the session into its workspace, but never *clear* the selection:
      // a session with no workspace must not close the project the user has open.
      activeWorkspacePath: conv?.workspacePath ?? get().activeWorkspacePath,
      projectRestoreSuppressedPath: conv?.workspacePath ? null : get().projectRestoreSuppressedPath,
    });
    persistSession(get().conversations, id);
    if (conv?.workspacePath) {
      void get().ensureProjectOpen();
    } else if (get().activeWorkspacePath) {
      // A session with no workspace, opened while one is selected, joins it.
      // This keeps "the session I am reading is in the filtered list" true
      // without the sidebar having to special-case it.
      get().setConversationWorkspace(id, get().activeWorkspacePath);
    }
  },

  /**
   * Select a workspace: open its folder, then make sure the active session
   * belongs to it. `null` clears the selection (and closes the project), so the
   * sidebar can fall back to showing sessions that have no workspace.
   */
  setActiveWorkspace: (path) => {
    if (path === null) {
      get().closeProject();
      return;
    }
    void (async () => {
      // Only adopt the workspace if its folder really opened — otherwise the
      // sidebar would filter to a workspace the app is not actually working in.
      const opened = await get().openProject(path, { silent: true });
      if (!opened) return;

      const decision = pickSessionForWorkspace({
        conversations: get().conversations,
        activeConversationId: get().activeConversationId,
        path,
      });
      switch (decision.kind) {
        case "switch":
          get().setActiveConversation(decision.id);
          break;
        case "adopt":
          get().setConversationWorkspace(get().activeConversationId, path);
          break;
        case "create":
          get().createConversation();
          break;
        case "keep":
          break;
      }
    })();
  },

  /** Re-point one session at a workspace (or at none) and persist it. */
  setConversationWorkspace: (id, path) => {
    if (!id) return;
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, workspacePath: path ?? undefined } : c
      ),
    }));
    persistSession(get().conversations, get().activeConversationId);
  },

  adoptOrphanActiveSession: (path) => {
    const id = get().activeConversationId;
    if (!id) return;
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.workspacePath) return;
    get().setConversationWorkspace(id, path);
  },

  /** Reopen the last project at boot (no-op when it is already open). */
  restoreLastProject: async () => {
    if (get().currentProject) return;
    const path = getInitialProjectPath();
    if (path) await get().openProject(path);
  },

  projectSync: { ...IDLE_PROJECT_SYNC },
  projectRestoreSuppressedPath: null,

  ensureProjectOpen: async (opts = {}) => {
    const { force = false } = opts;
    const state = get();
    const desired = resolveDesiredProjectPath(state);

    if (!desired) {
      // Nothing to restore: let the banner explain the (genuine) empty state.
      if (state.projectSync.status !== "idle") set({ projectSync: { ...IDLE_PROJECT_SYNC } });
      return;
    }
    if (state.currentProject?.path === desired) {
      if (state.projectSync.status !== "ready") {
        set({ projectSync: { status: "ready", path: desired, error: null } });
      }
      return;
    }
    if (!force && state.projectRestoreSuppressedPath === desired) return;
    // A restore for this exact path is already in flight (React 18 StrictMode
    // runs mount effects twice) — don't fire a second tree read.
    if (state.projectSync.status === "loading" && state.projectSync.path === desired) return;

    set({ projectSync: { status: "loading", path: desired, error: null } });
    // Silent: the banner carries the reason, a toast would just scroll away.
    await get().openProject(desired, { silent: true });
  },

  deleteConversation: (id) =>
    set((state) => {
      const filtered = state.conversations.filter((c) => c.id !== id);
      persistConversations(filtered);
      return {
        conversations: filtered,
        activeConversationId:
          state.activeConversationId === id
            ? filtered[0]?.id ?? null
            : state.activeConversationId,
      };
    }),

  setConversationTitle: (id, title) =>
    set((state) => {
      const conversations = state.conversations.map((c) =>
        c.id === id ? { ...c, title } : c
      );
      persistConversations(conversations);
      return { conversations };
    }),

  addMessage: (conversationId, message) =>
    set((state) => {
      const conversations = state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, message], updatedAt: Date.now() }
          : c
      );
      persistConversations(conversations);
      return { conversations };
    }),

  updateMessage: (conversationId, messageId, content) => {
    const state = get();
    const conversations = state.conversations.map((c) =>
      c.id === conversationId
        ? {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId ? { ...m, content } : m
            ),
          }
        : c
    );
    set({ conversations });
    // Persist only completed messages; streaming deltas re-render via zustand
    // but are throttled-copied only at the end.
    const conv = conversations.find((c) => c.id === conversationId);
    const target = conv?.messages.find((m) => m.id === messageId);
    if (conv && target && !target.isStreaming) {
      const plain: Conversation = {
        ...conv,
        updatedAt: Date.now(),
        messages: conv.messages.map((m) => ({
          ...m,
          isStreaming: false,
          reasoning: undefined,
        })),
      };
      try {
        localStorage.setItem(
          CONVERSATIONS_STORE_KEY,
          JSON.stringify(
            [plain, ...conversations.filter((c) => c.id !== conversationId)]
              .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
              .slice(0, MAX_STORED_CONVERSATIONS)
          )
        );
      } catch {
        /* ignore */
      }
    }
  },

  upsertStep: (conversationId, messageId, step) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const steps = m.steps ?? [];
                const idx = steps.findIndex((s) => s.id === step.id);
                return {
                  ...m,
                  steps:
                    idx >= 0
                      ? steps.map((s) => (s.id === step.id ? step : s))
                      : [...steps, step],
                };
              }),
            }
          : c
      ),
    })),

  setMessageStatus: (conversationId, messageId, statusText) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId
                  ? { ...m, statusText: statusText ?? undefined }
                  : m
              ),
            }
          : c
      ),
    })),

  setStreaming: (conversationId, messageId, isStreaming) => {
    const setResult = set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, isStreaming } : m
              ),
            }
          : c
      ),
    }));
    if (!isStreaming) {
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (conv) {
        const plain: Conversation = {
          ...conv,
          updatedAt: Date.now(),
          messages: conv.messages.map((m) => ({
            ...m,
            isStreaming: false,
            reasoning: undefined,
          })),
        };
        try {
          localStorage.setItem(
            CONVERSATIONS_STORE_KEY,
            JSON.stringify(
              [plain, ...get().conversations.filter((c) => c.id !== conversationId)]
                .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                .slice(0, MAX_STORED_CONVERSATIONS)
            )
          );
        } catch {
          /* ignore */
        }
      }
    }
    return setResult;
  },

  pendingApproval: null,
  requestApproval: async (tool, args) => {
    const s = get().settings;
    // Order matters, and it is the whole point of this function:
    //   1. An explicit "always deny" rule wins over everything, INCLUDING Full
    //      access. Turning the agent loose must not be a way around a tool the
    //      user blocked by name.
    //   2. Full access answers "no prompt" for every tool — not just run_command.
    //      That is what "toàn quyền" means, and it is ZCode's `fullAccess`
    //      ("grant the agent full access without further confirmation").
    //   3. An "always allow" rule answers for that one tool.
    //   4. Otherwise ask.
    if ((s.alwaysDenyTools ?? []).includes(tool)) return false;
    if (s.autoAcceptPermissions) return true;
    if ((s.alwaysAllowTools ?? []).includes(tool)) return true;
    return new Promise<boolean>((resolve) => {
      const id = generateId();
      set({ pendingApproval: { id, tool, args, resolve } });
    });
  },
  answerApproval: (id, decision) => {
    const p = get().pendingApproval;
    if (!p || p.id !== id) return;
    set({ pendingApproval: null });
    // "Full access" both answers this request and stops the agent asking again
    // for the rest of the session - the option's whole point in ZCode.
    if (decision === "allowFullAccess") get().setFullAccess(true);
    // The "always" scopes persist a per-tool rule, mirroring ZCode's
    // `addRules` updates. Deny rules are kept even while Full access is on.
    if (decision === "allowAlways") get().addAlwaysRule(p.tool, "allow");
    if (decision === "rejectAlways") get().addAlwaysRule(p.tool, "deny");
    p.resolve(decision !== "rejectOnce" && decision !== "rejectAlways");
  },
  setFullAccess: (on) => get().updateSettings({ autoAcceptPermissions: on }),
  /**
   * Record an "always allow" / "always deny" rule for one tool.
   *
   * Adding a rule for one behaviour removes it from the other, so a tool can
   * never sit in both lists — otherwise the deny check would win and the tool
   * would look allowed in the settings UI.
   */
  addAlwaysRule: (tool, behavior) => {
    const s = get().settings;
    const drop = (list?: string[]) => (list ?? []).filter((t) => t !== tool);
    get().updateSettings({
      alwaysAllowTools:
        behavior === "allow" ? [...drop(s.alwaysAllowTools), tool] : drop(s.alwaysAllowTools),
      alwaysDenyTools:
        behavior === "deny" ? [...drop(s.alwaysDenyTools), tool] : drop(s.alwaysDenyTools),
    });
  },
  clearAlwaysRule: (tool) => {
    const s = get().settings;
    get().updateSettings({
      alwaysAllowTools: (s.alwaysAllowTools ?? []).filter((t) => t !== tool),
      alwaysDenyTools: (s.alwaysDenyTools ?? []).filter((t) => t !== tool),
    });
  },

  setSkillEnabled: (id, enabled) => {
    const off = new Set(get().settings.disabledSkills ?? []);
    if (enabled) off.delete(id);
    else off.add(id);
    // Store in registry order so the persisted list is stable and diffable.
    get().updateSettings({ disabledSkills: ALL_SKILL_IDS.filter((s) => off.has(s)) });
  },
  setPromptSectionEnabled: (id, enabled) => {
    const off = new Set(get().settings.disabledPrompts ?? []);
    if (enabled) off.delete(id);
    else off.add(id);
    get().updateSettings({
      disabledPrompts: ALL_PROMPT_SECTION_IDS.filter((s) => off.has(s)),
    });
  },
  setAllSkillsEnabled: (enabled) => {
    get().updateSettings({ disabledSkills: enabled ? [] : [...ALL_SKILL_IDS] });
  },
  setAllPromptSectionsEnabled: (enabled) => {
    get().updateSettings({ disabledPrompts: enabled ? [] : [...ALL_PROMPT_SECTION_IDS] });
  },

  importSkills: (skills) => {
    if (skills.length === 0) return;
    const s = get().settings;
    const next = mergeImportedSkills(s.importedSkills ?? [], skills);
    get().updateSettings({
      importedSkills: next,
      disabledImportedSkills: pruneDisabledSkills(s.disabledImportedSkills, next),
    });
  },
  setImportedSkillEnabled: (id, enabled) => {
    const off = new Set(get().settings.disabledImportedSkills ?? []);
    if (enabled) off.delete(id);
    else off.add(id);
    const alive = new Set((get().settings.importedSkills ?? []).map((s) => s.id));
    get().updateSettings({ disabledImportedSkills: [...off].filter((x) => alive.has(x)) });
  },
  removeImportedSkillFile: (sourcePath) => {
    const s = get().settings;
    const next = (s.importedSkills ?? []).filter((x) => x.sourcePath !== sourcePath);
    get().updateSettings({
      importedSkills: next,
      disabledImportedSkills: pruneDisabledSkills(s.disabledImportedSkills, next),
    });
  },

  terminalLines: [],
  appendTerminal: (kind, text) =>
    set((state) => ({
      terminalLines: [
        ...state.terminalLines.slice(-500),
        { id: generateId(), kind, text },
      ],
    })),
  clearTerminal: () => set({ terminalLines: [] }),

  runShell: async (command, opts = { mirrorToTerminal: true }) => {
    const cmd = command.trim();
    if (!cmd) return { exitCode: null, stdout: "", stderr: "empty command", timedOut: false };
    if (opts.mirrorToTerminal !== false) {
      get().appendTerminal("cmd", cmd);
    }
    try {
      const res = await invoke<{
        exit_code: number | null;
        stdout: string;
        stderr: string;
        timed_out: boolean;
      }>("run_command", {
        command: cmd,
        cwd: null,
        shell: get().settings.terminalShell,
        root: get().currentProject?.path ?? null,
      });
      if (opts.mirrorToTerminal !== false) {
        if (res.stdout) get().appendTerminal("out", res.stdout.trimEnd());
        if (res.stderr) get().appendTerminal("err", res.stderr.trimEnd());
        if (res.timed_out) get().appendTerminal("err", "(timed out after 120s)");
        get().appendTerminal("info", `exit ${res.exit_code ?? "?"}`);
      }
      return {
        exitCode: res.exit_code,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: res.timed_out,
      };
    } catch (e) {
      const msg = String(e);
      if (opts.mirrorToTerminal !== false) get().appendTerminal("err", msg);
      return { exitCode: null, stdout: "", stderr: msg, timedOut: false };
    }
  },

  providers: loadProviders(),
  updateProvider: (id, updates) =>
    set((state) => {
      const providers = state.providers.map((p) =>
        p.id === id ? { ...p, ...updates } : p
      );
      persistProviders(providers);
      return { providers };
    }),

  addProvider: (p) =>
    set((state) => {
      const providers = [
        ...state.providers.filter((x) => x.id !== p.id),
        p,
      ];
      persistProviders(providers);
      return { providers };
    }),

  removeProvider: (id) =>
    set((state) => {
      if (id === defaultProvider.id) return {};
      const providers = state.providers.filter((p) => p.id !== id);
      persistProviders(providers);
      return {
        providers,
        settings:
          state.settings.selectedProvider === id
            ? { ...state.settings, selectedProvider: defaultProvider.id }
            : state.settings,
      };
    }),

  activeProvider: () => {
    const state = get();
    return (
      state.providers.find((p) => p.id === state.settings.selectedProvider) ??
      state.providers[0] ??
      defaultProvider
    );
  },

  currentProject: null,
  openProject: async (path, opts = {}) => {
    try {
      const info = await invoke<{ path: string; files: number; dirs: number; type?: string }>(
        "get_project_info",
        { path }
      );
      if (get().currentProject?.path === path) {
        // Idempotent re-open: the folder is already loaded, but the path has just
        // been proven to exist, so clear any earlier failure for it.
        set({
          projectSync: { status: "ready", path, error: null },
          projectRestoreSuppressedPath: null,
          activeWorkspacePath: path,
        });
        get().adoptOrphanActiveSession(path);
        return true;
      }
      const files = await invoke<FileNode[]>("read_project_tree", { path });
      const name = path.split(/[/\\]/).pop() ?? path;
      const project: Project = {
        id: generateId(),
        name,
        path,
        type: info.type,
        fileCount: info.files,
        dirCount: info.dirs,
        files,
        openedAt: Date.now(),
      };
      set({
        currentProject: project,
        projectSync: { status: "ready", path, error: null },
        projectRestoreSuppressedPath: null,
        // Opening a folder *is* selecting its workspace — keep the invariant
        // "a project is open ⟺ a workspace is selected" so the sidebar's filter
        // can never point at a workspace the app is not actually working in.
        activeWorkspacePath: path,
      });
      // A thread describes one folder. Carrying it into another project would
      // hand the model a file map and a tool protocol from the wrong tree, so
      // the next send has to open a fresh one.
      resetSpaThread();
      get().adoptOrphanActiveSession(path);
      // Remember in the recent-workspaces list (most recent first, deduped).
      const recents = [
        { path, lastOpenedAt: Date.now(), name: get().recentProjects.find((r) => r.path === path)?.name },
        ...get().recentProjects.filter((r) => r.path !== path),
      ].slice(0, MAX_RECENT_PROJECTS);
      set({ recentProjects: recents });
      persistWorkspaces(recents);
      persistSession(get().conversations, get().activeConversationId);
      get().addToast(`Project "${name}" loaded`, "success");
      void get().refreshOverview();
      void loadAgentsMd(path); // warm the AGENTS.md cache for the next prompt
      void loadCustomCommands(path).then((cmds) => {
        customCommands = cmds;
        if (cmds.length > 0) {
          get().addToast(`${cmds.length} custom command(s) từ .duckchat/commands`, "info");
        }
      });
      return true;
    } catch (e) {
      const message = errorMessage(e);
      // Record it: the no-project banner shows this verbatim, so a folder that
      // moved or was deleted is diagnosable instead of looking like a UI glitch.
      set({ projectSync: { status: "error", path, error: message } });
      if (!opts.silent) get().addToast(`Không mở được project: ${message}`, "error");
      return false;
    }
  },

  recentProjects: initialWorkspaces.recents,
  activeWorkspacePath: getInitialWorkspacePath(),
  renameWorkspace: (path, name) => {
    const recents = get().recentProjects.map((r) =>
      r.path === path ? { ...r, name: name.trim() || undefined } : r
    );
    set({ recentProjects: recents });
    persistWorkspaces(recents);
  },
  forgetWorkspace: (path) => {
    const recents = get().recentProjects.filter((r) => r.path !== path);
    set({ recentProjects: recents });
    persistWorkspaces(recents);
  },
  pinWorkspace: (path, pinned) => {
    const recents = get().recentProjects.map((r) =>
      r.path === path ? { ...r, pinned } : r
    );
    // Keep pinned entries grouped at the front, recency order inside groups.
    const sorted = [
      ...recents.filter((r) => r.pinned),
      ...recents.filter((r) => !r.pinned),
    ];
    set({ recentProjects: sorted });
    persistWorkspaces(sorted);
  },
  moveWorkspace: (fromPath, ontoPath) => {
    if (fromPath === ontoPath) return;
    const recents = [...get().recentProjects];
    const fromIdx = recents.findIndex((r) => r.path === fromPath);
    const ontoIdx = recents.findIndex((r) => r.path === ontoPath);
    if (fromIdx === -1 || ontoIdx === -1) return;
    const [moved] = recents.splice(fromIdx, 1);
    recents.splice(ontoIdx, 0, moved);
    set({ recentProjects: recents });
    persistWorkspaces(recents);
  },

  closeProject: () => {
    const closed = get().currentProject?.path ?? null;
    set({
      currentProject: null,
      projectOverview: null,
      overviewPath: null,
      rightPanelOpen: false,
      attachedFiles: [],
      projectSync: { ...IDLE_PROJECT_SYNC },
      // Clearing the workspace keeps "project open ⟺ workspace selected" true.
      // The sessions keep their `workspacePath`, so they are still reachable by
      // selecting that workspace again.
      activeWorkspacePath: null,
      // Deliberate close. Without this the reactive restorer would reopen the
      // folder on the very next conversation switch, which reads as a bug.
      projectRestoreSuppressedPath: closed,
    });
    customCommands = [];
    // Nothing to keep typing into once the folder is gone.
    resetSpaThread();
    persistSession(get().conversations, get().activeConversationId);
  },

  projectOverview: null,
  overviewPath: null,
  refreshOverview: async () => {
    const project = get().currentProject;
    if (!project) return;
    try {
      const ov = await invoke<ProjectOverview>("project_overview", { root: project.path });
      if (get().currentProject?.path === project.path) {
        set({ projectOverview: ov, overviewPath: project.path });
      }
    } catch {
      /* keep stale overview */
    }
  },

  attachedFiles: [],
  attachFile: async (path: string) => {
    await get().attachFromPaths([path]);
  },

  attachFromPaths: async (paths: readonly string[]) => {
    let overflow = 0;
    let images = 0;
    for (const raw of paths) {
      const path = raw.trim().replace(/[\\/]+$/, "");
      if (!path) continue;
      if (get().attachedFiles.some((f) => f.path === path)) continue;
      if (get().attachedFiles.length >= MAX_ATTACHMENTS) {
        overflow++;
        continue;
      }
      const name = baseNameOf(path);
      if (attachmentKindFor(path) === "image") {
        images++;
        set((s) => ({
          attachedFiles: [
            ...s.attachedFiles,
            { name, path, content: "", truncated: false, kind: "image" },
          ],
        }));
        continue;
      }
      try {
        const content = await invoke<string>("read_file_content", { path });
        const truncated = content.length > MAX_FILE_CHARS;
        set((s) => ({
          attachedFiles: [
            ...s.attachedFiles,
            {
              name,
              path,
              content: truncated ? content.slice(0, MAX_FILE_CHARS) : content,
              truncated,
              kind: "file",
            },
          ],
        }));
      } catch (e) {
        get().addToast(`Không đọc được ${name}: ${e}`, "error");
      }
    }
    if (images > 0) {
      get().addToast(
        `Đã đính kèm ${images} ảnh — model chỉ nhận đường dẫn, không nhận nội dung ảnh`,
        "info"
      );
    }
    if (overflow > 0) {
      get().addToast(`Chỉ đính kèm được tối đa ${MAX_ATTACHMENTS} mục`, "error");
    }
  },

  attachFolder: async (path: string) => {
    const root = path.trim().replace(/[\\/]+$/, "");
    if (!root) return;
    if (get().attachedFiles.some((f) => f.path === root)) return;
    if (get().attachedFiles.length >= MAX_ATTACHMENTS) {
      get().addToast(`Chỉ đính kèm được tối đa ${MAX_ATTACHMENTS} mục`, "error");
      return;
    }
    let nodes: FileNode[];
    try {
      nodes = await invoke<FileNode[]>("read_project_tree", { path: root });
    } catch (e) {
      get().addToast(`Không mở được thư mục ${baseNameOf(root)}: ${e}`, "error");
      return;
    }
    const listing: string[] = [];
    flattenTree(nodes, 0, listing);
    const files = collectTreeFiles(nodes);
    // Pictures inside the folder are listed like any other file, but never read:
    // their bytes cannot ride a text prompt.
    const readable = files.filter((f) => attachmentKindFor(f.path) === "file");
    const bodies: string[] = [];
    let budget = MAX_FOLDER_TOTAL_CHARS;
    for (const f of readable.slice(0, MAX_FOLDER_FILES)) {
      if (budget < 200) break;
      try {
        const raw = await invoke<string>("read_file_chunk", {
          path: f.path,
          maxChars: Math.min(MAX_FOLDER_FILE_CHARS, budget),
        });
        budget -= raw.length;
        bodies.push(`[File: ${f.path}]\n${raw}`);
      } catch {
        /* binary or vanished — the listing below still names it */
      }
    }
    set((s) => ({
      attachedFiles: [
        ...s.attachedFiles,
        {
          name: baseNameOf(root),
          path: root,
          content: `Structure:\n${listing.join("\n")}${bodies.length ? `\n\n${bodies.join("\n\n")}` : ""}`,
          truncated: readable.length > MAX_FOLDER_FILES || listing.length >= MAX_TREE_LINES,
          kind: "folder",
        },
      ],
    }));
    get().addToast(
      `Đã đính kèm thư mục ${baseNameOf(root)} · ${files.length} tệp (nạp nội dung ${bodies.length} tệp văn bản)`,
      "info"
    );
  },

  detachFile: (path: string) =>
    set((state) => ({
      attachedFiles: state.attachedFiles.filter((f) => f.path !== path),
    })),

  clearAttachedFiles: () => set({ attachedFiles: [] }),

  settings: initialSettings,
  updateSettings: (updates) =>
    set((state) => {
      const next = { ...state.settings, ...updates };
      try {
        localStorage.setItem(SETTINGS_STORE_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota errors */
      }
      return { settings: next };
    }),

  vqdStatus: "unknown",
  vqdSolvedAt: null,
  setVqdStatus: (s, ts = null) => set({ vqdStatus: s, vqdSolvedAt: ts }),

  stopAgent: () => {
    if (activeRun) activeRun.aborted = true;
    // A pending permission prompt blocks the send loop on a promise only the
    // dialog can resolve. Stopping must release it, otherwise the abort never
    // takes effect and the user is stuck behind a modal with no way out.
    const pending = get().pendingApproval;
    if (pending) {
      set({ pendingApproval: null });
      pending.resolve(false);
    }
  },

  agentMode: initialSettings.agentMode ?? "build",
  setAgentMode: (mode) => {
    set({ agentMode: mode });
    get().updateSettings({ agentMode: mode });
  },
  toggleAgentMode: () => {
    const next: AgentMode = get().agentMode === "build" ? "plan" : "build";
    get().setAgentMode(next);
  },

  canUndo: (conversationId) => (undoStacks.get(conversationId)?.length ?? 0) > 0,
  canRedo: (conversationId) => (redoStacks.get(conversationId)?.length ?? 0) > 0,

  getReviewFiles: async (conversationId) => {
    const tx = lastEditTx.get(conversationId);
    if (!tx) return [];
    const files: ReviewFile[] = [];
    for (const e of tx.before) {
      const d = diffLines(e.prevContent, e.afterContent);
      files.push({
        path: e.projectPath,
        created: false,
        added: d.added,
        removed: d.removed,
        before: e.prevContent,
        after: e.afterContent,
      });
    }
    for (const c of tx.created) {
      const d = diffLines("", c.afterContent);
      files.push({
        path: c.path,
        created: true,
        added: d.added,
        removed: 0,
        before: "",
        after: c.afterContent,
      });
    }
    // Git source: read the live on-disk diff for every touched path.
    if (get().settings.reviewSource === "git" && tx.projectRoot) {
      const root = tx.projectRoot;
      await Promise.all(
        files.map(async (f) => {
          try {
            const raw = await invoke<string>("git_diff", { path: f.path, root });
            if (raw.trim()) {
              const parsed = parseUnifiedDiff(raw);
              f.hunks = parsed.hunks;
              f.binary = parsed.binary;
              if (!parsed.binary && parsed.added + parsed.removed > 0) {
                f.added = parsed.added;
                f.removed = parsed.removed;
              }
            }
            // Empty diff = unchanged on disk since the edit (e.g. reverted
            // by hand): keep the snapshot numbers as the fallback.
          } catch {
            /* not a Git repo or git missing: snapshot stays the source */
          }
        })
      );
    }
    return files;
  },
  getConversationEditTxs: (conversationId) => undoStacks.get(conversationId) ?? [],
  reviewAvailable: (conversationId) => lastEditTx.has(conversationId),
  showReview: false,
  setShowReview: (show) => set({ showReview: show }),
  reviewUpdatedAt: 0,
  reviewFocusPath: null,
  setReviewFocusPath: (path) => set({ reviewFocusPath: path }),
  reloadProjectData: async () => {
    const project = get().currentProject;
    if (!project) return;
    agentsMdCache.delete(project.path);
    agentsMdMemo = null;
    agentsMdMemoPath = null;
    customCommands = await loadCustomCommands(project.path);
    set({ reviewUpdatedAt: Date.now() });
  },

  undoLastEdit: async (conversationId) => {
    const stack = undoStacks.get(conversationId);
    if (!stack || stack.length === 0) {
      get().addToast("Không có thay đổi nào để hoàn tác", "info");
      return;
    }
    const tx = stack[stack.length - 1];
    const root = tx.projectRoot;
    if (!root) {
      get().addToast("Không tìm thấy project — không thể hoàn tác", "error");
      return;
    }
    try {
      // Modified files: write the pre-agent content back.
      for (const e of tx.before) {
        await invoke<number>("write_file", {
          path: joinRoot(root, e.projectPath),
          content: e.prevContent,
          root: null,
        });
      }
      // Files the agent created: delete them again.
      for (const c of tx.created) {
        await invoke("delete_file", { path: joinRoot(root, c.path), root: null });
      }
      stack.pop();
      redoStacks.set(conversationId, [...(redoStacks.get(conversationId) ?? []), tx]);
      if (lastEditTx.get(conversationId) === tx) {
        lastEditTx.delete(conversationId);
        set({ reviewUpdatedAt: Date.now() });
      }
      get().addToast(
        `Đã hoàn tác ${tx.before.length + tx.created.length} file`,
        "success"
      );
      void get().refreshOverview();
    } catch (e) {
      get().addToast(`Undo thất bại: ${e}`, "error");
    }
  },
  redoLastEdit: async (conversationId) => {
    const rstack = redoStacks.get(conversationId);
    if (!rstack || rstack.length === 0) {
      get().addToast("Không có thay đổi nào để làm lại", "info");
      return;
    }
    const tx = rstack[rstack.length - 1];
    const root = tx.projectRoot;
    if (!root) {
      get().addToast("Không tìm thấy project — không thể làm lại", "error");
      return;
    }
    try {
      for (const e of tx.before) {
        await invoke<number>("write_file", {
          path: joinRoot(root, e.projectPath),
          content: e.afterContent,
          root: null,
        });
      }
      for (const c of tx.created) {
        await invoke<number>("write_file", {
          path: joinRoot(root, c.path),
          content: c.afterContent,
          root: null,
        });
      }
      rstack.pop();
      undoStacks.set(conversationId, [...(undoStacks.get(conversationId) ?? []), tx]);
      lastEditTx.set(conversationId, tx);
      set({ reviewUpdatedAt: Date.now() });
      get().addToast(
        `Đã làm lại ${tx.before.length + tx.created.length} file`,
        "success"
      );
      void get().refreshOverview();
    } catch (e) {
      get().addToast(`Redo thất bại: ${e}`, "error");
    }
  },

  sendDuckChat: async (
    conversationId: string,
    userContent: string,
    forceLegacy = false,
    opts: { systemPromptOverride?: string | null; mode?: AgentMode } = {}
  ): Promise<void> => {
    const state = get();
    const conversation = state.conversations.find((c) => c.id === conversationId);
    if (!conversation) return;

    // A new send interrupts whatever run is still going (opencode-style).
    if (activeRun) activeRun.aborted = true;
    const run = { conversationId, aborted: false };
    activeRun = run;

    const mode: AgentMode = opts.mode ?? get().agentMode;
    // Skills & Prompt toggles (Settings): the system prompt only documents the
    // enabled skills, and Plan rules only apply if that section is on.
    const skillsOn = enabledSkillIds(get().settings);
    const sectionsOn = enabledPromptSectionIds(get().settings);
    const baseSys: string | null =
      opts.systemPromptOverride !== undefined
        ? opts.systemPromptOverride!
        : sectionsOn.includes("system")
          ? buildAgentSysPrompt(skillsOn, sectionsOn)
          : null;
    const planRules =
      mode === "plan" && sectionsOn.includes("planRules") ? PLAN_MODE_RULES : "";
    // Blocks imported from `.md` (Settings → Skills & Prompt → Import từ .md).
    // They ride along even when the built-in System prompt section is off: the
    // user wrote this text, so it is sent as instructions on their own.
    const importedBlock = renderImportedSkills(
      get().settings.importedSkills,
      get().settings.disabledImportedSkills
    );
    // Reassigned below once the user's message has been read, so the intent
    // brief travels with the system prompt. `buildPayload` closes over it, so it
    // must be `let` rather than a constant.
    let sysPrompt = [baseSys ? baseSys + planRules : "", importedBlock]
      .filter(Boolean)
      .join("\n\n");
    // What decides whether a duck.ai thread can be reused. Imported blocks are
    // part of the prompt, so editing one must open a fresh thread instead of
    // continuing one that carries the old instructions.
    const promptBasis = baseSys === null && !importedBlock ? null : (baseSys ?? "") + importedBlock;

    const fileRefs = state.attachedFiles.map((f) => ({
      name: f.name,
      path: f.path,
      kind: f.kind,
    }));
    const isLegacyRetry = forceLegacy;
    if (!isLegacyRetry) {
      const userMsg: Message = {
        id: generateId(),
        role: "user",
        content: userContent,
        timestamp: Date.now(),
        fileRefs: fileRefs.length > 0 ? fileRefs : undefined,
      };
      state.addMessage(conversationId, userMsg);

      // Auto-title from the first message.
      if (conversation.messages.length === 0) {
        const title = userContent.length > 42 ? userContent.slice(0, 42) + "…" : userContent;
        state.setConversationTitle(conversationId, title);
      }
    }

    // On a legacy retry, reuse the streaming placeholder added by the first attempt.
    const pendingAssistant = isLegacyRetry
      ? (() => {
          const msgs = get()
            .conversations.find((c) => c.id === conversationId)
            ?.messages.filter((m) => m.role === "assistant");
          return msgs && msgs.length > 0 ? msgs[msgs.length - 1] : null;
        })()
      : null;
    const assistantId = pendingAssistant ? pendingAssistant.id : generateId();
    if (!isLegacyRetry) {
      state.addMessage(conversationId, {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        model: state.settings.selectedModel,
        isStreaming: true,
        mode,
      });
    }

    const projectRoot = get().currentProject?.path ?? null;

    // Snapshot target for opencode-style /undo of this send's file edits.
    const undoTxId = `tx_${++txSeq}`;
    const undoTx: UndoTx = {
      id: undoTxId,
      conversationId,
      projectRoot,
      startedAt: Date.now(),
      before: [],
      created: [],
    };
    messageTargets.set(undoTxId, { conversationId, messageId: assistantId });
    let txCommitted = false;

    /**
     * The project context block, assigned once inside the `try` below.
     *
     * Declared here because every payload builder closes over it. Each of them
     * used to call `buildContextBlock` itself, which is how the named-file
     * pre-read silently failed to reach the payload — the builders were still
     * computing their own block from the arguments they had always had.
     */
    let contextBlock: string | null = null;

    // Wire history for duck.ai: conversation messages + agent tool turns.
    // The system prompt is emitted as role="system" and folded into the first
    // user message by the Rust backend (duck.ai rejects role="system").
    const buildPayload = (agentLog: WireMessage[]): WireMessage[] => {
      const history = get()
        .conversations.find((c) => c.id === conversationId)
        ?.messages.filter((m) => m.role === "user" || m.role === "assistant")
        // duck.ai rejects messages with empty content (e.g. an assistant
        // placeholder that is still streaming).
        .filter((m) => m.role !== "assistant" || m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content })) ?? [];
      const ctx = contextBlock;
      if (ctx) {
        const idx = history.findIndex((m) => m.role === "user");
        if (idx >= 0) history[idx] = { ...history[idx], content: `${ctx}\n\n${history[idx].content}` };
      }
      return [{ role: "system", content: sysPrompt }, ...history, ...agentLog];
    };

    // Typed agent steps rendered as collapsible rows in the UI (and persisted).
    const pushStep = (step: AgentStep) => {
      get().upsertStep(conversationId, assistantId, step);
    };

    // Live status ticker: keeps a "phase · elapsed s" line on the streaming
    // message so the user sees progress instead of a silent blinking caret.
    let tickerPhase = "chuẩn bị";
    const tickerStart = Date.now();
    let ticker: ReturnType<typeof setInterval> | null = null;
    const startTicker = (phase: string) => {
      tickerPhase = phase;
      const tick = () => {
        const secs = Math.round((Date.now() - tickerStart) / 1000);
        get().setMessageStatus(conversationId, assistantId, `${tickerPhase} · ${secs}s`);
      };
      tick();
      if (!ticker) ticker = setInterval(tick, 1000);
    };
    const stopTicker = () => {
      if (ticker) {
        clearInterval(ticker);
        ticker = null;
      }
      get().setMessageStatus(conversationId, assistantId, null);
    };

    const streamOnce = async (vqdHash: string, wire: WireMessage[]): Promise<string> => {
      const ds = await generateDurableStream();
      const onEvent = new Channel<StreamMsg>();
      let acc = "";
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        get().updateMessage(conversationId, assistantId, stripToolBlocks(acc));
      };
      onEvent.onmessage = (ev) => {
        if (ev.event === "delta" && ev.data?.text) {
          acc += ev.data.text;
          if (!timer) timer = setTimeout(flush, 40);
        } else if (ev.event === "title" && ev.data?.title) {
          get().setConversationTitle(conversationId, ev.data.title);
        } else if (ev.event === "done") {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          get().updateMessage(conversationId, assistantId, stripToolBlocks(acc));
        }
      };
      await invoke("duckchat_stream", {
        model: get().settings.selectedModel,
        messages: wire,
        vqdHash,
        durableStream: {
          messageId: ds.messageId,
          conversationId: ds.conversationId,
          publicKey: ds.publicKey,
        },
        journeyId: ds.conversationId,
        feSignals: getFeSignals(),
        cookies: get().settings.duckaiCookies || null,
        onEvent,
      });
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      get().updateMessage(conversationId, assistantId, stripToolBlocks(acc));
      return acc;
    };

    let useDriver = false;
    let filesTouched = false;
    let driver: Awaited<ReturnType<typeof getDriver>> = null;
    let full = "";

    try {
      const provider = get().activeProvider();
      const useApi = provider.id !== "provider_duckai";

      // Read the user's message before reading the codebase: which files and
      // symbols they named decides what is worth pre-loading, and what kind of
      // request this is decides the workflow and the step budget.
      const signals = extractUserSignals(
        userContent,
        knownProjectPaths(get().currentProject, get().projectOverview)
      );
      const namedFiles = await readNamedFiles(signals.paths, projectRoot);

      // Only when the System prompt section is on — with it off the agent is
      // meant to have no tool protocol at all, so it gets no brief either.
      const brief = sysPrompt ? buildIntentBrief(signals) : "";
      if (brief) sysPrompt = `${sysPrompt}\n\n${brief}`;

      const stepBudget = stepBudgetFor(signals.intent);

      // Computed once; every payload builder reads this via closure.
      contextBlock = buildContextBlock(
        get().currentProject,
        get().attachedFiles,
        get().projectOverview,
        agentsMd(),
        enabledPromptSectionIds(get().settings),
        namedFiles
      );
      const composeFirstSpaTurn = (): string => {
        // duck.ai has no system role, so the prompt is folded into the user text.
        return composeAgentRequest({
          systemPrompt: sysPrompt,
          contextBlock,
          userContent,
          transport: "folded",
        }).userText;
      };

      /** First API turn: a real system role, and the prompt is NOT duplicated. */
      const composeFirstApiTurn = () =>
        composeAgentRequest({
          systemPrompt: sysPrompt,
          contextBlock,
          userContent,
          transport: "role-system",
        });

      const agentLog: WireMessage[] = [];
      let toolFeedback = "";
      /**
       * Corrective "you do have tools" turns spent by this send.
       *
       * Bounded by MAX_TOOL_REFUSAL_RETRY_TURNS on purpose: if the model still
       * refuses after the last one, retrying forever would burn the user's step
       * budget (and duck.ai's rate limit) to reach the same prose answer — but
       * exactly one attempt proved too few, which is why the original report
       * ("run_command không khả dụng trong phiên này") reached the user at all.
       */
      let refusalRetries = 0;

      /** One bridge turn; retries once on a clean thread when the current
       *  thread is wedged (instead of failing every later send on it). */
      const sendViaDriver = async (text: string, fresh: boolean): Promise<string> => {
        const res = await driver!.send(text, {
          fresh,
          onProgress: (partial) => {
            stopTicker();
            get().updateMessage(conversationId, assistantId, stripToolBlocks(partial));
          },
          onStatus: (msg) => {
            startTicker(msg);
            get().appendTerminal("info", `lvaigent: ${msg}`);
          },
        });
        if (res.errors.length > 0) {
          const rateLimited = res.errors.some((e) => /429|ERR_RATE_LIMIT|RATE_LIMIT/i.test(e));
          const captcha = res.errors.some((e) => /captcha/i.test(e));
          if (captcha) {
            // Show the bridge window docked beside the agent (split view) so
            // the user solves the image challenge without losing context;
            // the session cookie persists afterwards. The captcha watcher
            // retries this send automatically once the challenge is gone.
            bridgeAutoDocked = true;
            setPendingCaptchaRetry(conversationId, text);
            await invoke("show_bridge_window", { show: true }).catch(() => {});
            throw new Error(
              "lvaigent yêu cầu xác minh bạn là người (image challenge). Trình duyệt đã mở để bạn " +
                "chọn các ô chứa hình vịt rồi bấm Submit; tin nhắn sẽ tự gửi lại."
            );
          }
          if (rateLimited) {
            throw new Error("lvaigent đang giới hạn tốc độ (429). Thử lại sau 30–60 giây.");
          }
          // Non-rate-limit failure on a continued thread: the thread is likely
          // wedged (no input, no stream, expired challenge...). Reload the
          // hidden duck.ai page and retry once on a fresh thread — never
          // keep reusing the broken one.
          if (!fresh) {
            get().appendTerminal("err", `lvaigent thread lỗi (${res.errors.join("; ")}) — nạp lại lvaigent`);
            startTicker("thread lỗi — nạp lại lvaigent");
            const ok = await driver!.resetBridge().catch(() => false);
            if (ok) {
              startTicker("thử lại trên thread mới");
              const retry = await driver!.send(text, {
                fresh: true,
                onProgress: (partial) => {
                  stopTicker();
                  get().updateMessage(conversationId, assistantId, stripToolBlocks(partial));
                },
                onStatus: (msg) => startTicker(msg),
              });
              if (retry.errors.length === 0) {
                spaThreadOwner = conversationId;
                return retry.text;
              }
              throw new Error(`lvaigent error (sau retry): ${retry.errors.join("; ")}`);
            }
          }
          throw new Error(`lvaigent error: ${res.errors.join("; ")}`);
        }
        // A clean reply usually means the user already solved the challenge:
        // tuck the auto-docked bridge window away again. A window the user
        // docked manually (TitleBar split) stays put.
        if (fresh && bridgeAutoDocked) {
          bridgeAutoDocked = false;
          await invoke("show_bridge_window", { show: false }).catch(() => {});
          window.dispatchEvent(new Event("duckai:relayout"));
        }
        return res.text;
      };

      /** Wire messages for the standard-API path (system + history + agent turns). */
      const buildApiPayload = (agentLog: WireMessage[]): ApiChatMessage[] => {
        const history = get()
          .conversations.find((c) => c.id === conversationId)
          ?.messages.filter((m) => m.role === "user" || m.role === "assistant")
          .filter((m) => m.role !== "assistant" || m.content.trim().length > 0)
          .map((m) => ({ role: m.role, content: m.content })) as ApiChatMessage[] ?? [];
        const firstUser = history.findIndex((m) => m.role === "user");
        if (contextBlock && firstUser >= 0) {
          history[firstUser] = {
            ...history[firstUser],
            content: `${contextBlock}\n\n${history[firstUser].content}`,
          };
        }
        return [{ role: "system", content: sysPrompt }, ...history, ...agentLog];
      };

      // Driver transport only applies to the duck.ai provider.
      if (useApi) {
        useDriver = false;
      } else {
        startTicker(forceLegacy ? "giải PoW (legacy)" : "kết nối bridge lvaigent");
        driver = forceLegacy ? null : await getDriver(get().settings.duckaiCookies || "");
        useDriver = !!driver && driver.healthy;
      }

      for (let step = 0; ; step++) {
        if (run.aborted) break;
        if (useApi) {
          const isFirst = step === 0;
          startTicker(`gọi API ${provider.name}`);
          const apiMessages = isFirst
            ? (() => {
                const req = composeFirstApiTurn();
                return [
                  { role: "system" as const, content: req.system },
                  { role: "user" as const, content: req.userText },
                ];
              })()
            : buildApiPayload(agentLog);
          full = await streamApiChat(provider, {
            model: get().settings.selectedModel,
            messages: apiMessages,
            onProgress: (partial) => {
              stopTicker();
              get().updateMessage(conversationId, assistantId, stripToolBlocks(partial));
            },
          });
          stopTicker();
          if (!full.trim()) {
            throw new Error(`${provider.name} trả về phản hồi rỗng — kiểm tra API key / model`);
          }
        } else if (useDriver) {
          const isFirst = step === 0;
          // Exactly ONE real-SPA thread per app session: the first message
          // creates it and every later message continues it. The owner is
          // only claimed AFTER a successful send, so a broken first send
          // doesn't poison every later one.
          //
          // A thread is also abandoned when the prompt it was built with is no
          // longer the current one. Continuing a thread that carries a stale
          // prompt is what kept the model insisting it had no project tools:
          // the old history still said so, and it outweighed the fresh
          // instructions at the end of every turn.
          const signature = promptSignature(promptBasis, mode);
          if (isFirst && spaThreadOwner !== null && spaThreadSignature !== signature) {
            get().appendTerminal(
              "info",
              "lvaigent: prompt đã đổi — mở thread mới thay vì dùng thread cũ"
            );
            spaThreadOwner = null;
            spaThreadSignature = null;
          }
          const freshTurn = isFirst && spaThreadOwner === null;
          const textToSend = isFirst ? composeFirstSpaTurn() : toolFeedback;
          if (isFirst && !freshTurn) {
            get().appendTerminal("info", "lvaigent: continuing existing thread");
          }
          startTicker(freshTurn ? "mở thread mới trên lvaigent" : "gửi prompt đến lvaigent");
          full = await sendViaDriver(textToSend, freshTurn);
          if (freshTurn) {
            spaThreadOwner = conversationId;
            spaThreadSignature = signature;
          }
        } else {
          startTicker("giải proof-of-work");
          state.setVqdStatus("solving");
          const hash = await ensureVqdHash();
          state.setVqdStatus("ready", Date.now());
          startTicker("chờ lvaigent trả lời");
          full = await streamOnce(hash, buildPayload(agentLog));
          stopTicker();
        }

        const tools = parseToolCalls(full);
        // A turn that produced no tool block ends the loop — UNLESS the model
        // claimed it has no tools at all. That is the "AI Agent không gọi lệnh
        // được" report: the tools were enabled and working, the model just
        // answered in prose and the loop took that as the final answer. Give it
        // corrective turns with the tool syntax in front of it, then say so
        // openly instead of passing the refusal off as the app's verdict.
        if (tools.length === 0) {
          const refusing =
            skillsOn.length > 0 && mode !== "plan" && looksLikeToolRefusal(full);
          if (
            refusing &&
            step < stepBudget &&
            refusalRetries < MAX_TOOL_REFUSAL_RETRY_TURNS
          ) {
            refusalRetries++;
            const reminder = buildToolProtocolReminder(skillsOn, refusalRetries);
            agentLog.push({ role: "assistant", content: full });
            agentLog.push({ role: "user", content: reminder });
            toolFeedback = reminder;
            get().appendTerminal(
              "info",
              `agent không dùng tool — nhắc lại cú pháp tool (lần ${refusalRetries}/${MAX_TOOL_REFUSAL_RETRY_TURNS})`
            );
            get().updateMessage(conversationId, assistantId, stripToolBlocks(full));
            startTicker("nhắc lại tool protocol");
            continue;
          }
          if (refusing && refusalRetries > 0) {
            get().appendTerminal(
              "err",
              `lvaigent vẫn báo không có tool sau ${refusalRetries} lần nhắc cú pháp`
            );
            state.updateMessage(
              conversationId,
              assistantId,
              `${stripToolBlocks(full).trim()}\n\n${toolRefusalExhaustedNotice(refusalRetries)}`
            );
          }
          break;
        }
        if (step >= stepBudget) break;

        // Remember the assistant turn (raw, with <tool> blocks) for the next round.
        agentLog.push({ role: "assistant", content: full });

        const outcomes: { activity: { tool: string; args: Record<string, string>; summary: string }; message: string }[] = [];
        for (const t of tools) {
          if (run.aborted) break;
          const stepId = generateId();
          startTicker(`chạy ${t.name}`);
          pushStep({
            id: stepId,
            tool: t.name,
            args: t.args,
            summary: "…",
            status: "running",
            startedAt: Date.now(),
          });
          // Mirror agent shell commands into the right-panel terminal.
          if (t.name === "run_command" && t.args.command) {
            get().appendTerminal("cmd", t.args.command);
          }
          // Snapshot the target file before a write so /undo can restore it
          // and the review panel can diff it.
          let prevContent: string | null = null;
          let existed = false;
          if (t.name === "write_file" && t.args.path && projectRoot) {
            const rel = t.args.path.replace(/^[\\/]+/, "");
            const abs = resolveProjectPath(rel, projectRoot);
            try {
              prevContent = await invoke<string>("read_file_content", { path: abs });
              existed = true;
            } catch {
              existed = false;
            }
          }
          // A tool that THROWS (read_file on a missing path rejects with
          // "os error 2") must reach the model as a [tool_error] like any
          // other failure. Letting it escape aborts the whole agent loop
          // through the outer catch, which paints the raw Rust error as the
          // final answer and strands every later tool of the turn.
          let res: Awaited<ReturnType<typeof executeTool>>;
          try {
            res = await executeTool(t, projectRoot, {
              ask: (req) => get().requestApproval(req.name, req.args),
              shell: get().settings.terminalShell,
              readOnly: mode === "plan",
              disabledSkills: (get().settings.disabledSkills ?? []) as SkillId[],
              extraPathDirs: get().settings.extraPathDirs ?? [],
            });
          } catch (e) {
            res = {
              activity: { tool: t.name, args: t.args, summary: "tool crashed" },
              message: `[tool_error] The "${t.name}" tool failed to run: ${String(e)}`,
              failed: true,
            };
          }
          pushStep({
            id: stepId,
            tool: t.name,
            args: t.args,
            summary: res.activity.summary,
            detail: res.message,
            status:
              // `failed` is authoritative: a run_command that exits non-zero is
              // still a [tool_result], so prefix-matching alone painted a green
              // tick on every failed command. The message prefixes are kept as a
              // fallback so a branch that forgets the flag still cannot lie.
              res.failed || res.message.startsWith("[tool_error]")
                ? "error"
                : res.failed || res.message.startsWith("[tool_info]")
                  ? "denied"
                  : "done",
            startedAt: Date.now(),
            endedAt: Date.now(),
          });
          if (t.name === "run_command") {
            const m = res.message;
            const out = m.split("stdout:\n")[1]?.split("\nstderr:")[0]?.trim();
            const errPart = m.split("stderr:\n")[1]?.split("\n")[0]?.trim();
            if (out && out !== "(no stdout)") get().appendTerminal("out", out);
            if (errPart && errPart !== "(no stderr)") get().appendTerminal("err", errPart);
            get().appendTerminal("info", `${t.args.command} → ${res.activity.summary}`);
          }
          outcomes.push(res);
          // The codebase map goes stale after writes; refresh it once per send.
          if (t.name === "write_file" && res.activity.summary.includes("bytes written")) {
            filesTouched = true;
            if (projectRoot) {
              const rel = (t.args.path ?? "").replace(/^[\\/]+/, "");
              recordWrite(
                undoTx,
                resolveProjectPath(rel, projectRoot),
                rel,
                t.args.content ?? "",
                existed,
                prevContent
              );
              txCommitted = true;
              const d = diffLines(prevContent ?? "", t.args.content ?? "");
              pushStep({
                id: stepId,
                tool: t.name,
                args: t.args,
                summary: res.activity.summary,
                detail: res.message,
                status: "done",
                startedAt: Date.now(),
                endedAt: Date.now(),
                write: { path: rel, added: d.added, removed: d.removed },
              });
            }
          }
        }
        let feedbackParts: string[] = [];
        for (const o of outcomes) {
          agentLog.push({ role: "tool", content: o.message });
          feedbackParts.push(`[tool_result] ${o.message}`);
        }
        // Every round-trip back to the model repeats the tool protocol.
        //
        // This is the actual fix for "AI Agent không gọi lệnh được". duck.ai has
        // no system role, so the protocol reaches the model folded into the FIRST
        // user message. From round 2 on, the only thing we sent was a bare
        // `[tool_result] …`, so the model had to remember the `<tool …>` syntax
        // from deep in the history — and it reliably declared write_file and
        // run_command "không khả dụng trong phiên này" instead. read_file kept
        // working because it was in the same opening batch the model had just
        // used. Re-stating the syntax on every hop makes the tools stay live
        // without depending on the model's recall.
        //
        // It goes into BOTH carriers, because the two transports build their
        // payload from different places: the driver types `toolFeedback` into the
        // SPA, while the PoW/API path replays `agentLog`. Patching only one left
        // the other still sending bare tool results.
        const protocol = skillsOn.length > 0 ? buildToolProtocolReminder(skillsOn) : "";
        if (protocol) {
          agentLog.push({ role: "user", content: protocol });
          feedbackParts.push(protocol);
        }
        toolFeedback = feedbackParts.join("\n\n");
        // Latest partial text (tool blocks stripped) stays visible between rounds.
        stopTicker();
        get().updateMessage(conversationId, assistantId, stripToolBlocks(full));
        startTicker("gửi kết quả tool cho lvaigent");
      }
    } catch (e) {
      stopTicker();
      if (activeRun === run) activeRun = null;
      const errStr = String(e);
      const rateLimited = /429|ERR_RATE_LIMIT|RATE_LIMIT/.test(errStr);

      // Any failed driver turn means the SPA thread state is unknown: drop
      // the claim so the NEXT send opens a fresh thread instead of forever
      // "continuing existing thread" on a broken one. The signature goes with
      // it — leaving a stale signature behind would make the next send compare
      // against a prompt that no longer owns any thread.
      if (useDriver) resetSpaThread();

      // duck.ai rate limit: wait it out, don't churn solves or extra threads.
      if (rateLimited) {
        state.setVqdStatus("error");
        state.updateMessage(
          conversationId,
          assistantId,
          "⚠️ lvaigent đang giới hạn tốc độ (429). Chờ 30–60 giây rồi thử lại."
        );
        state.setStreaming(conversationId, assistantId, false);
        return;
      }

      // If the bridge attached but misbehaved, retry ONCE through the legacy
      // PoW transport instead of failing the whole exchange. A legacy retry
      // never falls back again, so a broken bridge can't cause infinite
      // recursion of failed sends.
      if (useDriver && !forceLegacy) {
        get().appendTerminal("info", "bridge lỗi — thử qua PoW (legacy) 1 lần");
        await new Promise((r) => setTimeout(r, 3000));
        await state.sendDuckChat(conversationId, userContent, true, opts);
        return;
      }

      if (errStr.includes("418") || errStr.includes("CHALLENGE")) {
        // Hash rejected/expired -> re-solve once and retry.
        try {
          invalidateVqdHash();
          state.setVqdStatus("solving");
          const hash = await ensureVqdHash(true);
          state.setVqdStatus("ready", Date.now());
          await streamOnce(hash, buildPayload([]));
        } catch (retryErr) {
          state.setVqdStatus("error");
          state.updateMessage(conversationId, assistantId, `Error: ${retryErr}`);
        }
      } else {
        state.setVqdStatus("error");
        state.updateMessage(conversationId, assistantId, `Error: ${e}`);
      }
    }

    // User stopped this run: keep what streamed, mark the message, drop the
    // rest of the loop. Uncommitted writes are still undoable this way.
    if (run.aborted) {
      const base = stripToolBlocks(full).trim();
      state.updateMessage(
        conversationId,
        assistantId,
        base ? `${base}\n\n⏹ *Đã dừng theo yêu cầu.*` : "⏹ *Đã dừng theo yêu cầu.*"
      );
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === assistantId ? { ...m, stopped: true } : m
                ),
              }
            : c
        ),
      }));
    }

    // Commit the undo transaction once per send (not per write round).
    if (txCommitted && (undoTx.before.length > 0 || undoTx.created.length > 0)) {
      const stack = undoStacks.get(conversationId) ?? [];
      stack.push(undoTx);
      undoStacks.set(conversationId, stack.slice(-MAX_UNDO_TXS));
      redoStacks.set(conversationId, []); // new edit invalidates the redo branch
      lastEditTx.set(conversationId, undoTx); // for the review-diff panel
      invalidateAgentsMd();
      set({ reviewUpdatedAt: Date.now() }); // refresh the review chip

      // Opportunistic Git stats for the write_file step rows (+N/−N badges).
      const gitRoot = undoTx.projectRoot;
      if (get().settings.reviewSource === "git" && gitRoot) {
        void (async () => {
          const conv = get().conversations.find((c) => c.id === conversationId);
          const msg = conv?.messages.find((m) => m.id === assistantId);
          if (!msg?.steps) return;
          const targets = messageTargets.get(undoTxId);
          if (!targets) return;
          for (const s of msg.steps) {
            if (s.tool !== "write_file" || s.write || s.status !== "done") continue;
            const rel = s.args.path?.replace(/^[\\/]+/, "");
            if (!rel) continue;
            try {
              const raw = await invoke<string>("git_diff", { path: rel, root: gitRoot });
              if (!raw.trim()) continue;
              const p = parseUnifiedDiff(raw);
              if (p.binary || p.added + p.removed === 0) continue;
              get().upsertStep(conversationId, targets.messageId, {
                ...s,
                write: { path: rel, added: p.added, removed: p.removed },
              });
            } catch {
              /* git unavailable: badge simply stays absent */
            }
          }
        })();
      }
    }
    if (activeRun === run) activeRun = null;

    if (filesTouched) {
      void get().refreshOverview();
    }

    state.setStreaming(conversationId, assistantId, false);
  },

  showSettings: false,
  setShowSettings: (show) => set({ showSettings: show }),
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  rightPanelOpen: false,
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),

  toasts: [],
  addToast: (message, type = "info") => {
    const id = generateId();
    set((state) => ({
      toasts: [...state.toasts, { id, message, type }],
    }));
    setTimeout(() => get().removeToast(id), 3000);
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));

// ---------------------------------------------------------------------------
// Slash commands (opencode-style). Executed by ChatView before a normal send.
// ---------------------------------------------------------------------------

export interface SlashCommand {
  name: string;
  description: string;
  /** True for project custom commands (palette fills the input instead of running). */
  custom?: boolean;
  /** Run the command; return true when it consumed the input (no chat send). */
  run: (args: string) => Promise<boolean> | boolean;
}

export function getSlashCommands(): SlashCommand[] {
  const store = useStore.getState();
  const builtins: SlashCommand[] = [
    {
      name: "/init",
      description: "Phân tích codebase và tạo AGENTS.md ở thư mục gốc project",
      run: () => {
        if (!store.currentProject) {
          store.addToast("Mở một project trước khi chạy /init", "error");
          return true;
        }
        const convId = store.activeConversationId ?? store.createConversation();
        void store.sendDuckChat(convId, INIT_PROMPT, false, {
          systemPromptOverride: AGENT_SYS_PROMPT,
        });
        return true;
      },
    },
    {
      name: "/undo",
      description: "Hoàn tác thay đổi file của lượt agent gần nhất",
      run: () => {
        const id = store.activeConversationId;
        if (id) void store.undoLastEdit(id);
        return true;
      },
    },
    {
      name: "/redo",
      description: "Làm lại thay đổi vừa hoàn tác",
      run: () => {
        const id = store.activeConversationId;
        if (id) void store.redoLastEdit(id);
        return true;
      },
    },
    {
      name: "/stop",
      description: "Dừng phản hồi đang chạy",
      run: () => {
        store.stopAgent();
        return true;
      },
    },
    {
      name: "/clear",
      description: "Bắt đầu chat mới",
      run: () => {
        store.createConversation();
        return true;
      },
    },
    {
      name: "/review",
      description: "Xem diff các file agent đã sửa ở lượt gần nhất",
      run: () => {
        const id = store.activeConversationId;
        if (!id || !store.reviewAvailable(id)) {
          store.addToast("Chưa có thay đổi nào để xem", "info");
          return true;
        }
        store.setShowReview(true);
        return true;
      },
    },
  ];
  // opencode-style custom commands from .duckchat/commands/*.md.
  const custom: SlashCommand[] = customCommands.map((cmd) => ({
    name: `/${cmd.name}`,
    description: cmd.description,
    custom: true,
    run: (args: string) => {
      const convId = store.activeConversationId ?? store.createConversation();
      void store.sendDuckChat(convId, renderCommandTemplate(cmd, args));
      return true;
    },
  }));
  return [...builtins, ...custom];
}

// Debug/testing hook: drive the store from DevTools or CDP
// (e.g. window.__duckStore.getState().openProject("D:/path")).
// Guarded because the store is also imported by Vitest's `node` environment,
// where touching `window` at module load would abort collection.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__duckStore = useStore;
}


import { invoke } from "@tauri-apps/api/core";
import { SKILLS, ALL_SKILL_IDS, ALL_PROMPT_SECTION_IDS } from "./skills";
import {
  PatchApplyError,
  addFileContent,
  applyHunks,
  patchLineCounts,
  parsePatch,
} from "./patch";
import type { PatchOp } from "./patch";
import type { PromptSectionId, SkillId, TodoItem } from "../types";

// ---------------------------------------------------------------------------
// Agent tool protocol
//
// duck.ai does NOT support user-defined OpenAI tool calling (only its built-in
// WebSearch/NewsSearch/GenerateImage etc.). So DuckChat runs a client-side
// agent loop: the model requests tools with inline `<tool ... />` blocks, the
// app executes them in Rust, appends the results as tool messages, and calls
// the model again until it produces a plain-text answer.
// ---------------------------------------------------------------------------

export const MAX_AGENT_STEPS = 10;

const MAX_GREP_RESULTS = 120;
const MAX_TOOL_MSG_CHARS = 20_000;

/**
 * Files read since the app started, as absolute paths.
 *
 * ZCode's edit tool refuses to touch a file it has not Read in the current
 * conversation (`FILE_NOT_READ`), because an edit whose `old_string` was invented
 * from memory silently misses. This app keeps the same contract with the
 * cheapest honest version of it: a set of paths a successful `read_file` has
 * produced. It is intentionally per-session rather than per-conversation — the
 * worst case of a stale entry is an edit that the old tool set allowed anyway.
 */
const readFileState = new Set<string>();

/** Record that this absolute path was read (called by read_file). */
export function markFileRead(absPath: string): void {
  readFileState.add(absPath);
}

/** True when read_file has produced this path since startup. */
export function wasFileRead(absPath: string): boolean {
  return readFileState.has(absPath);
}

/** Test seam: forget all read state (so tests start from ZCode's contract). */
export function resetReadFileState(): void {
  readFileState.clear();
}

/**
 * duck.ai's composer is a hard 16,000-character field.
 *
 * Over that it answers "Please try a shorter message." and refuses the send —
 * which from the app looked like a mysterious bridge failure, then a refused PoW
 * retry, and finally the 418 notice. The limit is invisible on the API and PoW
 * wire paths (per-message, and the Rust backend folds nothing), so only the
 * text typed into the SPA is budgeted here.
 */
export const SPA_MESSAGE_LIMIT = 16_000;

/**
 * How a transport carries the system prompt.
 *
 * duck.ai rejects `role: "system"`, so its payloads fold the system prompt into
 * the first user message. A standard API provider gets a real system role.
 */
export type PromptTransport = "role-system" | "folded";

export interface AgentRequest {
  /** System-role content. Empty when the transport has no system role. */
  system: string;
  /** User-role content: the project context, then the user's own words. */
  userText: string;
}

/**
 * Assemble one model call from the three things that make it up.
 *
 * This is the single place the system prompt and the project context are
 * combined. They used to be assembled separately in each transport branch, and
 * that duplication had produced two bugs on the API path: it sent the constant
 * all-skills prompt instead of the configured one (so the Skills & Prompt
 * toggles were ignored on the first turn) and it *also* embedded the system
 * prompt in the user message, so the model received it twice.
 *
 * Note there is deliberately no fallback to a default prompt when
 * `systemPrompt` is empty: turning the System prompt section off is supposed to
 * leave the agent with no tool syntax at all, which is what the Settings copy
 * promises.
 */
export function composeAgentRequest(input: {
  systemPrompt: string;
  contextBlock: string | null;
  userContent: string;
  transport: PromptTransport;
}): AgentRequest {
  const { systemPrompt, contextBlock, userContent, transport } = input;
  const userBody = contextBlock ? `${contextBlock}\n\n${userContent}` : userContent;

  if (transport === "folded") {
    return {
      system: "",
      userText: systemPrompt ? `${systemPrompt}\n\n${userBody}` : userBody,
    };
  }
  return { system: systemPrompt, userText: userBody };
}

/**
 * Room left for the project-context block in one folded SPA turn.
 *
 * Negative means the turn cannot be sent at all: the prompt and the user's own
 * words already exceed the composer on their own, so no amount of dropped
 * context helps and the send should be refused before either transport runs.
 */
export function spaContextBudget(
  systemPrompt: string,
  userContent: string,
  limit: number = SPA_MESSAGE_LIMIT
): number {
  // Two "\n\n" joiners; conservative when the system prompt is switched off.
  return limit - systemPrompt.length - userContent.length - 4;
}

/**
 * Assemble one bridge round-trip inside the composer limit.
 *
 * Whole `[tool_result]` blocks are dropped oldest-first, because the model
 * copes well with "an earlier round's output is missing" and badly with a file
 * cut mid-statement, which it will read as complete code. Only when a single
 * newest result is over budget by itself does it get sliced — and the slice is
 * labelled, so it cannot pass for the whole log. The tool-protocol reminder is
 * never dropped: it is what keeps the tools live from round 2 onward.
 */
export function clampToolFeedback(
  results: readonly string[],
  protocol: string,
  limit: number = SPA_MESSAGE_LIMIT
): { text: string; dropped: number } {
  const tail = protocol ? `\n\n${protocol}` : "";
  const kept: string[] = [];
  let used = tail.length;
  for (let i = results.length - 1; i >= 0; i--) {
    const cost = results[i].length + (kept.length > 0 ? 2 : 0);
    if (used + cost > limit) break;
    kept.unshift(results[i]);
    used += cost;
  }
  if (kept.length === 0 && results.length > 0) {
    const mark = "\n... (tool output truncated)";
    const room = limit - tail.length - mark.length;
    if (room > 0) kept.push(`${results[results.length - 1].slice(0, room)}${mark}`);
  }
  const body = kept.join("\n\n");
  return {
    text: body ? `${body}${tail}` : protocol,
    dropped: results.length - kept.length,
  };
}

/** Shared rule text prepended in PLAN mode: tools that mutate are disabled. */
export const PLAN_MODE_RULES = `

MODE: PLAN (read-only).
- write_file and run_command are DISABLED. Do not emit them.
- Analyze, read and search, then propose a concrete plan: files to change,
  step-by-step edits, commands the user can run to verify.
- The user switches to BUILD mode when the plan is approved.`;

/** Extra instructions injected as the system prompt when running /init. */
export const INIT_PROMPT = `Please analyze this codebase and create a AGENTS.md file in the project root, containing:
1. Build/test/lint commands - especially how to run a single test.
2. Architecture overview: important files and their roles.
3. Code style: naming, imports, patterns, conventions already used here.
4. Workflow notes: anything an AI agent should know before changing this code.

If an AGENTS.md already exists, improve and extend it. Keep it concise and factual; write it in English. When done, show its content.`;

export const AGENT_SYS_PROMPT_BASE = `You are lvaigent, an AI coding assistant working inside the user's project.`;

/**
 * One numbered item of the system prompt.
 *
 * `suffix` exists so a rule that mixes a general statement with a
 * skill-specific one can lose only the skill-specific half — duplicating the
 * text instead would let the all-enabled output drift from the prompt this file
 * shipped before the Settings toggles existed.
 */
interface PromptRule {
  text: string;
  /** Appended to the same numbered item while `requiresAny` is satisfied. */
  suffix?: { requiresAny: Requirement[]; text: string };
  /** When set, the whole item is dropped unless one of these is enabled. */
  requiresAny?: Requirement[];
}

type Requirement = SkillId | PromptSectionId;

const RULES: readonly PromptRule[] = [
  {
    text: "Read the relevant file(s) BEFORE answering or editing. Do NOT guess APIs.",
  },
  {
    // The reported dead-end, third form: the model named the exact files
    // (`src/gfx.lua`, `src/ui.lua`) and then asked the user to paste their
    // contents instead of reading them with its own tools — an agent that
    // cannot produce code on its own. Naming the anti-pattern in the prompt is
    // cheaper than recovering from it after the fact.
    requiresAny: ["read_file", "glob", "grep"],
    text: "NEVER ask the user to paste, attach, drop or send file contents —\n   you have read_file/glob/grep for exactly that. Emit the tool block and\n   read the project yourself, every time.",
  },
  {
    // ZCode's edit contract, stated so a model trained on whole-file writes
    // does not burn the turn: the guard is enforced in the executor too.
    requiresAny: ["edit_file"],
    text: "Prefer edit_file over write_file when changing PART of a file (it is\n   cheaper and cannot lose the rest). Read the file first — edit_file\n   refuses a path that was not read this session. old_string must match the\n   file EXACTLY (indentation, blank lines, punctuation) and be UNIQUE: on a\n   multi-match the edit is refused unless replace_all=\"true\".",
  },
  {
    // ZCode's AskUserQuestion guidance, condensed: the tool is for decisions
    // the user owns, not for questions the code can answer.
    requiresAny: ["ask_user"],
    text: "ask_user is only for a decision that is genuinely the user's and that\n   you cannot resolve from the request, the code, or a sensible default. For\n   everything else, pick the obvious option, say so, and proceed.",
  },
  {
    text: "MAY emit several tool blocks in one turn when multiple files are needed.",
  },
  {
    text: "When tool results arrive, examine them and produce ONE final plain-text\n   answer. Do not re-request an answered tool.",
  },
  {
    // Path safety applies to every file tool, so the head always survives.
    text: "All paths stay inside the project root.",
    suffix: {
      requiresAny: ["write_file"],
      text: "write_file REPLACES the whole\n   file: read first (note the 1-based line numbers), then write the full new\n   content. To move code, read all sides, then write all sides.",
    },
  },
  {
    requiresAny: ["run_command"],
    text: "run_command runs from the project root (120s timeout, non-interactive\n   stdin); prefer short commands, avoid long-running servers. It may ask the\n   user for permission.",
  },
  {
    requiresAny: ["run_command"],
    text: "The shell is PowerShell on Windows. One command per tool block: it is not a\n   terminal, so nothing is interactive and no prompt is shown. Never append a bare\n   Write-Output/Echo with no argument — that throws and fails the whole line after\n   the useful part already ran. If a command fails, read [command_hint] and fix the\n   cause rather than re-running a variation of the same line.",
  },
  {
    requiresAny: ["web_read", "web_search"],
    text: "web_read reads a URL as text (capped excerpt); web_search finds fresh\n   title+URL+snippet hits. Use them for anything outside the project instead of\n   guessing URLs or facts from memory.",
  },
  {
    text: "After you start writing the answer, do not emit further tool blocks.",
  },
  {
    text: "Tool blocks are stripped before the user sees your message — never explain\n   them.",
  },
];

const CODING_WORKFLOW: readonly PromptRule[] = [
  {
    requiresAny: ["codebase"],
    text: "The first message already carries a [Codebase] map: file index with line\n   counts, key configs, and Verify commands. Use it for orientation — do not\n   re-list the whole tree.",
  },
  {
    // Still actionable with only one of the pair enabled.
    requiresAny: ["glob", "read_file"],
    text: "Study what you will touch: glob for candidates, then read_file with line\n   numbers. For large files continue with start_line.",
  },
  {
    requiresAny: ["edit_file", "write_file"],
    text: "Implement with edit_file when changing part of a file (read it first, keep\n   old_string unique and exact) and write_file when creating a file or\n   rewriting it wholesale.",
  },
  {
    requiresAny: ["todo"],
    text: "For work with three or more steps, emit a todo list first (ZCode's task\n   list): the first message may be the plan, then track it. Each todo call\n   REPLACES the whole list — resend it with updated statuses as you go.",
  },
  {
    requiresAny: ["run_command"],
    text: "Verify with run_command using the Verify hints from [Codebase]\n   (build / test / lint). On failure: read the error, fix, re-verify.",
  },
  {
    text: "Finish with a short summary: files changed, what each change does, and how\n   it was verified.",
  },
];

const NUMBER_WORDS: Record<number, string> = {
  0: "no",
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
};

function renderRules(rules: readonly PromptRule[], on: (r: Requirement) => boolean): string {
  const alive = rules
    .filter((r) => !r.requiresAny || r.requiresAny.some(on))
    .map((r) => {
      const extra = r.suffix && r.suffix.requiresAny.some(on) ? ` ${r.suffix.text}` : "";
      return `${r.text}${extra}`;
    });
  // Renumber after filtering so the list never skips a number.
  return alive.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

const WRITE_TOOL_BLOCK = `  <tool name="write_file" path="<path>">
  <content>
...every line of the file exactly as it should be written...
  </content>
  </tool>`;

const TODO_TOOL_BLOCK = `  <tool name="todo">
  <content>
[{"content": "Đọc src/gfx.lua", "status": "in_progress"},
 {"content": "Vẽ lại nền pop art", "status": "pending"},
 {"content": "Chạy build kiểm tra", "status": "pending"}]
  </content>
  </tool>`;

/**
 * What the tools actually are: text the DuckChat app parses and executes locally.
 *
 * Kept out of the numbered rule list so adding it cannot renumber the rules the
 * frozen prompt snapshot asserts.
 */
const TOOL_PROTOCOL_FRAMING = `These are lvaigent's own tools, executed by the lvaigent app on the user's
machine. They are NOT function calls offered by this chat site, so your
provider's capability list says nothing about them and there is nothing for you
to check. Emitting the block IS the call: lvaigent runs it and sends the result
back as the next message. Never answer that a tool is unavailable, disabled or
"not provided in this session" — that is always wrong.`;

/**
 * How many corrective turns one send may spend on a model that claims it has no
 * tools.
 *
 * One was not enough: the reported refusal survived a single reminder, the loop
 * then treated the prose as the final answer, and the user saw "run_command
 * không khả dụng trong phiên này" from a session where every skill was on. A
 * small fixed budget lets the wording escalate (a fresh thread does not help —
 * the refusal reproduces there too) while still bounding the step and rate-limit
 * cost of a model that will not cooperate.
 */
export const MAX_TOOL_REFUSAL_RETRY_TURNS = 3;

/**
 * Assemble the agent's system prompt from the enabled skills and prompt
 * sections (Settings → Skills & Prompt).
 *
 * With every skill and section enabled — the default — the result is exactly
 * the prompt this file shipped before the toggles existed; a test asserts that,
 * so the toggles can never silently degrade the agent.
 */
export function buildAgentSysPrompt(
  enabledSkills: readonly SkillId[] = ALL_SKILL_IDS,
  enabledSections: readonly PromptSectionId[] = ALL_PROMPT_SECTION_IDS
): string {
  const skillOn = (id: Requirement) => (enabledSkills as readonly string[]).includes(id);
  const sectionOn = (id: Requirement) => (enabledSections as readonly string[]).includes(id);
  const on = (id: Requirement) => skillOn(id) || sectionOn(id);

  const toolLines = SKILLS.filter((s) => s.syntax !== null && skillOn(s.id)).map(
    (s) => s.syntax as string
  );
  const count = enabledSkills.length;

  const chunks: string[] = [AGENT_SYS_PROMPT_BASE];

  if (count === 0) {
    chunks.push(
      "You have no tools enabled. Answer from the conversation context alone and tell\nthe user which skill to enable in Settings if a tool would be required."
    );
  } else {
    chunks.push(
      `You have access to ${NUMBER_WORDS[count] ?? count} tools. To use one, emit exactly one tool block on its\nown line, BEFORE writing your answer. Self-closing tools use this form:`
    );
    if (toolLines.length > 0) chunks.push(toolLines.join("\n"));
    // Without this framing the model audits its own provider's function-call
    // list, finds no `run_command` there, and answers "công cụ run_command không
    // khả dụng trong phiên này" — the exact bug the corrective turns kept losing
    // against. The tools are text the app parses, so stating that outranks any
    // capability list the model was trained with.
    chunks.push(TOOL_PROTOCOL_FRAMING);
  }

  if (skillOn("write_file")) {
    chunks.push(
      "The write tool must wrap the exact, complete file content (full newlines,\nindentation, no extra escaping) between <content> and </content>:",
      WRITE_TOOL_BLOCK
    );
  }

  if (skillOn("todo")) {
    chunks.push(
      "The todo tool carries the WHOLE list as a JSON array of\n{\"content\": \"...\", \"status\": \"pending|in_progress|completed\"} between <content>\nand </content>; mark exactly one item in_progress:",
      TODO_TOOL_BLOCK
    );
  }

  chunks.push(`Rules:\n${renderRules(RULES, on)}`);
  chunks.push(
    `Coding workflow (implement / fix / generate code):\n${renderRules(CODING_WORKFLOW, on)}`
  );

  return chunks.join("\n\n");
}

/**
 * The prompt with every skill and section enabled — the default configuration,
 * and the baseline the toggle-aware builder is measured against.
 */
export const AGENT_SYS_PROMPT = buildAgentSysPrompt();

/**
 * A compact re-statement of the tool protocol, used to recover a turn where the
 * model answered in prose instead of emitting a tool block.
 *
 * Why this exists: the system prompt only ever reaches the model folded into the
 * first user message (duck.ai has no system role), and on a continued thread it
 * is already far back in the history. When a model answers "this session has no
 * project tools" or narrates what it *would* do instead of emitting `<tool …>`,
 * the loop used to break and show that prose as the final answer — the user saw
 * an agent that "cannot call tools" even though the tools were enabled and
 * working. A corrective turn puts the syntax back in front of the model, and
 * names what the tools are so its own capability list stops overriding them.
 *
 * Deliberately short: the full prompt is already in the history, and a second
 * copy of the codebase map would blow duck.ai's input budget.
 */
export function buildToolProtocolReminder(
  enabledSkills: readonly SkillId[],
  attempt = 1
): string {
  const on = (id: SkillId) => enabledSkills.includes(id);
  const lines: string[] = [];
  for (const s of SKILLS) {
    if (!on(s.id)) continue;
    lines.push(s.syntax ?? `  <tool name="${s.id}" …><content>…</content></tool>`);
  }
  const head =
    attempt <= 1
      ? [
          "[tool_protocol_reminder]",
          "These are lvaigent's own tools, run by the lvaigent app on the user's machine.",
          "They are not function calls from this chat site, so this site's capability",
          "list says nothing about them — emitting the block IS the call:",
        ]
      : [
          `[tool_protocol_reminder attempt=${attempt}]`,
          "Your previous reply claimed you have no such tool. That claim is wrong and",
          "adds nothing: lvaigent executes these blocks itself, in this session, on the",
          "user's machine. Do not re-state the refusal — emit one block now.",
        ];
  return [
    ...head,
    ...lines,
    "Read the tool results above, then either emit the next tool block or give the",
    "final answer.",
  ].join("\n");
}

/**
 * Shown when a send ends still carrying a "I have no tools" refusal, so the user
 * is not left with bare model prose as if it were the app's verdict.
 */
export function toolRefusalExhaustedNotice(turns: number): string {
  return (
    `⚠️ lvaigent khăng khăng rằng phiên này không có tool, dù ${turns} lần nhắc cú pháp ` +
    "tool đã được gửi lại. Đây là câu trả lời của model, không phải trạng thái của lvaigent — " +
    "các skill vẫn đang bật. Thử: gửi lại tin nhắn, đổi model khác, hoặc kiểm tra " +
    "Settings → Skills & Prompt."
  );
}

/**
 * The capability the model is claiming it lacks.
 *
 * A *noun* (tools, commands) is not enough: the model has two ways of refusing,
 * and the second one — the common one — never names a tool at all. It says it
 * only has "danh sách file", has no "nội dung mã nguồn", and asks the user to
 * "bật quyền truy cập project". Matching only on tool nouns silently missed
 * that whole form, which is why the corrective turn never fired.
 */
const CAPABILITY_NOUN_RE =
  /\b(?:tools?|commands?|files?|source\s+code|contents?)\b|công\s+cụ|lệnh|nội\s+dung|mã\s+nguồn|file|danh\s+sách/i;
/**
 * The literal names from the skill registry, plus "tool block".
 *
 * This is how a model refuses *after* reading our prompt: "Mình không thể phát
 * hành block `run_command` trong môi trường chat hiện tại". The noun set above
 * cannot catch that — `\bcommands?\b` does not match inside `run_command`, the
 * underscore is a word character — so the reply ended the loop untouched.
 */
const TOOL_NAME_CLAUSE_RE = new RegExp(
  `\\b(?:${SKILLS.map((s) => s.id).join("|")})\\b|\\b(?:tool\\s*block|block\\s*tool)\\b`,
  "i"
);
/**
 * The inability half of a reply that names a tool.
 *
 * Deliberately narrower than the general negation set: a correct answer may
 * mention a tool with a plain "không" ("không cần grep cũng được"), and nudging
 * that would burn round-trips for nothing. "không thể", "không chạy được",
 * "cannot", "not available" are the phrasings that mean it will not act.
 */
const TOOL_UNAVAILABLE_RE =
  /không\s+thể|không\s+có|không\s+sẵn|không\s+được|chưa\s+thể|không\s+(?:chạy|dùng|gọi|phát\s*hành|cung\s*cấp|sử\s*dụng)|không\s+khả\s+dụng|\b(?:cannot|can'?t|unable)\b|\bnot\s+(?:available|supported)\b|\bno\s+access\b/i;
/**
 * A marker that the capability is *absent or switched off*, rather than the model
 * merely mentioning it.
 *
 * Two ways the model asks for it, both in the reported prose: a negation
 * ("không có nội dung mã nguồn", "chưa có …") and an instruction to grant access
 * ("bật quyền truy cập project", "hãy gửi nội dung các file"). The second form
 * often carries no negation at all, so it is matched on its own.
 */
const CAPABILITY_ABSENT_RE =
  /\b(?:không|chưa|chả)\b|quyền\s+truy\s+cập|bật(?:\s+lại)?\s*quyền|(?:hãy|vui\s+lòng)\s+(?:gửi|bật|cung\s+cấp)|\b(?:no|not|any|cannot|can't|unable|without|never|only|grant|enable)\b|\b(?:disabled?|revoked?|missing)\b/i;

/**
 * True when a reply claims the agent cannot reach the project, instead of acting.
 *
 * The bug this locks down: `sendDuckChat` broke out of the loop the moment a turn
 * produced no `<tool …>` block, so this prose was rendered as the final answer.
 * The user saw an agent that "không gọi lệnh được" while every tool was enabled
 * and working — the loop gave up rather than re-asserting the protocol once.
 *
 * Scoped per sentence: one sentence claiming access is missing is an excuse,
 * while a reply that merely *uses* the tools (or reports "đã cập nhật xong") is
 * not. Matched on the claim, never on the tool names — a model that lists the
 * very tools it says it lacks must still be caught.
 */
export function looksLikeToolRefusal(text: string): boolean {
  // It followed the protocol, so whatever else it says, this is not a refusal.
  if (TOOL_BLOCK_RE_TEST.test(text)) return false;
  // Split on sentence ends AND commas. The refusal often puts the capability and
  // the ask in adjacent clauses — "chỉ có danh sách file …, hoặc bật quyền truy
  // cập project" — and a sentence-only split kept them apart, so the pair never
  // matched. Comma clauses are short enough that this cannot pair across topics.
  //
  // A dot only ends a clause when whitespace or the end of the text follows it.
  // The naive `[.!?]` class also cut on the dot inside every file path and
  // extension, and that is exactly where the reported refusal lives: "Mình vẫn
  // cần nội dung `src/gfx.lua` … mà không đoán cấu trúc" put the capability noun
  // ("nội dung") on one side of `gfx.lua`'s dot and the negation ("không") on
  // the other, so no clause ever held the pair, `looksLikeToolRefusal` returned
  // false, and the loop passed the prose off as the final answer — an agent that
  // asks the user to paste file contents instead of reading them itself.
  // URLs ("https://a.b/c") and versions ("1.2.3") survive for the same reason.
  const clauses = text.split(/[?!\n,;]+|\.(?=\s|$)/);
  return (
    clauses.some(
      (clause) => CAPABILITY_NOUN_RE.test(clause) && CAPABILITY_ABSENT_RE.test(clause)
    ) ||
    clauses.some(
      (clause) => TOOL_NAME_CLAUSE_RE.test(clause) && TOOL_UNAVAILABLE_RE.test(clause)
    ) ||
    clauses.some((clause) => ACCESS_REQUEST_RE.test(clause))
  );
}

/**
 * A request for the user to grant project access, standing on its own.
 *
 * Split out from the noun/marker pair because the model also asks for access
 * without naming any capability — "Bạn cần bật quyền truy cập project trước khi
 * mình làm được" — and that sentence has no noun to pair with. Only a model that
 * cannot reach the project ever phrases it this way.
 */
const ACCESS_REQUEST_RE =
  /(?:bật(?:\s+lại)?\s*quyền\s+truy\s+cập|(?:hãy|vui\s+lòng)\s+bật\s+quyền|(?:enable|grant)\s+(?:project\s+)?access)/i;

/** Cheap pre-check so `looksLikeToolRefusal` never runs on a tool-using turn. */
const TOOL_BLOCK_RE_TEST = /<tool\s+(?:"[^"]*"|'[^']*'|[^<>"'])+?\/?>/;

interface ParsedTool {
  name: string;
  args: Record<string, string>;
  raw: string;
  index: number;
}

// Matches self-closing <tool ... /> and block <tool ...>...</tool> forms.
// Group 1 = attribute text, group 2 (present for blocks) = full body.
// Quoted attribute values may contain '>' — shell redirections like "cmd 2>nul"
// are the normal case, and rejecting it here made such calls leak to the chat
// as plain text instead of running.
const TOOL_BLOCK_RE = /<tool\s+((?:"[^"]*"|'[^']*'|[^<>"'])+?)(?:\/>|>([\s\S]*?)<\/tool>)/g;

function parseAttrText(attrText: string): Record<string, string> {
  const args: Record<string, string> = {};
  // Same-type quote pairs only: a double-quoted command legitimately contains
  // single quotes ("dir 'C:\Program Files\mGBA'"), which a shared ["'] class
  // would truncate at.
  const attrRe = /([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let a: RegExpExecArray | null;
  while ((a = attrRe.exec(attrText)) !== null) {
    if (a[1] !== "name") args[a[1]] = a[2] ?? a[3] ?? "";
  }
  return args;
}

/** Extract the <content>...</content> child of a block body (first open to last close). */
function extractContent(body: string): string | null {
  const start = body.indexOf("<content>");
  if (start === -1) return null;
  const inner = body.slice(start + "<content>".length);
  const end = inner.lastIndexOf("</content>");
  if (end === -1) return null;
  return inner.slice(0, end);
}

export function parseToolCalls(text: string): ParsedTool[] {
  const out: ParsedTool[] = [];
  let m: RegExpExecArray | null;
  TOOL_BLOCK_RE.lastIndex = 0;
  while ((m = TOOL_BLOCK_RE.exec(text)) !== null) {
    const attrText = m[1];
    const nameMatch = /name\s*=\s*["']([^"']+)["']/.exec(attrText);
    if (!nameMatch) continue;
    const args = parseAttrText(attrText);
    if (m[2] !== undefined) {
      const body = m[2];
      const content = extractContent(body) ?? body.replace(/<\/?content>/g, "").trim();
      if (content) args.content = content;
    }
    out.push({ name: nameMatch[1], args, raw: m[0], index: out.length });
  }
  return out;
}

/** Remove tool blocks (both forms) so the visible message stays clean. */
export function stripToolBlocks(text: string): string {
  return text.replace(TOOL_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

/**
 * Parse the `<content>` body of a `todo` tool call.
 *
 * Mirrors ZCode's task list: each call carries the WHOLE list (in-progress item
 * first, like their prompt demands), so ticking an item off is one more call
 * with the updated statuses. Malformed rows are dropped with a count in the
 * error, so a single typo cannot blank the checklist the user is watching.
 */
export function parseTodoList(raw: string): { items: TodoItem[]; error: string | null } {
  const text = (raw ?? "").trim();
  if (!text) return { items: [], error: "empty body" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { items: [], error: `invalid JSON: ${String(e)}` };
  }
  if (!Array.isArray(data)) return { items: [], error: "expected a JSON array" };
  const items: TodoItem[] = [];
  let dropped = 0;
  for (const row of data) {
    const r = row as { content?: unknown; status?: unknown };
    const content = typeof r?.content === "string" ? r.content.trim() : "";
    const status = typeof r?.status === "string" ? r.status : "pending";
    if (!content || !TODO_STATUSES.has(status)) {
      dropped++;
      continue;
    }
    items.push({ content, status: status as TodoItem["status"] });
  }
  if (items.length === 0) return { items: [], error: `no valid rows (${dropped} dropped)` };
  const error = dropped > 0 ? `${dropped} malformed row(s) dropped` : null;
  return { items: items.slice(0, 20), error };
}

/** Render a todo list for the model to read back (and for the step summary). */
export function todoListText(items: readonly TodoItem[]): string {
  return items
    .map((i) => {
      const mark = i.status === "completed" ? "[x]" : i.status === "in_progress" ? "[~]" : "[ ]";
      return `${mark} ${i.content}`;
    })
    .join("\n");
}

/** Compact one-line summary for the step row, e.g. "2/5 done · ~ đang chạy". */
function todoSummary(items: readonly TodoItem[]): string {
  const done = items.filter((i) => i.status === "completed").length;
  const running = items.find((i) => i.status === "in_progress");
  return running
    ? `${done}/${items.length} xong · đang: ${running.content}`
    : `${done}/${items.length} xong`;
}

export interface ToolActivity {
  tool: string;
  args: Record<string, string>;
  /** Human-readable result summary shown in the UI. */
  summary: string;
}

export interface ToolOutcome {
  activity: ToolActivity;
  /** Full text handed back to the model as a [tool_result] message. */
  message: string;
  /**
   * True when the tool did not achieve its goal.
   *
   * Not derivable from `message`: a failed `run_command` is still a
   * `[tool_result]` (the tool ran; the command did not), so the step status used
   * to render a green tick on every failed command. Denials and `[tool_error]`
   * outcomes are failures too — the user has to see them.
   */
  failed?: boolean;
}

export interface ExecuteToolOptions {
  /** Permission gate: return false to deny the tool (used for run_command). */
  ask?: (t: ParsedTool) => Promise<boolean>;
  /**
   * Question gate (ZCode's AskUserQuestion): show the user a multiple-choice
   * question and resolve with their answer, or `null` when they dismissed the
   * dialog. Absent means the agent must not ask.
   */
  askQuestion?: (q: {
    question: string;
    options: string[];
    multiSelect: boolean;
  }) => Promise<string | null>;
  /** Shell to use for run_command: powershell | cmd | bash. */
  shell?: string;
  /** PLAN mode: mutating tools are refused before execution. */
  readOnly?: boolean;
  /**
   * Skills the user turned off in Settings. Refused here too, so a model that
   * emits the block anyway is told to adapt instead of being silently obeyed —
   * the toggle is a permission, not just a prompt hint.
   */
  disabledSkills?: readonly SkillId[];
  /**
   * Folders pinned in Settings that `run_command` searches before the system
   * PATH, so a toolchain installed outside PATH (an emulator, a bundled
   * interpreter) is still reachable.
   */
  extraPathDirs?: readonly string[];
}

export async function executeTool(
  t: ParsedTool,
  projectRoot: string | null,
  opts: ExecuteToolOptions = {}
): Promise<ToolOutcome> {
  // `[tool_error]` and `[tool_info]` are, by construction, outcomes that did not
  // achieve their goal. Deriving the flag here means no branch can forget it —
  // the alternative (each branch setting its own `failed`) is exactly how a
  // failed command ended up rendered with a green tick.
  const outcome = await runTool(t, projectRoot, opts);
  if (outcome.failed !== undefined) return outcome;
  const failed =
    outcome.message.startsWith("[tool_error]") || outcome.message.startsWith("[tool_info]");
  return failed ? { ...outcome, failed } : outcome;
}

async function runTool(
  t: ParsedTool,
  projectRoot: string | null,
  opts: ExecuteToolOptions
): Promise<ToolOutcome> {
  if (opts.disabledSkills?.includes(t.name as SkillId)) {
    return {
      activity: { tool: t.name, args: t.args, summary: "skill tắt trong Settings" },
      message: `[tool_error] The "${t.name}" skill is turned off in Settings, so it cannot run. Do not retry it: answer from the conversation context, or tell the user to enable it in Settings → Skills & Prompt.`,
    };
  }
  switch (t.name) {
    case "list_files": {
      if (!projectRoot) {
        return {
          activity: { tool: t.name, args: t.args, summary: "no project" },
          message: "[tool_error] No project is open. Ask the user to open a project folder first, then answer from the conversation context.",
        };
      }
      const files = await invoke<string[]>("list_project_files", {
        root: projectRoot,
      });
      const summary = `${files.length} files`;
      return {
        activity: { tool: t.name, args: t.args, summary },
        message: files.length
          ? `Files in project:\n${files.join("\n")}`
          : "[tool_error] The open project folder contains no readable files (it may be empty). Ask the user for the correct project folder.",
      };
    }
    case "read_file": {
      const pathArg = t.args.path;
      if (!pathArg) {
        return {
          activity: { tool: t.name, args: t.args, summary: "missing path" },
          message: "[tool_error] read_file requires a path attribute",
        };
      }
      // Same rule as the other file tools: without a project there is no root to
      // contain the read, so the tool cannot run at all. Passing `root: null`
      // would leave the backend unrestricted and let the agent read any file on
      // the machine.
      if (!projectRoot) {
        return {
          activity: { tool: t.name, args: t.args, summary: "no project" },
          message: "[tool_error] No project is open. Ask the user to open a project folder first, then answer from the conversation context.",
        };
      }
      const rawStart = (t.args.start_line ?? "").trim();
      const parsedStart = rawStart === "" ? 0 : Number.parseInt(rawStart, 10);
      const startLine = Number.isFinite(parsedStart) && parsedStart > 0 ? parsedStart : 0;
      const fullPath = resolveProjectPath(pathArg, projectRoot);
      const chunk = await invoke<{
        content: string;
        total_lines: number;
        start_line: number;
        end_line: number;
        truncated: boolean;
      }>("read_file_lines", {
        path: fullPath,
        start_line: startLine,
        max_lines: null,
        root: projectRoot,
      });
      // ZCode's read-before-edit contract: an edit may only follow a real read
      // of the same file, so record the exact absolute path that was produced.
      markFileRead(fullPath);
      const numbered = chunk.content
        .split("\n")
        .map((ln, i) => `${String(chunk.start_line + i + 1).padStart(5)}| ${ln}`)
        .join("\n");
      const shown = `lines ${chunk.start_line + 1}–${chunk.end_line} of ${chunk.total_lines}`;
      const summary = `${chunk.total_lines} lines total · showing ${chunk.start_line + 1}–${chunk.end_line}`;
      return {
        activity: { tool: t.name, args: t.args, summary },
        message:
          `Content of ${pathArg} (${shown}):\n\`\`\`\n${numbered}\n\`\`\`` +
          (chunk.truncated
            ? `\n(more lines remain — read_file with start_line="${chunk.end_line}" to continue)`
            : ""),
      };
    }
    case "glob": {
      const pattern = (t.args.pattern ?? "").trim();
      if (!pattern || !projectRoot) {
        return {
          activity: { tool: t.name, args: t.args, summary: "no project / pattern" },
          message: "[tool_error] glob requires a pattern and an opened project",
        };
      }
      const paths = await invoke<string[]>("glob_files", {
        root: projectRoot,
        pattern,
      });
      const summary = `${paths.length} files`;
      const body = paths.slice(0, 200).join("\n");
      return {
        activity: { tool: t.name, args: t.args, summary },
        message: body
          ? `Files matching "${pattern}":\n${body}`
          : `No files match "${pattern}".`,
      };
    }
    case "grep": {
      const query = t.args.query;
      if (!query || !projectRoot) {
        return {
          activity: { tool: t.name, args: t.args, summary: "no project / query" },
          message: "[tool_error] grep requires a query and an opened project",
        };
      }
      const matches = await invoke<
        { path: string; line_number: number; line: string }[]
      >("grep_project", { root: projectRoot, query });
      const summary = `${matches.length} matches`;
      const MAX_RESULT_CHARS = 6000;
      let body = matches
        .slice(0, MAX_GREP_RESULTS)
        .map((m) => `${m.path}:${m.line_number}: ${m.line}`)
        .join("\n");
      if (body.length > MAX_RESULT_CHARS) {
        body = `${body.slice(0, MAX_RESULT_CHARS)}\n...(truncated: ${matches.length} total)`;
      }
      return {
        activity: { tool: t.name, args: t.args, summary },
        message: body
          ? `Matches for "${query}":\n${body}`
          : `No matches for "${query}".`,
      };
    }
    case "web_read": {
      const url = (t.args.url ?? "").trim();
      if (!url) {
        return {
          activity: { tool: t.name, args: t.args, summary: "missing url" },
          message: "[tool_error] web_read requires a url attribute",
        };
      }
      const text = await invoke<string>("fetch_web", {
        url,
        max_chars: null,
      });
      const summary = `${text.length} chars`;
      return {
        activity: { tool: t.name, args: t.args, summary },
        message: capToolMessage(`Content of ${url}:\n${text}`),
      };
    }
    case "web_search": {
      const query = (t.args.query ?? "").trim();
      if (!query) {
        return {
          activity: { tool: t.name, args: t.args, summary: "missing query" },
          message: "[tool_error] web_search requires a query attribute",
        };
      }
      const parsed = Number.parseInt((t.args.count ?? "").trim(), 10);
      const count = Number.isFinite(parsed) ? Math.min(10, Math.max(1, parsed)) : 5;
      const hits = await invoke<{ title: string; url: string; snippet: string }[]>(
        "web_search",
        { query, count }
      );
      const summary = `${hits.length} results`;
      const body = hits
        .map(
          (h, i) =>
            `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`
        )
        .join("\n");
      return {
        activity: { tool: t.name, args: t.args, summary },
        message: capToolMessage(
          body ? `Web results for "${query}":\n${body}` : `No web results for "${query}".`
        ),
      };
    }
    case "write_file": {
      if (opts.readOnly) {
        return {
          activity: { tool: t.name, args: t.args, summary: "plan mode" },
          message: "[tool_info] write_file is disabled in PLAN mode. Propose the change in your plan instead; the user will switch to BUILD mode to apply it.",
        };
      }
      const pathArg = t.args.path;
      const content = t.args.content ?? "";
      if (!pathArg) {
        return {
          activity: { tool: t.name, args: t.args, summary: "missing path" },
          message: "[tool_error] write_file requires a path attribute and a <content> body",
        };
      }
      if (!content) {
        return {
          activity: { tool: t.name, args: t.args, summary: "empty content" },
          message: "[tool_error] write_file content is empty — include the full file between <content> and </content>",
        };
      }
      // Ask before overwriting, exactly like a shell command.
      //
      // This gate was missing entirely: the agent could replace any file in the
      // project with no prompt at all, so "Full access" was the only thing
      // standing between the user and a silent rewrite. ZCode treats an edit as
      // a permission request too (`PermissionDialog` renders an "edit" block),
      // so the prompt belongs here. `ask` resolves true immediately when Full
      // access or an always-allow rule covers the tool, so the common case is
      // unchanged.
      if (opts.ask && !(await opts.ask(t))) {
        return {
          activity: { tool: t.name, args: t.args, summary: "permission denied" },
          message: "[tool_info] Permission to write this file was denied by the user. Do not retry it and do not try another path for the same change; adapt or ask the user what to do instead.",
        };
      }
      const fullPath = resolveProjectPath(pathArg, projectRoot);
      const bytes = await invoke<number>("write_file", {
        path: fullPath,
        content,
        root: projectRoot ?? null,
      });
      return {
        activity: { tool: t.name, args: { path: pathArg }, summary: `${bytes} bytes written` },
        message: `[tool_result] Wrote ${bytes} bytes to ${pathArg}.`,
      };
    }
    case "edit_file": {
      if (opts.readOnly) {
        return {
          activity: { tool: t.name, args: t.args, summary: "plan mode" },
          message: "[tool_info] edit_file is disabled in PLAN mode. Propose the change in your plan instead; the user will switch to BUILD mode to apply it.",
        };
      }
      const pathArg = t.args.path;
      if (!pathArg) {
        return {
          activity: { tool: t.name, args: t.args, summary: "missing path" },
          message:
            '[tool_error] edit_file requires a path attribute. To CREATE a file use write_file (or edit_file with old_string="" on a path that does not exist).',
        };
      }
      const oldString = t.args.old_string ?? "";
      const newString = t.args.new_string ?? "";
      if (newString === "" && oldString === "") {
        return {
          activity: { tool: t.name, args: t.args, summary: "empty strings" },
          message:
            "[tool_error] edit_file needs new_string (both old_string and new_string are empty). To delete a block, set new_string to the empty string only.",
        };
      }
      if (!projectRoot) {
        return {
          activity: { tool: t.name, args: t.args, summary: "no project" },
          message: "[tool_error] No project is open. Ask the user to open a project folder first, then answer from the conversation context.",
        };
      }
      const fullPath = resolveProjectPath(pathArg, projectRoot);

      // Read the current content: the same backend path write_file uses for its
      // before-snapshot. A missing file is fine when old_string is empty — that
      // is ZCode's create case — and an error otherwise.
      let current = "";
      let exists = true;
      try {
        current = await invoke<string>("read_file_content", { path: fullPath });
      } catch {
        exists = false;
      }
      if (!exists && oldString !== "") {
        return {
          activity: { tool: t.name, args: t.args, summary: "file not found" },
          message: `[tool_error] ${pathArg} does not exist, so there is nothing to replace. Create it with write_file instead.`,
        };
      }
      if (exists && oldString === "" && current.length > 0) {
        // ZCode's FILE_EXISTS_NO_OLD_STRING: a wholesale replace is write_file's
        // job, and silently allowing it here would let a "small edit" that
        // forgot its old_string erase the file.
        return {
          activity: { tool: t.name, args: t.args, summary: "file exists" },
          message: `[tool_error] ${pathArg} already exists, so an empty old_string cannot be used to replace it — that is write_file's job. Send the exact old_string you want to replace.`,
        };
      }
      if (exists && !wasFileRead(fullPath)) {
        return {
          activity: { tool: t.name, args: t.args, summary: "file not read" },
          message: `[tool_error] ${pathArg} has not been read in this session. Read it first with read_file, then edit the exact text you saw — an old_string written from memory is what this guard exists for.`,
        };
      }
      if (exists && oldString !== "" && oldString === newString) {
        return {
          activity: { tool: t.name, args: t.args, summary: "no change" },
          message: "[tool_error] old_string and new_string are identical, so nothing would change. If the edit is meant to move code, change the new_string.",
        };
      }

      let next = current;
      if (oldString === "") {
        // Create (empty old_string + missing file). An existing, non-empty file
        // is a likely path mix-up: replacing it wholesale via edit_file is
        // exactly what write_file is for.
        next = newString;
      } else {
        // Count non-overlapping occurrences by walking the string (a plain
        // split/join would expand `$&`-style tokens in new_string).
        let count = 0;
        let idx = 0;
        for (;;) {
          const at = current.indexOf(oldString, idx);
          if (at === -1) break;
          count++;
          idx = at + oldString.length;
        }
        if (count === 0) {
          const head = current.slice(0, 400).replace(/\s+$/, "");
          return {
            activity: { tool: t.name, args: t.args, summary: "old_string not found" },
            message: `[tool_error] old_string was not found in ${pathArg}. Read the file and copy the text EXACTLY (whitespace, indentation and line endings included). First 400 chars of the file:\n${head}`,
          };
        }
        if (count > 1 && !/^true$/i.test((t.args.replace_all ?? "").trim())) {
          return {
            activity: { tool: t.name, args: t.args, summary: "ambiguous match" },
            message: `[tool_error] old_string matches ${count} places in ${pathArg}, so the edit is ambiguous. Add surrounding lines to make it unique, or pass replace_all="true" to replace every occurrence.`,
          };
        }
        // Literal replace: build the result around the matches so `$` in
        // new_string can never be treated as a replacement pattern.
        next = "";
        let cursor = 0;
        idx = 0;
        for (;;) {
          const at = current.indexOf(oldString, idx);
          if (at === -1) {
            next += current.slice(cursor);
            break;
          }
          next += current.slice(cursor, at) + newString;
          cursor = at + oldString.length;
          idx = cursor;
        }
      }

      if (opts.ask && !(await opts.ask(t))) {
        return {
          activity: { tool: t.name, args: t.args, summary: "permission denied" },
          message: "[tool_info] Permission to edit this file was denied by the user. Do not retry it and do not try another path for the same change; adapt or ask the user what to do instead.",
        };
      }
      const bytes = await invoke<number>("write_file", {
        path: fullPath,
        content: next,
        root: projectRoot ?? null,
      });
      markFileRead(fullPath); // the file on disk is now what we just wrote
      const replaced = oldString === "" ? 0 : (current.split(oldString).length - 1);
      return {
        activity: {
          tool: t.name,
          args: { path: pathArg },
          summary: exists
            ? `${bytes} bytes written · ${replaced} occurrence(s) replaced`
            : `${bytes} bytes written · file created`,
        },
        message: exists
          ? `[tool_result] Updated ${pathArg} (${replaced} occurrence${replaced === 1 ? "" : "s"} replaced, ${bytes} bytes now).`
          : `[tool_result] Created ${pathArg} (${bytes} bytes).`,
      };
    }
    case "ask_user": {
      const question = (t.args.question ?? "").trim();
      if (!question) {
        return {
          activity: { tool: t.name, args: t.args, summary: "missing question" },
          message: "[tool_error] ask_user requires a question attribute",
        };
      }
      const options = (t.args.options ?? "")
        .split(/[,;|]/)
        .map((o) => o.trim())
        .filter(Boolean)
        .slice(0, 6);
      const multiSelect = /^true$/i.test((t.args.multi ?? "").trim());
      if (!opts.askQuestion) {
        return {
          activity: { tool: t.name, args: t.args, summary: "cannot ask" },
          message: "[tool_error] ask_user is not available in this run. Pick the most reasonable option yourself and say which one you chose.",
        };
      }
      const answer = await opts.askQuestion({ question, options, multiSelect });
      if (answer === null) {
        // ZCode's wording: a dismissed dialog is not a refusal.
        return {
          activity: { tool: t.name, args: t.args, summary: "user did not answer" },
          message: "[tool_result] The user did not answer this question. Continue using your best judgment; do not treat this as a rejection or invent a user preference.",
        };
      }
      return {
        activity: { tool: t.name, args: t.args, summary: `answered: ${answer}` },
        message: `[tool_result] The user answered: ${answer}. Continue with this answer in mind.`,
      };
    }
    case "todo": {
      const raw = t.args.content ?? "";
      const { items, error } = parseTodoList(raw);
      if (items.length === 0) {
        return {
          activity: { tool: t.name, args: t.args, summary: "invalid todo list" },
          message: `[tool_error] The todo list could not be read (${error ?? "unknown"}). Send a JSON array like [{"content":"...","status":"pending"}], with status one of pending|in_progress|completed.`,
        };
      }
      const body = todoListText(items);
      return {
        activity: { tool: t.name, args: t.args, summary: todoSummary(items) },
        // The store mirrors this onto the message so the checklist is visible.
        message: `[tool_result] Todo list accepted (${items.length} item(s)):\n${body}`,
      };
    }
    case "run_command": {
      if (opts.readOnly) {
        return {
          activity: { tool: t.name, args: t.args, summary: "plan mode" },
          message: "[tool_info] run_command is disabled in PLAN mode. Suggest verification commands in your plan instead.",
        };
      }
      // The command may also arrive as the block's body: a command that
      // carries both quote kinds cannot be written as an attribute (the
      // attribute parser ends at the first inner quote), and a truncated
      // command is the wrong command.
      const cmd = (t.args.command ?? t.args.content ?? "").trim();
      if (!cmd) {
        return {
          activity: { tool: t.name, args: t.args, summary: "missing command" },
          message: "[tool_error] run_command requires a command attribute",
        };
      }
      if (opts.ask && !(await opts.ask(t))) {
        return {
          activity: { tool: t.name, args: t.args, summary: "user denied" },
          message: "[tool_info] Permission to run this command was denied by the user. Do not run it or retry it; adapt without it.",
        };
      }
      const res = await invoke<{
        exit_code: number | null;
        stdout: string;
        stderr: string;
        timed_out: boolean;
      }>("run_command", {
        command: cmd,
        cwd: t.args.cwd ?? null,
        shell: opts.shell ?? "powershell",
        root: projectRoot ?? null,
        extraPath: (opts.extraPathDirs ?? []).map((d) => d.trim()).filter(Boolean),
      });
      const statusText = res.timed_out ? "timeout after 120s" : res.exit_code === 0 ? "0 (ok)" : `${res.exit_code ?? "?"} (failed)`;
      const outChars = res.stdout.length + res.stderr.length;
      const summary = `exit ${statusText}${outChars ? ` · ${outChars} chars` : ""}`;
      const msg = [
        `[tool_result] command: ${cmd}`,
        `exit: ${statusText}`,
        res.stdout ? `stdout:\n${res.stdout}` : "(no stdout)",
        res.stderr ? `stderr:\n${res.stderr}` : "(no stderr)",
        ...diagnoseCommandFailure(cmd, res, opts.shell ?? "powershell"),
      ].join("\n");
      return {
        activity: { tool: t.name, args: t.args, summary },
        message: capToolMessage(msg),
        // A non-zero exit is a failed command even though the tool itself ran,
        // so the message stays a [tool_result] the model can read.
        failed: res.timed_out || res.exit_code !== 0,
      };
    }
    default:
      return {
        activity: { tool: t.name, args: t.args, summary: "unknown tool" },
        message: `[tool_error] unknown tool "${t.name}"`,
      };
  }
}

/**
 * Turn a raw exit code into something the model can act on.
 *
 * Why this exists: the reported failure was `Get-ChildItem -Force; Write-Output`
 * coming back as "exit 1 (failed)" with no usable diagnosis. The listing had in
 * fact run; the trailing bare `Write-Output` (no argument) is a PowerShell
 * parameter-binding error, so the whole line failed after doing the useful part.
 * Reporting only the exit code left the model with nothing to fix, so it kept
 * re-issuing variations of the same broken line.
 *
 * Each hint names the actual mistake so the model can correct itself on the
 * next turn, instead of guessing. Returns [] for a clean run so the common case
 * is byte-identical to what it was before.
 */
export function diagnoseCommandFailure(
  command: string,
  res: { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean },
  shell: string
): string[] {
  if (res.timed_out) {
    return [
      "[command_hint] The command hit the 120s timeout and was killed.",
      "Split it into smaller steps, or run the slow part in the background and",
      "poll the output file. Do not re-run the same command unchanged.",
    ];
  }
  if (res.exit_code === 0) return [];

  const err = res.stderr;
  const hints: string[] = [];

  if (err) {
    // PowerShell: a cmdlet invoked with a mandatory parameter missing.
    if (/is not recognized as a name of a cmdlet|CommandNotFoundException/i.test(err)) {
      hints.push(
        "[command_hint] The command name was not found on this machine.",
        "lvaigent searches the system PATH plus the folders pinned in Settings →",
        "General → Đường dẫn PATH bổ sung, so a tool installed outside PATH still",
        "resolves. If the program lives elsewhere, run it by full path",
        "(& 'D:\\tools\\lua\\lua.exe' main.lua) or ask the user which folder it is in.",
        "Check the spelling too: PowerShell on this box also accepts cmd-style",
        "commands (dir, type, where)."
      );
    }
    if (/missing mandatory parameter|Cannot process command because/i.test(err)) {
      hints.push(
        "[command_hint] A cmdlet was called without a required argument, so PowerShell",
        "threw and the whole line failed — earlier statements in the same line may",
        "still have run. Re-issue only the part you need, with a real value, e.g.",
        "Write-Output 'text' or Get-ChildItem alone. Never append a bare Write-Output."
      );
    }
    if (/is not recognized as an internal or external command/i.test(err)) {
      hints.push(
        "[command_hint] cmd.exe could not find that program. Verify it exists and is",
        "on PATH — or call it by full path; folders pinned in Settings are searched first."
      );
    }
    if (/Access to the path .* is denied/i.test(err)) {
      hints.push(
        "[command_hint] The process lacks permission for that path. Do not retry it the",
        "same way; ask the user to run it, or target a path you can write to."
      );
    }
  }

  // A multi-statement line where only the last one failed: the classic
  // `something; Write-Output` shape that produced the reported failure.
  if (hints.length === 0 && /;/.test(command) && res.stdout.trim().length > 0) {
    hints.push(
      "[command_hint] The line produced output and then failed, so an earlier",
      "statement ran and a later one did not. Re-run the failing statement on its",
      "own instead of the whole line."
    );
  }

  if (hints.length === 0 && res.exit_code !== null && res.exit_code !== 0 && !err) {
    hints.push(
      `[command_hint] The command exited ${res.exit_code} without writing to stderr.`,
      `Nothing ran visibly under "${shell}". Check that the program exists and`,
      "that its arguments are valid, then try a smaller command to isolate it."
    );
  }

  if (hints.length > 0) {
    hints.push("[command_hint] Fix the cause above before re-running — do not repeat the same command.");
  }
  return hints;
}

/** Guarded by the store before executeTool, but keep the type-level list here. */
export const MUTATING_TOOLS = new Set(["write_file", "run_command"]);

/** Bound the message sent back to the model so the input stays duck.ai-sized. */
function capToolMessage(msg: string): string {
  if (msg.length <= MAX_TOOL_MSG_CHARS) return msg;
  return `${msg.slice(0, MAX_TOOL_MSG_CHARS)}\n... (tool output truncated)`;
}

/** Text of a tool block exactly as it should be echoed back inside agent turns. */
export function toolCallText(t: ParsedTool): string {
  const attrs = ["name", ...Object.keys(t.args)]
    .map((k) => {
      const v = k === "name" ? t.name : t.args[k];
      // A command holding double quotes (PowerShell -Command "...") must not
      // be re-wrapped in double quotes — parseAttrText accepts either pair.
      const q = v.includes('"') && !v.includes("'") ? "'" : '"';
      return `${k}=${q}${v}${q}`;
    })
    .join(" ");
  return `<tool ${attrs} />`;
}

/**
 * Resolve a model-supplied path against the project root. Absolute Windows
 * (C:\... / \\host\share) and POSIX (/...) paths pass through untouched.
 * Anything else is treated as project-relative.
 */
export function resolveProjectPath(p: string, root: string | null): string {
  if (!root) return p;
  if (/^([A-Za-z]:[\\/]|[\\/]{2})/.test(p) || p.startsWith("/")) return p;
  return `${root.replace(/[\\/]+$/, "")}\\${p.replace(/^[\\/]+/, "")}`;
}
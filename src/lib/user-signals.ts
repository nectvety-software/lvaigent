/**
 * Reading the user's message before reading the codebase.
 *
 * The agent used to get the same treatment for every message: the whole file
 * index, plus the implement-and-verify coding workflow. So "what does this
 * function do?" was answered with instructions about write_file and run_command,
 * and the agent had to *guess* which of a thousand indexed files the question was
 * about.
 *
 * This module does the cheap, deterministic half of the job: pull the file paths
 * and identifiers the user actually named out of their message, and classify what
 * kind of request it is. The caller then reads the named files and picks the
 * workflow that fits.
 *
 * Everything here is pure and string-in/string-out on purpose — the classification
 * is a heuristic, so it has to be inspectable and testable rather than buried in
 * the send loop.
 */
import { MAX_AGENT_STEPS } from "./agent";

export type RequestIntent = "question" | "debug" | "run" | "edit";

export interface UserSignals {
  intent: RequestIntent;
  /**
   * Project-relative paths (forward slashes) the message names.
   *
   * Only paths that resolve to a real entry in the project index are kept: a
   * path the user typed from memory must not become a fabricated file in the
   * context block.
   */
  paths: string[];
  /** Code identifiers named in backticks or written as `call()`. */
  symbols: string[];
}

/** How many named files are worth pre-reading, and how much of each. */
export const MAX_NAMED_FILES = 3;
export const MAX_NAMED_FILE_CHARS = 6000;

/**
 * Order matters: the first match wins.
 *
 * `debug` is first because "how do I fix this?" is a debugging request, not a
 * general question. `question` is ahead of `run` because "build", "test" and
 * "lint" are nouns at least as often as they are commands — "tại sao build chậm
 * vậy" is a question about the build, not a request to run it, and a bare noun
 * must not outrank an explicit question marker. `edit` is last: anything
 * unrecognised keeps the pre-existing behaviour, so this classifier can never
 * make a working request worse.
 */
const INTENT_RULES: readonly { intent: RequestIntent; re: RegExp }[] = [
  {
    intent: "debug",
    re: /\b(?:fix|fixed|fixing|bug|bugs|error|errors|crash(?:es|ed|ing)?|fails?|failed|failing|failure|broken|stack ?trace|exception|regression)\b|sửa\s*lỗi|bị\s*lỗi|gặp\s*lỗi|\blỗi\b|hỏng|không\s*chạy|sai\b/i,
  },
  {
    intent: "question",
    re: /^\s*(?:what|why|how|where|when|who|which|is|are|does|do|can|could|should|would|explain|describe|tell)\b|\?|giải\s*thích|là\s*gì|tại\s*sao|thế\s*nào|ở\s*đâu|cho\s*(?:tôi|mình)\s*biết/i,
  },
  {
    intent: "run",
    re: /\b(?:run|build|compile|lint|install|deploy|start|launch)\b|chạy|biên\s*dịch|cài\s*đặt|triển\s*khai/i,
  },
  {
    intent: "edit",
    re: /\b(?:add|create|implement|refactor|rename|remove|delete|update|change|write|generate|move|split|extract)\b|thêm|tạo|viết|đổi|xóa|xoá|chuyển|gộp|tách|triển\s*khai\s*tính/i,
  },
];

export function classifyIntent(content: string): RequestIntent {
  for (const rule of INTENT_RULES) {
    if (rule.re.test(content)) return rule.intent;
  }
  return "edit";
}

/**
 * Per-intent step budget for the agent loop.
 *
 * A flat budget of 10 wasted rounds on a question that needs no tools, and was
 * stingy for a debugging session that legitimately reads, patches and re-runs.
 */
const STEP_BUDGET: Record<RequestIntent, number> = {
  question: 3,
  run: 6,
  debug: 10,
  edit: 10,
};

/** Clamped to MAX_AGENT_STEPS so no intent can silently exceed the global ceiling. */
export function stepBudgetFor(intent: RequestIntent): number {
  return Math.min(STEP_BUDGET[intent], MAX_AGENT_STEPS);
}

/** A path-ish token: at least one separator, so `src/a.ts` counts and `a.ts` does not. */
const PATH_TOKEN_RE = /(?:^|[\s"'`([{<,;])((?:\.{0,2}[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)+)/g;
/** A bare filename with a known extension, e.g. "index.ts" typed without a folder. */
const BARE_FILE_RE = /(?:^|[\s"'`([{<,;])([\w.@+-]+\.[A-Za-z]\w{0,7})(?![\w/\\])/g;
/** Identifiers in backticks, or written as a call: `foo`, `foo()`. */
const IDENT_RE = /`([A-Za-z_$][\w$]*)`|\b([A-Za-z_$][\w$]{2,})\(\)/g;

/** Lower-cased, forward-slashed form used for every comparison. */
function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

/**
 * Extract what the user named, restricted to what the project actually has.
 *
 * `knownPaths` is the project file index (project-relative). Passing it in — rather
 * than trusting the message — is what stops a hallucinated or stale path from
 * being pre-read and handed to the model as fact.
 */
export function extractUserSignals(
  content: string,
  knownPaths: readonly string[] = [],
): UserSignals {
  const intent = classifyIntent(content);

  const byNormalised = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const p of knownPaths) {
    const n = normalise(p);
    if (!byNormalised.has(n)) byNormalised.set(n, p);
    const base = n.split("/").pop() ?? n;
    byBasename.set(base, [...(byBasename.get(base) ?? []), p]);
  }

  const paths: string[] = [];
  const push = (resolved: string) => {
    if (!paths.includes(resolved)) paths.push(resolved);
  };

  // 1. Explicit paths. `src/store/index.ts` resolves even if the user wrote
  //    backslashes, a leading ./, or a suffix of the real path.
  for (const m of content.matchAll(PATH_TOKEN_RE)) {
    const n = normalise(m[1]);
    const exact = byNormalised.get(n);
    if (exact) {
      push(exact);
      continue;
    }
    const suffix = [...byNormalised.entries()].find(
      ([known]) => known === n || known.endsWith(`/${n}`),
    );
    if (suffix) push(suffix[1]);
  }

  // 2. Bare filenames, but only when exactly one file has that name — guessing
  //    between three `index.ts` would be worse than not guessing at all.
  for (const m of content.matchAll(BARE_FILE_RE)) {
    const matches = byBasename.get(m[1].toLowerCase());
    if (matches && matches.length === 1) push(matches[0]);
  }

  const symbols: string[] = [];
  for (const m of content.matchAll(IDENT_RE)) {
    const name = m[1] ?? m[2];
    if (name && !symbols.includes(name)) symbols.push(name);
  }

  return {
    intent,
    paths: paths.slice(0, MAX_NAMED_FILES),
    symbols: symbols.slice(0, 8),
  };
}

/**
 * The brief appended to the system prompt for this request.
 *
 * Returns "" when there is nothing worth saying — an ordinary edit that names no
 * files adds nothing, so the common case leaves the prompt exactly as it was and
 * the all-enabled prompt stays byte-identical.
 */
export function buildIntentBrief(signals: UserSignals): string {
  const lines: string[] = [];

  switch (signals.intent) {
    case "question":
      lines.push(
        "- The user is asking, not asking you to change files. Answer from the context",
        "  and tool results; do not emit write_file or run_command unless they ask for a change.",
      );
      break;
    case "debug":
      lines.push(
        "- Something is failing. Read the failing code and the real error before changing",
        "  anything, then make the smallest change that fixes the cause.",
        "- Say plainly if the evidence does not support a cause instead of guessing.",
      );
      break;
    case "run":
      lines.push(
        "- The user wants a command run. Use run_command, then report the actual output —",
        "  including failures — rather than describing what should have happened.",
      );
      break;
    case "edit":
      // The coding workflow already describes this case; only the notes below
      // (when the user named something) are worth adding.
      break;
  }

  // Telling the model these were pre-read is the point: without it, it re-reads
  // them, spending a step of the budget on work already done.
  if (signals.paths.length > 0) {
    lines.push(`- Files named in the request, already read for you: ${signals.paths.join(", ")}`);
  }
  if (signals.symbols.length > 0) {
    lines.push(`- Identifiers named in the request: ${signals.symbols.join(", ")}`);
  }

  if (lines.length === 0) return "";
  return [`[Request: ${signals.intent}]`, ...lines].join("\n");
}

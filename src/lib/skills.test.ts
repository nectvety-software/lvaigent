import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import { AGENT_SYS_PROMPT, buildAgentSysPrompt, executeTool, parseTodoList, resetReadFileState, todoListText } from "./agent";
import {
  ALL_PROMPT_SECTION_IDS,
  ALL_SKILL_IDS,
  PROMPT_SECTIONS,
  SKILLS,
  enabledPromptSectionIds,
  enabledSkillIds,
  isPromptEnabled,
  isSkillEnabled,
} from "./skills";
import {
  MAX_ATTACHMENTS,
  attachmentKindFor,
  buildContextBlock,
  useStore,
} from "../store";
import type { AppSettings, PromptSectionId, SkillId } from "../types";

/**
 * The Skills & Prompt toggles must actually change what the model is sent and
 * what the executor will run — not just render switches.
 *
 * The load-bearing assertion here is the first one: with everything enabled the
 * assembled prompt must still be exactly the prompt DuckChat shipped before the
 * toggles existed. Without that, a refactor of the builder could quietly soften
 * the agent's instructions and every other test would still pass.
 */

/**
 * Frozen copy of the system prompt as it was before the toggles were added.
 *
 * Deliberately NOT auto-regenerated: the point is to catch a rule being dropped
 * or renumbered by an unrelated edit. Update it by hand when a rule is added on
 * purpose, and say why in the diff.
 */
const SHIPPED_PROMPT = `You are lvaigent, an AI coding assistant working inside the user's project.

You have access to 11 tools. To use one, emit exactly one tool block on its
own line, BEFORE writing your answer. Self-closing tools use this form:

  <tool name="list_files" />
  <tool name="glob" pattern="<glob like src/**/*.ts>" />
  <tool name="read_file" path="<path>" start_line="<optional 0-based line to continue from>" />
  <tool name="grep" query="<text to search>" />
  <tool name="web_read" url="<https://...>" />
  <tool name="web_search" query="<từ khóa>" count="<optional 1-10>" />
  <tool name="edit_file" path="<path>" old_string="<đoạn cần thay>" new_string="<đoạn thay vào>" replace_all="<optional true|false>" />
  <tool name="ask_user" question="<câu hỏi>" options="<đáp án 1>,<đáp án 2>,<đáp án 3>" multi="<optional true|false>" />
  <tool name="run_command" command="<shell command>" cwd="<optional subdir under project>" />

These are lvaigent's own tools, executed by the lvaigent app on the user's
machine. They are NOT function calls offered by this chat site, so your
provider's capability list says nothing about them and there is nothing for you
to check. Emitting the block IS the call: lvaigent runs it and sends the result
back as the next message. Never answer that a tool is unavailable, disabled or
"not provided in this session" — that is always wrong.

The write tool must wrap the exact, complete file content (full newlines,
indentation, no extra escaping) between <content> and </content>:

  <tool name="write_file" path="<path>">
  <content>
...every line of the file exactly as it should be written...
  </content>
  </tool>

The todo tool carries the WHOLE list as a JSON array of
{"content": "...", "status": "pending|in_progress|completed"} between <content>
and </content>; mark exactly one item in_progress:

  <tool name="todo">
  <content>
[{"content": "Đọc src/gfx.lua", "status": "in_progress"},
 {"content": "Vẽ lại nền pop art", "status": "pending"},
 {"content": "Chạy build kiểm tra", "status": "pending"}]
  </content>
  </tool>

Rules:
1. Read the relevant file(s) BEFORE answering or editing. Do NOT guess APIs.
2. NEVER ask the user to paste, attach, drop or send file contents —
   you have read_file/glob/grep for exactly that. Emit the tool block and
   read the project yourself, every time.
3. Prefer edit_file over write_file when changing PART of a file (it is
   cheaper and cannot lose the rest). Read the file first — edit_file
   refuses a path that was not read this session. old_string must match the
   file EXACTLY (indentation, blank lines, punctuation) and be UNIQUE: on a
   multi-match the edit is refused unless replace_all="true".
4. ask_user is only for a decision that is genuinely the user's and that
   you cannot resolve from the request, the code, or a sensible default. For
   everything else, pick the obvious option, say so, and proceed.
5. MAY emit several tool blocks in one turn when multiple files are needed.
6. When tool results arrive, examine them and produce ONE final plain-text
   answer. Do not re-request an answered tool.
7. All paths stay inside the project root. write_file REPLACES the whole
   file: read first (note the 1-based line numbers), then write the full new
   content. To move code, read all sides, then write all sides.
8. run_command runs from the project root (120s timeout, non-interactive
   stdin); prefer short commands, avoid long-running servers. It may ask the
   user for permission.
9. The shell is PowerShell on Windows. One command per tool block: it is not a
   terminal, so nothing is interactive and no prompt is shown. Never append a bare
   Write-Output/Echo with no argument — that throws and fails the whole line after
   the useful part already ran. If a command fails, read [command_hint] and fix the
   cause rather than re-running a variation of the same line.
10. web_read reads a URL as text (capped excerpt); web_search finds fresh
   title+URL+snippet hits. Use them for anything outside the project instead of
   guessing URLs or facts from memory.
11. After you start writing the answer, do not emit further tool blocks.
12. Tool blocks are stripped before the user sees your message — never explain
   them.

Coding workflow (implement / fix / generate code):
1. The first message already carries a [Codebase] map: file index with line
   counts, key configs, and Verify commands. Use it for orientation — do not
   re-list the whole tree.
2. Study what you will touch: glob for candidates, then read_file with line
   numbers. For large files continue with start_line.
3. Implement with edit_file when changing part of a file (read it first, keep
   old_string unique and exact) and write_file when creating a file or
   rewriting it wholesale.
4. For work with three or more steps, emit a todo list first (ZCode's task
   list): the first message may be the plan, then track it. Each todo call
   REPLACES the whole list — resend it with updated statuses as you go.
5. Verify with run_command using the Verify hints from [Codebase]
   (build / test / lint). On failure: read the error, fix, re-verify.
6. Finish with a short summary: files changed, what each change does, and how
   it was verified.`;

const without = <T,>(all: readonly T[], ...drop: T[]): T[] =>
  all.filter((x) => !drop.includes(x));

const tool = (name: string) => ({ name, args: {}, raw: "", index: 0 });

beforeEach(() => {
  invokeMock.mockReset();
});

describe("the prompt with every toggle on", () => {
  it("is byte-identical to the prompt shipped before the toggles existed", () => {
    expect(buildAgentSysPrompt()).toBe(SHIPPED_PROMPT);
    expect(AGENT_SYS_PROMPT).toBe(SHIPPED_PROMPT);
    expect(buildAgentSysPrompt([...ALL_SKILL_IDS], [...ALL_PROMPT_SECTION_IDS])).toBe(
      SHIPPED_PROMPT
    );
  });
});

describe("skills", () => {
  it("documents one tool line per enabled skill, and counts them", () => {
    const prompt = buildAgentSysPrompt(without(ALL_SKILL_IDS, "grep"));
    expect(prompt).not.toContain('name="grep"');
    // 11 registered skills, minus grep. Past eight the builder stops spelling
    // the number, which is the documented fallback.
    expect(prompt).toContain("You have access to 10 tools.");
    // The others survive untouched.
    expect(prompt).toContain('name="list_files"');
    expect(prompt).toContain('name="run_command"');
  });

  it("drops write_file's content block but keeps the shared path-safety rule", () => {
    const prompt = buildAgentSysPrompt(without(ALL_SKILL_IDS, "write_file"));
    expect(prompt).not.toContain('name="write_file"');
    expect(prompt).not.toContain("The write tool must wrap");
    expect(prompt).not.toContain("write_file REPLACES the whole");
    // Rule 4 is half general, half write-specific: only the general half may go.
    expect(prompt).toContain("All paths stay inside the project root.");
  });

  it("drops a rule that is entirely about a disabled skill and renumbers", () => {
    const prompt = buildAgentSysPrompt(without(ALL_SKILL_IDS, "run_command"));
    expect(prompt).not.toContain("run_command runs from the project root");
    expect(prompt).not.toContain("Verify with run_command");
    // 12 rules became 10, 6 workflow steps became 5 — with no gap in the numbering.
    expect(prompt).toContain("10. Tool blocks are stripped");
    expect(prompt).not.toContain("11. Tool blocks are stripped");
    expect(prompt).toContain("5. Finish with a short summary");
  });

  it("says so plainly when no skill is enabled", () => {
    const prompt = buildAgentSysPrompt([], [...ALL_PROMPT_SECTION_IDS]);
    expect(prompt).toContain("You have no tools enabled.");
    expect(prompt).not.toContain("<tool name=");
    expect(prompt).not.toContain("You have access to");
    // The text-protocol framing promises tools the app will run, so it may not
    // survive into a prompt that documents none.
    expect(prompt).not.toContain("lvaigent's own tools");
  });

  it("every registry entry names a real tool the executor accepts", () => {
    // A typo here would document a tool that silently falls through to
    // "unknown tool" at runtime.
    expect(SKILLS.map((s) => s.id)).toEqual([...ALL_SKILL_IDS]);
    // write_file and todo are documented as <content> blocks, the other nine
    // as self-closing one-liners.
    expect(SKILLS.filter((s) => s.syntax !== null)).toHaveLength(9);
    expect(SKILLS.find((s) => s.id === "write_file")?.syntax).toBeNull();
    expect(SKILLS.find((s) => s.id === "todo")?.syntax).toBeNull();
  });
});

describe("prompt sections", () => {
  it("drops the [Codebase] workflow step when the codebase map is off", () => {
    const prompt = buildAgentSysPrompt(
      [...ALL_SKILL_IDS],
      without(ALL_PROMPT_SECTION_IDS, "codebase")
    );
    expect(prompt).not.toContain("[Codebase] map");
    expect(prompt).toContain("1. Study what you will touch");
  });

  it("builds the context block from the enabled sections only", () => {
    const project = {
      id: "p",
      name: "demo",
      path: "D:/demo",
      files: [],
      openedAt: 1,
    };
    const attached = [
      {
        name: "a.ts",
        path: "D:/demo/a.ts",
        content: "let x = 1;",
        truncated: false,
        kind: "file" as const,
      },
    ];

    const all = buildContextBlock(project, attached, null, "# rules", [...ALL_PROMPT_SECTION_IDS]);
    expect(all).toContain("[Project: demo");
    expect(all).toContain("[AGENTS.md]");
    expect(all).toContain("[File: D:/demo/a.ts]");

    const none = buildContextBlock(project, attached, null, "# rules", []);
    expect(none).toBeNull();

    const noAgents = buildContextBlock(
      project,
      attached,
      null,
      "# rules",
      without(ALL_PROMPT_SECTION_IDS, "agentsMd")
    );
    expect(noAgents).not.toContain("[AGENTS.md]");
    expect(noAgents).toContain("[Project: demo");

    const noAttachments = buildContextBlock(
      project,
      attached,
      null,
      "# rules",
      without(ALL_PROMPT_SECTION_IDS, "attachments")
    );
    expect(noAttachments).not.toContain("[File: D:/demo/a.ts]");
    expect(noAttachments).toContain("[AGENTS.md]");
  });

  /**
   * duck.ai's composer takes 16,000 characters, and the folded first turn is
   * prompt + this block + the user's own words, so the block is what has to give.
   * Giving way means dropping WHOLE sections — a file cut mid-statement reads as
   * complete code to the model — in the order: attachments, then AGENTS.md, then
   * the codebase map, and the code the user named last.
   */
  it("gives way section by section under a character budget", () => {
    const project = {
      id: "p",
      name: "demo",
      path: "D:/demo",
      files: [{ name: "a.ts", path: "a.ts", is_dir: false }],
      openedAt: 1,
    };
    const attached = [
      {
        name: "big.ts",
        path: "D:/demo/big.ts",
        content: "z".repeat(4000),
        truncated: false,
        kind: "file" as const,
      },
    ];
    const named = [{ path: "src/x.ts", content: "export const x = 1;", truncated: false }];
    const sections = [...ALL_PROMPT_SECTION_IDS];
    const at = (text: string, marker: string) => text.indexOf(`\n\n${marker}`);
    const withBudget = (maxChars: number) =>
      buildContextBlock(project, attached, null, "# rules", sections, named, maxChars);

    const full = buildContextBlock(project, attached, null, "# rules", sections, named)!;
    expect(full).toContain("[File: D:/demo/big.ts]");

    const noAttachments = withBudget(at(full, "[File:"))!;
    expect(noAttachments).toBe(full.slice(0, at(full, "[File:")));

    const noAgents = withBudget(at(noAttachments, "[AGENTS.md]"))!;
    expect(noAgents).toBe(noAttachments.slice(0, at(noAttachments, "[AGENTS.md]")));

    const noMap = withBudget(at(noAgents, "[Project:"))!;
    expect(noMap).not.toContain("[Project: demo");
    // The pre-read code survives to the end, intact.
    expect(noMap).toContain("export const x = 1;");

    // No room for even that means no block at all, not a sliced one.
    expect(withBudget(30)).toBeNull();
  });

  it("puts the files the user named first, with their content", () => {
    const project = {
      id: "p",
      name: "demo",
      path: "D:/demo",
      files: [],
      openedAt: 1,
    };
    const named = [
      { path: "src/store/index.ts", content: "export const x = 1;", truncated: false },
    ];

    const withNamed = buildContextBlock(
      project,
      [],
      null,
      null,
      [...ALL_PROMPT_SECTION_IDS],
      named
    );
    expect(withNamed).toContain("[Relevant file: src/store/index.ts]");
    expect(withNamed).toContain("export const x = 1;");
    // The named file is the code the request is about, so it comes before the
    // map that is only orientation.
    expect(withNamed!.indexOf("[Relevant file:")).toBeLessThan(
      withNamed!.indexOf("[Project: demo")
    );

    // Turning the codebase section off drops it along with the rest of the map.
    const off = buildContextBlock(project, [], null, null, without(ALL_PROMPT_SECTION_IDS, "codebase"), named);
    expect(off).toBeNull();
  });
});

describe("a disabled skill is refused, not merely undocumented", () => {
  it("returns a tool_error without touching the backend", async () => {
    const outcome = await executeTool(tool("read_file"), "D:/demo", {
      disabledSkills: ["read_file"],
    });

    expect(outcome.message).toContain("[tool_error]");
    expect(outcome.message).toContain("turned off in Settings");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses a mutating skill too, even with full access on", async () => {
    const outcome = await executeTool(tool("write_file"), "D:/demo", {
      disabledSkills: ["write_file"],
    });
    expect(outcome.message).toContain("[tool_error]");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("still runs an enabled skill", async () => {
    // Must not be `[]`: an empty listing is itself a tool_error (empty folder),
    // which would make the assertion below pass for the wrong reason.
    invokeMock.mockResolvedValue(["src/a.ts"]);
    const outcome = await executeTool(tool("list_files"), "D:/demo", {
      disabledSkills: ["read_file"],
    });
    expect(outcome.message).not.toContain("[tool_error]");
    expect(outcome.message).toContain("src/a.ts");
    expect(invokeMock).toHaveBeenCalledWith("list_project_files", { root: "D:/demo" });
  });
});

/**
 * write_file used to run with no permission gate at all, so the agent could
 * replace any file in the project silently. ZCode treats an edit as a permission
 * request (its dialog renders a distinct "edit" block), so it must ask here too.
 */
describe("run_command tells the model what actually went wrong", () => {
  const cmd = (command: string) => ({ name: "run_command", args: { command }, raw: "", index: 0 });

  it("includes a hint in the tool_result the model reads", async () => {
    // The unit test of diagnoseCommandFailure passes with or without the wiring,
    // so this is the assertion that would have caught the hint never reaching
    // the model. The failure in the report was the model re-issuing the same
    // broken line because it had nothing to act on.
    invokeMock.mockResolvedValue({
      exit_code: 1,
      stdout: "package.json",
      stderr:
        "Write-Output : Cannot process command because of one or more missing mandatory parameters: InputObject.",
      timed_out: false,
    });
    const outcome = await executeTool(cmd("Get-ChildItem -Force; Write-Output"), "D:/demo");

    expect(outcome.message).toContain("[command_hint]");
    expect(outcome.message.replace(/\s+/g, " ")).toContain("Never append a bare Write-Output");
  });

  it("hands the folders pinned in Settings to the shell", async () => {
    // The hint above is only worth anything if the folders actually reach the
    // child process: `extraPath` is what the Rust side prepends to PATH.
    invokeMock.mockResolvedValue({
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      timed_out: false,
    });
    await executeTool(cmd("lua main.lua"), "D:/demo", {
      extraPathDirs: ["D:\\lua", "   ", "D:\\mre\\bin"],
    });

    const call = invokeMock.mock.calls.find((c) => c[0] === "run_command");
    expect(call, "run_command never reached the backend").toBeTruthy();
    expect((call![1] as { extraPath: string[] }).extraPath).toEqual([
      "D:\\lua",
      "D:\\mre\\bin",
    ]);
  });

  it("takes the command from the block body when the attribute cannot carry it", async () => {
    // A command with both quote kinds has no attribute form — the parser
    // ends at the first inner quote — so it travels in the body. Reading it
    // from there is what keeps a python one-liner intact.
    invokeMock.mockResolvedValue({
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      timed_out: false,
    });
    const outcome = await executeTool(
      { name: "run_command", args: { content: `py -3 -c "print('hi')"` }, raw: "", index: 0 },
      "D:/demo"
    );

    expect(outcome.message).not.toContain("[tool_error]");
    const call = invokeMock.mock.calls.find((c) => c[0] === "run_command");
    expect((call![1] as { command: string }).command).toBe(`py -3 -c "print('hi')"`);
  });

  it("says nothing extra when the command succeeded", async () => {    invokeMock.mockResolvedValue({
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      timed_out: false,
    });
    const outcome = await executeTool(cmd("npm test"), "D:/demo");

    expect(outcome.message).not.toContain("[command_hint]");
    expect(outcome.message).toContain("exit: 0 (ok)");
  });

  it("reports a non-zero exit as an error, not as a finished step", async () => {
    // A failed command is still a `[tool_result]` — the tool itself worked, the
    // command did not. The step status used to be derived only from the message
    // prefix, so every failed command rendered with a green check in the chat,
    // which is exactly what the screenshots showed: three `exit 1 (failed)` rows
    // all ticked. The exit code has to be carried on the outcome.
    invokeMock.mockResolvedValue({
      exit_code: 1,
      stdout: "",
      stderr: "boom",
      timed_out: false,
    });
    const outcome = await executeTool(cmd("npm test"), "D:/demo");

    expect(outcome.failed).toBe(true);
    expect(outcome.activity.summary).toContain("failed");
  });

  it("does not mark a clean run as failed", async () => {
    invokeMock.mockResolvedValue({
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      timed_out: false,
    });
    const outcome = await executeTool(cmd("npm test"), "D:/demo");
    expect(outcome.failed).toBe(false);
  });

  it("treats a timeout as a failure too", async () => {
    invokeMock.mockResolvedValue({
      exit_code: null,
      stdout: "",
      stderr: "",
      timed_out: true,
    });
    const outcome = await executeTool(cmd("npm run dev"), "D:/demo");
    expect(outcome.failed).toBe(true);
  });

  it("never marks a denied or errored tool as a plain success", async () => {
    // A denial is a real outcome the user must see, not a green tick.
    invokeMock.mockResolvedValue(20);
    const denied = await executeTool(
      { name: "write_file", args: { path: "a.ts", content: "x" }, raw: "", index: 0 },
      "D:/demo",
      { ask: async () => false }
    );
    expect(denied.failed).toBe(true);

    const noProject = await executeTool(
      { name: "read_file", args: { path: "a.ts" }, raw: "", index: 0 },
      null
    );
    expect(noProject.failed).toBe(true);
  });
});

describe("write_file asks before overwriting, like a shell command", () => {
  const withArgs = (args: Record<string, string>) => ({
    name: "write_file",
    args,
    raw: "",
    index: 0,
  });

  it("does not touch the filesystem when the user denies", async () => {
    invokeMock.mockResolvedValue(20);
    const outcome = await executeTool(
      withArgs({ path: "src/new.ts", content: "export const x = 1;\n" }),
      "D:\\proj",
      { ask: async () => false }
    );

    expect(outcome.message).toContain("[tool_info]");
    expect(outcome.message).toContain("denied");
    // The load-bearing part: the write must never have reached the backend.
    expect(invokeMock).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("writes when the user allows it", async () => {
    invokeMock.mockResolvedValue(20);
    const outcome = await executeTool(
      withArgs({ path: "src/new.ts", content: "export const x = 1;\n" }),
      "D:\\proj",
      { ask: async () => true }
    );

    expect(outcome.message).toContain("Wrote");
    expect(invokeMock).toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("asks even for a brand-new file, not only for overwrites", async () => {
    // A new file is still a change to the user's project, and the prompt is the
    // only thing standing between the model and a tree full of files it invented.
    invokeMock.mockResolvedValue(20);
    await executeTool(withArgs({ path: "src/never/asked.ts", content: "x" }), "D:\\proj", {
      ask: async () => false,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("write_file", expect.anything());
  });
});

/**
 * The backend enforces containment, but only for the paths it is handed. These
 * lock the front half of that contract: every file tool must resolve a relative
 * path into the project AND pass the root, because `root: null` means
 * "unrestricted" on the Rust side.
 */
describe("the file tools hand the backend a project-contained path", () => {
  const withArgs = (name: string, args: Record<string, string>) => ({
    name,
    args,
    raw: "",
    index: 0,
  });

  it("resolves a relative write into the project and passes the root", async () => {
    invokeMock.mockResolvedValue(20);
    const outcome = await executeTool(
      withArgs("write_file", { path: "src/new.ts", content: "export const x = 1;\n" }),
      "D:\\proj"
    );

    expect(outcome.message).not.toContain("[tool_error]");
    // The separator at the join is a backslash; separators *inside* the
    // project-relative path are left as the model wrote them. Windows accepts
    // the mix, so this is the real contract, not a normalised one.
    expect(invokeMock).toHaveBeenCalledWith("write_file", {
      path: "D:\\proj\\src/new.ts",
      content: "export const x = 1;\n",
      root: "D:\\proj",
    });
  });

  it("passes the root on every read so the backend can contain it", async () => {
    invokeMock.mockResolvedValue({
      content: "line\n",
      total_lines: 1,
      start_line: 0,
      end_line: 1,
      truncated: false,
    });
    await executeTool(withArgs("read_file", { path: "src/a.ts" }), "D:\\proj");

    expect(invokeMock).toHaveBeenCalledWith("read_file_lines", {
      path: "D:\\proj\\src/a.ts",
      start_line: 0,
      max_lines: null,
      root: "D:\\proj",
    });
  });

  it("refuses to read at all when no project is open", async () => {
    // Without a root the backend cannot contain the read, and passing
    // `root: null` would leave it unrestricted — so the tool must not run.
    const outcome = await executeTool(
      withArgs("read_file", { path: "C:\\Users\\x\\.ssh\\id_rsa" }),
      null
    );

    expect(outcome.message).toContain("[tool_error]");
    expect(outcome.message).toContain("No project is open");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("the internet tools reach the backend without a project", () => {
  const withArgs = (name: string, args: Record<string, string>) => ({
    name,
    args,
    raw: "",
    index: 0,
  });

  it("web_read needs a url and never touches the backend without one", async () => {
    const outcome = await executeTool(withArgs("web_read", {}), null);
    expect(outcome.message).toContain("[tool_error]");
    expect(outcome.message).toContain("url");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("web_read forwards the url and labels the excerpt", async () => {
    invokeMock.mockResolvedValue("hello ".repeat(100));
    const outcome = await executeTool(
      withArgs("web_read", { url: "https://example.com/a" }),
      null
    );
    expect(invokeMock).toHaveBeenCalledWith("fetch_web", {
      url: "https://example.com/a",
      max_chars: null,
    });
    expect(outcome.message).toContain("Content of https://example.com/a");
    expect(outcome.activity.summary).toContain("chars");
  });

  it("web_search needs a query and clamps count into 1-10", async () => {
    const empty = await executeTool(withArgs("web_search", {}), null);
    expect(empty.message).toContain("[tool_error]");
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValue([
      { title: "T", url: "https://e.com", snippet: "S" },
    ]);
    const outcome = await executeTool(
      withArgs("web_search", { query: "duck.ai", count: "99" }),
      null
    );
    expect(invokeMock).toHaveBeenCalledWith("web_search", {
      query: "duck.ai",
      count: 10,
    });
    expect(outcome.message).toContain('Web results for "duck.ai"');
    expect(outcome.message).toContain("https://e.com");
  });

  it("web_search says so plainly when nothing is found", async () => {
    invokeMock.mockResolvedValue([]);
    const outcome = await executeTool(
      withArgs("web_search", { query: "no such thing anywhere" }),
      null
    );
    expect(outcome.message).toContain("No web results");
  });
});

describe("defaults and persistence", () => {
  it("treats an absent list as everything enabled", () => {
    const bare = {} as AppSettings;
    expect(isSkillEnabled(bare, "run_command")).toBe(true);
    expect(isPromptEnabled(bare, "system")).toBe(true);
    expect(enabledSkillIds(bare)).toEqual([...ALL_SKILL_IDS]);
    expect(enabledPromptSectionIds(bare)).toEqual([...ALL_PROMPT_SECTION_IDS]);
  });

  it("stores what is OFF, so a skill added later defaults to on", () => {
    const settings = { disabledSkills: ["grep"] } as AppSettings;
    expect(isSkillEnabled(settings, "grep")).toBe(false);
    // A capability nobody has an opinion about is enabled.
    expect(isSkillEnabled(settings, "run_command")).toBe(true);
  });

  it("toggles persist in registry order and round-trip through the store", () => {
    useStore.getState().setSkillEnabled("run_command", false);
    useStore.getState().setSkillEnabled("grep", false);
    // Registry order, not click order — keeps the saved list stable.
    expect(useStore.getState().settings.disabledSkills).toEqual(["grep", "run_command"]);

    useStore.getState().setSkillEnabled("grep", true);
    expect(useStore.getState().settings.disabledSkills).toEqual(["run_command"]);

    useStore.getState().setAllSkillsEnabled(false);
    expect(useStore.getState().settings.disabledSkills).toEqual([...ALL_SKILL_IDS]);

    useStore.getState().setAllSkillsEnabled(true);
    expect(useStore.getState().settings.disabledSkills).toEqual([]);
  });

  it("the same contract holds for prompt sections", () => {
    useStore.getState().setAllPromptSectionsEnabled(false);
    expect(useStore.getState().settings.disabledPrompts).toEqual([...ALL_PROMPT_SECTION_IDS]);

    useStore.getState().setPromptSectionEnabled("system", true);
    expect(useStore.getState().settings.disabledPrompts).not.toContain("system");

    useStore.getState().setAllPromptSectionsEnabled(true);
    expect(useStore.getState().settings.disabledPrompts).toEqual([]);
  });

  it("the store's enabled sets drive the prompt and the executor from one place", () => {
    useStore.getState().setAllSkillsEnabled(true);
    const settings = useStore.getState().settings;
    const skills = enabledSkillIds(settings) as SkillId[];
    expect(skills).toHaveLength(ALL_SKILL_IDS.length);
    expect(buildAgentSysPrompt(skills)).toBe(SHIPPED_PROMPT);

    useStore.getState().setSkillEnabled("run_command", false);
    const next = useStore.getState().settings;
    expect(buildAgentSysPrompt(enabledSkillIds(next))).not.toContain('name="run_command"');
    expect(
      enabledPromptSectionIds(next) as PromptSectionId[]
    ).toEqual([...ALL_PROMPT_SECTION_IDS]);
  });

  it("exposes every registry entry to the Settings UI", () => {
    expect(PROMPT_SECTIONS.map((p) => p.id)).toEqual([...ALL_PROMPT_SECTION_IDS]);
    // Titles and descriptions are what the user actually reads.
    for (const entry of [...SKILLS, ...PROMPT_SECTIONS]) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

describe("importing images, files and folders into the composer", () => {
  /** The store keeps attachments across sends, so each case starts clean. */
  const reset = () => {
    invokeMock.mockReset();
    useStore.setState({ attachedFiles: [], toasts: [] });
  };

  it("attaches an image as a path, never as bytes the transport cannot carry", async () => {
    reset();
    await useStore.getState().attachFromPaths(["D:/assets/logo.png"]);

    // No read: a PNG has no business in a text prompt.
    expect(invokeMock).not.toHaveBeenCalled();
    const [item] = useStore.getState().attachedFiles;
    expect(item.kind).toBe("image");
    expect(item.path).toBe("D:/assets/logo.png");

    const block = buildContextBlock(null, [item], null, null, ALL_PROMPT_SECTION_IDS);
    expect(block).toContain("[Image on the user's disk: D:/assets/logo.png]");
    expect(block).toContain("Only the path reached you");
  });

  it("reads an imported file by absolute path, outside the project too", async () => {
    reset();
    invokeMock.mockResolvedValue("print('hi')\n");
    await useStore.getState().attachFromPaths(["D:/other/notes.lua"]);

    expect(invokeMock).toHaveBeenCalledWith("read_file_content", {
      path: "D:/other/notes.lua",
    });
    const [item] = useStore.getState().attachedFiles;
    expect(item.kind).toBe("file");
    expect(item.name).toBe("notes.lua");
  });

  it("expands a folder into a listing plus the text files inside it", async () => {
    reset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_project_tree") {
        return Promise.resolve([
          { name: "main.lua", path: "D:/game/main.lua", is_dir: false, size: 10 },
          {
            name: "assets",
            path: "D:/game/assets",
            is_dir: true,
            children: [
              { name: "hero.png", path: "D:/game/assets/hero.png", is_dir: false, size: 5 },
            ],
          },
        ]);
      }
      if (cmd === "read_file_chunk") return Promise.resolve("print(1)\n");
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    await useStore.getState().attachFolder("D:/game/");

    const [item] = useStore.getState().attachedFiles;
    expect(item.kind).toBe("folder");
    // Trailing separator is the picker's, not part of the name.
    expect(item.path).toBe("D:/game");
    expect(item.name).toBe("game");
    expect(item.content).toContain("Structure:");
    expect(item.content).toContain("assets/");
    expect(item.content).toContain("hero.png");
    expect(item.content).toContain("[File: D:/game/main.lua]");
    // Pictures inside a folder are listed, not decoded.
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "read_file_chunk").map((c) => c[1]?.path)
    ).toEqual(["D:/game/main.lua"]);

    const block = buildContextBlock(null, [item], null, null, ALL_PROMPT_SECTION_IDS);
    expect(block).toContain("[Folder: D:/game]");
  });

  it("caps how much one send carries and says so instead of failing silently", async () => {
    reset();
    const many = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) => `D:/x/f${i}.lua`);
    invokeMock.mockResolvedValue("x");
    await useStore.getState().attachFromPaths(many);

    expect(useStore.getState().attachedFiles).toHaveLength(MAX_ATTACHMENTS);
    expect(useStore.getState().toasts.some((t) => t.message.includes("tối đa"))).toBe(true);
  });

  it("treats SVG as source, because unlike a PNG its drawing is text", () => {
    expect(attachmentKindFor("D:/assets/icon.svg")).toBe("file");
    expect(attachmentKindFor("D:/assets/icon.png")).toBe("image");
    expect(attachmentKindFor("D:/assets/ICON.JPG")).toBe("image");
    expect(attachmentKindFor("D:/game/main.lua")).toBe("file");
  });
});

/**
 * edit_file — ZCode's edit tool, ported.
 *
 * The contract that matters: an edit must follow a real read of the same file,
 * and old_string must be unique unless replace_all is set. Both guards exist
 * because the alternative (an old_string written from memory) silently edits
 * the wrong place or nothing at all.
 */
describe("edit_file (ported from ZCode)", () => {
  const edit = (args: Record<string, string>) => ({
    name: "edit_file",
    args,
    raw: "",
    index: 0,
  });
  const FILE = "line one\nline two\nline three\n";

  /** A file read via the real tool path marks it editable. */
  const readFirst = async () => {
    invokeMock.mockResolvedValueOnce({
      content: FILE,
      total_lines: 3,
      start_line: 0,
      end_line: 3,
      truncated: false,
    });
    await executeTool({ name: "read_file", args: { path: "a.lua" }, raw: "", index: 0 }, "D:\\proj");
  };

  it("refuses to edit a file that was not read this session", async () => {
    invokeMock.mockResolvedValue(FILE);
    const outcome = await executeTool(
      edit({ path: "a.lua", old_string: "line two", new_string: "LINE TWO" }),
      "D:\\proj",
      { ask: async () => true }
    );
    expect(outcome.message).toContain("[tool_error]");
    expect(outcome.message).toContain("has not been read");
    expect(invokeMock).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("replaces the unique old_string and reports it", async () => {
    await readFirst();
    invokeMock.mockResolvedValueOnce(FILE); // read_file_content (executor)
    invokeMock.mockResolvedValueOnce(21); // write_file
    const outcome = await executeTool(
      edit({ path: "a.lua", old_string: "line two", new_string: "LINE TWO" }),
      "D:\\proj",
      { ask: async () => true }
    );
    expect(outcome.message).toContain("[tool_result]");
    expect(outcome.activity.summary).toContain("1 occurrence(s) replaced");
  });

  it("refuses an ambiguous match without replace_all", async () => {
    await readFirst();
    invokeMock.mockResolvedValue("x\nx\nx\n");
    const outcome = await executeTool(
      edit({ path: "a.lua", old_string: "x", new_string: "y" }),
      "D:\\proj",
      { ask: async () => true }
    );
    expect(outcome.message).toContain("ambiguous");
    expect(outcome.message).toContain('replace_all="true"');
    expect(invokeMock).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("replaces every occurrence with replace_all", async () => {
    await readFirst();
    invokeMock.mockResolvedValueOnce("x\nx\nx\n");
    invokeMock.mockResolvedValueOnce(6);
    const outcome = await executeTool(
      edit({ path: "a.lua", old_string: "x", new_string: "y", replace_all: "true" }),
      "D:\\proj",
      { ask: async () => true }
    );
    expect(outcome.message).toContain("3 occurrences");
    expect(invokeMock).toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("reports an old_string that does not exist, with a file excerpt", async () => {
    await readFirst();
    invokeMock.mockResolvedValueOnce(FILE);
    const outcome = await executeTool(
      edit({ path: "a.lua", old_string: "line FOUR", new_string: "x" }),
      "D:\\proj",
      { ask: async () => true }
    );
    expect(outcome.message).toContain("was not found");
    // The excerpt is what lets the model retry with the real text.
    expect(outcome.message).toContain("line one");
  });

  it("creates the file when old_string is empty and the file is missing", async () => {
    invokeMock.mockRejectedValueOnce(new Error("os error 2")); // read_file_content misses
    invokeMock.mockResolvedValueOnce(5); // write_file
    const outcome = await executeTool(
      edit({ path: "new.lua", old_string: "", new_string: "hi\n" }),
      "D:\\proj",
      { ask: async () => true }
    );
    expect(outcome.message).toContain("Created new.lua");
  });

  it("refuses an empty old_string on an existing file — that is write_file's job", async () => {
    await readFirst();
    invokeMock.mockResolvedValueOnce(FILE);
    const outcome = await executeTool(
      edit({ path: "a.lua", old_string: "", new_string: "clobber\n" }),
      "D:\\proj",
      { ask: async () => true }
    );
    expect(outcome.message).toContain("[tool_error]");
    expect(outcome.message).toContain("write_file");
    expect(invokeMock).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("does not touch the filesystem when the user denies", async () => {
    await readFirst();
    invokeMock.mockResolvedValueOnce(FILE);
    const outcome = await executeTool(
      edit({ path: "a.lua", old_string: "line two", new_string: "x" }),
      "D:\\proj",
      { ask: async () => false }
    );
    expect(outcome.message).toContain("[tool_info]");
    expect(invokeMock).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  it("is disabled in PLAN mode", async () => {
    const outcome = await executeTool(
      edit({ path: "a.lua", old_string: "x", new_string: "y" }),
      "D:\\proj",
      { readOnly: true }
    );
    expect(outcome.message).toContain("PLAN mode");
  });
});

/**
 * ask_user — ZCode's AskUserQuestion, ported.
 *
 * The answer must reach the model as a [tool_result]; a dismissed dialog is
 * NOT a refusal and must not read as one.
 */
describe("ask_user (ported from ZCode)", () => {
  const ask = (args: Record<string, string>) => ({ name: "ask_user", args, raw: "", index: 0 });

  it("returns the user's answer as the tool result", async () => {
    const outcome = await executeTool(
      ask({
        question: "Pop art hay pixel art?",
        options: "pop art,pixel art",
      }),
      "D:\\proj",
      { askQuestion: async () => "pop art" }
    );
    expect(outcome.message).toContain("[tool_result]");
    expect(outcome.message).toContain("The user answered: pop art");
    expect(outcome.activity.summary).toContain("pop art");
  });

  it("passes question, options and multiSelect through to the UI", async () => {
    let seen: { question: string; options: string[]; multiSelect: boolean } | null = null;
    await executeTool(
      ask({ question: "Chọn màu", options: "đỏ,xanh | vàng", multi: "true" }),
      "D:\\proj",
      {
        askQuestion: async (q) => {
          seen = q;
          return "đỏ, vàng";
        },
      }
    );
    expect(seen).toEqual({
      question: "Chọn màu",
      options: ["đỏ", "xanh", "vàng"],
      multiSelect: true,
    });
  });

  it("treats a dismissed dialog as no answer, not a refusal", async () => {
    const outcome = await executeTool(
      ask({ question: "Tiếp tục?", options: "có,không" }),
      "D:\\proj",
      { askQuestion: async () => null }
    );
    expect(outcome.message).toContain("did not answer");
    expect(outcome.message).toContain("not treat this as a rejection");
  });

  it("errors clearly when the question attribute is missing", async () => {
    const outcome = await executeTool(ask({ options: "a" }), "D:\\proj", {
      askQuestion: async () => "a",
    });
    expect(outcome.message).toContain("[tool_error]");
    expect(outcome.message).toContain("question attribute");
  });

  it("tells the model to decide itself when it cannot ask", async () => {
    const outcome = await executeTool(ask({ question: "?", options: "a" }), "D:\\proj");
    expect(outcome.message).toContain("not available in this run");
  });
});

/**
 * todo — ZCode's task list, ported.
 *
 * Each call carries the WHOLE list, so a malformed row must never blank the
 * checklist the user is watching.
 */
describe("todo (ported from ZCode)", () => {
  const todo = (content: string) => ({
    name: "todo",
    args: { content },
    raw: "",
    index: 0,
  });

  it("parses a well-formed list and counts statuses", () => {
    const { items, error } = parseTodoList(
      '[{"content":"Đọc file","status":"in_progress"},{"content":"Sửa","status":"completed"},{"content":"Test","status":"pending"}]'
    );
    expect(error).toBeNull();
    expect(items).toEqual([
      { content: "Đọc file", status: "in_progress" },
      { content: "Sửa", status: "completed" },
      { content: "Test", status: "pending" },
    ]);
    expect(todoListText(items)).toBe("[~] Đọc file\n[x] Sửa\n[ ] Test");
  });

  it("drops malformed rows instead of failing the whole list", () => {
    const { items, error } = parseTodoList(
      '[{"content":"Tốt","status":"pending"},{"content":"","status":"pending"},{"content":"Trạng thái lạ","status":"weird"}]'
    );
    expect(items).toHaveLength(1);
    expect(error).toContain("2 malformed");
  });

  it("rejects bodies that are not a JSON array", () => {
    expect(parseTodoList("{}").error).toContain("array");
    expect(parseTodoList("not json").error).toContain("invalid JSON");
    expect(parseTodoList("").error).toContain("empty");
    expect(parseTodoList("[]").error).toContain("no valid rows");
  });

  it("runs through the executor with a step summary the UI shows", async () => {
    const outcome = await executeTool(
      todo('[{"content":"Đọc file","status":"in_progress"},{"content":"Xong","status":"completed"}]'),
      "D:\\proj"
    );
    expect(outcome.message).toContain("[tool_result]");
    expect(outcome.message).toContain("[x] Xong");
    expect(outcome.activity.summary).toContain("1/2 xong");
    expect(outcome.activity.summary).toContain("đang: Đọc file");
  });
});

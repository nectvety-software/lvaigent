import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import { AGENT_SYS_PROMPT, buildAgentSysPrompt, executeTool } from "./agent";
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

You have access to six tools. To use one, emit exactly one tool block on its
own line, BEFORE writing your answer. Self-closing tools use this form:

  <tool name="list_files" />
  <tool name="glob" pattern="<glob like src/**/*.ts>" />
  <tool name="read_file" path="<path>" start_line="<optional 0-based line to continue from>" />
  <tool name="grep" query="<text to search>" />
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

Rules:
1. Read the relevant file(s) BEFORE answering or editing. Do NOT guess APIs.
2. MAY emit several tool blocks in one turn when multiple files are needed.
3. When tool results arrive, examine them and produce ONE final plain-text
   answer. Do not re-request an answered tool.
4. All paths stay inside the project root. write_file REPLACES the whole
   file: read first (note the 1-based line numbers), then write the full new
   content. To move code, read all sides, then write all sides.
5. run_command runs from the project root (120s timeout, non-interactive
   stdin); prefer short commands, avoid long-running servers. It may ask the
   user for permission.
6. The shell is PowerShell on Windows. One command per tool block: it is not a
   terminal, so nothing is interactive and no prompt is shown. Never append a bare
   Write-Output/Echo with no argument — that throws and fails the whole line after
   the useful part already ran. If a command fails, read [command_hint] and fix the
   cause rather than re-running a variation of the same line.
7. After you start writing the answer, do not emit further tool blocks.
8. Tool blocks are stripped before the user sees your message — never explain
   them.

Coding workflow (implement / fix / generate code):
1. The first message already carries a [Codebase] map: file index with line
   counts, key configs, and Verify commands. Use it for orientation — do not
   re-list the whole tree.
2. Study what you will touch: glob for candidates, then read_file with line
   numbers. For large files continue with start_line.
3. Implement with write_file (full exact content). Create new files freely
   (parents are created); rewrite existing files completely.
4. Verify with run_command using the Verify hints from [Codebase]
   (build / test / lint). On failure: read the error, fix, re-verify.
5. Finish with a short summary: files changed, what each change does, and how
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
    expect(prompt).toContain("You have access to five tools.");
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
    // 7 rules became 6, 5 workflow steps became 4 — with no gap in the numbering.
    expect(prompt).toContain("6. Tool blocks are stripped");
    expect(prompt).not.toContain("7. Tool blocks are stripped");
    expect(prompt).toContain("4. Finish with a short summary");
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
    expect(SKILLS.filter((s) => s.syntax !== null)).toHaveLength(5);
    expect(SKILLS.find((s) => s.id === "write_file")?.syntax).toBeNull();
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

  it("says nothing extra when the command succeeded", async () => {
    invokeMock.mockResolvedValue({
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

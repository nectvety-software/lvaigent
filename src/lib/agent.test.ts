import { describe, expect, it } from "vitest";
import {
  resolveProjectPath,
  parseToolCalls,
  stripToolBlocks,
  toolCallText,
  composeAgentRequest,
  buildToolProtocolReminder,
  diagnoseCommandFailure,
  looksLikeToolRefusal,
  AGENT_SYS_PROMPT,
} from "./agent";
import { ALL_SKILL_IDS } from "./skills";

describe("diagnoseCommandFailure", () => {
  const run = (over: Partial<Parameters<typeof diagnoseCommandFailure>[1]> = {}) => ({
    exit_code: 1,
    stdout: "",
    stderr: "",
    timed_out: false,
    ...over,
  });

  it("stays silent on a clean run", () => {
    expect(diagnoseCommandFailure("npm test", run({ exit_code: 0 }), "powershell")).toEqual([]);
  });

  it("names the real mistake in the reported failure", () => {
    // Verbatim from the report: `Get-ChildItem -Force; Write-Output`. The listing
    // ran fine; the bare Write-Output has no argument, so PowerShell threw and
    // the whole line came back exit 1. Without this the model had nothing to act
    // on and kept re-issuing variants of the same broken line.
    const stderr =
      "Write-Output : Cannot process command because of one or more missing mandatory parameters: InputObject.";
    const hints = diagnoseCommandFailure(
      "Get-ChildItem -Force; Write-Output",
      run({ stderr, stdout: "package.json" }),
      "powershell"
    ).join("\n");

    expect(hints).toContain("[command_hint]");
    expect(hints).toContain("required argument");
    expect(hints).toContain("Never append a bare Write-Output");
    // The actionable warning: do not just retry the same thing.
    expect(hints).toContain("do not repeat the same command");
  });

  it("tells the model a missing program is a PATH problem", () => {
    const hints = diagnoseCommandFailure(
      "cmake --build",
      run({ stderr: "cmake : The term 'cmake' is not recognized as a name of a cmdlet" }),
      "powershell"
    ).join("\n");
    expect(hints).toContain("not found on this machine");
    // The actionable half: DuckChat really does search pinned folders first, so
    // the model should point the user there instead of concluding the tool is
    // not installed.
    expect(hints).toContain("Đường dẫn PATH bổ sung");
    expect(hints).toContain("full path");
  });

  it("handles a timeout as its own case, not a generic failure", () => {
    const hints = diagnoseCommandFailure("npm run dev", run({ timed_out: true }), "bash").join("\n");
    expect(hints).toContain("120s timeout");
    expect(hints).toContain("Do not re-run the same command");
  });

  it("falls back to a usable hint when there is no stderr to read", () => {
    const hints = diagnoseCommandFailure("lua build.lua", run({ exit_code: 127 }), "powershell").join(
      "\n"
    );
    expect(hints).toContain("exited 127");
  });

  it("spots a multi-statement line that ran, then failed on a later statement", () => {
    // The shape the report actually produced: output arrived (so the early
    // statements ran) and the line still failed, which means re-running the whole
    // line is the wrong move — the fix is to re-issue only what failed.
    const hints = diagnoseCommandFailure(
      "Get-ChildItem; Write-Output",
      run({ stdout: "a.txt", stderr: "some unrelated note" }),
      "powershell"
    ).join("\n");
    // Matched against the joined text, so the assertion has to survive the line
    // wrapping inside the hint itself.
    expect(hints.replace(/\s+/g, " ")).toContain("an earlier statement ran and a later one did not");
    expect(hints.replace(/\s+/g, " ")).toContain("Re-run the failing statement on its own");
  });
});

describe("buildToolProtocolReminder", () => {
  it("re-states the syntax of every enabled tool", () => {
    const text = buildToolProtocolReminder(ALL_SKILL_IDS);
    for (const id of ALL_SKILL_IDS) {
      expect(text, id).toContain(`name="${id}"`);
    }
  });

  it("omits a tool the user turned off, so it cannot promise a disabled skill", () => {
    const text = buildToolProtocolReminder(ALL_SKILL_IDS.filter((s) => s !== "run_command"));
    expect(text).not.toContain('name="run_command"');
  });

  it("never invites the refusal it is meant to cure", () => {
    // The old tail asked the model to name an unavailable tool "and why", which
    // read as permission to refuse. "không khả dụng trong phiên này" survived a
    // single reminder, so later attempts have to reject the claim outright.
    const first = buildToolProtocolReminder(ALL_SKILL_IDS, 1);
    expect(first).not.toMatch(/if a tool is genuinely unavailable/i);
    expect(first).toContain("not function calls from this chat site");
    const later = buildToolProtocolReminder(ALL_SKILL_IDS, 2);
    expect(later).toContain("That claim is wrong");
    expect(later).not.toMatch(/^\[tool_protocol_reminder\]$/m);
  });

  it("stays short: the full prompt is already in the history", () => {
    // A second copy of the codebase map would blow duck.ai's input budget.
    expect(buildToolProtocolReminder(ALL_SKILL_IDS).length).toBeLessThan(1400);
  });
});

describe("looksLikeToolRefusal", () => {
  it("catches the reported prose, in the app's own language", () => {
    // Verbatim from the bug report: the model listing the very tools it has.
    expect(
      looksLikeToolRefusal(
        "Mình chưa thể thực hiện thay đổi hoặc chạy kiểm tra vì phiên làm việc này không cung cấp các tool thao tác project (read_file, write_file, run_command)."
      )
    ).toBe(true);
    expect(
      looksLikeToolRefusal(
        "Hãy bật lại quyền truy cập coding tools hoặc gửi nội dung các file sau đây."
      )
    ).toBe(true);
  });

  it("catches the third form of the report, which lists the tools it lacks", async () => {
    // Latest screenshot: the model enumerates the five project tools by name and
    // says only web tools exist. "Công cụ" + "không" in one clause, so the
    // detector has to match on capability wording, not the literal word "tool".
    expect(
      looksLikeToolRefusal(
        "Công cụ dự án read_file, glob, grep, write_file và run_command không khả dụng trong phiên này; chỉ có các công cụ web, nên mình không thể đọc hoặc chỉnh sửa code mà không đoán cầu trúc hiện tại."
      )
    ).toBe(true);
  });

  it("catches the second form of the report, which never says 'tool'", () => {
    // The follow-up screenshot: the model stopped naming tools and instead said it
    // only has "danh sách file", has no "nội dung mã nguồn", and asked the user to
    // "bật quyền truy cập project". Matching only on tool nouns missed this whole
    // form, which is why the corrective turn never fired and the agent stayed stuck.
    expect(
      looksLikeToolRefusal(
        "Hiện mình chỉ có danh sách file và mô tả từ đó ánh, chưa có nội dung mã nguồn để thay thế an toàn. Hãy gửi nội dung các file trên hoặc bật quyền truy cập project, mình sẽ viết lại trực tiếp phần giao diện và gameplay theo phong cách pop art nông trại."
      )
    ).toBe(true);
    expect(
      looksLikeToolRefusal("Mình không có quyền truy cập vào project để đọc nội dung file.")
    ).toBe(true);
    // Asking the user to grant access counts as a refusal even when the sentence
    // names no capability noun — "bật quyền truy cập" is only ever said by a model
    // that cannot reach the project.
    expect(
      looksLikeToolRefusal("Bạn cần bật quyền truy cập project trước khi mình làm được.")
    ).toBe(true);
  });

  it("catches the English form", () => {
    expect(looksLikeToolRefusal("I cannot access any tools in this session.")).toBe(true);
    expect(looksLikeToolRefusal("No project tools are available here.")).toBe(true);
    expect(
      looksLikeToolRefusal("I have no access to the project files — paste their contents.")
    ).toBe(true);
  });

  it("catches a refusal that names only the tool itself", () => {
    // Verbatim from the live run after the prompt framing was added. Nothing in
    // the general capability-noun set matches: "run_command" has no word boundary
    // around "command", and the sentence never says "công cụ" or "tool" alone.
    expect(
      looksLikeToolRefusal(
        "Mình không thể phát hành block `run_command` trong môi trường chat hiện tại, nên chưa chạy được `help` và không có đầu ra thực tế để báo cáo."
      )
    ).toBe(true);
    expect(looksLikeToolRefusal("I cannot emit a tool block here.")).toBe(true);
    // Naming a tool without claiming to be unable to use it stays a normal answer.
    expect(looksLikeToolRefusal("Mình không cần grep cũng trả lời được.")).toBe(false);
  });

  it("stays quiet on an ordinary answer that happens to mention a tool", () => {
    expect(looksLikeToolRefusal("Không có gì cần sửa, mọi thứ đã ổn.")).toBe(false);
    expect(looksLikeToolRefusal("Hàm này dùng read_file để đọc file.")).toBe(false);
    expect(looksLikeToolRefusal("")).toBe(false);
  });

  it("stays quiet on a normal answer that merely mentions project access", () => {
    // A completed turn must not trigger a retry just because it says "project".
    expect(
      looksLikeToolRefusal("Đã cập nhật xong. Bạn có thể xem lại phần giao diện trong project.")
    ).toBe(false);
  });

  it("stays quiet when the turn did use a tool — the protocol was followed", () => {
    // Otherwise every normal tool turn would trigger a pointless retry.
    const text = '<tool name="read_file" path="a.ts" />\nKhông có gì cần sửa.';
    expect(looksLikeToolRefusal(text)).toBe(false);
  });
});

describe("resolveProjectPath", () => {
  it("passes absolute Windows paths through untouched", () => {
    expect(resolveProjectPath("C:\\work\\a.ts", "D:/proj")).toBe("C:\\work\\a.ts");
    expect(resolveProjectPath("D:/x/y.ts", "D:/proj")).toBe("D:/x/y.ts");
    expect(resolveProjectPath("\\\\host\\share\\f", "D:/proj")).toBe("\\\\host\\share\\f");
  });

  it("passes absolute POSIX paths through untouched", () => {
    expect(resolveProjectPath("/usr/local/a.ts", "/home/u/proj")).toBe("/usr/local/a.ts");
  });

  it("joins relative paths with the project root", () => {
    expect(resolveProjectPath("src/a.ts", "D:/proj")).toBe("D:/proj\\src/a.ts");
    // Leading-slash paths are treated as absolute POSIX -> pass-through.
    expect(resolveProjectPath("/rel.ts", "D:/proj")).toBe("/rel.ts");
  });

  it("returns the path unchanged when there is no root", () => {
    expect(resolveProjectPath("src/a.ts", null)).toBe("src/a.ts");
  });
});

describe("parseToolCalls", () => {
  it("parses self-closing tool blocks with attributes", () => {
    const tools = parseToolCalls('<tool name="read_file" path="src/a.ts" />');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("read_file");
    expect(tools[0].args.path).toBe("src/a.ts");
  });

  it("parses write_file blocks and extracts the content body", () => {
    const text = '<tool name="write_file" path="a.ts">\n<content>\nhello\nworld\n</content>\n</tool>';
    const tools = parseToolCalls(text);
    expect(tools).toHaveLength(1);
    expect(tools[0].args.content).toBe("\nhello\nworld\n");
  });

  it("returns no tools for plain text", () => {
    expect(parseToolCalls("just an answer, no tools")).toHaveLength(0);
  });

  it("parses '>' inside quoted attributes (shell redirections)", () => {
    // Verbatim from the bug report: nemotron emitted `2>nul` probes and every
    // call leaked to the chat as plain text because the old attribute class
    // rejected '>', so neither execution nor stripping ever saw them.
    const text =
      '<tool name="run_command" command="where mame 2>nul; where bgb 2>nul" />\n' +
      '<tool name="run_command" command="dir \'C:\\Program Files\\mGBA\' 2>nul" />';
    const tools = parseToolCalls(text);
    expect(tools).toHaveLength(2);
    expect(tools[0].args.command).toBe("where mame 2>nul; where bgb 2>nul");
    expect(tools[1].args.command).toBe("dir 'C:\\Program Files\\mGBA' 2>nul");
  });
});

describe("toolCallText", () => {
  it("round-trips a command containing redirections and both quote kinds", () => {
    const t = parseToolCalls('<tool name="run_command" command="dir \'x y\' 2>nul" />')[0];
    const echoed = toolCallText(t);
    expect(parseToolCalls(echoed)[0].args.command).toBe("dir 'x y' 2>nul");
  });
});

describe("stripToolBlocks", () => {
  it("removes tool blocks from assistant text", () => {
    const text = 'before\n<tool name="list_files" />\nafter';
    // 3+ newlines are collapsed to exactly one blank line.
    expect(stripToolBlocks(text)).toBe("before\n\nafter");
  });

  it("removes write_file blocks including content", () => {
    const text = '<tool name="write_file" path="a.ts">\n<content>x</content>\n</tool>\ndone';
    expect(stripToolBlocks(text)).toBe("done");
  });

  it("strips blocks whose attributes contain '>'", () => {
    const text =
      'ok\n<tool name="run_command" command="where mame 2>nul; where retroarch 2>nul" />\ntail';
    expect(stripToolBlocks(text)).toBe("ok\n\ntail");
  });
});

describe("composeAgentRequest", () => {
  const base = {
    systemPrompt: "SYSTEM RULES",
    contextBlock: "[Codebase]\nfiles: 3",
    userContent: "fix the bug",
  };

  it("uses a real system role for API providers, without duplicating the prompt", () => {
    const req = composeAgentRequest({ ...base, transport: "role-system" });
    expect(req.system).toBe("SYSTEM RULES");
    // The bug this locks down: the system prompt used to be embedded in the user
    // message as well, so the model received it twice.
    expect(req.userText).not.toContain("SYSTEM RULES");
    expect(req.userText).toBe("[Codebase]\nfiles: 3\n\nfix the bug");
  });

  it("folds the prompt into the user text for duck.ai, which rejects role=system", () => {
    const req = composeAgentRequest({ ...base, transport: "folded" });
    expect(req.system).toBe("");
    expect(req.userText).toBe(
      "SYSTEM RULES\n\n[Codebase]\nfiles: 3\n\nfix the bug",
    );
  });

  it("sends the caller's prompt verbatim — never a fallback", () => {
    // Turning the System prompt section off must leave the agent with no tool
    // protocol. A `|| AGENT_SYS_PROMPT` fallback silently defeated that, so the
    // setting looked broken on the duck.ai transport.
    const off = composeAgentRequest({
      systemPrompt: "",
      contextBlock: null,
      userContent: "hello",
      transport: "folded",
    });
    expect(off.userText).toBe("hello");
    expect(off.userText).not.toContain(AGENT_SYS_PROMPT);
  });

  it("omits the context section cleanly when there is none", () => {
    const req = composeAgentRequest({
      systemPrompt: "S",
      contextBlock: null,
      userContent: "hello",
      transport: "role-system",
    });
    expect(req.userText).toBe("hello");
  });

  it("still carries the context when the system prompt is off", () => {
    const req = composeAgentRequest({
      systemPrompt: "",
      contextBlock: "[Codebase]\nfiles: 3",
      userContent: "hello",
      transport: "role-system",
    });
    expect(req.system).toBe("");
    expect(req.userText).toBe("[Codebase]\nfiles: 3\n\nhello");
  });
});

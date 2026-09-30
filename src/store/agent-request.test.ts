import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

/** Every `Channel` the transport created, so a test can replay server events. */
const channels: { onmessage: ((m: unknown) => void) | null }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
    constructor() {
      channels.push(this);
    }
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// The PoW transport needs a challenge hash and a durable-stream ticket before it
// will build a payload; stub both so the test can reach the request itself.
// `solveFailure` reproduces the other way the direct transport dies: duck.ai's
// status call refusing to hand out a challenge at all.
let solveFailure: string | null = null;
vi.mock("../lib/duckai", () => ({
  ensureVqdHash: async () => {
    if (solveFailure) throw new Error(solveFailure);
    return "test-hash";
  },
  generateDurableStream: async () => ({
    messageId: "m1",
    conversationId: "c1",
    publicKey: "pk",
  }),
  getFeSignals: () => ({}),
  invalidateVqdHash: () => {},
  getCachedVqdInfo: () => null,
}));

// The driver transport. `null` means "no healthy bridge" and the send falls back
// to the PoW path; a fake driver object means the real-SPA path, which is the
// only one where a duck.ai thread is created and then reused.
let fakeDriver: {
  send: (text: string, opts: { fresh: boolean }) => Promise<unknown>;
  healthy: boolean;
} | null = null;
vi.mock("../lib/duckai-driver", () => ({
  getDriver: async () => fakeDriver,
}));

/**
 * The standard-API transport, captured rather than sent.
 *
 * duck.ai and a normal provider are genuinely different shapes: duck.ai has no
 * system role so the prompt is folded into the first user message, while an API
 * provider gets a real `system` message. Both bugs this file locks down lived on
 * the boundary between those two, so the capture has to be per-transport.
 */
const apiCapture = vi.fn();
vi.mock("../lib/api-chat", () => ({
  streamApiChat: (...args: unknown[]) => apiCapture(...args),
}));

import { useStore, resetSpaThread } from "./index";
import {
  flushParkedRetry,
  getBridgeWatcherStatus,
  stopBridgeWatcherForTests,
} from "../lib/bridge-watcher";
import { MAX_TOOL_REFUSAL_RETRY_TURNS, SPA_MESSAGE_LIMIT } from "../lib/agent";
import { MAX_NAMED_FILE_CHARS } from "../lib/user-signals";
import { ALL_PROMPT_SECTION_IDS, ALL_SKILL_IDS } from "../lib/skills";
import type { Conversation } from "../types";

const AGENT_SRC = "export function composeAgentRequest() {}";
const ROOT = "D:\\proj";

/**
 * The real-SPA duck.ai thread and the prompt it was built with.
 *
 * This has to run on the DRIVER path. The PoW path rebuilds the whole message
 * list on every send, so the current prompt always goes out and a stale thread
 * cannot affect it — a test there passes with or without this fix (it did, the
 * first time round). Only the driver types a message into a duck.ai page whose
 * history we do not control, and that page is reused for the whole app session.
 *
 * So: after a prompt change the old page still contains the OLD prompt and the
 * OLD "I have no project tools" turns, and the model keeps answering from that
 * history no matter what the new turn says. That is why three earlier fixes to
 * the prompt all failed to change the observed behaviour.
 */
describe("a duck.ai thread is abandoned when the prompt it was built with changes", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    channels.length = 0;
    apiCapture.mockReset();
    apiCapture.mockResolvedValue("ok");
    // Every other suite in this file exercises the PoW path, so a driver left
    // installed here would silently reroute them.
    fakeDriver = null;
    // The duck.ai thread lives in a module-level variable, so a thread claimed by
    // an earlier test would make this one start on a thread it never opened —
    // which reads as "the first send was not fresh" and hides the real behaviour.
    resetSpaThread();
    useStore.setState({
      settings: {
        ...useStore.getState().settings,
        disabledPrompts: [],
        disabledSkills: [],
        agentMode: "build",
      },
    });
  });

  /** A driver that records every send and its `fresh` flag. */
  function installDriver(answer = "ok") {
    const sends: { text: string; fresh: boolean }[] = [];
    fakeDriver = {
      healthy: true,
      send: async (text: string, opts: { fresh: boolean }) => {
        sends.push({ text, fresh: opts.fresh });
        return { text: answer, errors: [], actions: [] };
      },
    };
    return sends;
  }

  function seedConv(): void {
    const conv: Conversation = {
      id: "c1",
      title: "t",
      messages: [],
      model: "gpt-5",
      createdAt: 1,
      updatedAt: 1,
      workspacePath: ROOT,
    };
    useStore.setState({
      conversations: [conv],
      activeConversationId: "c1",
      activeWorkspacePath: ROOT,
      currentProject: {
        id: "p",
        name: "proj",
        path: ROOT,
        files: [{ name: "agent.ts", path: "src/lib/agent.ts", is_dir: false }],
        openedAt: 1,
      },
      projectOverview: null,
      attachedFiles: [],
      projectSync: { status: "ready", path: ROOT, error: null },
      toasts: [],
    });
  }

  it("opens a NEW thread when a Skills toggle changes the prompt", async () => {
    seedConv();
    const sends = installDriver();

    await useStore.getState().sendDuckChat("c1", "sửa src/lib/agent.ts");
    expect(sends[0].fresh, "the first send must open a thread").toBe(true);
    expect(sends[0].text).toContain('name="grep"');

    // Turning a skill off changes the prompt, so the thread that documents the
    // old set must be abandoned rather than continued.
    useStore.getState().setSkillEnabled("grep", false);
    await useStore.getState().sendDuckChat("c1", "tiếp tục");

    expect(sends[1].fresh, "a changed prompt must not reuse the old thread").toBe(true);
    expect(sends[1].text).not.toContain('name="grep"');
    expect(sends[1].text).toContain('name="write_file"');
  });

  it("opens a NEW thread when switching Build -> Plan", async () => {
    seedConv();
    const sends = installDriver();

    await useStore.getState().sendDuckChat("c1", "sửa src/lib/agent.ts");
    expect(sends[0].text).not.toContain("MODE: PLAN");

    useStore.getState().setAgentMode("plan");
    await useStore.getState().sendDuckChat("c1", "tiếp tục");

    // Plan rules genuinely change what the agent may do, so a thread built
    // without them must not be continued.
    expect(sends[1].fresh).toBe(true);
    expect(sends[1].text).toContain("MODE: PLAN");
  });

  it("keeps ONE thread when nothing changed, so follow-ups still have context", async () => {
    // The counterpart, and the reason the check is a signature rather than a
    // blanket "always start fresh": opening a thread per message would break
    // every follow-up ("tiếp tục") that depends on prior context.
    seedConv();
    const sends = installDriver();

    await useStore.getState().sendDuckChat("c1", "sửa src/lib/agent.ts");
    await useStore.getState().sendDuckChat("c1", "tiếp tục");
    await useStore.getState().sendDuckChat("c1", "tiếp tục nữa");

    expect(sends[0].fresh).toBe(true);
    expect(sends[1].fresh, "an unchanged prompt must reuse the thread").toBe(false);
    expect(sends[2].fresh).toBe(false);
  });

  it("a reused thread still carries the CURRENT prompt, not a bare message", async () => {
    // What a reused turn actually sends: the first turn of a send always folds
    // in the project context and the agent prompt, because the SPA thread holds
    // no per-send state of ours. So "reuse" is about which duck.ai page we type
    // into, not about what we type. Asserting the real shape, so the thread
    // tests above cannot pass for the wrong reason.
    seedConv();
    const sends = installDriver();

    await useStore.getState().sendDuckChat("c1", "sửa src/lib/agent.ts");
    await useStore.getState().sendDuckChat("c1", "tiếp tục");

    expect(sends[1].fresh, "the second send must continue the thread").toBe(false);
    expect(sends[1].text).toContain("tiếp tục");
    expect(sends[1].text).toContain("<tool name=");
    for (const id of ALL_SKILL_IDS) {
      expect(sends[1].text, id).toContain(`name="${id}"`);
    }
  });

  it("the default prompt documents every skill, so a fresh thread is usable", async () => {
    // Guards the premise of all of the above: if the default prompt were
    // incomplete, opening a new thread would make things worse, not better.
    seedConv();
    const sends = installDriver();

    await useStore.getState().sendDuckChat("c1", "sửa src/lib/agent.ts");
    for (const id of ALL_SKILL_IDS) {
      expect(sends[0].text, id).toContain(`name="${id}"`);
    }
  });
});

/** Any provider whose id is not `provider_duckai` takes the standard-API path. */
const API_PROVIDER = {
  id: "provider_test_api",
  name: "TestAPI",
  baseUrl: "https://example.test/v1",
  apiKey: "k",
  apiFormat: "openai" as const,
  models: [{ id: "gpt-5", name: "GPT-5", enabled: true }],
  status: "connected" as const,
};

/**
 * The wiring these lock down:
 *
 *   The pure pieces (classifying the request, extracting the paths it names,
 *   composing the payload) are tested on their own. This file proves the send
 *   loop actually *calls* them with the right things — the half that a unit test
 *   of a pure function cannot see, and where the transport bug lived.
 */

function seed(opts: { content?: string; sections?: string[]; api?: boolean } = {}): string {
  const conv: Conversation = {
    id: "c1",
    title: "t",
    messages: [],
    model: "gpt-5",
    createdAt: 1,
    updatedAt: 1,
    workspacePath: ROOT,
  };
  const settings = {
    ...useStore.getState().settings,
    disabledPrompts: opts.sections
      ? ALL_PROMPT_SECTION_IDS.filter((s) => !opts.sections!.includes(s))
      : [],
    ...(opts.api ? { selectedProvider: API_PROVIDER.id } : {}),
  };
  useStore.setState({
    conversations: [conv],
    activeConversationId: "c1",
    activeWorkspacePath: ROOT,
    ...(opts.api ? { providers: [API_PROVIDER] } : {}),
    currentProject: {
      id: "p",
      name: "proj",
      path: ROOT,
      files: [
        { name: "agent.ts", path: "src/lib/agent.ts", is_dir: false },
        { name: "index.ts", path: "src/store/index.ts", is_dir: false },
      ],
      openedAt: 1,
    },
    projectOverview: null,
    attachedFiles: [],
    agentMode: "build",
    settings,
    projectSync: { status: "ready", path: ROOT, error: null },
    toasts: [],
  });
  return "c1";
}

/** Drive one send and return the wire messages it handed to the backend. */
async function sendAndCapture(userContent: string): Promise<{ role: string; content: string }[]> {
  const convId = seed();
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_file_content") {
      const path = String(args?.path ?? "");
      if (path.endsWith("agent.ts")) return Promise.resolve(AGENT_SRC);
      return Promise.reject(new Error("ENOENT"));
    }
    if (cmd === "duckchat_stream") return Promise.resolve(undefined);
    return Promise.resolve(null);
  });

  await useStore.getState().sendDuckChat(convId, userContent);

  const call = invokeMock.mock.calls.find((c) => c[0] === "duckchat_stream");
  if (!call) throw new Error("no duckchat_stream call — the send never reached the transport");
  return (call[1] as { messages: { role: string; content: string }[] }).messages;
}

beforeEach(() => {
  invokeMock.mockReset();
  channels.length = 0;
  apiCapture.mockReset();
  apiCapture.mockResolvedValue("ok");
  fakeDriver = null;
});

/**
 * The reported bug: the model answers in prose ("this session has no project
 * tools") instead of emitting `<tool …>`, and the loop used to break and render
 * that prose as the final answer — the user saw an agent that "không gọi lệnh
 * được" while every tool was enabled and working.
 *
 * These lock down the recovery: one corrective turn carrying the tool syntax, and
 * exactly one (never a loop).
 */
describe("a turn that claims to have no tools gets one corrective retry", () => {
  // Verbatim from the bug report.
  const REFUSAL =
    "Mình chưa thể thực hiện thay đổi hoặc chạy kiểm tra vì phiên làm việc này không cung cấp các tool thao tác project (read_file, write_file, run_command).";
  /**
   * The follow-up report. Note it never says "tool": it claims it only has the
   * file list, has no source, and asks the user to "bật quyền truy cập project".
   * An earlier version of the detector required a tool noun in the sentence, so
   * this whole form slipped through and the retry never fired.
   */
  const ACCESS_REFUSAL =
    "Hiện mình chỉ có danh sách file và mô tả từ đó ánh, chưa có nội dung mã nguồn để thay thế an toàn. Hãy gửi nội dung các file trên hoặc bật quyền truy cập project, mình sẽ viết lại trực tiếp phần giao diện và gameplay theo phong cách pop art nông trại.";

  /** Replay one assistant turn into every Channel the transport opened. */
  function reply(text: string): void {
    for (const ch of channels) {
      ch.onmessage?.({ event: "delta", data: { text } });
      ch.onmessage?.({ event: "done" });
    }
  }

  function setup(onStream: () => void): string {
    const convId = seed();
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      // A real read result: without it `read_file_lines` resolves null, executeTool
      // throws, and the whole send aborts after one round.
      if (cmd === "read_file_lines") {
        return Promise.resolve({
          content: "export const composeAgentRequest = () => {};",
          total_lines: 1,
          start_line: 0,
          end_line: 1,
          truncated: false,
          path: String(args?.path ?? ""),
        });
      }
      if (cmd === "read_file_content") {
        return Promise.resolve(AGENT_SRC);
      }
      if (cmd === "duckchat_stream") {
        onStream();
        return Promise.resolve(undefined);
      }
      return Promise.resolve(null);
    });
    return convId;
  }

  /** The user messages of the Nth duckchat_stream call (0-based). */
  function userTextsOf(callIndex: number): string[] {
    const calls = invokeMock.mock.calls.filter((c) => c[0] === "duckchat_stream");
    const messages = (calls[callIndex][1] as { messages: { role: string; content: string }[] })
      .messages;
    return messages.filter((m) => m.role === "user").map((m) => m.content);
  }

  it("re-sends the turn with the tool syntax when the model refuses in prose", async () => {
    const convId = setup(() => reply(REFUSAL));

    await useStore.getState().sendDuckChat(convId, "hoàn thiện gameplay và chạy kiểm tra build");

    const calls = invokeMock.mock.calls.filter((c) => c[0] === "duckchat_stream");
    expect(
      calls.length,
      "the loop never retried after the refusal"
    ).toBe(1 + MAX_TOOL_REFUSAL_RETRY_TURNS);

    // The corrective turn must actually carry the syntax, not just "try again".
    const retryUserTexts = userTextsOf(1);
    expect(retryUserTexts.join("\n")).toContain("[tool_protocol_reminder]");
    expect(retryUserTexts.join("\n")).toContain('<tool name="write_file"');
    expect(retryUserTexts.join("\n")).toContain('<tool name="run_command"');
  });

  it("caps the corrective turns, so a stubborn model cannot loop forever", async () => {
    const convId = setup(() => reply(REFUSAL));

    await useStore.getState().sendDuckChat(convId, "hoàn thiện gameplay và chạy kiểm tra build");

    const calls = invokeMock.mock.calls.filter((c) => c[0] === "duckchat_stream");
    expect(calls.length).toBe(1 + MAX_TOOL_REFUSAL_RETRY_TURNS);

    // Once the budget is spent, the user gets an explanation instead of the bare
    // refusal: "run_command không khả dụng trong phiên này" read as if DuckChat
    // itself had no tools.
    const msg = useStore
      .getState()
      .conversations.find((c) => c.id === convId)!
      .messages.find((m) => m.role === "assistant")!;
    expect(msg.content).toContain("không phải trạng thái của lvaigent");
  });

  it("retries the 'grant me project access' form, which never mentions tools", async () => {
    // This is the exact wording from the latest report. The model claims it has
    // only a file list and asks the user to enable project access — no tool noun
    // anywhere. If the detector only looks for "tool", the loop breaks here and
    // the agent stays stuck saying it cannot write.
    const convId = setup(() => reply(ACCESS_REFUSAL));

    await useStore.getState().sendDuckChat(convId, "code game style pop art nông trại chăn nuôi");

    const calls = invokeMock.mock.calls.filter((c) => c[0] === "duckchat_stream");
    expect(
      calls.length,
      "the access-refusal form was not detected"
    ).toBe(1 + MAX_TOOL_REFUSAL_RETRY_TURNS);
    const retry = (calls[1][1] as { messages: { content: string }[] }).messages
      .map((m) => m.content)
      .join("\n");
    expect(retry).toContain("[tool_protocol_reminder]");
    expect(retry).toContain('<tool name="write_file"');
    expect(retry).toContain('<tool name="read_file"');
  });

  it("marks a failed command as an error step, not a green tick", async () => {
    // The screenshot showed three `exit 1 (failed)` rows all rendered with a
    // success check. The step status was derived only from the message prefix, and
    // a failed run_command is still a [tool_result] — the tool ran, the command
    // did not. This asserts the status the UI actually renders.
    // run_command asks for permission, and nothing in this test answers the
    // prompt — the send would sit there until the test times out. Full access is
    // the real-world setting this report was taken under anyway.
    useStore.getState().setFullAccess(true);
    const convId = seed();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "run_command") {
        return Promise.resolve({
          exit_code: 1,
          stdout: "",
          stderr: "boom",
          timed_out: false,
        });
      }
      if (cmd === "duckchat_stream") {
        for (const ch of channels) {
          ch.onmessage?.({
            event: "delta",
            data: { text: '<tool name="run_command" command="npm test" />' },
          });
          ch.onmessage?.({ event: "done" });
        }
        return Promise.resolve(undefined);
      }
      return Promise.resolve(null);
    });

    await useStore.getState().sendDuckChat(convId, "chạy test");

    const msg = useStore
      .getState()
      .conversations.find((c) => c.id === convId)!
      .messages.find((m) => m.role === "assistant")!;
    const step = msg.steps?.[0];
    expect(step, "no tool step was recorded").toBeTruthy();
    expect(step!.status, `step status was "${step!.status}"`).toBe("error");
  });

  it("a tool that throws becomes a [tool_error] round, not an aborted turn", async () => {
    // The report: `read_file package.json` on a project without that file made
    // the invoke reject with "The system cannot find the file specified.
    // (os error 2)". The rejection punched through the agent loop into the
    // outer catch, so the raw Rust error was painted as the final answer and
    // every later tool of the turn was stranded.
    let round = 0;
    const convId = seed();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "duckchat_stream") {
        round++;
        reply(
          round === 1
            ? '<tool name="read_file" path="package.json" />'
            : "Project không có package.json, bỏ qua bước đọc file đó."
        );
        return Promise.resolve(undefined);
      }
      if (cmd === "read_file_lines") {
        return Promise.reject(
          new Error("The system cannot find the file specified. (os error 2)")
        );
      }
      return Promise.resolve(null);
    });

    await useStore.getState().sendDuckChat(convId, "chạy giả lập và test");

    const calls = invokeMock.mock.calls.filter((c) => c[0] === "duckchat_stream");
    expect(calls.length, "the loop aborted instead of reporting the tool failure").toBe(2);
    const round2 = (calls[1][1] as { messages: { role: string; content: string }[] }).messages;
    const toolMsg = round2.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("[tool_error]");
    expect(toolMsg?.content).toContain("os error 2");

    const msg = useStore
      .getState()
      .conversations.find((c) => c.id === convId)!
      .messages.find((m) => m.role === "assistant")!;
    expect(msg.steps?.[0].status).toBe("error");
    expect(msg.content).toBe("Project không có package.json, bỏ qua bước đọc file đó.");
  });

  it("still re-states the protocol on a normal tool round, not only on a refusal", async () => {
    // THE regression test for the reported bug. Round 1 is a plain, successful
    // read_file turn — the model did nothing wrong. But from round 2 on we used to
    // send a bare `[tool_result] …`, and the model then declared write_file and
    // run_command "không khả dụng trong phiên này". The protocol must ride along
    // on every hop, whether or not the model misbehaved.
    const convId = setup(() => {
      reply('<tool name="read_file" path="src/lib/agent.ts" />');
    });

    await useStore.getState().sendDuckChat(convId, "đọc src/lib/agent.ts rồi sửa");

    const calls = invokeMock.mock.calls.filter((c) => c[0] === "duckchat_stream");
    expect(calls.length, "the read never came back for a second round").toBeGreaterThan(1);

    // The round that carries the tool results must also carry the syntax.
    // Read the raw wire messages, not the user text: the backend folds
    // role="tool" into a user message at send time, so asserting on user text
    // here would test the backend's transform instead of what this loop built.
    const round2 = (calls[1][1] as { messages: { role: string; content: string }[] }).messages;
    expect(round2.some((m) => m.role === "tool"), "round 2 carried no tool result").toBe(true);
    const round2Text = round2.map((m) => m.content).join("\n");
    expect(round2Text, "round 2 lost the tool protocol").toContain("[tool_protocol_reminder]");
    expect(round2Text).toContain('<tool name="write_file"');
    expect(round2Text).toContain('<tool name="run_command"');
  });

  it("keeps re-stating the protocol on every later round, not just round 2", async () => {
    // One reminder is not enough: the model forgets again a few turns later, which
    // is exactly how it managed to read the files and then claim it could not write.
    const convId = setup(() => {
      reply('<tool name="read_file" path="src/lib/agent.ts" />');
    });

    await useStore.getState().sendDuckChat(convId, "đọc rồi sửa src/lib/agent.ts");

    const calls = invokeMock.mock.calls.filter((c) => c[0] === "duckchat_stream");
    expect(calls.length, "the loop never reached a second round").toBeGreaterThan(1);
    for (let i = 1; i < calls.length; i++) {
      const text = (calls[i][1] as { messages: { content: string }[] }).messages
        .map((m) => m.content)
        .join("\n");
      expect(text, `round ${i + 1} lost the protocol`).toContain("[tool_protocol_reminder]");
    }
  });
});

describe("the send loop reads the message before it reads the codebase", () => {
  it("pre-reads a file the user named and puts its content in the payload", async () => {
    const messages = await sendAndCapture("refactor src/lib/agent.ts");

    // read_file_content was actually called for the named path.
    const read = invokeMock.mock.calls.find(
      (c) => c[0] === "read_file_content" && String((c[1] as { path: string }).path).includes("agent.ts"),
    );
    expect(read, "the named file was never read").toBeTruthy();

    const firstUser = messages.find((m) => m.role === "user");
    expect(firstUser?.content).toContain("[Relevant file: src/lib/agent.ts]");
    expect(firstUser?.content).toContain(AGENT_SRC);
  });

  it("does not read a file the project does not have", async () => {
    await sendAndCapture("refactor src/ghost/missing.ts");
    const read = invokeMock.mock.calls.filter((c) => c[0] === "read_file_content");
    expect(read).toHaveLength(0);
  });

  it("carries the intent brief on the system message", async () => {
    const messages = await sendAndCapture("refactor src/lib/agent.ts");
    const system = messages.find((m) => m.role === "system");
    expect(system?.content).toContain("[Request: edit]");
    expect(system?.content).toContain("already read for you: src/lib/agent.ts");
  });

  it("steers a question away from editing, and keeps the file note", async () => {
    const messages = await sendAndCapture("what does `composeAgentRequest` do in src/lib/agent.ts?");
    const system = messages.find((m) => m.role === "system");
    expect(system?.content).toContain("[Request: question]");
    expect(system?.content).toContain("do not emit write_file");
    expect(system?.content).toContain("composeAgentRequest");
  });

  it("adds nothing to the prompt for a plain edit", async () => {
    const messages = await sendAndCapture("refactor the sidebar layout");
    const system = messages.find((m) => m.role === "system");
    expect(system?.content).not.toContain("[Request:");
  });

  it("omits the brief when the System prompt section is off", async () => {
    const convId = seed({ sections: ["codebase", "agentsMd", "attachments", "planRules"] });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "duckchat_stream") return Promise.resolve(undefined);
      return Promise.resolve(null);
    });
    await useStore.getState().sendDuckChat(convId, "refactor src/lib/agent.ts");

    const call = invokeMock.mock.calls.find((c) => c[0] === "duckchat_stream");
    const messages = (call![1] as { messages: { role: string; content: string }[] }).messages;
    const system = messages.find((m) => m.role === "system");
    // With the system prompt off there is no tool protocol, so no brief either.
    expect(system?.content ?? "").not.toContain("[Request:");
  });
});

/**
 * The other transport. A standard API provider takes `role-system`: a real
 * system message and the user text left alone.
 *
 * This used to be broken in two ways at once — the system message was the
 * hardcoded `AGENT_SYS_PROMPT` constant rather than the configured prompt (so
 * the Skills & Prompt toggles did nothing for API users), and the prompt was
 * *also* folded into the user text, sending it twice.
 */
describe("a standard API provider gets a real system role, not a folded prompt", () => {
  /** Drive one API send and return the messages handed to the provider. */
  async function sendAndCaptureApi(
    userContent: string,
    opts: { sections?: string[]; override?: string | null } = {},
  ): Promise<{ role: string; content: string }[]> {
    const convId = seed({ api: true, sections: opts.sections });
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_file_content") {
        const path = String(args?.path ?? "");
        if (path.endsWith("agent.ts")) return Promise.resolve(AGENT_SRC);
        return Promise.reject(new Error("ENOENT"));
      }
      return Promise.resolve(null);
    });

    await useStore.getState().sendDuckChat(convId, userContent, false, {
      systemPromptOverride: opts.override,
    });

    const call = apiCapture.mock.calls[0];
    if (!call) throw new Error("no streamApiChat call — the send never reached the API transport");
    return (call[1] as { messages: { role: string; content: string }[] }).messages;
  }

  it("sends the configured prompt as a system message", async () => {
    const messages = await sendAndCaptureApi("refactor src/lib/agent.ts", {
      override: "SENTINEL_SYS_7f3a",
    });

    const system = messages.find((m) => m.role === "system");
    expect(system, "the API path sent no system message").toBeTruthy();
    expect(system!.content).toContain("SENTINEL_SYS_7f3a");
  });

  it("does not fold the system prompt into the user text as well", async () => {
    // No override, so this is the *real* agent prompt — the one that used to be
    // duplicated into the user turn.
    const messages = await sendAndCaptureApi("refactor src/lib/agent.ts");

    const system = messages.find((m) => m.role === "system");
    const user = messages.find((m) => m.role === "user");
    expect(system, "the API path sent no system message").toBeTruthy();
    expect(user, "the API path sent no user message").toBeTruthy();

    // Probe with whatever the system message actually contains rather than a
    // hardcoded fragment, so this keeps biting if the prompt text changes.
    // (Asserting on the *override* sentinel here would not work: the old bug
    // folded the hardcoded constant, so the user turn never contained it.)
    const probe = system!.content.slice(0, 60);
    expect(probe.length, "system prompt too short to probe").toBeGreaterThan(20);
    expect(user!.content).not.toContain(probe);

    // …while the context block and the named file still ride along on the user turn.
    expect(user!.content).toContain("[Relevant file: src/lib/agent.ts]");
    expect(user!.content).toContain(AGENT_SRC);
  });

  it("carries the intent brief on the system message", async () => {
    const messages = await sendAndCaptureApi("refactor src/lib/agent.ts", {
      override: "SENTINEL_SYS_7f3a",
    });
    const system = messages.find((m) => m.role === "system");
    expect(system!.content).toContain("[Request: edit]");
  });

  it("respects the System prompt toggle instead of sending the hardcoded constant", async () => {
    // "system" off => no agent prompt at all. The buggy version sent the full
    // AGENT_SYS_PROMPT constant here regardless of the user's setting.
    const messages = await sendAndCaptureApi("refactor src/lib/agent.ts", {
      sections: ["codebase", "agentsMd", "attachments", "planRules"],
    });

    const system = messages.find((m) => m.role === "system");
    expect(system?.content ?? "").toBe("");
  });
});

/**
 * duck.ai's anti-bot refuses the direct PoW transport (`HTTP 418 …
 * ERR_CHALLENGE`, `429`, or no challenge handed out at all), so a send has to
 * find its way back to the bridge. Six separate bugs lived on that path: the
 * retry re-entered `sendDuckChat` as a brand-new turn (the chat showed the
 * user's message twice and the first bubble froze on its placeholder), the
 * bridge was given a single 1.5s recheck — not enough for a page that is still
 * reloading — giving up printed duck.ai's JSON or Rust's transport text as if it
 * were the answer, a send that gave up told the user to retype instead of
 * parking itself, a captcha fell through to PoW (which cannot solve one), and
 * the two fallbacks handed the turn back to each other without ever stopping.
 */
describe("a PoW refusal that falls back to the bridge keeps exactly one turn", () => {
  // Verbatim shape of the observed failure body.
  const CHALLENGE =
    'Error: HTTP 418 I\'m a teapot: {"action":"error","status":418,"type":"ERR_CHALLENGE","overrideCode":"3501"}';

  beforeEach(() => {
    invokeMock.mockReset();
    channels.length = 0;
    apiCapture.mockReset();
    solveFailure = null;
    resetSpaThread();
    // Also drops any send parked by the previous case, so `willRetry` below
    // reports this failure rather than an earlier one.
    stopBridgeWatcherForTests();
    useStore.setState({
      // A provider list left over from the API block would win here:
      // `activeProvider()` falls back to `providers[0]`, and that would send
      // these duck.ai transport tests down the standard-API path.
      providers: [],
      settings: {
        ...useStore.getState().settings,
        selectedProvider: "provider_duckai",
        disabledPrompts: [],
        disabledSkills: [],
        agentMode: "build",
      },
    });
  });

  /**
   * Refuse every PoW send, and let the bridge answer only after its `N`th
   * health check.
   *
   * The count is the point: a single recheck can never see a bridge that is
   * healthy on check 3, which is how a page that was still reloading got
   * reported as "bridge chưa sẵn sàng" while it was in fact fine.
   */
  function refusePoW(bridgeComesBack: boolean, checksToHealth = 4): { text: string }[] {
    const sends: { text: string }[] = [];
    let checks = 0;
    fakeDriver = bridgeComesBack
      ? {
          get healthy() {
            checks++;
            return checks >= checksToHealth;
          },
          send: async (
            text: string,
            opts: { fresh: boolean; onProgress?: (partial: string) => void }
          ) => {
            sends.push({ text });
            // The real driver streams through onProgress; without that call the
            // bubble would stay empty and the assertion below would test
            // nothing but the message count.
            opts.onProgress?.("đã xong qua bridge");
            return { text: "đã xong qua bridge", errors: [], actions: [] };
          },
        }
      : null;
    let streamCalls = 0;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      // The context builder reads AGENTS.md through these; a null result throws
      // before the send ever reaches the transport.
      if (cmd === "read_file_content") return Promise.resolve(AGENT_SRC);
      if (cmd === "read_file_lines") {
        return Promise.resolve({
          content: AGENT_SRC,
          total_lines: 1,
          start_line: 0,
          end_line: 1,
          truncated: false,
          path: String(args?.path ?? ""),
        });
      }
      if (cmd === "duckchat_stream") {
        streamCalls++;
        return Promise.reject(new Error(CHALLENGE));
      }
      return Promise.resolve(null);
    });
    return sends;
  }

  /** How many PoW requests this send burned before the transport gave up. */
  function powAttempts(): number {
    return invokeMock.mock.calls.filter((c) => c[0] === "duckchat_stream").length;
  }

  function turn(): { users: string[]; assistants: { content: string; isStreaming?: boolean }[] } {
    const msgs = useStore.getState().conversations[0].messages;
    return {
      users: msgs.filter((m) => m.role === "user").map((m) => m.content),
      assistants: msgs
        .filter((m) => m.role === "assistant")
        .map((m) => ({ content: m.content, isStreaming: m.isStreaming })),
    };
  }

  it("waits for a late bridge, then reuses the original turn and bubble", async () => {
    const convId = seed();
    // Health arrives on the 8th check: attempt 1 spends 2 of them (the first
    // read plus its single recheck), the two PoW burns add none, and the bridge
    // retry only reaches 8 if it probes the full budget. With the old
    // single-recheck retry the send stops at 4 and reports "bridge chưa sẵn
    // sàng" for a page that was about to answer.
    const sends = refusePoW(true, 8);

    await useStore
      .getState()
      .sendDuckChat(convId, "Trả lời đúng một từ: ok");

    expect(powAttempts(), "PoW was not burned exactly twice before the fallback").toBe(2);
    expect(sends, "the retry never reached the bridge").toHaveLength(1);
    const { users, assistants } = turn();
    expect(users, "the retried send appended a second copy of the user turn").toEqual([
      "Trả lời đúng một từ: ok",
    ]);
    expect(assistants, "the retry opened a second assistant bubble").toHaveLength(1);
    expect(assistants[0].content).toBe("đã xong qua bridge");
    expect(assistants[0].isStreaming).toBeFalsy();
  }, 30000);

  /** Poll the store until `pred` holds, so a fire-and-forget resend can settle. */
  async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 40) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return pred();
  }

  /**
   * The captcha path, end to end.
   *
   * duck.ai answers the bridge send with an image challenge, so the turn is
   * parked and floated — NOT handed to the PoW transport, which cannot solve a
   * captcha and only answers 418. The watcher's resend then carries what the
   * user actually wrote: parking the composed SPA message instead folded the
   * system prompt and the codebase map into a chat bubble twice.
   */
  it("parks a captcha-blocked turn, then resends the user's own text once", async () => {
    const convId = seed();
    const USER = "sentinel_turn_4f9c";
    const wire: string[] = [];
    let calls = 0;
    fakeDriver = {
      healthy: true,
      send: async (
        text: string,
        opts: { fresh: boolean; onProgress?: (partial: string) => void }
      ) => {
        wire.push(text);
        calls++;
        if (calls === 1) return { text: "", errors: ["captcha"], actions: [] };
        opts.onProgress?.("đã xong sau captcha");
        return { text: "đã xong sau captcha", errors: [], actions: [] };
      },
    };
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_file_content") return Promise.resolve(AGENT_SRC);
      if (cmd === "read_file_lines") {
        return Promise.resolve({
          content: AGENT_SRC,
          total_lines: 1,
          start_line: 0,
          end_line: 1,
          truncated: false,
          path: String(args?.path ?? ""),
        });
      }
      // Only reachable if a captcha-blocked send falls through to PoW.
      if (cmd === "duckchat_stream") return Promise.reject(new Error(CHALLENGE));
      return Promise.resolve(null);
    });

    await useStore.getState().sendDuckChat(convId, USER);

    expect(calls, "the captcha send did not reach the bridge").toBe(1);
    expect(powAttempts(), "a captcha-blocked send burned the PoW transport").toBe(0);
    const blocked = turn();
    expect(blocked.users).toEqual([USER]);
    expect(blocked.assistants).toHaveLength(1);
    expect(blocked.assistants[0].content).toContain("image challenge");
    expect(getBridgeWatcherStatus().willRetry, "the captcha-blocked send was not parked").toBe(
      true
    );

    // Challenge solved: the watcher's resend goes out on the bridge.
    await flushParkedRetry("captcha");
    const delivered = await waitFor(
      () => turn().assistants[0]?.content === "đã xong sau captcha"
    );
    expect(delivered, "the parked send was never resent").toBe(true);

    expect(calls, "the resend was not a single bridge send").toBe(2);
    const { users, assistants } = turn();
    expect(users, "the resent send appended a second user bubble").toEqual([USER]);
    expect(assistants, "the resent send opened a second assistant bubble").toHaveLength(1);
    const resent = wire[wire.length - 1];
    expect(
      resent.split(USER).length - 1,
      "the resent turn carried the user text more than once — a parked composed prompt"
    ).toBe(1);
    expect(
      getBridgeWatcherStatus().willRetry,
      "a delivered send stayed parked and would fire a third time"
    ).toBe(false);
    // The floated bridge is tucked away again once the turn is out.
    expect(
      invokeMock.mock.calls.some(
        (c) => c[0] === "show_bridge_window" && (c[1] as { show?: boolean })?.show === false
      ),
      "the auto-docked bridge window stayed floated after a delivered send"
    ).toBe(true);
  }, 40000);

  /**
   * The cascade must stop after one pass.
   *
   * A `preferBridge` run is the end of the chain by definition — PoW already
   * refused this turn — so a second bridge failure parks the send. Before that
   * bound the two fallbacks handed the turn back to each other, and every hop
   * cost another PoW 418 plus a bridge probe.
   */
  it("parks a bridge-only retry that fails again instead of restarting the cascade", async () => {
    const convId = seed();
    const USER = "Trả lời đúng một từ: ok";
    let calls = 0;
    fakeDriver = {
      healthy: true,
      send: async () => {
        calls++;
        // A wedged SPA thread: no captcha, no reply — the transport itself died.
        return { text: "", errors: ["bridge timeout"], actions: [] };
      },
    };
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_file_content") return Promise.resolve(AGENT_SRC);
      if (cmd === "read_file_lines") {
        return Promise.resolve({
          content: AGENT_SRC,
          total_lines: 1,
          start_line: 0,
          end_line: 1,
          truncated: false,
          path: String(args?.path ?? ""),
        });
      }
      if (cmd === "duckchat_stream") return Promise.reject(new Error(CHALLENGE));
      return Promise.resolve(null);
    });

    await useStore.getState().sendDuckChat(convId, USER);

    expect(calls, "bridge→PoW→bridge did not stop after one pass").toBe(2);
    expect(powAttempts(), "the refused PoW transport was attempted more than once").toBe(2);
    const { users, assistants } = turn();
    expect(users).toEqual([USER]);
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toContain("418");
    expect(assistants[0].content).not.toContain("ERR_CHALLENGE");
    expect(getBridgeWatcherStatus().willRetry, "the failed send was not parked").toBe(true);
  }, 40000);

  /**
   * The failure seen live on the installed build: duck.ai's status call handed
   * back no challenge to solve, so the PoW transport died before it even sent.
   * That text is a transport detail, not an answer — it must never be printed in
   * the chat as if the assistant had said it.
   */
  it("parks a send whose PoW challenge was never issued", async () => {
    const convId = seed();
    solveFailure = "No x-vqd-hash-1 header in status response";
    refusePoW(false);

    await useStore.getState().sendDuckChat(convId, "Trả lời đúng một từ: ok");

    const { users, assistants } = turn();
    expect(users).toEqual(["Trả lời đúng một từ: ok"]);
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toContain("418");
    expect(assistants[0].content).not.toContain("x-vqd");
    expect(getBridgeWatcherStatus().willRetry, "the failed send was not parked").toBe(true);
  }, 40000);

  it("parks the send and floats the bridge when the bridge never comes back", async () => {
    const convId = seed();
    refusePoW(false);

    await useStore.getState().sendDuckChat(convId, "Trả lời đúng một từ: ok");

    const { users, assistants } = turn();
    expect(users).toHaveLength(1);
    expect(assistants).toHaveLength(1);
    // The whole point of the fix: no raw duck.ai JSON in the chat.
    expect(assistants[0].content).toContain("418");
    expect(assistants[0].content).not.toContain("ERR_CHALLENGE");
    expect(assistants[0].isStreaming).toBeFalsy();
    // And the user is not asked to retype it: the send is parked for the
    // watcher, and the bridge window is opened so the cause is visible.
    expect(getBridgeWatcherStatus().willRetry, "the failed send was not parked").toBe(true);
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "show_bridge_window"),
      "the bridge window was never floated"
    ).toBe(true);
  }, 40000);
});

/**
 * The reason the cascade above still produced a dead send on the installed
 * build: duck.ai's composer is a hard 16,000-character field, and the folded
 * first turn (prompt + codebase map + AGENTS.md + pre-read files) walked past it
 * — the page answered "Please try a shorter message. 17042/16000", the bridge
 * reported a generic failure, and the PoW fallback came back with the 418
 * notice. So the length has to be handled where the turn is composed, and a
 * message that can never fit must be refused before either transport runs.
 */
describe("a turn bound for duck.ai never exceeds the composer limit", () => {
  /** Three files at `MAX_NAMED_FILE_CHARS`, i.e. the shape that hit 17,042. */
  const NAMED = ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => ({
    path,
    content: `// ${path}\n` + "y".repeat(MAX_NAMED_FILE_CHARS),
  }));

  beforeEach(() => {
    invokeMock.mockReset();
    channels.length = 0;
    apiCapture.mockReset();
    solveFailure = null;
    resetSpaThread();
    stopBridgeWatcherForTests();
    useStore.setState({
      providers: [],
      settings: {
        ...useStore.getState().settings,
        selectedProvider: "provider_duckai",
        disabledPrompts: [],
        disabledSkills: [],
        agentMode: "build",
      },
    });
  });

  /** A healthy bridge that records everything typed into it. */
  function recordSends(answer = "xong"): string[] {
    const sends: string[] = [];
    fakeDriver = {
      healthy: true,
      send: async (
        text: string,
        opts: { fresh: boolean; onProgress?: (partial: string) => void }
      ) => {
        sends.push(text);
        opts.onProgress?.(answer);
        return { text: answer, errors: [], actions: [] };
      },
    };
    return sends;
  }

  function serveNamedFiles(): void {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      const path = String(args?.path ?? "");
      if (cmd === "read_file_content") {
        const hit = NAMED.find((f) => path.endsWith(f.path));
        return Promise.resolve(hit?.content ?? "");
      }
      if (cmd === "read_file_lines") {
        const hit = NAMED.find((f) => path.endsWith(f.path));
        return Promise.resolve({
          content: hit?.content ?? "",
          total_lines: 1,
          start_line: 0,
          end_line: 1,
          truncated: false,
          path,
        });
      }
      return Promise.resolve(null);
    });
  }

  function projectWithNamedFiles(): void {
    useStore.setState({
      currentProject: {
        id: "p",
        name: "proj",
        path: ROOT,
        files: NAMED.map((f) => ({ name: f.path, path: f.path, is_dir: false })),
        openedAt: 1,
      },
    });
  }

  /** What the chat shows for this conversation. */
  function turnOf(id: string): {
    users: string[];
    assistants: { content: string; isStreaming?: boolean }[];
  } {
    const msgs = useStore.getState().conversations.find((c) => c.id === id)!.messages;
    return {
      users: msgs.filter((m) => m.role === "user").map((m) => m.content),
      assistants: msgs
        .filter((m) => m.role === "assistant")
        .map((m) => ({ content: m.content, isStreaming: m.isStreaming })),
    };
  }

  it("shortens a turn that names three full-size files instead of failing", async () => {
    const convId = seed();
    projectWithNamedFiles();
    serveNamedFiles();
    const sends = recordSends();

    await useStore.getState().sendDuckChat(convId, "sửa src/a.ts src/b.ts src/c.ts cho gọn");

    expect(sends, "the send never reached the bridge").toHaveLength(1);
    expect(
      sends[0].length,
      "duck.ai would have answered 'Please try a shorter message.'"
    ).toBeLessThanOrEqual(SPA_MESSAGE_LIMIT);
    // The user's own words and the pre-read code the request is about survive;
    // the orientation sections are what give way.
    expect(sends[0]).toContain("sửa src/a.ts src/b.ts src/c.ts cho gọn");
    expect(sends[0]).toContain(NAMED[0].content.slice(0, 120));
    expect(sends[0]).toContain('<tool name="write_file"');
  });

  it("refuses a message that cannot fit even with no context, and sends nothing", async () => {
    const convId = seed();
    serveNamedFiles();
    const sends = recordSends();
    const tooLong = "d".repeat(SPA_MESSAGE_LIMIT);

    await useStore.getState().sendDuckChat(convId, tooLong);

    expect(sends, "a turn that cannot fit was typed into duck.ai anyway").toHaveLength(0);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "duckchat_stream"),
      "a turn that cannot fit was handed to the PoW transport"
    ).toHaveLength(0);
    const { users, assistants } = turnOf(convId);
    expect(users).toEqual([tooLong]);
    expect(assistants[0].content).toContain("quá dài");
    expect(assistants[0].isStreaming).toBeFalsy();
    // Nothing to resend later: this failure is not a transport problem.
    expect(getBridgeWatcherStatus().willRetry, "an unsendable message got parked").toBe(false);
  });

  it("keeps a tool round inside the limit when one result is oversized", async () => {
    // `capToolMessage` allows 20,000 characters per tool message, which is more
    // than the composer takes — so round 2 used to die on the same limit as the
    // first turn, one step later.
    const convId = seed();
    serveNamedFiles();
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      const path = String(args?.path ?? "");
      if (cmd === "read_file_content") return Promise.resolve("");
      if (cmd === "read_file_lines") {
        return Promise.resolve({
          content: "r".repeat(20_000),
          total_lines: 400,
          start_line: 0,
          end_line: 400,
          truncated: false,
          path,
        });
      }
      return Promise.resolve(null);
    });
    const sends: string[] = [];
    let calls = 0;
    fakeDriver = {
      healthy: true,
      send: async (
        text: string,
        opts: { fresh: boolean; onProgress?: (partial: string) => void }
      ) => {
        sends.push(text);
        calls++;
        if (calls === 1) {
          return { text: '<tool name="read_file" path="src/big.ts" />', errors: [], actions: [] };
        }
        opts.onProgress?.("xong");
        return { text: "xong", errors: [], actions: [] };
      },
    };

    await useStore.getState().sendDuckChat(convId, "đọc src/big.ts");

    expect(sends.length, "the tool round never came back to the bridge").toBe(2);
    expect(
      sends[1].length,
      "a full tool result was typed into a composer that cannot take it"
    ).toBeLessThanOrEqual(SPA_MESSAGE_LIMIT);
    expect(
      sends[1],
      "the clamped round lost the tool protocol, which is what keeps tools live"
    ).toContain('<tool name="write_file"');
  });
});

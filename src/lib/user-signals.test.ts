import { describe, expect, it } from "vitest";
import {
  MAX_NAMED_FILES,
  buildIntentBrief,
  classifyIntent,
  extractUserSignals,
  stepBudgetFor,
} from "./user-signals";
import { MAX_AGENT_STEPS } from "./agent";

/**
 * The mechanism these lock down:
 *
 *   Every message used to get the same treatment — the whole file index plus the
 *   implement-and-verify coding workflow — so a question was answered with
 *   instructions about write_file, and the agent had to guess which of a thousand
 *   indexed files the question was about. Reading the message first is what makes
 *   the codebase read directed instead of blind.
 */

/** The app's own suggestion chips — real messages, not invented fixtures. */
const SUGGESTIONS = [
  ["Giải thích luồng của đoạn code này", "question"],
  ["Tìm và sửa lỗi trong project", "debug"],
  ["Thêm một tính năng nhỏ", "edit"],
  ["Viết test cho module chính", "edit"],
] as const;

const PROJECT = [
  "src/store/index.ts",
  "src/lib/agent.ts",
  "src/lib/skills.ts",
  "src/components/Sidebar.tsx",
  "package.json",
];

describe("classifyIntent", () => {
  it("classifies the app's own suggestion chips the way a reader would", () => {
    for (const [message, expected] of SUGGESTIONS) {
      expect(classifyIntent(message), message).toBe(expected);
    }
  });

  it("treats a how-do-I-fix question as debugging, not as a question", () => {
    // Checked before `question` on purpose: the answer involves changing code.
    expect(classifyIntent("how do I fix the crash on startup?")).toBe("debug");
  });

  it("recognises a plain question", () => {
    expect(classifyIntent("what does resolveProjectPath do?")).toBe("question");
    expect(classifyIntent("why is this file so large")).toBe("question");
    expect(classifyIntent("tại sao build chậm vậy")).toBe("question");
  });

  it("does not let a bare noun outrank a question marker", () => {
    // "build" is a noun here. Matching it as a command would send a question down
    // the run path — the ordering bug this test exists for.
    expect(classifyIntent("tại sao build chậm vậy")).toBe("question");
    expect(classifyIntent("is the build reproducible?")).toBe("question");
    // ...while a real imperative still reaches `run`.
    expect(classifyIntent("build it")).toBe("run");
  });

  it("recognises a run request", () => {
    expect(classifyIntent("run the tests")).toBe("run");
    expect(classifyIntent("chạy build xem sao")).toBe("run");
  });

  it("recognises an edit", () => {
    expect(classifyIntent("refactor the sidebar")).toBe("edit");
    expect(classifyIntent("đổi tên hàm này")).toBe("edit");
  });

  it("defaults to edit for anything it cannot place", () => {
    // Conservative: an unrecognised message keeps the pre-existing behaviour, so
    // this classifier can never make a working request worse.
    expect(classifyIntent("hmm")).toBe("edit");
    expect(classifyIntent("foo bar baz")).toBe("edit");
  });
});

describe("extractUserSignals — only what the project actually has", () => {
  it("resolves a path the user typed", () => {
    const s = extractUserSignals("sửa lỗi trong src/store/index.ts", PROJECT);
    expect(s.paths).toEqual(["src/store/index.ts"]);
  });

  it("resolves a Windows-style path", () => {
    const s = extractUserSignals("xem src\\lib\\agent.ts giúp tôi", PROJECT);
    expect(s.paths).toEqual(["src/lib/agent.ts"]);
  });

  it("resolves a path suffix", () => {
    const s = extractUserSignals("what is in store/index.ts?", PROJECT);
    expect(s.paths).toEqual(["src/store/index.ts"]);
  });

  it("drops a path the project does not have", () => {
    // The whole point of passing the index in: a remembered path must not become
    // a fabricated file handed to the model as fact.
    const s = extractUserSignals("fix src/does/not/exist.ts", PROJECT);
    expect(s.paths).toEqual([]);
  });

  it("resolves a bare filename only when it is unambiguous", () => {
    const unique = extractUserSignals("đọc Sidebar.tsx", PROJECT);
    expect(unique.paths).toEqual(["src/components/Sidebar.tsx"]);

    const ambiguous = extractUserSignals("đọc index.ts", [
      "src/a/index.ts",
      "src/b/index.ts",
    ]);
    expect(ambiguous.paths).toEqual([]);
  });

  it("caps how many files it will name", () => {
    const s = extractUserSignals(
      "compare src/store/index.ts with src/lib/agent.ts and src/lib/skills.ts and src/components/Sidebar.tsx",
      PROJECT,
    );
    expect(s.paths).toHaveLength(MAX_NAMED_FILES);
  });

  it("does not repeat a file named twice", () => {
    const s = extractUserSignals("src/lib/agent.ts ... src/lib/agent.ts again", PROJECT);
    expect(s.paths).toEqual(["src/lib/agent.ts"]);
  });
});

describe("extractUserSignals — symbols", () => {
  it("picks up backticked identifiers and call-looking names", () => {
    const s = extractUserSignals("what does `resolveProjectPath` do, and does buildPayload() run?", []);
    expect(s.symbols).toContain("resolveProjectPath");
    expect(s.symbols).toContain("buildPayload");
  });

  it("ignores ordinary prose", () => {
    const s = extractUserSignals("please make the sidebar nicer and faster", []);
    expect(s.symbols).toEqual([]);
  });
});

describe("buildIntentBrief", () => {
  it("says nothing for a plain edit, so the common prompt is unchanged", () => {
    expect(buildIntentBrief({ intent: "edit", paths: [], symbols: [] })).toBe("");
  });

  it("steers a question away from writing files", () => {
    const brief = buildIntentBrief({ intent: "question", paths: [], symbols: [] });
    expect(brief).toContain("[Request: question]");
    expect(brief).toContain("do not emit write_file");
  });

  it("tells a debug request to read the real error before changing anything", () => {
    const brief = buildIntentBrief({ intent: "debug", paths: [], symbols: [] });
    expect(brief).toContain("[Request: debug]");
    expect(brief).toContain("real error");
  });

  it("says which files were pre-read, so the model does not re-read them", () => {
    const brief = buildIntentBrief({
      intent: "edit",
      paths: ["src/store/index.ts"],
      symbols: ["openProject"],
    });
    expect(brief).toContain("[Request: edit]");
    expect(brief).toContain("already read for you: src/store/index.ts");
    expect(brief).toContain("openProject");
  });
});

describe("stepBudgetFor", () => {
  it("gives a question far fewer rounds than a debugging session", () => {
    expect(stepBudgetFor("question")).toBeLessThan(stepBudgetFor("debug"));
  });

  it("never exceeds the global ceiling", () => {
    for (const intent of ["question", "debug", "run", "edit"] as const) {
      expect(stepBudgetFor(intent)).toBeLessThanOrEqual(MAX_AGENT_STEPS);
      expect(stepBudgetFor(intent)).toBeGreaterThan(0);
    }
  });
});

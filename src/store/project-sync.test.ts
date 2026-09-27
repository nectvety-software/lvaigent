import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The store talks to the backend through Tauri's `invoke`; swap it for a spy so
 * the reconciliation logic can be driven without a webview.
 */
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useStore, resolveDesiredProjectPath } from "./index";
import type { Conversation, Project } from "../types";
import type { WorkspaceEntry } from "./index";

/**
 * The bug these assertions lock down:
 *
 *   The active session named the folder it worked in, the folder was still on
 *   disk, and the app *still* showed "Chưa mở project — hãy mở project trước".
 *   The restore ran once at boot through a branch chain that could be skipped or
 *   fail silently, and nothing ever tried again.
 *
 * So: the project must follow the conversation, retries must be cheap, and a
 * failure must be recorded where the UI can show it instead of vanishing into a
 * toast.
 */

const DIBO = "D:\\GBStudio\\DIbo";
const OTHER = "D:\\work\\other";

function conversation(id: string, workspacePath?: string, updatedAt = 1): Conversation {
  return {
    id,
    title: id,
    messages: [],
    model: "gpt-5",
    createdAt: updatedAt,
    updatedAt,
    workspacePath,
  };
}

function projectAt(path: string): Project {
  return { id: `p-${path}`, name: path.split(/[/\\]/).pop() ?? path, path, openedAt: 1 };
}

function recent(path: string): WorkspaceEntry {
  return { path, lastOpenedAt: 1 };
}

/** Backend stub: every command resolves unless an override says otherwise. */
function mockBackend(overrides: Record<string, () => Promise<unknown>> = {}): void {
  invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
    const override = overrides[cmd];
    if (override) return override();
    if (cmd === "get_project_info") {
      return Promise.resolve({ path: args?.path ?? "", files: 3, dirs: 1, type: "package" });
    }
    if (cmd === "read_project_tree") return Promise.resolve([]);
    if (cmd === "glob_files") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

function seed(state: {
  conversations?: Conversation[];
  activeConversationId?: string | null;
  recentProjects?: WorkspaceEntry[];
  currentProject?: Project | null;
  activeWorkspacePath?: string | null;
}): void {
  useStore.setState({
    conversations: state.conversations ?? [],
    activeConversationId: state.activeConversationId ?? null,
    recentProjects: state.recentProjects ?? [],
    currentProject: state.currentProject ?? null,
    // Must be reset: it is module-level initial state, so a workspace selected by
    // one test would otherwise leak into the next and win over the session.
    activeWorkspacePath: state.activeWorkspacePath ?? null,
    projectSync: { status: "idle", path: null, error: null },
    projectRestoreSuppressedPath: null,
    toasts: [],
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  mockBackend();
  seed({});
});

describe("resolveDesiredProjectPath", () => {
  it("prefers the active conversation's binding over the recent-workspace list", () => {
    expect(
      resolveDesiredProjectPath({
        conversations: [conversation("c1", DIBO)],
        activeConversationId: "c1",
        recentProjects: [recent(OTHER)],
      }),
    ).toBe(DIBO);
  });

  it("falls back to the most recent workspace when the session names none", () => {
    expect(
      resolveDesiredProjectPath({
        conversations: [conversation("c1")],
        activeConversationId: "c1",
        recentProjects: [recent(OTHER)],
      }),
    ).toBe(OTHER);
  });

  it("returns null when neither history nor a session says where to work", () => {
    expect(
      resolveDesiredProjectPath({
        conversations: [],
        activeConversationId: null,
        recentProjects: [],
      }),
    ).toBeNull();
  });
});

describe("project follows the conversation", () => {
  it("opens the folder the active session is bound to", async () => {
    seed({ conversations: [conversation("c1", DIBO)], activeConversationId: "c1" });

    await useStore.getState().ensureProjectOpen();

    expect(useStore.getState().currentProject?.path).toBe(DIBO);
    expect(useStore.getState().projectSync).toEqual({
      status: "ready",
      path: DIBO,
      error: null,
    });
  });

  it("is a no-op when the right project is already open (no IPC, no re-read)", async () => {
    seed({
      conversations: [conversation("c1", DIBO)],
      activeConversationId: "c1",
      currentProject: projectAt(DIBO),
    });
    invokeMock.mockClear();

    await useStore.getState().ensureProjectOpen();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useStore.getState().projectSync.status).toBe("ready");
  });

  it("does not fire a second tree read while one is already in flight", async () => {
    seed({ conversations: [conversation("c1", DIBO)], activeConversationId: "c1" });

    // React 18 StrictMode runs mount effects twice; the second pass must not
    // issue a duplicate read_project_tree.
    await Promise.all([
      useStore.getState().ensureProjectOpen(),
      useStore.getState().ensureProjectOpen(),
    ]);

    const treeReads = invokeMock.mock.calls.filter(([cmd]) => cmd === "read_project_tree");
    expect(treeReads).toHaveLength(1);
    expect(useStore.getState().currentProject?.path).toBe(DIBO);
  });

  it("falls back to the most recent workspace when no session is bound", async () => {
    seed({
      conversations: [conversation("c1")],
      activeConversationId: "c1",
      recentProjects: [recent(OTHER)],
    });

    await useStore.getState().ensureProjectOpen();

    expect(useStore.getState().currentProject?.path).toBe(OTHER);
  });

  it("stays idle — not error — when there is genuinely nothing to restore", async () => {
    seed({});

    await useStore.getState().ensureProjectOpen();

    expect(useStore.getState().projectSync.status).toBe("idle");
    expect(useStore.getState().currentProject).toBeNull();
  });
});

describe("deliberate close vs. session switch", () => {
  it("does not reopen a project the user closed on purpose", async () => {
    seed({
      conversations: [conversation("c1", DIBO)],
      activeConversationId: "c1",
      recentProjects: [recent(DIBO)],
      currentProject: projectAt(DIBO),
    });

    useStore.getState().closeProject();
    expect(useStore.getState().projectRestoreSuppressedPath).toBe(DIBO);
    invokeMock.mockClear();

    await useStore.getState().ensureProjectOpen();

    expect(useStore.getState().currentProject).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reopens it when the user switches to a session bound to that project", async () => {
    seed({
      conversations: [conversation("c1", DIBO), conversation("c2")],
      activeConversationId: "c2",
      recentProjects: [recent(DIBO)],
      currentProject: projectAt(DIBO),
    });

    useStore.getState().closeProject();
    expect(useStore.getState().currentProject).toBeNull();

    // Picking a conversation from history is the user asking for that project.
    useStore.getState().setActiveConversation("c1");

    await vi.waitFor(() => expect(useStore.getState().currentProject?.path).toBe(DIBO));
    expect(useStore.getState().projectRestoreSuppressedPath).toBeNull();
  });

  it("leaves the user's choice alone when the new session has no project", async () => {
    seed({
      conversations: [conversation("c1", DIBO), conversation("c2")],
      activeConversationId: "c1",
      recentProjects: [recent(DIBO)],
      currentProject: projectAt(DIBO),
    });

    useStore.getState().closeProject();
    invokeMock.mockClear();

    useStore.getState().setActiveConversation("c2");
    await useStore.getState().ensureProjectOpen();

    expect(useStore.getState().currentProject).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("a failed restore is reported, not swallowed", () => {
  it("records the backend message against the path it tried", async () => {
    seed({ conversations: [conversation("c1", DIBO)], activeConversationId: "c1" });
    mockBackend({
      get_project_info: () =>
        Promise.reject(new Error("No such file or directory (os error 2)")),
    });

    await useStore.getState().ensureProjectOpen();

    expect(useStore.getState().currentProject).toBeNull();
    expect(useStore.getState().projectSync.status).toBe("error");
    expect(useStore.getState().projectSync.path).toBe(DIBO);
    expect(useStore.getState().projectSync.error).toContain("os error 2");
  });

  it("does not toast on an automatic restore — the banner carries the reason", async () => {
    seed({ conversations: [conversation("c1", DIBO)], activeConversationId: "c1" });
    mockBackend({ get_project_info: () => Promise.reject(new Error("gone")) });

    await useStore.getState().ensureProjectOpen();

    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it("recovers when the folder comes back and the user retries", async () => {
    seed({ conversations: [conversation("c1", DIBO)], activeConversationId: "c1" });
    mockBackend({ get_project_info: () => Promise.reject(new Error("gone")) });

    await useStore.getState().ensureProjectOpen();
    expect(useStore.getState().projectSync.status).toBe("error");

    mockBackend(); // folder is back
    await useStore.getState().ensureProjectOpen({ force: true });

    expect(useStore.getState().currentProject?.path).toBe(DIBO);
    expect(useStore.getState().projectSync).toEqual({
      status: "ready",
      path: DIBO,
      error: null,
    });
  });

  it("a user-initiated open still toasts, so a bad pick is noticed immediately", async () => {
    seed({});
    mockBackend({ get_project_info: () => Promise.reject(new Error("nope")) });

    const ok = await useStore.getState().openProject(DIBO);

    expect(ok).toBe(false);
    expect(useStore.getState().toasts.some((t) => t.type === "error")).toBe(true);
  });
});

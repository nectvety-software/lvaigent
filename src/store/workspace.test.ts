import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useStore, pickSessionForWorkspace, sanitizeConversation } from "./index";
import type { Conversation } from "../types";

const DIBO = "D:\\GBStudio\\DIbo";
const OTHER = "D:\\work\\other";

/**
 * The model change these assertions lock down:
 *
 *   The folder used to belong to the *session* — every conversation carried its
 *   own `projectPath`, so two sessions in one folder were unrelated, and the
 *   sidebar showed workspaces and sessions as two flat lists that never met.
 *   The workspace now owns the folder; sessions belong to a workspace and
 *   inherit it, which is what makes "click a workspace → see its sessions" mean
 *   anything.
 */

function conversation(
  id: string,
  workspacePath?: string,
  extra: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    title: id,
    messages: [],
    model: "gpt-5",
    createdAt: 1,
    updatedAt: 1,
    workspacePath,
    ...extra,
  };
}

function mockBackend(): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "get_project_info") {
      return Promise.resolve({ path: "x", files: 3, dirs: 1, type: "package" });
    }
    if (cmd === "read_project_tree") return Promise.resolve([]);
    if (cmd === "glob_files") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

function seed(state: {
  conversations?: Conversation[];
  activeConversationId?: string | null;
  activeWorkspacePath?: string | null;
  recentProjects?: { path: string; lastOpenedAt: number }[];
  currentProject?: { id: string; name: string; path: string; openedAt: number } | null;
}): void {
  useStore.setState({
    conversations: state.conversations ?? [],
    activeConversationId: state.activeConversationId ?? null,
    activeWorkspacePath: state.activeWorkspacePath ?? null,
    recentProjects: (state.recentProjects ?? []) as never,
    currentProject: (state.currentProject ?? null) as never,
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

describe("migrating projectPath to workspacePath", () => {
  it("carries the old per-session folder over to the workspace field", () => {
    const legacy = { ...conversation("c1"), projectPath: DIBO } as Conversation & {
      projectPath: string;
    };
    const migrated = sanitizeConversation(legacy);
    expect(migrated.workspacePath).toBe(DIBO);
  });

  it("drops the legacy key so it is not written back out", () => {
    const legacy = { ...conversation("c1"), projectPath: DIBO } as Conversation & {
      projectPath: string;
    };
    expect("projectPath" in sanitizeConversation(legacy)).toBe(false);
  });

  it("prefers an existing workspacePath over the legacy value", () => {
    const both = {
      ...conversation("c1", OTHER),
      projectPath: DIBO,
    } as Conversation & { projectPath: string };
    expect(sanitizeConversation(both).workspacePath).toBe(OTHER);
  });

  it("leaves a session that belongs to no workspace alone", () => {
    const orphan = sanitizeConversation(conversation("c1"));
    expect(orphan.workspacePath).toBeUndefined();
    expect(orphan.messages).toEqual([]);
  });
});

describe("pickSessionForWorkspace", () => {
  it("keeps the active session when it already belongs to the workspace", () => {
    expect(
      pickSessionForWorkspace({
        conversations: [conversation("a", DIBO)],
        activeConversationId: "a",
        path: DIBO,
      }),
    ).toEqual({ kind: "keep" });
  });

  it("switches to the most recently updated session in the workspace", () => {
    const decision = pickSessionForWorkspace({
      conversations: [
        conversation("a", OTHER, { updatedAt: 50 }),
        conversation("old", DIBO, { updatedAt: 10 }),
        conversation("new", DIBO, { updatedAt: 90 }),
      ],
      activeConversationId: "a",
      path: DIBO,
    });
    expect(decision).toEqual({ kind: "switch", id: "new" });
  });

  it("moves an empty session instead of creating a second empty one", () => {
    expect(
      pickSessionForWorkspace({
        conversations: [conversation("blank", undefined, { messages: [] })],
        activeConversationId: "blank",
        path: DIBO,
      }),
    ).toEqual({ kind: "adopt" });
  });

  it("creates a session when the active one has history and the workspace is new", () => {
    const decision = pickSessionForWorkspace({
      conversations: [
        conversation("busy", OTHER, {
          messages: [{ id: "m1", role: "user", content: "hi", timestamp: 1 }] as never,
        }),
      ],
      activeConversationId: "busy",
      path: DIBO,
    });
    expect(decision).toEqual({ kind: "create" });
  });

  it("creates a session when nothing is active at all", () => {
    expect(
      pickSessionForWorkspace({ conversations: [], activeConversationId: null, path: DIBO }),
    ).toEqual({ kind: "create" });
  });
});

describe("the workspace owns the open folder", () => {
  it("selecting a workspace opens its folder and adopts a blank session", async () => {
    seed({ conversations: [conversation("blank")], activeConversationId: "blank" });

    useStore.getState().setActiveWorkspace(DIBO);
    await vi.waitFor(() => {
      expect(useStore.getState().currentProject?.path).toBe(DIBO);
    });

    const state = useStore.getState();
    expect(state.activeWorkspacePath).toBe(DIBO);
    // The blank session moved into the workspace rather than being left orphan —
    // otherwise the sidebar's filter would hide the session being typed in.
    expect(state.conversations.find((c) => c.id === "blank")?.workspacePath).toBe(DIBO);
    expect(state.conversations).toHaveLength(1);
  });

  it("keeps the active session when switching to another workspace it belongs to", async () => {
    seed({
      conversations: [conversation("mine", OTHER), conversation("theirs", DIBO)],
      activeConversationId: "mine",
      activeWorkspacePath: OTHER,
    });

    useStore.getState().setActiveWorkspace(DIBO);
    await vi.waitFor(() => {
      expect(useStore.getState().currentProject?.path).toBe(DIBO);
    });

    const state = useStore.getState();
    expect(state.activeConversationId).toBe("theirs");
    expect(state.activeWorkspacePath).toBe(DIBO);
    // No session was created or moved: the workspace already had one.
    expect(state.conversations).toHaveLength(2);
  });

  it("does not select a workspace whose folder fails to open", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_project_info") return Promise.reject(new Error("ENOENT: gone"));
      return Promise.resolve(null);
    });
    seed({ conversations: [conversation("blank")], activeConversationId: "blank" });

    useStore.getState().setActiveWorkspace(DIBO);
    await vi.waitFor(() => {
      expect(useStore.getState().projectSync.status).toBe("error");
    });

    // Filtering to a workspace the app is not actually in would hide everything.
    expect(useStore.getState().activeWorkspacePath).toBeNull();
  });

  it("holds the invariant: a project is open exactly when a workspace is selected", async () => {
    seed({ conversations: [conversation("blank")], activeConversationId: "blank" });

    useStore.getState().setActiveWorkspace(DIBO);
    await vi.waitFor(() => {
      expect(useStore.getState().currentProject).not.toBeNull();
    });
    expect(useStore.getState().activeWorkspacePath).toBe(DIBO);

    useStore.getState().closeProject();
    expect(useStore.getState().currentProject).toBeNull();
    expect(useStore.getState().activeWorkspacePath).toBeNull();
    // The session keeps its workspace, so it is still reachable by selecting it.
    expect(useStore.getState().conversations[0].workspacePath).toBe(DIBO);
  });
});

describe("switching sessions follows the workspace", () => {
  it("adopts the open workspace when the chosen session has none", async () => {
    seed({
      conversations: [conversation("orphan"), conversation("bound", DIBO)],
      activeConversationId: "bound",
      activeWorkspacePath: DIBO,
      currentProject: { id: "p", name: "DIbo", path: DIBO, openedAt: 1 },
    });

    useStore.getState().setActiveConversation("orphan");
    expect(useStore.getState().conversations.find((c) => c.id === "orphan")?.workspacePath).toBe(
      DIBO,
    );
  });

  it("does not clear the workspace when an unbound session is selected", () => {
    seed({
      conversations: [conversation("orphan")],
      activeConversationId: null,
      activeWorkspacePath: DIBO,
      currentProject: { id: "p", name: "DIbo", path: DIBO, openedAt: 1 },
    });

    useStore.getState().setActiveConversation("orphan");
    // A session with no workspace must not close the project the user has open.
    expect(useStore.getState().activeWorkspacePath).toBe(DIBO);
  });
});

describe("new sessions belong to the selected workspace", () => {
  it("stamps workspacePath from the selected workspace", () => {
    seed({ activeWorkspacePath: OTHER });
    useStore.getState().createConversation();
    const active = useStore
      .getState()
      .conversations.find((c) => c.id === useStore.getState().activeConversationId);
    expect(active?.workspacePath).toBe(OTHER);
  });

  it("leaves a new session unbound when no workspace is selected", () => {
    seed({ activeWorkspacePath: null });
    useStore.getState().createConversation();
    const active = useStore
      .getState()
      .conversations.find((c) => c.id === useStore.getState().activeConversationId);
    expect(active?.workspacePath).toBeUndefined();
  });
});

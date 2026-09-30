import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus,
  History,
  MessageSquare,
  Settings,
  TerminalSquare,
  Trash2,
  FolderOpen,
  X,
  ExternalLink,
  Copy,
  Check,
  FolderPlus,
  Pencil,
  ChevronDown,
  Pin,
  PinOff,
  Layers,
} from "lucide-react";
import { useStore } from "../store";
import type { WorkspaceEntry } from "../store";
import { t, tf, useLang } from "../lib/i18n";

interface Props {
  openPanel?: boolean;
  /** Width of the collapsible panel column (the rail beside it is fixed). */
  panelWidth?: number;
  /** True while a resize drag is active: kills the width transition so the
   * panel tracks the pointer instead of lagging behind it. */
  resizing?: boolean;
  onOpenSettings?: () => void;
  onOpenCommands?: () => void;
  onOpenWorkspaces?: () => void;
}

interface MenuState {
  x: number;
  y: number;
  entry: WorkspaceEntry | null; // null = the active project card
}

/** Compact relative timestamp for a session list ("5m ago", "2h ago", date). */
function formatWhen(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Deterministic avatar colour from the workspace path. This is the fixed
 * nine-colour identity palette: it encodes identity only and never status.
 */
const AVATAR_COLORS = [
  "#4f6bed", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981",
  "#06b6d4", "#ef4444", "#84cc16", "#a855f7", "#f97316",
];
function avatarColor(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Initials shown on the workspace rail avatar. */
function avatarInitials(name: string): string {
  const parts = name.split(/[\s-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/**
 * Workspace sidebar, ported from ZCode's `WorkspaceSidebar`:
 *   - a bare 48px drag strip owns the top of the column
 *   - the sidebar has no surface of its own; it reads as part of the window frame
 *   - rows are `h-8 rounded-lg text-ui-base`, selected rows use `bg-selected`
 *   - section headers are `text-ui-xs uppercase tracking-wider` in the weakest tone
 */
export default function Sidebar({
  openPanel = true,
  panelWidth = 260,
  resizing = false,
  onOpenSettings,
  onOpenCommands,
  onOpenWorkspaces,
}: Props) {
  useLang();
  const {
    conversations,
    activeConversationId,
    createConversation,
    setActiveConversation,
    deleteConversation,
    currentProject,
    closeProject,
    recentProjects,
    activeWorkspacePath,
    setActiveWorkspace,
    renameWorkspace,
    forgetWorkspace,
    pinWorkspace,
    moveWorkspace,
  } = useStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [recentsOpen, setRecentsOpen] = useState(true);
  /** Show every session, not just the selected workspace's. */
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  /**
   * The session list is workspace-scoped: the workspace owns the project folder,
   * so showing every session from every folder made the two sections read as
   * unrelated lists. `showAllSessions` is the escape hatch — without it, sessions
   * in other workspaces would be unreachable from here.
   */
  const workspaceSessions = activeWorkspacePath
    ? conversations.filter((c) => c.workspacePath === activeWorkspacePath)
    : conversations.filter((c) => !c.workspacePath);

  const scopedConversations = showAllSessions ? conversations : workspaceSessions;

  const filteredConversations = scopedConversations.filter((c) =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const workspaceName = (entry: WorkspaceEntry): string =>
    entry.name ?? entry.path.split(/[/\\]/).filter(Boolean).pop() ?? entry.path;

  const activeWorkspaceLabel = (() => {
    const entry = recentProjects.find((r) => r.path === activeWorkspacePath);
    if (entry) return workspaceName(entry);
    return activeWorkspacePath ? activeWorkspacePath.split(/[/\\]/).filter(Boolean).pop() ?? activeWorkspacePath : null;
  })();

  const handleOpenProject = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: "Open Project Folder" });
      if (selected) {
        const folderPath = Array.isArray(selected) ? selected[0] : selected;
        setActiveWorkspace(folderPath);
      }
    } catch (e) {
      console.error("Open project error:", e);
    }
  };

  const openInExplorer = async (path: string) => {
    try {
      await invoke("open_in_explorer", { path });
    } catch (e) {
      console.error("Open folder error:", e);
    }
    setMenu(null);
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
    setMenu(null);
  };

  const startRename = (entry: WorkspaceEntry) => {
    setMenu(null);
    setRenaming(entry.path);
    setRenameValue(workspaceName(entry));
  };

  const commitRename = () => {
    if (renaming) renameWorkspace(renaming, renameValue);
    setRenaming(null);
    setRenameValue("");
  };

  /** Context-menu actions that only make sense for the OPEN project. */
  const newSpace = () => {
    setMenu(null);
    void (async () => {
      try {
        const selected = await openDialog({ directory: true, multiple: false, title: t("New Space — chọn thư mục gốc") });
        if (!selected) return;
        const src = Array.isArray(selected) ? selected[0] : selected;
        const parent = src.replace(/[\\/]+$/, "").replace(/[/\\][^/\\]+$/, "");
        const to = `${parent}/new-space`;
        try {
          await invoke("rename_folder", { from: src, to });
          setActiveWorkspace(to);
        } catch (e) {
          useStore.getState().addToast(String(e), "error");
        }
      } catch (e) {
        console.error("New space error:", e);
      }
    })();
  };

  // Close the context menu on any click outside it or Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const menuItemsFor = (entry: WorkspaceEntry | null) => {
    const isOpenEntry = entry === null;
    return (
      <>
        {isOpenEntry && (
          <button onClick={newSpace} className="menu-row">
            <FolderPlus className="size-3.5 text-foreground-subtlest" />
            New Space
          </button>
        )}
        <button
          onClick={() => entry ? startRename(entry) : newSpace()}
          className="menu-row"
        >
          <Pencil className="size-3.5 text-foreground-subtlest" />
          Rename
        </button>
        <button
          onClick={() => openInExplorer(entry ? entry.path : currentProject!.path)}
          className="menu-row"
        >
          <ExternalLink className="size-3.5 text-foreground-subtlest" />
          {t("Mở vị trí thư mục dự án")}
        </button>
        <button
          onClick={() => copyPath(entry ? entry.path : currentProject!.path)}
          className="menu-row"
        >
          {copied ? (
            <Check className="size-3.5 text-brand" />
          ) : (
            <Copy className="size-3.5 text-foreground-subtlest" />
          )}
          {copied ? t("Đã copy") : t("Copy đường dẫn")}
        </button>
        {entry && (
          <>
            <div className="menu-separator" />
            <button
              onClick={() => {
                pinWorkspace(entry.path, !entry.pinned);
                setMenu(null);
              }}
              className="menu-row"
            >
              {entry.pinned ? (
                <PinOff className="size-3.5 text-foreground-subtlest" />
              ) : (
                <Pin className="size-3.5 text-foreground-subtlest" />
              )}
              {entry.pinned ? t("Bỏ ghim") : t("Ghim lên đầu rail")}
            </button>
            <button
              onClick={() => {
                forgetWorkspace(entry.path);
                setMenu(null);
              }}
              className="menu-row hover:bg-destructive/15 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              {t("Bỏ khỏi danh sách")}
            </button>
          </>
        )}
      </>
    );
  };

  /** The selected workspace is the model's source of truth for "which folder". */
  const activePath = activeWorkspacePath ?? null;

  const railButton =
    "flex items-center justify-center size-9 rounded-lg text-foreground-subtle hover:bg-hover hover:text-foreground transition-colors shrink-0";

  return (
    <aside
      className="flex h-full flex-col select-none overflow-hidden shrink-0"
      style={{ width: `${40 + 48 + (openPanel ? panelWidth : 0)}px` }}
    >
      {/* Bare drag strip: the sidebar column has no header of its own. */}
      <div data-tauri-drag-region className="h-12 shrink-0 titlebar-drag" />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Workspace rail: saved workspaces as identity avatars. */}
        <div className="w-10 min-w-[40px] flex flex-col items-center py-1">
          <div className="flex flex-col items-center gap-1 flex-1 overflow-y-auto sidebar-scroll w-full py-0.5">
            {recentProjects.slice(0, 12).map((r) => {
              const active = activePath === r.path;
              const isDragging = dragPath === r.path;
              const isDropTarget = dragOverPath === r.path && dragPath && dragPath !== r.path;
              return (
                <button
                  key={r.path}
                  onClick={() => setActiveWorkspace(r.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const x = Math.min(e.clientX, window.innerWidth - 200);
                    const y = Math.min(e.clientY, window.innerHeight - 180);
                    setMenu({ x: Math.max(4, x), y: Math.max(4, y), entry: r });
                  }}
                  draggable
                  onDragStart={(e) => {
                    setDragPath(r.path);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragOverPath !== r.path) setDragOverPath(r.path);
                  }}
                  onDragLeave={() => setDragOverPath((p) => (p === r.path ? null : p))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragPath) moveWorkspace(dragPath, r.path);
                    setDragPath(null);
                    setDragOverPath(null);
                  }}
                  onDragEnd={() => {
                    setDragPath(null);
                    setDragOverPath(null);
                  }}
                  className={`relative w-8 h-8 rounded-lg flex items-center justify-center text-ui-xs font-bold text-primary-foreground shrink-0 transition-all hover:brightness-110 ${
                    isDragging ? "opacity-40" : ""
                  } ${isDropTarget ? "ring-2 ring-brand scale-110" : ""}`}
                  style={{
                    backgroundColor: avatarColor(r.path),
                    outline: active ? "2px solid var(--color-brand)" : "none",
                    outlineOffset: "1px",
                  }}
                  title={`${workspaceName(r)} — ${r.path}${r.pinned ? ` ${t("(đã ghim)")}` : ""}`}
                >
                  {avatarInitials(workspaceName(r))}
                  {active && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-background" />
                  )}
                  {r.pinned && (
                    <span className="absolute -top-1 -right-1 text-ui-xs text-brand drop-shadow">◆</span>
                  )}
                </button>
              );
            })}
            {/* Thêm dự án: workspace + session manager */}
            <button
              onClick={() => onOpenWorkspaces?.()}
              className={railButton}
              title={t("Thêm dự án — quản lý workspace & sessions")}
            >
              <Plus className="size-4" />
            </button>
          </div>
        </div>

        {/* Icon rail */}
        <div className="w-12 min-w-[48px] flex flex-col items-center py-1 gap-0.5">
          <div className="flex flex-col items-center gap-0.5 flex-1">
            <button onClick={createConversation} className={railButton} title={t("Chat mới")}>
              <MessageSquare className="size-4" />
            </button>
          </div>
          <button
            onClick={() => onOpenCommands?.()}
            className={railButton}
            title="Custom commands (.duckchat/commands)"
          >
            <TerminalSquare className="size-4" />
          </button>
          <button onClick={() => onOpenSettings?.()} className={railButton} title="Settings">
            <Settings className="size-4" />
          </button>
        </div>

        {/* Panel */}
        <div
          className={`flex flex-col transition-all duration-200 overflow-hidden ${
            openPanel ? "opacity-100" : "opacity-0"
          }`}
          style={{
            width: openPanel ? panelWidth : 0,
            minWidth: openPanel ? panelWidth : 0,
            transitionDuration: resizing ? "0ms" : undefined,
          }}
        >
          {/* New chat + Open project */}
          <div className="flex flex-col gap-1 px-2 py-2">
            <button
              onClick={createConversation}
              className="flex items-center gap-2 w-full px-2 h-9 rounded-lg text-ui-base font-medium text-foreground hover:bg-surface-hover transition-colors"
            >
              <Plus className="size-4 text-foreground-subtle" />
              <span className="truncate">{t("Chat mới")}</span>
            </button>

            {!currentProject ? (
              <button
                onClick={handleOpenProject}
                className="flex items-center gap-2 w-full px-2 h-9 rounded-lg text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground transition-colors"
              >
                <FolderOpen className="size-4" />
                <span className="font-medium truncate">{t("Mở project")}</span>
              </button>
            ) : (
              <div
                className="group flex items-center gap-2 px-2 py-1.5 bg-card border border-card-border rounded-xl cursor-context-menu"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const x = Math.min(e.clientX, window.innerWidth - 200);
                  const y = Math.min(e.clientY, window.innerHeight - 180);
                  setMenu({ x: Math.max(4, x), y: Math.max(4, y), entry: null });
                }}
                title={currentProject.path}
              >
                <FolderOpen className="size-3.5 text-foreground-subtle shrink-0 self-center" />
                <div className="flex-1 min-w-0 self-center">
                  <div className="text-ui-sm font-medium text-foreground truncate leading-tight">
                    {recentProjects.find((r) => r.path === currentProject.path)?.name ?? currentProject.name}
                  </div>
                  {/* Hover reveals the full project path in place of the stats line. */}
                  <div className="text-ui-xs text-foreground-subtlest truncate leading-tight">
                    <span className="font-mono hidden group-hover:inline">{currentProject.path}</span>
                    <span className="group-hover:hidden">
                      {tf("{files} files · {dirs} thư mục", { files: currentProject.fileCount ?? 0, dirs: currentProject.dirCount ?? 0 })}
                    </span>
                  </div>
                </div>
                <button
                  onClick={closeProject}
                  className="flex items-center justify-center size-6 rounded-md text-foreground-subtlest hover:bg-destructive/15 hover:text-destructive transition-colors shrink-0"
                  title={t("Đóng project")}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto sidebar-scroll px-2 space-y-4 relative">
            {/* Recent projects / workspaces */}
            {recentProjects.length > 0 && (
              <section>
                <button
                  onClick={() => setRecentsOpen((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-2 h-7 text-ui-xs font-semibold text-foreground-subtlest uppercase tracking-wider hover:text-foreground-subtle transition-colors"
                >
                  <FolderOpen className="size-3" />
                  <span className="flex-1 text-left">{t("Dự án gần đây")}</span>
                  <ChevronDown
                    className={`size-3 transition-transform ${recentsOpen ? "" : "-rotate-90"}`}
                  />
                </button>
                {recentsOpen && (
                  <div className="flex flex-col gap-0.5">
                    {[...recentProjects].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false)).map((r) => {
                      const active = currentProject?.path === r.path;
                      return (
                        <div key={r.path} className="group/rec relative">
                          {renaming === r.path ? (
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onBlur={commitRename}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename();
                                if (e.key === "Escape") setRenaming(null);
                              }}
                              className="input-field text-ui-sm"
                            />
                          ) : (
                            <button
                              onClick={() => setActiveWorkspace(r.path)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const x = Math.min(e.clientX, window.innerWidth - 200);
                                const y = Math.min(e.clientY, window.innerHeight - 180);
                                setMenu({ x: Math.max(4, x), y: Math.max(4, y), entry: r });
                              }}
                              title={r.path}
                              className={`group/rec w-full flex items-center gap-2 px-2 h-8 rounded-lg text-left transition-colors ${
                                active
                                  ? "bg-selected text-foreground"
                                  : "text-foreground-subtle hover:bg-hover hover:text-foreground"
                              }`}
                            >
                              <FolderOpen className={`size-3.5 shrink-0 self-center ${active ? "text-foreground" : "opacity-50"}`} />
                              <span className="flex-1 min-w-0 self-center">
                                <span className="block text-ui-base truncate leading-tight">{workspaceName(r)}</span>
                                {/* Hover swaps the timestamp for the full path. */}
                                <span className="block text-ui-xs text-foreground-subtlest truncate leading-tight">
                                  <span className="group-hover/rec:hidden">{formatWhen(r.lastOpenedAt)}</span>
                                  <span className="hidden group-hover/rec:inline font-mono">{r.path}</span>
                                </span>
                              </span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            <section>
              <div className="flex items-center gap-1.5 px-2 h-7 text-ui-xs font-semibold text-foreground-subtlest uppercase tracking-wider">
                <History className="size-3" />
                <span className="flex-1 text-left">{t("Lịch sử chat")}</span>
                <span className="normal-case tracking-normal font-normal">
                  {filteredConversations.length}
                </span>
              </div>

              {/* Scope indicator. Clicking it flips between "this workspace" and
                  every session, so sessions in other folders stay reachable. */}
              <button
                onClick={() => setShowAllSessions((v) => !v)}
                title={
                  showAllSessions
                    ? t("Đang hiện session của mọi workspace — bấm để chỉ hiện workspace đang chọn")
                    : t("Đang chỉ hiện session của workspace đang chọn — bấm để hiện tất cả")
                }
                className="flex items-center gap-1.5 w-full px-2 h-7 mb-1 rounded-lg text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground transition-colors"
              >
                {showAllSessions ? (
                  <>
                    <Layers className="size-3 shrink-0 opacity-60" />
                    <span className="truncate">{t("Tất cả workspace")}</span>
                  </>
                ) : (
                  <>
                    <FolderOpen className="size-3 shrink-0 opacity-60" />
                    <span className="truncate">
                      {activeWorkspaceLabel ?? t("Chưa có workspace")}
                    </span>
                  </>
                )}
                <span className="ml-auto shrink-0 opacity-60">
                  {showAllSessions ? t("lọc") : t("tất cả")}
                </span>
              </button>

              <input
                type="text"
                placeholder={t("Tìm trong lịch sử…")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input-field text-ui-sm mb-1.5"
              />
              <div className="flex flex-col gap-0.5">
                {filteredConversations.length === 0 ? (
                  <p className="text-ui-sm text-foreground-subtlest px-2 py-3 text-center">
                    {searchQuery
                      ? t("Không tìm thấy hội thoại nào")
                      : showAllSessions
                        ? t("Chưa có hội thoại nào")
                        : activeWorkspacePath
                          ? t("Workspace này chưa có session nào")
                          : t("Chưa có session nào ngoài workspace")}
                  </p>
                ) : (
                  filteredConversations.map((conv) => (
                    <div
                      key={conv.id}
                      className={`group flex items-center gap-2 px-2 h-8 rounded-lg cursor-pointer transition-colors ${
                        activeConversationId === conv.id
                          ? "bg-selected text-foreground"
                          : "text-foreground-subtle hover:bg-hover hover:text-foreground"
                      }`}
                      onClick={() => setActiveConversation(conv.id)}
                    >
                      <MessageSquare className="size-3.5 shrink-0 opacity-50" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-ui-base truncate leading-tight">{conv.title}</span>
                      </span>
                      <span className="text-ui-xs text-foreground-subtlest shrink-0">
                        {formatWhen(conv.updatedAt)}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteConversation(conv.id);
                        }}
                        className="flex items-center justify-center size-6 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/15 text-foreground-subtlest hover:text-destructive transition-colors shrink-0"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Context menu (project card or a recent entry) */}
            {menu && (
              <div
                ref={menuRef}
                className="menu-surface fixed z-50 w-[190px] animate-scale-in"
                style={{ left: menu.x, top: menu.y }}
              >
                {menuItemsFor(menu.entry)}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

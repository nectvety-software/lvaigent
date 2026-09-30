import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import {
  X,
  Plus,
  FolderOpen,
  MessageSquare,
  ExternalLink,
  Trash2,
  Package,
  Pencil,
  Check,
  RefreshCw,
} from "lucide-react";
import { useStore, type WorkspaceEntry } from "../store";
import type { Conversation } from "../types";
import { t as tr, tf as trf, useLang } from "../lib/i18n";

interface WorkspaceManagerProps {
  onClose: () => void;
}

/** Format a relative timestamp for session rows. */
function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * "Thêm dự án" modal: manage workspaces (recent projects, rename/forget,
 * quick open) and all chat sessions grouped by their project.
 */
export default function WorkspaceManager({ onClose }: WorkspaceManagerProps) {
  useLang();
  const currentProject = useStore((s) => s.currentProject);
  const recentProjects = useStore((s) => s.recentProjects);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const forgetWorkspace = useStore((s) => s.forgetWorkspace);
  const conversations = useStore((s) => s.conversations);
  const setActiveConversation = useStore((s) => s.setActiveConversation);
  const deleteConversation = useStore((s) => s.deleteConversation);
  const createConversation = useStore((s) => s.createConversation);
  const addToast = useStore((s) => s.addToast);

  const [tab, setTab] = useState<"workspaces" | "sessions">("workspaces");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const workspaceName = (entry: WorkspaceEntry): string =>
    entry.name ?? entry.path.split(/[/\\]/).filter(Boolean).pop() ?? entry.path;

  const handleAddProject = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: tr("Mở thư mục dự án") });
      if (!selected) return;
      const folderPath = Array.isArray(selected) ? selected[0] : selected;
      setActiveWorkspace(folderPath);
      onClose();
    } catch (e) {
      addToast(trf("Không mở được project: {err}", { err: String(e) }), "error");
    }
  };

  const newSpace = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: tr("New Space — chọn thư mục gốc") });
      if (!selected) return;
      const src = Array.isArray(selected) ? selected[0] : selected;
      const parent = src.replace(/[\\/]+$/, "").replace(/[/\\][^/\\]+$/, "");
      const to = `${parent}/new-space`;
      try {
        await invoke("rename_folder", { from: src, to });
        setActiveWorkspace(to);
        onClose();
      } catch (e) {
        addToast(String(e), "error");
      }
    } catch (e) {
      console.error("New space error:", e);
    }
  };

  const openFolder = async (path: string) => {
    try {
      await invoke("open_in_explorer", { path });
    } catch (e) {
      console.error("Open folder error:", e);
    }
  };

  const commitRename = () => {
    if (renaming) renameWorkspace(renaming, renameValue);
    setRenaming(null);
    setRenameValue("");
  };

  /** Sessions grouped by their workspace (or "no workspace"). */
  const sessionsByProject = (() => {
    const groups = new Map<string, Conversation[]>();
    for (const c of conversations) {
      const key = c.workspacePath ?? "";
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((a, b) => {
      const am = a[1].reduce((m, c) => Math.max(m, c.updatedAt), 0);
      const bm = b[1].reduce((m, c) => Math.max(m, c.updatedAt), 0);
      return bm - am;
    });
  })();

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-[1px] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="dialog-surface w-[640px] max-w-[94vw] max-h-[85vh] flex flex-col animate-scale-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Package size={15} className="text-brand" />
            <span className="text-ui-base font-semibold text-foreground">{tr("Thêm dự án")}</span>
            <span className="text-ui-xs text-foreground-subtlest">{tr("workspace & sessions")}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pt-2.5 shrink-0">
          {(
            [
              { id: "workspaces" as const, label: "Workspaces", count: recentProjects.length },
              { id: "sessions" as const, label: "Sessions", count: conversations.length },
            ]
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-ui-sm transition-colors ${
                tab === t.id
                  ? "bg-surface text-foreground border border-b-0 border-border"
                  : "text-foreground-subtlest hover:text-foreground-subtle"
              }`}
            >
              {t.label}
              <span className="text-ui-xs text-foreground-subtlest">{t.count}</span>
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 modal-scroll border-t border-border">
          {tab === "workspaces" ? (
            <>
              <div className="flex gap-1.5">
                <button
                  onClick={() => void handleAddProject()}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-border bg-surface hover:bg-surface-hover text-ui-base text-foreground transition-colors"
                >
                  <Plus size={15} className="text-brand" />
                  {tr("Mở thư mục dự án")}
                </button>
                <button
                  onClick={() => void newSpace()}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-border bg-surface hover:bg-surface-hover text-ui-base text-foreground transition-colors"
                >
                  <FolderOpen size={15} className="text-brand" />
                  New Space
                </button>
              </div>
              {recentProjects.length === 0 ? (
                <div className="text-center text-ui-sm text-foreground-subtlest py-8">
                  {tr("Chưa có dự án nào gần đây.")}
                  <br />
                  {tr("Mở một thư mục để bắt đầu làm việc.")}
                </div>
              ) : (
                recentProjects.map((r) => {
                  const active = currentProject?.path === r.path;
                  const sessions = conversations.filter((c) => c.workspacePath === r.path).length;
                  return (
                    <div
                      key={r.path}
                      className={`group flex items-center gap-2.5 px-3 py-2 rounded-lg border bg-surface ${
                        active ? "border-brand/40" : "border-border"
                      }`}
                    >
                      <FolderOpen size={14} className={active ? "text-brand shrink-0" : "text-foreground-subtlest shrink-0"} />
                      <div className="flex-1 min-w-0">
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
                            className="input-field text-ui-sm py-1"
                          />
                        ) : (
                          <>
                            <div className="text-ui-base font-medium text-foreground truncate">
                              {workspaceName(r)}
                              {active && (
                                <span className="ml-2 text-ui-xs text-brand font-normal">{tr("đang mở")}</span>
                              )}
                            </div>
                            <div className="text-ui-xs text-foreground-subtlest font-mono truncate">{r.path}</div>
                          </>
                        )}
                      </div>
                      <span className="text-ui-xs text-foreground-subtlest shrink-0 flex items-center gap-1">
                        <MessageSquare size={10} />
                        {sessions}
                      </span>
                      <span className="text-ui-xs text-foreground-subtlest shrink-0">{formatWhen(r.lastOpenedAt)}</span>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {!active && (
                          <button
                            onClick={() => setActiveWorkspace(r.path)}
                            className="p-1.5 rounded-lg hover:bg-surface-hover text-foreground-subtlest hover:text-brand transition-colors opacity-0 group-hover:opacity-100"
                            title={tr("Mở workspace này")}
                          >
                            <RefreshCw size={12} />
                          </button>
                        )}
                        <button
                          onClick={() => void openFolder(r.path)}
                          className="p-1.5 rounded-lg hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
                          title={tr("Mở vị trí thư mục")}
                        >
                          <ExternalLink size={12} />
                        </button>
                        <button
                          onClick={() => {
                            setRenaming(r.path);
                            setRenameValue(workspaceName(r));
                          }}
                          className="p-1.5 rounded-lg hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
                          title={tr("Đổi tên (Rename)")}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          onClick={() => forgetWorkspace(r.path)}
                          className="p-1.5 rounded-lg hover:bg-destructive/15 text-foreground-subtlest hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                          title={tr("Bỏ khỏi danh sách")}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </>
          ) : (
            /* Sessions tab */
            sessionsByProject.length === 0 ? (
              <div className="text-center text-ui-sm text-foreground-subtlest py-8">
                {tr("Chưa có session nào.")}
              </div>
            ) : (
              sessionsByProject.map(([projPath, sessions]) => (
                <div key={projPath || "none"} className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1 pt-1 text-ui-xs font-semibold text-foreground-subtlest uppercase tracking-wider">
                    <FolderOpen size={10} />
                    <span className="truncate font-mono normal-case">
                      {projPath || tr("(không gắn với project)")}
                    </span>
                    {!projPath && currentProject && (
                      <button
                        onClick={() => setActiveWorkspace(currentProject.path)}
                        className="normal-case text-brand hover:underline"
                      >
                        {tr("mở project hiện tại")}
                      </button>
                    )}
                  </div>
                  {sessions
                    .slice()
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                    .map((c) => (
                      <div
                        key={c.id}
                        className="group flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border bg-surface"
                      >
                        <MessageSquare size={13} className="text-foreground-subtlest shrink-0" />
                        <button
                          onClick={() => {
                            setActiveConversation(c.id);
                            onClose();
                          }}
                          className="flex-1 min-w-0 text-left"
                        >
                          <div className="text-ui-sm text-foreground truncate">{c.title}</div>
                          <div className="text-ui-xs text-foreground-subtlest">
                            {trf("{n} tin · {when}", { n: c.messages.length, when: formatWhen(c.updatedAt) })}
                            {c.model ? ` · ${c.model}` : ""}
                          </div>
                        </button>
                        <button
                          onClick={() => deleteConversation(c.id)}
                          className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-destructive/15 text-foreground-subtlest hover:text-destructive transition-all"
                          title={tr("Xóa session")}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                </div>
              ))
            )
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, FolderOpen, Pin, Package } from "lucide-react";
import { useStore, type WorkspaceEntry } from "../store";

/** Deterministic avatar color (kept in sync with Sidebar). */
const AVATAR_COLORS = [
  "#4f6bed", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981",
  "#06b6d4", "#ef4444", "#84cc16", "#a855f7", "#f97316",
];
function avatarColor(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function avatarInitials(name: string): string {
  const parts = name.split(/[\s-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

interface WorkspaceSwitcherProps {
  onManage: () => void;
}

/** TitleBar dropdown: quick switch between saved workspaces. */
export default function WorkspaceSwitcher({ onManage }: WorkspaceSwitcherProps) {
  const currentProject = useStore((s) => s.currentProject);
  const recentProjects = useStore((s) => s.recentProjects);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const workspaceName = (entry: WorkspaceEntry): string =>
    entry.name ?? entry.path.split(/[/\\]/).filter(Boolean).pop() ?? entry.path;

  const activePath = currentProject?.path ?? null;
  const sorted = [...recentProjects].sort(
    (a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false)
  );

  if (recentProjects.length === 0 && !currentProject) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-ui-sm text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors max-w-[220px]"
        title="Chuyển nhanh giữa các workspace"
      >
        {currentProject ? (
          <>
            <span
              className="w-4 h-4 rounded flex items-center justify-center text-ui-xs font-bold text-primary-foreground shrink-0"
              style={{ backgroundColor: avatarColor(currentProject.path) }}
            >
              {avatarInitials(
                sorted.find((r) => r.path === currentProject.path)?.name ?? currentProject.name
              )}
            </span>
            <span className="truncate">
              {sorted.find((r) => r.path === currentProject.path)?.name ?? currentProject.name}
            </span>
          </>
        ) : (
          <span className="text-foreground-subtlest">Workspace</span>
        )}
        <ChevronDown size={11} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="menu-surface absolute top-full left-0 mt-1 w-64 flex flex-col gap-0.5 animate-scale-in z-[80]">
          {sorted.length === 0 ? (
            <div className="px-3 py-2.5 text-ui-xs text-foreground-subtlest">
              Chưa có workspace nào — mở một project để bắt đầu.
            </div>
          ) : (
            sorted.map((r) => {
              const active = activePath === r.path;
              return (
                <button
                  key={r.path}
                  onClick={() => {
                    if (!active) setActiveWorkspace(r.path);
                    setOpen(false);
                  }}
                  className="menu-row"
                  title={r.path}
                >
                  <span
                    className="w-4 h-4 rounded flex items-center justify-center text-ui-xs font-bold text-primary-foreground shrink-0"
                    style={{ backgroundColor: avatarColor(r.path) }}
                  >
                    {avatarInitials(workspaceName(r))}
                  </span>
                  <span className="flex-1 min-w-0 truncate">{workspaceName(r)}</span>
                  {r.pinned && <Pin className="size-3 text-foreground-subtle shrink-0" />}
                  {active && <Check className="size-3 shrink-0" />}
                </button>
              );
            })
          )}
          <div className="menu-separator" />
          <button
            onClick={() => {
              setOpen(false);
              onManage();
            }}
            className="menu-row"
          >
            <Package className="size-3.5 text-foreground-subtle" />
            Quản lý workspace &amp; sessions…
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onManage();
            }}
            className="menu-row"
          >
            <FolderOpen className="size-3.5 text-foreground-subtlest" />
            Thêm dự án…
          </button>
        </div>
      )}
    </div>
  );
}

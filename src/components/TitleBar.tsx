import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelsTopLeft,
  Minus,
  X,
} from "lucide-react";
import WorkspaceSwitcher from "./WorkspaceSwitcher";

interface TitleBarProps {
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
  rightPanelOpen: boolean;
  sidebarOpen: boolean;
  onManageWorkspaces?: () => void;
  /** The embedded duck.ai pane (see BrowserPane); App owns the state. */
  browserSplit: boolean;
  onToggleSplit: () => void;
}

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * Conversation header. Ported from ZCode's `WorkspaceHeader`:
 *   - 48px tall (`h-12`), `p-2`, `border-b border-border/50`
 *   - leading actions on the left, trailing actions + window controls on the right
 *   - the whole row is a drag region; buttons opt out
 *
 * Window controls follow ZCode's `DesktopWindowControls`: square ghost icon
 * buttons with `size-4` glyphs, close tinted destructive on hover.
 */
export default function TitleBar({
  onToggleSidebar,
  onToggleRightPanel,
  rightPanelOpen,
  sidebarOpen,
  onManageWorkspaces,
  browserSplit,
  onToggleSplit,
}: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  // Null when running outside the Tauri WebView (e.g. plain-browser preview).
  const win = (() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    if (!win) return;
    (async () => {
      try {
        setMaximized(await win.isMaximized());
        const fn = await win.onResized(async () => {
          try { setMaximized(await win.isMaximized()); } catch {}
        });
        unlisten = fn;
      } catch {}
    })();
    return () => { try { unlisten?.(); } catch {} };
  }, [win]);

  const minimize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    win?.minimize().catch((err) => console.error("minimize failed:", err));
  };

  const toggleMax = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    win?.toggleMaximize()
      .then(() => win.isMaximized().then(setMaximized).catch(() => {}))
      .catch((err) => console.error("toggleMaximize failed:", err));
  };

  const closeWindow = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    win?.close().catch((err) => console.error("close failed:", err));
  };

  const headerButton =
    "flex items-center justify-center size-8 rounded-lg text-foreground-subtle hover:bg-hover hover:text-foreground transition-colors";

  return (
    <header className="relative flex w-full shrink-0 h-12 border-b border-border/50">
      {/* NOTE: no `overflow-hidden` here. It used to clip the workspace
        * dropdown to this 48px row, so the menu opened into nothing and the
        * switcher looked broken. Truncation is handled by `min-w-0` +
        * `truncate` on the label itself, not by clipping the row. */}
      <div
        data-tauri-drag-region
        className="flex h-12 flex-1 min-w-0 items-center justify-between gap-2 p-2 titlebar-drag"
      >
        {/* Leading: navigation + workspace identity */}
        <div className="flex items-center gap-1 min-w-0">
          <button
            type="button"
            onClick={onToggleSidebar}
            style={NO_DRAG}
            className={headerButton}
            title={sidebarOpen ? "Ẩn sidebar" : "Hiện sidebar"}
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
          </button>

          <img
            src="/icon.png"
            alt=""
            draggable={false}
            className="w-4 h-4 rounded-[4px] shrink-0 select-none"
          />

          {/* Quick workspace switcher (dropdown) */}
          {onManageWorkspaces && <WorkspaceSwitcher onManage={onManageWorkspaces} />}

          <span data-tauri-drag-region className="text-ui-base font-medium text-foreground truncate">
            lvaigent
          </span>
        </div>

        {/* Trailing: panel toggles + browser split + window controls */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={onToggleSplit}
            style={NO_DRAG}
            className={`${headerButton} ${browserSplit ? "bg-selected text-foreground" : ""}`}
            title={
              browserSplit
                ? "Ẩn trình duyệt lvaigent"
                : "Hiện trình duyệt lvaigent cạnh khu vực AI Agents"
            }
            aria-label="Browser split"
          >
            <PanelsTopLeft className="size-4" />
          </button>


          <button
            type="button"
            onClick={onToggleRightPanel}
            style={NO_DRAG}
            className={`${headerButton} ${rightPanelOpen ? "bg-selected text-foreground" : ""}`}
            title={rightPanelOpen ? "Ẩn side pane" : "Hiện side pane"}
            aria-label="Toggle side pane"
          >
            {rightPanelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          </button>

          {/* Separator: weak rule before the window controls. */}
          <div className="mx-1 h-4 w-px bg-border" />

          <button
            type="button"
            onClick={minimize}
            style={NO_DRAG}
            className={headerButton}
            aria-label="Minimize"
          >
            <Minus className="size-4" />
          </button>

          <button
            type="button"
            onClick={toggleMax}
            style={NO_DRAG}
            className={headerButton}
            aria-label={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? (
              <svg className="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="3" y="1.5" width="9" height="9" rx="1" />
                <rect x="1.5" y="3.5" width="9" height="9" rx="1" fill="var(--color-background)" />
              </svg>
            ) : (
              <svg className="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
              </svg>
            )}
          </button>

          <button
            type="button"
            onClick={closeWindow}
            style={NO_DRAG}
            className={`${headerButton} hover:bg-destructive hover:text-destructive-foreground`}
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    </header>
  );
}

import { useEffect, useState } from "react";
import { useStore } from "./store";
import { startBridgeWatcher } from "./lib/bridge-watcher";
import TitleBar from "./components/TitleBar";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import RightPanel from "./components/RightPanel";
import BrowserPane, { initialBrowserSplit } from "./components/BrowserPane";
import SettingsDialog from "./components/SettingsDialog";
import ReviewPanel from "./components/ReviewPanel";
import CommandsManager from "./components/CommandsManager";
import WorkspaceManager from "./components/WorkspaceManager";
import Toast from "./components/Toast";
import { t, useLang } from "./lib/i18n";

/**
 * App shell, ported from ZCode's `DesktopWindowFrame` + `WorkspaceShellLayout`.
 *
 * Frame composition:
 *   - Window frame       -> bg-background-win-alt (opaque on Windows/Linux/Web)
 *   - Sidebar            -> no surface of its own; it reads as part of the frame,
 *                           with a bare 48px drag strip at the top
 *   - Conversation frame -> bg-background, rounded-xl + border, 48px header inside
 *   - Side pane          -> bg-panel, rounded-xl + border, own 48px tab bar
 *   - The 4px gaps between frames are the frame colour showing through. Layout
 *     frames deliberately do not count toward content radius levels.
 */
/**
 * Persisted pixel width for a resizable region, clamped to a usable range.
 */
function storedWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number.parseFloat(localStorage.getItem(key) ?? "");
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  } catch {
    return fallback;
  }
}

function App() {
  useLang();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarPanelW, setSidebarPanelW] = useState(() =>
    storedWidth("duckchat.sidebarPanelW", 260, 180, 420)
  );
  const [rightPanelW, setRightPanelW] = useState(() =>
    storedWidth("duckchat.rightPanelW", 340, 220, 640)
  );
  const [paneResizing, setPaneResizing] = useState(false);
  /**
   * The embedded duck.ai browser pane: on by default, remembered across
   * restarts, and resizable like every other region (width in CSS px,
   * persisted on release). The native child webview follows this column via
   * `place_duckai` (see BrowserPane).
   */
  const [browserSplit, setBrowserSplit] = useState(() => {
    try {
      return initialBrowserSplit(localStorage.getItem("duckchat.browserSplit"));
    } catch {
      return true;
    }
  });
  const [browserPaneW, setBrowserPaneW] = useState(() =>
    storedWidth("duckchat.browserPaneW", 480, 320, 900)
  );
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen);
  const showReview = useStore((s) => s.showReview);
  const setShowReview = useStore((s) => s.setShowReview);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const reviewFocusPath = useStore((s) => s.reviewFocusPath);
  const setReviewFocusPath = useStore((s) => s.setReviewFocusPath);
  const [showSettings, setShowSettings] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [showWorkspaces, setShowWorkspaces] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Boot once: start the duck.ai session upkeep, then reconcile the project.
  useEffect(() => {
    if (bootstrapped) return;
    setBootstrapped(true);
    // Automatic duck.ai session upkeep: captcha polling (auto-dock), cookie
    // harvest from the bridge page, and background PoW warm-up.
    startBridgeWatcher();
    // Plugin skills/commands live under <app data>/plugins, outside any project,
    // so they are read once at boot and after every install/toggle.
    void useStore.getState().reloadPluginContent();
    // The free model lane publishes its roster at the gateway, not in the app,
    // so the list is re-read at boot: a model that disappeared upstream must
    // disappear from the picker too.
    void useStore.getState().refreshFreeModels();
    // The store already boots on the saved conversation, so this single call
    // resolves the folder that session worked in. Falling back to the most
    // recent workspace covers a fresh launch with history but no session.
    void useStore.getState().ensureProjectOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The project follows the conversation. Selecting a saved session must reopen
  // the folder it worked in — otherwise the app nags "no project open" while the
  // session itself already names one. Idempotent, so a switch to a session with
  // the same project costs nothing.
  useEffect(() => {
    void useStore.getState().ensureProjectOpen();
  }, [activeConversationId]);

  /**
   * Generic horizontal drag for the in-app regions (sidebar, side pane).
   * `sign` is +1 when dragging right widens the region, -1 when the handle
   * sits on the region's left edge. Width lives in React state (DOM-only,
   * cheap); the final value is written to localStorage on release.
   */
  const beginColDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    start: number,
    sign: number,
    min: number,
    max: number,
    setLive: (w: number) => void,
    storageKey: string
  ) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    setPaneResizing(true);
    const startX = e.clientX;
    let latest = start;
    const onMove = (ev: PointerEvent) => {
      latest = Math.round(
        Math.min(max, Math.max(min, start + sign * (ev.clientX - startX)))
      );
      setLive(latest);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = "";
      setPaneResizing(false);
      try {
        localStorage.setItem(storageKey, String(latest));
      } catch {
        /* ignore */
      }
    };
    // Listeners live on `window`, not the handle: pointer capture can be lost
    // when the drag passes over the native duck.ai view (a real child window
    // that wins input), and a leaked drag would then keep resizing the pane
    // long after the button was released.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const toggleSplit = () => {
    const next = !browserSplit;
    setBrowserSplit(next);
    try {
      localStorage.setItem("duckchat.browserSplit", String(next));
    } catch {
      /* ignore */
    }
    // BrowserPane's mount/unmount places or parks the native view itself.
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background-win-alt text-foreground">
      <div className="relative flex flex-1 min-h-0 w-full overflow-hidden app-content-row">
        <Sidebar
          openPanel={sidebarOpen}
          panelWidth={sidebarPanelW}
          resizing={paneResizing}
          onOpenSettings={() => setShowSettings(true)}
          onOpenCommands={() => setShowCommands(true)}
          onOpenWorkspaces={() => setShowWorkspaces(true)}
        />

        {/* Sidebar resize handle: drag to change the panel column's width. */}
        {sidebarOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            title={t("Kéo để thay đổi độ rộng sidebar")}
            onPointerDown={(e) =>
              beginColDrag(
                e,
                sidebarPanelW,
                1,
                180,
                420,
                setSidebarPanelW,
                "duckchat.sidebarPanelW"
              )
            }
            className="group/handle relative z-10 flex h-full w-1 shrink-0 cursor-col-resize items-center justify-center bg-transparent"
          >
            <span className="pointer-events-none absolute inset-y-3 w-0.5 rounded-full bg-foreground-subtlest/50 opacity-0 transition-opacity group-hover/handle:opacity-100" />
          </div>
        )}

        {/* Content region: 4px frame inset on right/bottom, bare drag strip on top. */}
        <div className="flex min-w-[320px] flex-1 flex-col p-1 pl-0 pt-0">
          <div data-tauri-drag-region className="h-1 w-full titlebar-drag" />

          {/* Horizontal group: conversation frame + optional side pane, 4px apart. */}
          <div className="flex flex-1 min-h-0 gap-1">
            <section
              data-workspace-conversation-frame="true"
              className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background rounded-xl border border-border"
            >
              <TitleBar
                onToggleSidebar={() => setSidebarOpen((v) => !v)}
                onToggleRightPanel={() => setRightPanelOpen(!rightPanelOpen)}
                rightPanelOpen={rightPanelOpen}
                sidebarOpen={sidebarOpen}
                onManageWorkspaces={() => setShowWorkspaces(true)}
                browserSplit={browserSplit}
                onToggleSplit={toggleSplit}
              />
              <ChatView />
            </section>

            {browserSplit && (
              <BrowserPane
                width={browserPaneW}
                onClose={toggleSplit}
                paused={
                  showSettings || showCommands || showWorkspaces || showReview
                }
                onResizeStart={(e) =>
                  beginColDrag(
                    e,
                    browserPaneW,
                    -1,
                    320,
                    Math.max(320, window.innerWidth - 460),
                    setBrowserPaneW,
                    "duckchat.browserPaneW"
                  )
                }
              />
            )}

            {rightPanelOpen && (
              <RightPanel
                onClose={() => setRightPanelOpen(false)}
                width={rightPanelW}
                onResizeStart={(e) =>
                  beginColDrag(
                    e,
                    rightPanelW,
                    -1,
                    220,
                    640,
                    setRightPanelW,
                    "duckchat.rightPanelW"
                  )
                }
              />
            )}
          </div>
        </div>
      </div>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showCommands && <CommandsManager onClose={() => setShowCommands(false)} />}
      {showWorkspaces && <WorkspaceManager onClose={() => setShowWorkspaces(false)} />}
      {showReview && (
        <ReviewPanel
          conversationId={activeConversationId}
          focusPath={reviewFocusPath}
          onClose={() => {
            setShowReview(false);
            setReviewFocusPath(null);
          }}
        />
      )}
      <Toast />
    </div>
  );
}

export default App;

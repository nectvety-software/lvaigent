import { useState, useRef, useEffect } from "react";
import { X, Terminal, FileText, Copy, Check, Trash2 } from "lucide-react";
import { useStore } from "../store";
// The tab map below uses `t` as its callback param, so alias the i18n helpers.
import { t as tr, useLang } from "../lib/i18n";

interface RightPanelProps {
  onClose: () => void;
  /** Pixel width, owned by App so the resize drag can live with the layout. */
  width: number;
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void;
}

type PanelTab = "terminal" | "output";

/**
 * Side pane. Ported from ZCode's `AnimatedSidePanePanel`:
 *   - owns its tab bar (48px, drag region) rather than borrowing the app header
 *   - independent frame: `bg-panel`, `rounded-xl` + `border`
 *   - tabs are compact ghost buttons; the active one uses `bg-selected`
 */
export default function RightPanel({ onClose, width, onResizeStart }: RightPanelProps) {
  useLang();
  const { currentProject, terminalLines, clearTerminal, runShell } = useStore();
  const [activeTab, setActiveTab] = useState<PanelTab>("terminal");
  const [terminalInput, setTerminalInput] = useState("");
  const [running, setRunning] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastLen = terminalLines.length;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lastLen]);

  const handleTerminalExec = async () => {
    const cmd = terminalInput.trim();
    if (!cmd || running) return;
    setTerminalInput("");
    setRunning(true);
    await runShell(cmd, { mirrorToTerminal: true });
    setRunning(false);
  };

  const handleCopyPath = () => {
    if (!currentProject) return;
    navigator.clipboard.writeText(currentProject.path);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const lineColor = (kind: string) =>
    kind === "cmd"
      ? "text-terminal-blue"
      : kind === "err"
        ? "text-terminal-red"
        : kind === "info"
          ? "text-foreground-subtlest"
          : "text-foreground-subtle";

  const iconButton =
    "flex items-center justify-center size-7 rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground transition-colors";

  return (
    <div
      className="relative flex flex-col shrink-0 bg-panel rounded-xl border border-border overflow-hidden"
      style={{ width: `${width}px` }}
    >
      {/* Resize handle: a strip on the panel's left edge; dragging it left
        * widens the panel. Pointer capture keeps the drag alive off-element. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
        title={tr("Kéo để thay đổi độ rộng panel")}
        className="group/rp absolute left-0 top-0 bottom-0 z-20 w-1.5 cursor-col-resize"
      >
        <span className="pointer-events-none absolute inset-y-6 left-0.5 w-0.5 rounded-full bg-foreground-subtlest/50 opacity-0 transition-opacity group-hover/rp:opacity-100" />
      </div>
      {/* Tab bar: own 48px drag region, matching the conversation header height. */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between h-12 px-2 shrink-0 border-b border-border/50 titlebar-drag"
      >
        <div className="flex items-center gap-0.5">
          {([
            { key: "terminal", label: "Terminal", icon: Terminal },
            { key: "output", label: "Output", icon: FileText },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-1.5 h-7 px-2 rounded-md text-ui-base font-medium transition-colors ${
                activeTab === t.key
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover hover:text-foreground"
              }`}
            >
              <t.icon className="size-3.5" />
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={clearTerminal} title={tr("Xóa terminal")} className={iconButton}>
            <Trash2 className="size-4" />
          </button>
          <button onClick={onClose} title={tr("Đóng side pane")} className={iconButton}>
            <X className="size-4" />
          </button>
        </div>
      </div>

      {activeTab === "terminal" ? (
        <>
          {/* Project info */}
          {currentProject && (
            <div className="px-3 py-2 border-b border-border space-y-1 shrink-0">
              <div className="flex items-center justify-between">
                <span className="text-ui-xs text-foreground-subtlest uppercase tracking-wider">Project</span>
                <button
                  onClick={handleCopyPath}
                  className="text-ui-xs text-foreground-subtle hover:text-foreground flex items-center gap-0.5 transition-colors"
                >
                  {copiedPath ? <Check className="size-3" /> : <Copy className="size-3" />}
                  {copiedPath ? tr("Đã copy") : "Copy path"}
                </button>
              </div>
              <div className="text-ui-sm text-foreground font-medium truncate">{currentProject.name}</div>
              <div className="flex gap-3 text-ui-xs text-foreground-subtlest">
                <span>{currentProject.fileCount ?? 0} files</span>
                <span>{currentProject.dirCount ?? 0} dirs</span>
                {currentProject.type && <span className="text-foreground-subtle">{currentProject.type}</span>}
              </div>
            </div>
          )}

          {/* Terminal output */}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-ui-sm leading-relaxed">
            {terminalLines.length === 0 ? (
              <div className="text-foreground-subtlest">{tr("Terminal trống. Gõ một lệnh bên dưới.")}</div>
            ) : (
              terminalLines.map((l) => (
                <div key={l.id} className={`py-0.5 whitespace-pre-wrap break-words ${lineColor(l.kind)}`}>
                  {l.kind === "cmd" ? `$ ${l.text}` : l.text}
                </div>
              ))
            )}
            {running && <div className="py-0.5 text-foreground-subtlest">…</div>}
          </div>

          {/* Terminal input */}
          <div className="px-3 pb-3 pt-1 shrink-0">
            <div className="flex items-center gap-2 h-8 bg-input border border-input-border rounded-lg px-2.5 focus-within:border-input-border-focused transition-colors">
              <span className="text-foreground-subtle text-ui-sm font-mono">$</span>
              <input
                value={terminalInput}
                onChange={(e) => setTerminalInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleTerminalExec()}
                placeholder={currentProject ? tr("Lệnh trong project…") : tr("Lệnh…")}
                disabled={running}
                className="flex-1 min-w-0 bg-transparent text-ui-sm text-foreground placeholder-foreground-subtlest outline-none font-mono"
              />
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-ui-sm leading-relaxed">
          <div className="text-foreground-subtlest mb-2">
            {tr("Nhật ký hoạt động của agent (lệnh agent chạy sẽ hiện ở cả Terminal).")}
          </div>
          {terminalLines
            .filter((l) => l.kind === "info" || l.kind === "err")
            .map((l) => (
              <div key={l.id} className={`py-0.5 whitespace-pre-wrap break-words ${lineColor(l.kind)}`}>
                {l.text}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

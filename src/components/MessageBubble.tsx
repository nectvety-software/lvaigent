import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore, attachmentKindFor } from "../store";
import { stripToolBlocks } from "../lib/agent";
import {
  Copy,
  Check,
  FileSearch,
  FolderTree,
  FileCode2,
  Search,
  Terminal,
  FileEdit,
  Wrench,
  ChevronRight,
  Loader2,
  XCircle,
  ShieldAlert,
  FileCode,
  Image as ImageIcon,
  Folder,
  Square,
  GitCompare,
} from "lucide-react";
import type { Message, AgentStep } from "../types";
import { parseUnifiedDiff, hunksToRows } from "../lib/git-diff";
import { t, tf, useLang } from "../lib/i18n";
import DiffRows from "./DiffRows";
import HoverPreview from "./HoverPreview";
import Markdown from "./Markdown";

const TOOL_META: Record<string, { icon: typeof Wrench; label: (a: Record<string, string>) => string }> = {
  list_files: { icon: FolderTree, label: (a) => a.root || "project" },
  glob: { icon: FileSearch, label: (a) => a.pattern || "" },
  read_file: { icon: FileCode2, label: (a) => a.path || "" },
  grep: { icon: Search, label: (a) => `“${a.query || "”"}` },
  run_command: { icon: Terminal, label: (a) => a.command || "" },
  write_file: { icon: FileEdit, label: (a) => a.path || "" },
};

function stepIcon(step: AgentStep) {
  const meta = TOOL_META[step.tool];
  const Icon = meta?.icon ?? Wrench;
  return <Icon size={12} className="shrink-0" />;
}

/** Clickable +N/−N badge that expands the file's Git diff inline. */
function InlineDiffBadge({ step }: { step: AgentStep }) {
  useLang();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ReturnType<typeof hunksToRows> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setShowReview = useStore((s) => s.setShowReview);
  const setReviewFocusPath = useStore((s) => s.setReviewFocusPath);
  const currentProject = useStore((s) => s.currentProject);

  const loadDiff = async () => {
    if (rows || loading || !step.write) return;
    setLoading(true);
    setError(null);
    try {
      const root = currentProject?.path;
      const rel = step.write.path;
      const raw = root
        ? await invoke<string>("git_diff", { path: rel, root })
        : "";
      const parsed = parseUnifiedDiff(raw);
      if (parsed.binary) {
        setError("File nhị phân — không hiển thị diff.");
        setRows([]);
      } else if (parsed.hunks.length > 0) {
        setRows(hunksToRows(parsed.hunks));
      } else {
        setError("Không đọc được diff Git của file này.");
        setRows([]);
      }
    } catch (e) {
      setError(String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void loadDiff();
  };

  return (
    <div className="shrink-0">
      <span className="flex items-center gap-0.5">
        <button
          onClick={toggle}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono text-ui-xs bg-surface-hover hover:bg-card-selected transition-colors"
          title={open ? t("Thu gọn diff") : t("Xem diff ngay tại đây")}
        >
          <span className="text-success">+{step.write!.added}</span>
          <span className="text-destructive">−{step.write!.removed}</span>
          <GitCompare size={9} className="text-foreground-subtlest" />
        </button>
        <button
          onClick={() => {
            setReviewFocusPath(step.write!.path);
            setShowReview(true);
          }}
          className="p-0.5 rounded-md text-foreground-subtlest hover:text-brand transition-colors"
          title={t("Mở review panel")}
        >
          <ChevronRight size={10} />
        </button>
      </span>
      {open && (
        <div className="mt-1 rounded-lg border border-border overflow-hidden">
          {loading ? (
            <div className="px-3 py-2.5 text-ui-xs text-foreground-subtlest flex items-center gap-2 bg-terminal-bg">
              <Loader2 size={11} className="animate-spin" /> {t("Đang đọc diff…")}
            </div>
          ) : error ? (
            <div className="px-3 py-2.5 text-ui-xs text-warning/90 bg-terminal-bg">{t(error)}</div>
          ) : (
            <DiffRows rows={rows ?? []} />
          )}
        </div>
      )}
    </div>
  );
}

function ToolStepRow({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  const setShowReview = useStore((s) => s.setShowReview);
  const setReviewFocusPath = useStore((s) => s.setReviewFocusPath);
  const meta = TOOL_META[step.tool];
  const label = meta ? meta.label(step.args) : step.args.path || step.args.pattern || step.args.query || "";

  const openReview = () => {
    if (!step.write) return;
    setReviewFocusPath(step.write.path);
    setShowReview(true);
  };

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-ui-sm transition-colors ${
          step.detail ? "hover:bg-surface-hover" : ""
        }`}
      >
        {step.status === "running" ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-brand" />
        ) : step.status === "error" ? (
          <XCircle size={12} className="shrink-0 text-destructive" />
        ) : step.status === "denied" ? (
          <ShieldAlert size={12} className="shrink-0 text-warning" />
        ) : (
          <Check size={12} className="shrink-0 text-foreground-subtlest" />
        )}
        <span className="text-foreground-subtlest font-mono shrink-0">{step.tool}</span>
        <span className="text-foreground-subtlest truncate flex-1 min-w-0">{label}</span>
        {step.write && <InlineDiffBadge step={step} />}
        {!step.write && (
          <span
            title={step.summary}
            className="text-foreground-subtlest text-ui-xs tabular-nums shrink min-w-0 max-w-[45%] truncate"
          >
            {step.summary}
          </span>
        )}
        {step.endedAt ? (
          <span className="text-foreground-subtlest text-ui-xs shrink-0 tabular-nums">
            {Math.max(1, Math.round((step.endedAt - step.startedAt) / 1000))}s
          </span>
        ) : null}
        {step.detail && (
          <ChevronRight
            size={12}
            className={`shrink-0 text-foreground-subtlest transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </div>
      {open && step.detail && (
        <pre className="px-3 py-2 border-t border-border bg-terminal-bg text-ui-xs font-mono text-foreground-subtle whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {step.detail}
        </pre>
      )}
    </div>
  );
}

/**
 * ZCode-v3.14.3-style run status: a live counter header plus auto-collapse
 * once a large run outgrows the message, so recent steps stay reachable
 * without scrolling past dozens of finished rows.
 */
const TAIL_WHILE_STREAMING = 6;
const TAIL_WHEN_DONE = 8;

function StepList({ steps, streaming }: { steps: AgentStep[]; streaming: boolean }) {
  useLang();
  const [expanded, setExpanded] = useState(false);
  const runningStep = steps.find((s) => s.status === "running");
  const tail = streaming ? TAIL_WHILE_STREAMING : TAIL_WHEN_DONE;
  const collapsible = steps.length > tail + 2;
  const showAll = expanded || !collapsible;
  const shown = showAll ? steps : steps.slice(steps.length - tail);
  return (
    <div className="flex flex-col gap-1 mb-2">
      <div className="flex items-center gap-2 text-ui-xs text-foreground-subtlest">
        <span className="tabular-nums">
          {streaming
            ? tf("LIVE · bước {done}/{total} · đang chạy {tool}", {
                done: steps.length - (runningStep ? 1 : 0),
                total: steps.length,
                tool: runningStep?.tool ?? "…",
              })
            : tf("{total} bước đã hoàn tất", { total: steps.length })}
        </span>
        {collapsible && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="hover:text-foreground transition-colors underline-offset-2 hover:underline"
          >
            {showAll ? t("Thu gọn") : tf("Xem tất cả {n} bước", { n: steps.length })}
          </button>
        )}
      </div>
      {shown.map((s) => (
        <ToolStepRow key={s.id} step={s} />
      ))}
    </div>
  );
}

export default function MessageBubble({ message }: { message: Message }) {
  useLang();
  const [copied, setCopied] = useState(false);

  const isUser = message.role === "user";
  // Legacy turns were persisted with raw <tool> tags (the old strip regex
  // could not match attributes containing '>'), so strip at render time too —
  // an idempotent no-op for messages saved by the current parser.
  const visible = useMemo(
    () => (isUser ? message.content : stripToolBlocks(message.content)),
    [isUser, message.content]
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(visible);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const time = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const waiting = message.isStreaming && !message.content && !(message.steps?.length);

  return (
    <div className="group/msg">
      {isUser ? (
        <div className="py-3">
          {message.fileRefs && message.fileRefs.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {message.fileRefs.map((f) => {
                // Messages stored before imports existed carry no kind.
                const kind = f.kind ?? attachmentKindFor(f.path);
                const KindIcon =
                  kind === "image" ? ImageIcon : kind === "folder" ? Folder : FileCode;
                return (
                  <HoverPreview
                    key={f.path}
                    name={f.name}
                    path={f.path}
                    kind={kind}
                    placement="below"
                  >
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-border bg-surface text-ui-xs text-foreground-subtle"
                    >
                      <KindIcon size={10} className="text-brand" />
                      {f.name}
                    </span>
                  </HoverPreview>
                );
              })}
            </div>
          )}
          <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-ui-base text-foreground whitespace-pre-wrap break-words">
            {message.content}
          </div>
          <div className="text-ui-xs text-foreground-subtlest mt-1 px-0.5">{time}</div>
        </div>
      ) : (
        <div className="py-3">
          <div className="flex items-center gap-2 mb-2 text-ui-xs text-foreground-subtlest">
            <span className="w-5 h-5 rounded-md bg-primary-soft border border-[rgba(255,103,0,0.25)] flex items-center justify-center">
              <Wrench size={10} className="text-brand" />
            </span>
            <span className="font-medium text-foreground-subtle">{message.model ?? "assistant"}</span>
            <span>{time}</span>
          </div>

          {message.steps && message.steps.length > 0 && (
            <StepList steps={message.steps} streaming={!!message.isStreaming} />
          )}

          {message.mode === "plan" && (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[rgba(255,103,0,0.1)] border border-[rgba(255,103,0,0.25)] text-ui-xs font-medium text-brand mb-2 w-fit">
              <ShieldAlert size={9} />
              {t("PLAN — chỉ đề xuất, không sửa file")}
            </div>
          )}

          {message.stopped && (
            <div className="flex items-center gap-1.5 text-ui-xs text-warning/90 mb-1.5">
              <Square size={10} fill="currentColor" />
              {t("Đã dừng bởi người dùng")}
            </div>
          )}

          {waiting ? (
            <div className="flex items-center gap-2.5 text-foreground-subtlest text-ui-base">
              <span>{t(message.statusText ?? "Đang suy nghĩ")}</span>
              <span className="flex items-center gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-dot"
                    style={{ animationDelay: `${i * 0.2}s` }}
                  />
                ))}
              </span>
            </div>
          ) : visible ? (
            <>
              {message.isStreaming && message.statusText && (
                <div className="flex items-center gap-2 text-ui-sm text-foreground-subtlest mb-1.5">
                  <Loader2 size={11} className="animate-spin" />
                  {t(message.statusText)}
                </div>
              )}
              <div className={message.isStreaming ? "stream-caret" : ""}>
                <Markdown text={visible} />
              </div>
            </>
          ) : message.statusText ? (
            <div className="flex items-center gap-2 text-ui-sm text-foreground-subtlest">
              <Loader2 size={11} className="animate-spin" />
              {t(message.statusText)}
            </div>
          ) : null}

          {visible && !message.isStreaming && (
            <div className="flex items-center gap-0.5 mt-1.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
              <button
                onClick={handleCopy}
                className="p-1 rounded hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors"
                title="Copy"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

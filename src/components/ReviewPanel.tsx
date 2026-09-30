import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X,
  FileEdit,
  FilePlus,
  Undo2,
  RefreshCw,
  GitCompare,
  Camera,
  Plus,
  Minus,
  GitCommitHorizontal,
  Sparkles,
  Loader2,
  Check,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useStore } from "../store";
import type { ReviewFile } from "../types";
import { collapseContext, diffLines } from "../lib/diff";
import { hunksToRows, type GitHunk } from "../lib/git-diff";
import { mergeChangedFiles } from "../lib/changed-files";
import { t as tr, tf as trf, useLang } from "../lib/i18n";
import DiffRows, { type DiffRow } from "./DiffRows";

const TURN_CHIP_STYLE = [
  "bg-blue-500/20 text-blue-300 border-blue-500/40",
  "bg-purple-500/20 text-purple-300 border-purple-500/40",
  "bg-pink-500/20 text-pink-300 border-pink-500/40",
  "bg-amber-500/20 text-amber-300 border-amber-500/40",
  "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
  "bg-rose-500/20 text-rose-300 border-rose-500/40",
  "bg-lime-500/20 text-lime-300 border-lime-500/40",
  "bg-indigo-500/20 text-indigo-300 border-indigo-500/40",
];
const turnChip = (t: number) => TURN_CHIP_STYLE[t % TURN_CHIP_STYLE.length];

/** Diff rows with per-line turn markers: "L2" chip = introduced by turn 2. */
function MarkerRows({
  rows,
  rowTurns,
  enabled,
}: {
  rows: DiffRow[];
  rowTurns: (number | undefined)[];
  enabled: boolean;
}) {
  useLang();
  if (!enabled) return <DiffRows rows={rows} />;
  return (
    <div className="border-t border-border bg-terminal-bg font-mono text-ui-xs leading-[1.5] max-h-[50vh] overflow-auto">
      {rows.map((row, i) => {
        if (row.type === "gap") {
          return (
            <div key={i} className="px-3 py-0.5 text-foreground-subtlest bg-surface/60 select-none">
              ⋯ {trf("{count} dòng không đổi", { count: row.count })}
            </div>
          );
        }
        const bg =
          row.type === "add" ? "bg-diff-added/10" : row.type === "del" ? "bg-diff-removed/10" : "";
        const sign = row.type === "add" ? "+" : row.type === "del" ? "−" : " ";
        const signColor =
          row.type === "add"
            ? "text-success"
            : row.type === "del"
              ? "text-destructive"
              : "text-foreground-subtlest";
        const textColor =
          row.type === "add"
            ? "text-diff-added"
            : row.type === "del"
              ? "text-diff-removed"
              : "text-foreground-subtle";
        const turnIdx = rowTurns[i];
        return (
          <div key={i} className={`flex ${bg} whitespace-pre-wrap break-all`}>
            <span className="w-9 shrink-0 text-right pr-1.5 text-foreground-subtlest select-none tabular-nums">
              {row.a ?? row.b ?? ""}
            </span>
            <span className={`w-4 shrink-0 text-center ${signColor} select-none`}>{sign}</span>
            <span className={`flex-1 pr-1 ${textColor}`}>{row.text}</span>
            {turnIdx !== undefined && turnIdx >= 0 && (
              <span
                className={`self-center mr-1.5 px-1 rounded border text-ui-xs font-bold shrink-0 ${turnChip(turnIdx)}`}
                title={trf("Dòng này được thêm ở lượt {turn}", { turn: turnIdx + 1 })}
              >
                L{turnIdx + 1}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ReviewPanelProps {
  conversationId: string | null;
  /** When set, open the panel scrolled/expanded to this file. */
  focusPath?: string | null;
  onClose: () => void;
}

/** "14:05" / "hôm qua 14:05" style label for a timeline milestone. */
function formatEditTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `${d.toLocaleDateString([], { day: "2-digit", month: "2-digit" })} ${hm}`;
}

/** Vertical per-send timeline shown under a file row in session scope.
 *  Clicking a milestone switches the file's diff to that turn only. */
function EditTimeline({
  edits,
  selected,
  onSelect,
}: {
  edits: NonNullable<ReviewFile["edits"]>;
  selected: number | null;
  onSelect: (turn: number | null) => void;
}) {
  useLang();
  return (
    <div className="border-t border-border px-3 py-2 space-y-0">
      {edits.map((e, i) => {
        const active = selected === i;
        return (
          <button
            key={i}
            onClick={() => onSelect(active ? null : i)}
            title={active ? tr("Bấm để quay lại diff tổng hợp") : tr("Xem diff riêng của lượt này")}
            className={`w-full flex items-center gap-2 text-ui-xs relative pl-3 pr-1.5 py-0.5 rounded transition-colors ${
              active ? "bg-primary/15" : "hover:bg-surface-hover"
            }`}
          >
            {/* rail + dot */}
            <span
              className="absolute left-[3px] top-0 bottom-0 w-px bg-border"
              style={{ display: i === edits.length - 1 ? "none" : undefined }}
            />
            <span
              className={`absolute left-0 top-1/2 -translate-y-1/2 w-[7px] h-[7px] rounded-full ${
                active ? "bg-primary ring-2 ring-brand/30" : "bg-primary/70"
              }`}
            />
            <span className="text-foreground-subtlest tabular-nums shrink-0">{formatEditTime(e.at)}</span>
            <span className={active ? "text-brand font-medium" : "text-foreground-subtlest"}>
              {trf("lượt {turn}", { turn: i + 1 })}
            </span>
            {e.added > 0 && <span className="font-mono text-success">+{e.added}</span>}
            {e.removed > 0 && <span className="font-mono text-destructive">−{e.removed}</span>}
            {e.added === 0 && e.removed === 0 && (
              <span className="text-foreground-subtlest">{tr("không đổi")}</span>
            )}
            {active && (
              <span className="ml-auto text-ui-xs text-brand">{tr("đang xem · bấm để thoát")}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Tag chips shown at the right edge of diff rows in marker mode. */
const TURN_CHIP = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"];

/** One collapsible per-file diff block (snapshot or Git source). */
function FileDiff({
  file,
  defaultOpen,
  showTimeline,
}: {
  file: ReviewFile;
  defaultOpen: boolean;
  showTimeline: boolean;
}) {
  useLang();
  const [open, setOpen] = useState(defaultOpen);
  /** null = aggregate diff; 0..n = show only that turn's diff. */
  const [turn, setTurn] = useState<number | null>(null);
  const showMarkers = showTimeline && turn === null && !!file.lineTurns;

  useEffect(() => {
    setTurn(null); // switching scope resets per-turn selection
  }, [showTimeline]);

  const rows: DiffRow[] = useMemo(() => {
    if (turn !== null) {
      const e = file.edits?.[turn];
      if (e) return collapseContext(diffLines(e.before, e.after).lines, 3);
    }
    if (file.hunks) return hunksToRows(file.hunks as GitHunk[]);
    return collapseContext(diffLines(file.before, file.after).lines, 3);
  }, [file, turn]);

  /** For marker mode: which final-file line each collapsed row corresponds to. */
  const rowTurns: (number | undefined)[] = useMemo(() => {
    if (!showMarkers || turn !== null || file.hunks) {
      return rows.map(() => undefined);
    }
    const lineTurns = file.lineTurns ?? [];
    const out: (number | undefined)[] = [];
    let finalLine = 0; // 0-based index into the FINAL file content
    for (const r of rows) {
      if (r.type === "gap") {
        out.push(undefined);
      } else if (r.type === "del") {
        out.push(undefined);
      } else {
        // ctx/add rows carry the final-file (b) line number.
        finalLine = (r.b ?? 1) - 1;
        out.push(lineTurns[finalLine]);
      }
    }
    return out;
  }, [rows, showMarkers, file, turn]);

  const headerLabel =
    turn !== null
      ? trf("Lượt {turn} — riêng lượt này", { turn: turn + 1 })
      : showTimeline
        ? tr("Tổng hợp cả phiên")
        : "";

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover transition-colors"
      >
        {open ? (
          <ChevronDown size={13} className="text-foreground-subtlest shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-foreground-subtlest shrink-0" />
        )}
        {file.created ? (
          <FilePlus size={13} className="text-success shrink-0" />
        ) : (
          <FileEdit size={13} className="text-brand shrink-0" />
        )}
        <span className="font-mono text-ui-sm text-foreground truncate flex-1">{file.path}</span>
        {turn !== null ? (
          <span className="text-ui-xs font-medium text-brand shrink-0 bg-primary/15 px-1.5 py-0.5 rounded">
            {trf("Lượt {turn}", { turn: turn + 1 })}
          </span>
        ) : showTimeline && file.edits && file.edits.length > 1 ? (
          <span
            className="text-ui-xs text-foreground-subtlest shrink-0"
            title={tr("Số lượt agent đã sửa file này trong phiên")}
          >
            {trf("{count} lượt", { count: file.edits.length })}
          </span>
        ) : null}
        {file.binary ? (
          <span className="text-ui-xs text-foreground-subtlest">binary</span>
        ) : (
          <>
            <span className="text-ui-xs font-mono text-success shrink-0">+{file.added}</span>
            <span className="text-ui-xs font-mono text-destructive shrink-0">−{file.removed}</span>
          </>
        )}
      </button>
      {open && showTimeline && file.edits && file.edits.length > 0 && (
        <EditTimeline edits={file.edits} selected={turn} onSelect={setTurn} />
      )}
      {open && turn !== null && (
        <div className="border-t border-border px-3 py-1 text-ui-xs text-foreground-subtlest bg-surface/60">
          {headerLabel} · {tr("chỉ hiển thị thay đổi của lượt được chọn")}
        </div>
      )}
      {open &&
        (file.binary ? (
          <div className="border-t border-border px-3 py-3 text-ui-xs text-foreground-subtlest">
            {tr("File nhị phân — không hiển thị diff.")}
          </div>
        ) : (
          <MarkerRows rows={rows} rowTurns={rowTurns} enabled={showMarkers} />
        ))}
    </div>
  );
}

interface StatusFile {
  path: string;
  index_status: string;
  worktree_status: string;
  untracked: boolean;
}

const statusLetter = (f: StatusFile): string => {
  const x = f.index_status.trim();
  const y = f.worktree_status.trim();
  return (x || y || "M").toUpperCase();
};

/** Git staging + commit block shown above the file list. */
function GitActions({ root }: { root: string }) {
  useLang();
  const addToast = useStore((s) => s.addToast);
  const [files, setFiles] = useState<StatusFile[]>([]);
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const refreshStatus = async () => {
    try {
      const list = await invoke<StatusFile[]>("git_status", { root });
      setFiles(list);
      setStaged(new Set(list.filter((f) => f.index_status.trim()).map((f) => f.path)));
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const refresh = async () => {
    setLoading(true);
    await refreshStatus();
  };

  const toggle = (path: string) => {
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const applyStaging = async (paths: string[]) => {
    const currentlyStaged = new Set(files.filter((f) => f.index_status.trim()).map((f) => f.path));
    const toStage = paths.filter((p) => !currentlyStaged.has(p));
    const toUnstage = paths.filter((p) => currentlyStaged.has(p));
    try {
      if (toStage.length > 0) await invoke("git_stage", { paths: toStage, root });
      if (toUnstage.length > 0) await invoke("git_unstage", { paths: toUnstage, root });
      await refresh();
    } catch (e) {
      addToast(trf("Git staging lỗi: {error}", { error: String(e) }), "error");
    }
  };

  const suggestMessage = async () => {
    setSuggesting(true);
    try {
      const msg = await invoke<string>("git_suggest_commit_message", { root });
      setMessage(msg);
    } catch (e) {
      addToast(trf("Không gợi ý được: {error}", { error: String(e) }), "error");
    } finally {
      setSuggesting(false);
    }
  };

  const commit = async () => {
    const msg = message.trim();
    if (!msg || committing) return;
    setCommitting(true);
    try {
      await invoke("git_commit", { message: msg, root });
      addToast(tr("Đã commit thay đổi staged"), "success");
      setMessage("");
      await refresh();
    } catch (e) {
      addToast(trf("Commit thất bại: {error}", { error: String(e) }), "error");
    } finally {
      setCommitting(false);
    }
  };

  const stagedCount = files.filter((f) => f.index_status.trim()).length;
  const unstagedCount = files.length - stagedCount;

  if (loading) {
    return (
      <div className="px-3 py-2.5 rounded-lg border border-border bg-surface text-ui-xs text-foreground-subtlest flex items-center gap-2">
        <Loader2 size={12} className="animate-spin" /> {tr("Đang đọc git status…")}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="px-3 py-2 rounded-lg border border-border bg-surface text-ui-xs text-foreground-subtlest">
        {tr("Git: working tree sạch — không có gì để stage/commit.")}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden shrink-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover transition-colors"
      >
        {expanded ? (
          <ChevronDown size={13} className="text-foreground-subtlest shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-foreground-subtlest shrink-0" />
        )}
        <GitCommitHorizontal size={13} className="text-brand shrink-0" />
        <span className="text-ui-sm text-foreground flex-1">Stage & commit (git)</span>
        <span className="text-ui-xs text-foreground-subtlest font-mono">
          {stagedCount} staged · {unstagedCount} unstaged
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border p-2 space-y-2">
          {/* File checkboxes */}
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {files.map((f) => {
              const isStaged = staged.has(f.path);
              return (
                <label
                  key={f.path}
                  className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-surface-hover cursor-pointer text-ui-xs"
                >
                  <input
                    type="checkbox"
                    checked={isStaged}
                    onChange={() => void applyStaging([f.path])}
                    className="accent-brand"
                  />
                  <span
                    className={`font-mono shrink-0 w-3 text-center ${
                      statusLetter(f) === "D" ? "text-destructive" : "text-success"
                    }`}
                  >
                    {statusLetter(f)}
                  </span>
                  <span className="truncate font-mono text-foreground-subtle">{f.path}</span>
                  {f.untracked && <span className="text-ui-xs text-foreground-subtlest">new</span>}
                </label>
              );
            })}
          </div>
          {/* Bulk actions */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void applyStaging(files.map((f) => f.path))}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-ui-xs border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
            >
              <Plus size={11} /> {tr("Stage tất cả")}
            </button>
            <button
              onClick={() => void applyStaging([])}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-ui-xs border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
            >
              <Minus size={11} /> {tr("Unstage tất cả")}
            </button>
            <button
              onClick={() => void refresh()}
              className="p-1 rounded-md hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors"
              title={tr("Đọc lại git status")}
            >
              <RefreshCw size={11} />
            </button>
          </div>
          {/* Commit message + actions */}
          <div className="flex items-center gap-1.5">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message…"
              className="input-field text-ui-sm font-mono py-1.5 flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") void commit();
              }}
            />
            <button
              onClick={() => void suggestMessage()}
              disabled={suggesting}
              className="p-1.5 rounded-md border border-border text-foreground-subtle hover:text-brand hover:bg-surface-hover transition-colors disabled:opacity-40"
              title={tr("Gợi ý message từ thay đổi")}
            >
              {suggesting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Sparkles size={13} />
              )}
            </button>
            <button
              onClick={() => void commit()}
              disabled={!message.trim() || committing}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-ui-xs font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all disabled:opacity-30"
            >
              {committing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <GitCommitHorizontal size={12} />
              )}
              Commit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReviewPanel({ conversationId, focusPath, onClose }: ReviewPanelProps) {
  useLang();
  const getReviewFiles = useStore((s) => s.getReviewFiles);
  const getConversationEditTxs = useStore((s) => s.getConversationEditTxs);
  const undoLastEdit = useStore((s) => s.undoLastEdit);
  const reviewSource = useStore((s) => s.settings.reviewSource);
  const updateSettings = useStore((s) => s.updateSettings);
  const reloadProjectData = useStore((s) => s.reloadProjectData);
  const reviewUpdatedAt = useStore((s) => s.reviewUpdatedAt);
  const currentProject = useStore((s) => s.currentProject);

  const [files, setFiles] = useState<ReviewFile[]>([]);
  const [loading, setLoading] = useState(true);
  /** "last" = most recent agent send; "session" = every edit of the conversation. */
  const [scope, setScope] = useState<"last" | "session">("last");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load =
      scope === "session"
        ? Promise.resolve(
            mergeChangedFiles(getConversationEditTxs(conversationId ?? ""))
          )
        : getReviewFiles(conversationId ?? "");
    void load.then((f) => {
      if (alive) {
        setFiles(f);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
    // Reload when the source changes or a new edit tx commits.
  }, [conversationId, getReviewFiles, getConversationEditTxs, reviewSource, reviewUpdatedAt, scope]);

  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-[1px] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="dialog-surface w-[720px] max-w-[94vw] max-h-[85vh] flex flex-col animate-scale-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <FileEdit size={15} className="text-brand" />
            <span className="text-ui-base font-semibold text-foreground">{tr("Thay đổi của agent")}</span>
            <span className="text-ui-xs text-foreground-subtlest">
              {trf("{count} file", { count: files.length })} ·{" "}
              <span className="text-success">+{totalAdded}</span>{" "}
              <span className="text-destructive">−{totalRemoved}</span>
            </span>
          </div>
          <div className="flex items-center rounded-lg border border-border overflow-hidden">
            <button
              onClick={() => setScope("last")}
              className={`px-2 py-1 text-ui-xs transition-colors ${
                scope === "last"
                  ? "bg-surface-hover text-brand"
                  : "text-foreground-subtlest hover:text-foreground-subtle"
              }`}
              title={tr("Chỉ lượt gửi gần nhất của agent")}
            >
              {tr("Lượt này")}
            </button>
            <button
              onClick={() => setScope("session")}
              className={`px-2 py-1 text-ui-xs transition-colors ${
                scope === "session"
                  ? "bg-surface-hover text-brand"
                  : "text-foreground-subtlest hover:text-foreground-subtle"
              }`}
              title={tr("Tác nhân đã thay đổi tệp — mọi file agent đã sửa trong phiên này")}
            >
              {tr("Cả phiên")}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Source switcher */}
            <div className="flex items-center rounded-lg border border-border overflow-hidden mr-1">
              <button
                onClick={() => updateSettings({ reviewSource: "git" })}
                className={`flex items-center gap-1 px-2 py-1 text-ui-xs transition-colors ${
                  reviewSource === "git"
                    ? "bg-surface-hover text-brand"
                    : "text-foreground-subtlest hover:text-foreground-subtle"
                }`}
                title={tr("So với Git (trạng thái hiện tại của repo)")}
              >
                <GitCompare size={11} />
                Git
              </button>
              <button
                onClick={() => updateSettings({ reviewSource: "snapshot" })}
                className={`flex items-center gap-1 px-2 py-1 text-ui-xs transition-colors ${
                  reviewSource === "snapshot"
                    ? "bg-surface-hover text-brand"
                    : "text-foreground-subtlest hover:text-foreground-subtle"
                }`}
                title={tr("So với snapshot trong bộ nhớ (trước/sau lượt agent)")}
              >
                <Camera size={11} />
                Snapshot
              </button>
            </div>
            <button
              onClick={() => void reloadProjectData()}
              className="p-1.5 rounded-lg hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors"
              title={tr("Đọc lại Git diff và custom commands")}
            >
              <RefreshCw size={13} />
            </button>
            <button
              onClick={() => conversationId && undoLastEdit(conversationId)}
              disabled={files.length === 0 || scope === "session"}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-sm font-medium border border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title={scope === "session" ? tr("Undo chỉ dùng cho phạm vi \"Lượt này\"") : tr("Hoàn tác toàn bộ thay đổi này (/undo)")}
            >
              <Undo2 size={13} />
              Undo
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Git stage & commit (only in Git source mode with an open project) */}
        {reviewSource === "git" && currentProject && (
          <div className="px-3 pt-3 shrink-0">
            <GitActions root={currentProject.path} />
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 modal-scroll">
          {loading ? (
            <div className="text-center text-ui-sm text-foreground-subtlest py-10">{tr("Đang đọc diff…")}</div>
          ) : files.length === 0 ? (
            <div className="text-center text-ui-sm text-foreground-subtlest py-10">
              {scope === "session"
                ? tr("Tác nhân chưa thay đổi tệp nào trong phiên này.")
                : tr("Chưa có thay đổi nào ở lượt gần nhất.")}
            </div>
          ) : (
            files
              .slice()
              .sort((a, b) => (a.path === focusPath ? -1 : b.path === focusPath ? 1 : 0))
              .map((f) => (
                <FileDiff
                  key={f.path}
                  file={f}
                  showTimeline={scope === "session"}
                  defaultOpen={focusPath ? f.path === focusPath : files.length <= 3}
                />
              ))
          )}
        </div>
      </div>
    </div>
  );
}

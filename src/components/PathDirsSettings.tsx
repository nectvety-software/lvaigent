import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderPlus, Trash2 } from "lucide-react";
import { useStore } from "../store";
import { t, tf, useLang } from "../lib/i18n";

interface PathReport {
  /** Directories the agent's shell actually searches. */
  searched: number;
  /** Pinned folders that are not (yet) a real directory. */
  invalid: string[];
}

/**
 * Settings → General: folders `run_command` searches before the system PATH.
 *
 * The shell inherits the environment of whatever launched DuckChat, so an
 * interpreter that ships inside its own folder (a Lua/MRE emulator, a bundled
 * toolchain) reads to the agent as "máy chưa cài Lua". Pinning the folder here
 * makes the command resolve without the user editing Windows or restarting.
 */
export default function PathDirsSettings() {
  useLang();
  const dirs = useStore((s) => s.settings.extraPathDirs);
  const updateSettings = useStore((s) => s.updateSettings);
  const [report, setReport] = useState<PathReport | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<PathReport>("path_report", { extra: dirs ?? [] })
      .then((r) => alive && setReport(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dirs]);

  const pinned = dirs ?? [];

  const addFolders = async () => {
    let picked: string | string[] | null = null;
    try {
      picked = await openDialog({
        directory: true,
        multiple: true,
        title: t("Chọn thư mục thêm vào PATH của agent"),
      });
    } catch {
      return;
    }
    if (!picked) return;
    const next = [...pinned, ...(Array.isArray(picked) ? picked : [picked])].filter(
      (d, i, all) => all.indexOf(d) === i
    );
    updateSettings({ extraPathDirs: next });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-ui-sm font-medium text-foreground-subtle">
          {t("Đường dẫn PATH bổ sung")} ({pinned.length})
        </label>
        <button
          onClick={() => void addFolders()}
          className="h-6 px-2 inline-flex items-center gap-1 rounded-md text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground transition-colors"
        >
          <FolderPlus size={13} />
          {t("Thêm thư mục")}
        </button>
      </div>
      <p className="text-ui-xs text-foreground-subtlest mb-2">
        {t("Agent tìm lệnh trong các thư mục này trước, rồi mới đến PATH của hệ thống. Thêm thư mục chứa")}{" "}
        <code className="text-foreground-subtle">lua.exe</code>
        {t(", emulator hoặc bộ build của bạn nếu chúng nằm ngoài PATH.")}
      </p>

      {pinned.length > 0 && (
        <div className="space-y-0.5 rounded-xl border border-border bg-surface px-3 py-1.5">
          {pinned.map((d) => {
            const bad = report?.invalid.includes(d);
            return (
              <div key={d} className="flex items-center gap-2 py-1">
                <span
                  className={`flex-1 font-mono text-ui-xs truncate ${
                    bad ? "text-warning" : "text-foreground-subtle"
                  }`}
                  title={bad ? tf("{path} — thư mục không tồn tại", { path: d }) : d}
                >
                  {d}
                </span>
                <button
                  onClick={() =>
                    updateSettings({ extraPathDirs: pinned.filter((x) => x !== d) })
                  }
                  className="shrink-0 p-1 rounded-md text-foreground-subtlest hover:bg-hover hover:text-destructive transition-colors"
                  aria-label={tf("Bỏ {path}", { path: d })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {report && (
        <p className="text-ui-xs text-foreground-subtlest mt-1.5">
          {tf("Shell của agent đang tìm lệnh trong {n} thư mục", { n: report.searched })}
          {report.invalid.length > 0 && (
            <span className="text-warning">
              {" "}
              {tf("· {n} thư mục ghim không tồn tại", { n: report.invalid.length })}
            </span>
          )}
          .
        </p>
      )}
    </div>
  );
}

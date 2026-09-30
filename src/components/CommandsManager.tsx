import { useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X,
  Plus,
  Pencil,
  Trash2,
  FileText,
  RefreshCw,
  Check,
  TerminalSquare,
  AlertTriangle,
} from "lucide-react";
import { useStore, getCustomCommands } from "../store";
import {
  loadCustomCommands,
  validateFrontmatter,
  type CustomCommand,
  type FrontmatterIssue,
} from "../lib/custom-commands";
import { t, tf, useLang } from "../lib/i18n";

interface CommandsManagerProps {
  onClose: () => void;
}

/** Hard errors block saving; style warnings (unknown key, empty description) don't. */
const isHardError = (issues: FrontmatterIssue[]): boolean =>
  issues.some(
    (i) =>
      i.message.includes("Thiếu dòng đóng") ||
      i.message.includes("không hợp lệ") ||
      i.message.includes("bị trùng")
  );

/** Editable textarea for one command file (frontmatter + template). */
function CommandEditor({
  initialName,
  initialBody,
  isNew,
  onSave,
  onCancel,
}: {
  initialName: string;
  initialBody: string;
  isNew: boolean;
  onSave: (name: string, body: string) => void;
  onCancel: () => void;
}) {
  useLang();
  const [name, setName] = useState(initialName);
  const [body, setBody] = useState(initialBody);
  const [saving, setSaving] = useState(false);

  const issues = useMemo(() => validateFrontmatter(body), [body]);
  const blocking = isHardError(issues);

  const handleSave = async () => {
    const clean = name.trim().replace(/\.md$/, "");
    if (!clean || saving || blocking) return;
    setSaving(true);
    await onSave(clean, body);
    setSaving(false);
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-brand font-mono text-ui-base">/</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.replace(/[^\w.-]/g, "-"))}
          placeholder="ten-lenh"
          className="input-field text-ui-base font-mono py-1.5 flex-1"
          disabled={!isNew}
        />
        <span className="text-ui-xs text-foreground-subtlest font-mono">.md</span>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={"---\ndescription: Mô tả ngắn\n---\nPrompt template. Dùng $ARGUMENTS để chèn args."}
        className="input-field text-ui-sm font-mono min-h-[200px] resize-y leading-relaxed"
      />
      {issues.length > 0 && (
        <div
          className={`rounded-lg border px-2.5 py-2 space-y-1 text-ui-xs ${
            blocking
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-warning/40 bg-warning/10 text-warning"
          }`}
        >
          <div className="font-medium flex items-center gap-1.5">
            <AlertTriangle size={11} />
            {blocking ? t("Frontmatter lỗi — chưa thể lưu") : t("Cảnh báo frontmatter")}
          </div>
          {issues.map((iss, i) => (
            <div key={i} className="font-mono">
              {iss.line ? tf("Dòng {line}: ", { line: iss.line }) : ""}
              {iss.message}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-ui-xs text-foreground-subtlest">
          {t("$ARGUMENTS = args sau lệnh · $1, $2… = từng từ")}
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-ui-sm border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            {t("Hủy")}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || blocking || !name.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-sm font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all disabled:opacity-30"
          >
            <Check size={12} />
            {t("Lưu")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CommandsManager({ onClose }: CommandsManagerProps) {
  useLang();
  const currentProject = useStore((s) => s.currentProject);
  const reloadProjectData = useStore((s) => s.reloadProjectData);
  const addToast = useStore((s) => s.addToast);

  const [commands, setCommands] = useState<CustomCommand[]>(() => getCustomCommands());
  const [editing, setEditing] = useState<
    { mode: "new" } | { mode: "edit"; cmd: CustomCommand } | null
  >(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    if (!currentProject) return;
    setRefreshing(true);
    await reloadProjectData();
    setCommands(loadCustomCommandsFromStore());
    setRefreshing(false);
  };

  const loadCustomCommandsFromStore = (): CustomCommand[] => getCustomCommands();

  const cmdPath = (name: string): string => {
    if (!currentProject) return name;
    const sep = currentProject.path.includes("\\") ? "\\" : "/";
    return `${currentProject.path.replace(/[\\/]+$/, "")}${sep}.duckchat${sep}commands${sep}${name}.md`;
  };

  const handleSave = async (name: string, body: string) => {
    if (!currentProject) return;
    try {
      await invoke<number>("write_file", { path: cmdPath(name), content: body, root: null });
      addToast(tf("Đã lưu /{name}", { name }), "success");
      setEditing(null);
      await refresh();
    } catch (e) {
      addToast(tf("Không lưu được lệnh: {err}", { err: String(e) }), "error");
    }
  };

  const handleDelete = async (cmd: CustomCommand) => {
    try {
      await invoke("delete_file", { path: cmd.path, root: null });
      addToast(tf("Đã xóa /{name}", { name: cmd.name }), "success");
      await refresh();
    } catch (e) {
      addToast(tf("Không xóa được: {err}", { err: String(e) }), "error");
    }
  };

  const newTemplate = `---\ndescription: Mô tả ngắn cho lệnh\n---\nViết prompt ở đây. Args người dùng gõ sẽ thay vào $ARGUMENTS.`;

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
            <TerminalSquare size={15} className="text-brand" />
            <span className="text-ui-base font-semibold text-foreground">Custom commands</span>
            <span className="text-ui-xs text-foreground-subtlest font-mono truncate max-w-[220px]">
              .duckchat/commands
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void refresh()}
              className="p-1.5 rounded-lg hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors"
              title={t("Đọc lại từ đĩa")}
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 modal-scroll">
          {!currentProject ? (
            <div className="text-center text-ui-sm text-foreground-subtlest py-10">
              {t("Mở một project để quản lý custom commands.")}
            </div>
          ) : editing ? (
            <CommandEditor
              initialName={editing.mode === "edit" ? editing.cmd.name : ""}
              initialBody={editing.mode === "edit" ? editing.cmd.rawContent ?? editing.cmd.template : newTemplate}
              isNew={editing.mode === "new"}
              onSave={handleSave}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <>
              <button
                onClick={() => setEditing({ mode: "new" })}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-dashed border-border text-ui-base text-foreground-subtle hover:text-brand hover:border-brand/40 transition-colors"
              >
                <Plus size={15} />
                {t("Tạo lệnh mới")}
              </button>
              {commands.length === 0 ? (
                <div className="text-center text-ui-sm text-foreground-subtlest py-8">
                  {t("Chưa có custom command nào trong project này.")}
                  <br />
                  {t("Tạo file ")}<span className="font-mono">.duckchat/commands/&lt;tên&gt;.md</span>{" "}
                  {tf("hoặc bấm \"{btn}\".", { btn: t("Tạo lệnh mới") })}
                </div>
              ) : (
                commands.map((cmd) => (
                  <div
                    key={cmd.path}
                    className="group flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border bg-surface"
                  >
                    <FileText size={13} className="text-brand shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-ui-base font-mono text-foreground">
                        /{cmd.name}
                      </div>
                      <div className="text-ui-xs text-foreground-subtlest truncate">{cmd.description}</div>
                    </div>
                    <button
                      onClick={() => setEditing({ mode: "edit", cmd })}
                      className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-all"
                      title={t("Sửa")}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => void handleDelete(cmd)}
                      className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-destructive/15 text-foreground-subtlest hover:text-destructive transition-all"
                      title={t("Xóa file")}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

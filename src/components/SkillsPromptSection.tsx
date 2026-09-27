import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText, Plus, Trash2, ShieldAlert, Wrench, Upload } from "lucide-react";
import { useStore } from "../store";
import { SKILLS, PROMPT_SECTIONS, isSkillEnabled, isPromptEnabled } from "../lib/skills";
import { parseSkillsMarkdown, MAX_SKILL_BLOCK_CHARS } from "../lib/imported-skills";
import type { ImportedSkill } from "../types";

/**
 * A row of label + description + switch, used by every toggle in this tab.
 * Lives here (and is exported) because SettingsDialog's General tab shares it and
 * importing it back from SettingsDialog would close a module cycle.
 */
export function ToggleRow({
  title,
  desc,
  value,
  onChange,
  tone,
}: {
  title: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
  /** High-permission rows keep a warning treatment so the risk stays visible. */
  tone?: "warning";
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <div className="flex items-center gap-1.5 text-ui-base text-foreground font-medium">
          {tone === "warning" && <ShieldAlert className="size-3.5 text-warning" />}
          <span className={tone === "warning" && value ? "text-warning" : undefined}>{title}</span>
        </div>
        <div className="text-ui-xs text-foreground-subtlest">{desc}</div>
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`relative w-10 h-[22px] rounded-full transition-colors ${
          value ? (tone === "warning" ? "bg-warning" : "bg-primary") : "bg-border"
        }`}
      >
        <div
          className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-transform ${
            value ? "translate-x-[22px]" : "translate-x-[3px]"
          }`}
        />
      </button>
    </div>
  );
}

const MARKDOWN_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown"] }];

/**
 * Pick `.md` file(s) and read them.
 *
 * Reading goes through `read_file_content` (an absolute path chosen by the user
 * in the native dialog), not the web `File` API: this webview's picker hands
 * back paths, and duck.ai's own file inputs are not what we are importing here.
 */
async function readMarkdownFiles(): Promise<{ path: string; raw: string }[]> {
  const picked = await openDialog({ multiple: true, title: "Chọn file Skills & Prompt (.md)", filters: MARKDOWN_FILTERS });
  if (!picked) return [];
  const paths = (Array.isArray(picked) ? picked : [picked]).filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  const out: { path: string; raw: string }[] = [];
  for (const path of paths) {
    out.push({ path, raw: await invoke<string>("read_file_content", { path }) });
  }
  return out;
}

/** Turn picked files into importable blocks, skipping empty and unreadable ones. */
export function toImportedSkills(files: { path: string; raw: string }[]): ImportedSkill[] {
  const addedAt = Date.now();
  return files.flatMap((f) => parseSkillsMarkdown(f.raw, f.path, addedAt));
}

export default function SkillsPromptSection() {
  const settings = useStore((s) => s.settings);
  const setSkillEnabled = useStore((s) => s.setSkillEnabled);
  const setPromptSectionEnabled = useStore((s) => s.setPromptSectionEnabled);
  const setAllSkillsEnabled = useStore((s) => s.setAllSkillsEnabled);
  const setAllPromptSectionsEnabled = useStore((s) => s.setAllPromptSectionsEnabled);
  const importSkills = useStore((s) => s.importSkills);
  const setImportedSkillEnabled = useStore((s) => s.setImportedSkillEnabled);
  const removeImportedSkillFile = useStore((s) => s.removeImportedSkillFile);
  const addToast = useStore((s) => s.addToast);

  const [importing, setImporting] = useState(false);

  const skillsOn = SKILLS.filter((s) => isSkillEnabled(settings, s.id)).length;
  const promptsOn = PROMPT_SECTIONS.filter((p) => isPromptEnabled(settings, p.id)).length;
  const imported = settings.importedSkills ?? [];
  const disabledImported = new Set(settings.disabledImportedSkills ?? []);
  const importedOn = imported.filter((s) => !disabledImported.has(s.id)).length;

  /** One source file groups its `## ` blocks, so delete removes the whole file. */
  const files = new Map<string, ImportedSkill[]>();
  for (const s of imported) {
    const list = files.get(s.sourcePath) ?? [];
    list.push(s);
    files.set(s.sourcePath, list);
  }

  const handleImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const picked = await readMarkdownFiles();
      if (picked.length === 0) return;
      const skills = toImportedSkills(picked);
      if (skills.length === 0) {
        addToast("File .md rỗng — không có block nào để import", "error");
        return;
      }
      importSkills(skills);
      addToast(`Đã import ${skills.length} block từ ${picked.length} file .md`, "success");
    } catch (e) {
      addToast(`Import thất bại: ${e}`, "error");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-ui-base font-semibold text-foreground">Skills &amp; Prompt</h3>
        <p className="text-ui-sm text-foreground-subtle mt-1">
          Chọn agent được dùng công cụ nào và phần nào của prompt được gửi đi.
          Tắt một skill sẽ bỏ nó khỏi prompt <span className="text-foreground">và</span>{" "}
          chặn thực thi — model có tự phát lệnh cũng bị từ chối.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-ui-sm font-semibold text-foreground-subtle uppercase tracking-wider">
            <Wrench className="size-3.5" />
            Skills ({skillsOn} / {SKILLS.length})
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setAllSkillsEnabled(true)}
              className="h-6 px-2 rounded-md text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground transition-colors"
            >
              Bật tất cả
            </button>
            <button
              onClick={() => setAllSkillsEnabled(false)}
              className="h-6 px-2 rounded-md text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground transition-colors"
            >
              Tắt tất cả
            </button>
          </div>
        </div>
        <div className="space-y-0.5 rounded-xl border border-border bg-surface px-3 py-1.5">
          {SKILLS.map((s) => (
            <ToggleRow
              key={s.id}
              title={s.name}
              desc={s.description}
              value={isSkillEnabled(settings, s.id)}
              onChange={(v) => setSkillEnabled(s.id, v)}
              tone={s.mutating ? "warning" : undefined}
            />
          ))}
        </div>
        <p className="text-ui-xs text-foreground-subtlest mt-1.5">
          write_file và run_command có thể thay đổi project hoặc chạy lệnh trên máy.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-ui-sm font-semibold text-foreground-subtle uppercase tracking-wider">
            <FileText className="size-3.5" />
            Prompt ({promptsOn} / {PROMPT_SECTIONS.length})
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setAllPromptSectionsEnabled(true)}
              className="h-6 px-2 rounded-md text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground transition-colors"
            >
              Bật tất cả
            </button>
            <button
              onClick={() => setAllPromptSectionsEnabled(false)}
              className="h-6 px-2 rounded-md text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground transition-colors"
            >
              Tắt tất cả
            </button>
          </div>
        </div>
        <div className="space-y-0.5 rounded-xl border border-border bg-surface px-3 py-1.5">
          {PROMPT_SECTIONS.map((p) => (
            <ToggleRow
              key={p.id}
              title={p.name}
              desc={p.description}
              value={isPromptEnabled(settings, p.id)}
              onChange={(v) => setPromptSectionEnabled(p.id, v)}
            />
          ))}
        </div>
        <p className="text-ui-xs text-foreground-subtlest mt-1.5">
          Tắt <span className="text-foreground-subtle">System prompt</span> sẽ khiến
          agent không còn cú pháp tool — nó chỉ trả lời như chat thường.
        </p>
      </div>

      {/* Imported `.md` blocks: the user's own skills/prompt document, appended
          to the system prompt instead of being retyped into chat. */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-ui-sm font-semibold text-foreground-subtle uppercase tracking-wider">
            <Upload className="size-3.5" />
            Import từ .md ({importedOn} / {imported.length})
          </div>
          <button
            onClick={() => void handleImport()}
            disabled={importing}
            className="h-7 px-2.5 rounded-md text-ui-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Plus className="size-3.5" />
            {importing ? "Đang đọc file…" : "Import .md"}
          </button>
        </div>

        {imported.length === 0 ? (
          <p className="text-ui-xs text-foreground-subtlest rounded-xl border border-dashed border-border bg-surface px-3 py-2.5">
            Chưa import file nào. Chọn một file <code className="text-foreground-subtle">.md</code>, mỗi block{" "}
            <code className="text-foreground-subtle">## Ten</code> sẽ thành một phần của system prompt.
          </p>
        ) : (
          <div className="space-y-2">
            {[...files.entries()].map(([path, blocks]) => (
              <div key={path} className="rounded-xl border border-border bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span className="text-ui-xs font-mono text-foreground-subtle truncate" title={path}>
                    {path.split(/[\\/]/).pop()}
                  </span>
                  <button
                    onClick={() => removeImportedSkillFile(path)}
                    className="p-1 rounded-md text-foreground-subtlest hover:text-danger hover:bg-hover transition-colors shrink-0"
                    title="Bỏ file này"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                <div className="space-y-0.5 mt-1">
                  {blocks.map((b) => (
                    <ToggleRow
                      key={b.id}
                      title={b.name}
                      desc={
                        b.truncated
                          ? `${b.description} (đã cắt còn ${MAX_SKILL_BLOCK_CHARS} ký tự)`
                          : b.description
                      }
                      value={!disabledImported.has(b.id)}
                      onChange={(v) => setImportedSkillEnabled(b.id, v)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-ui-xs text-foreground-subtlest mt-1.5">
          Import lại cùng một file sẽ thay thế các block cũ của file đó. Nội dung được lưu trong Settings.
        </p>
      </div>
    </div>
  );
}

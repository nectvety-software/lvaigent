import { useState, useRef, useEffect } from "react";
import {
  Send,
  Paperclip,
  ChevronDown,
  User,
  Check,
  Terminal,
  X,
  FolderOpen,
  ImagePlus,
  FileText,
  Folder,
  Bug,
  FileQuestion,
  Hammer,
  Square,
  Slash,
  AtSign,
  Diff,
  ShieldAlert,
  TriangleAlert,
  LoaderCircle,
  RefreshCw,
  ClipboardList,
  Hammer as HammerIcon,
} from "lucide-react";
import { useStore, getSlashCommands } from "../store";
import { t, tf, useLang } from "../lib/i18n";
import type { FileNode } from "../types";
import MessageBubble from "./MessageBubble";
import HoverPreview from "./HoverPreview";
import PermissionPrompt from "./PermissionPrompt";

/** Flatten project tree into pickable files with depth for indent. */
function flattenFiles(nodes: FileNode[] | undefined, depth: number, out: { path: string; name: string; depth: number }[]): void {
  if (!nodes) return;
  for (const n of nodes) {
    if (n.is_dir) flattenFiles(n.children, depth + 1, out);
    else if (out.length < 200) out.push({ path: n.path, name: n.name, depth });
  }
}

/** Extensions the image picker offers. SVG is text, so it imports as source. */
const IMAGE_FILTER_EXTS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tiff", "heic", "svg",
];

export default function ChatView() {
  useLang();
  const {
    conversations,
    activeConversationId,
    settings,
    providers,
    currentProject,
    attachedFiles,
    attachFile,
    detachFile,
    pendingApproval,
    answerApproval,
    setFullAccess,
    projectSync,
  } = useStore();

  const [input, setInput] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAttachPicker, setShowAttachPicker] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agentMode = useStore((s) => s.agentMode);
  const toggleAgentMode = useStore((s) => s.toggleAgentMode);
  const setAgentMode = useStore((s) => s.setAgentMode);
  const stopAgent = useStore((s) => s.stopAgent);
  /** Full access: the agent runs tools without asking (ZCode `fullAccess`). */
  const fullAccess = settings.autoAcceptPermissions;
  const [slashOpen, setSlashOpen] = useState(false);
  const [atOpen, setAtOpen] = useState(false);
  /** Merged "how much may the agent do" menu: mode + Full access. */
  const [showRunMenu, setShowRunMenu] = useState(false);
  const runMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showRunMenu) return;
    const onDown = (e: MouseEvent) => {
      if (runMenuRef.current && !runMenuRef.current.contains(e.target as Node)) {
        setShowRunMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowRunMenu(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [showRunMenu]);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  const activeProv = providers.find((p) => p.id === settings.selectedProvider) ?? providers[0];
  const selectedModel = activeProv?.models.find((m) => m.id === settings.selectedModel);

  const pickableFiles = (() => {
    const out: { path: string; name: string; depth: number }[] = [];
    flattenFiles(currentProject?.files, 0, out);
    return out;
  })();

  const attachedPaths = new Set(attachedFiles.map((f) => f.path));

  const msgs = activeConversation?.messages ?? [];
  const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
  const isStreaming = !!lastMsg?.isStreaming;

  const reviewAvailable = useStore((s) => s.reviewAvailable);
  const reviewUpdatedAt = useStore((s) => s.reviewUpdatedAt);
  const showReviewChip =
    !!activeConversationId &&
    !isStreaming &&
    reviewAvailable(activeConversationId) &&
    reviewUpdatedAt >= 0;
  // During streaming the reply grows every ~350ms; depend on LENGTH only so a
  // re-render doesn't fire a smooth-scroll animation on every delta.
  const liveLen = lastMsg && lastMsg.isStreaming ? lastMsg.content.length : 0;
  const liveSteps = lastMsg?.steps?.length ?? 0;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [activeConversation?.messages.length, liveLen, liveSteps]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content) return;
    let convId = activeConversationId;
    if (!convId) convId = useStore.getState().createConversation();
    setInput("");
    setSlashOpen(false);
    setAtOpen(false);
    // opencode-style slash commands: "/undo", "/init", ... .
    if (content.startsWith("/")) {
      const [name, ...rest] = content.split(/\s+/);
      const cmd = getSlashCommands().find((c) => c.name === name.toLowerCase());
      if (cmd) {
        try {
          const consumed = await cmd.run(rest.join(" ").trim());
          if (consumed) return;
        } catch {
          /* fall through to a normal send */
        }
      } else {
        useStore.getState().addToast(tf("Lệnh không rõ: {name} — /init /undo /redo /stop /clear", { name }), "error");
        return;
      }
    }
    try {
      await useStore.getState().sendDuckChat(convId, content);
    } catch (e) {
      useStore.getState().addToast(`Send failed: ${e}`, "error");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      toggleAgentMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const filteredSlash = (() => {
    if (!input.startsWith("/")) return [];
    const q = input.slice(1).split(/\s+/)[0].toLowerCase();
    return getSlashCommands().filter((c) => c.name.slice(1).startsWith(q));
  })();

  const filteredAtFiles = (() => {
    if (!input.includes("@")) return [];
    const idx = input.lastIndexOf("@");
    const q = input.slice(idx + 1).split(/\s/)[0].toLowerCase();
    const out: { path: string; name: string; depth: number }[] = [];
    flattenFiles(currentProject?.files, 0, out);
    return out.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 8);
  })();

  const insertAtFile = (path: string) => {
    const idx = input.lastIndexOf("@");
    if (idx === -1) return;
    const next = `${input.slice(0, idx)}@${path} `;
    setInput(next);
    setAtOpen(false);
    void useStore.getState().attachFile(path);
  };

  const suggestions = [
    { icon: FileQuestion, text: t("Giải thích luồng của đoạn code này") },
    { icon: Bug, text: t("Tìm và sửa lỗi trong project") },
    { icon: Hammer, text: t("Thêm một tính năng nhỏ") },
    { icon: FolderOpen, text: t("Viết test cho module chính") },
  ];

  /**
   * No-project banner.
   *
   * Three honest states instead of one blanket warning. The bug this replaces:
   * the app *knew* which folder the active session belonged to, failed (or never
   * got round) to open it, and then told the user to "open a project" — reading
   * as a glitch, because the project was right there in the session history.
   * `idle` is the only state where that advice is actually true.
   */
  const projectBanner = (() => {
    if (currentProject) return null;
    const { status, path, error } = projectSync;
    if (status === "loading") {
      return {
        tone: "border-border bg-surface text-foreground-subtle",
        Icon: LoaderCircle,
        iconClass: "size-4 shrink-0 animate-spin",
        message: path ? tf('Đang mở project "{path}"…', { path }) : t("Đang mở project…"),
        retry: false,
      };
    }
    if (status === "error") {
      return {
        tone: "border-destructive/40 bg-destructive/10 text-destructive",
        Icon: TriangleAlert,
        iconClass: "size-4 shrink-0",
        message: tf('Không mở được project{path}: {error}. Kiểm tra thư mục còn tồn tại không.', {
          path: path ? ` "${path}"` : "",
          error: error ?? t("lỗi không rõ"),
        }),
        retry: true,
      };
    }
    return {
      tone: "border-warning/40 bg-warning/10 text-warning",
      Icon: FolderOpen,
      iconClass: "size-4 shrink-0",
      message: t(
        "Chưa mở project — agent không đọc/sửa được file. Hãy mở project trước khi yêu cầu chỉnh sửa code.",
      ),
      retry: false,
    };
  })();

  const pickProjectFolder = async () => {
    try {
      const openDialog = await import("@tauri-apps/plugin-dialog").then((m) => m.open);
      const selected = await openDialog({ directory: true, multiple: false, title: t("Mở Project") });
      if (selected) {
        const folderPath = Array.isArray(selected) ? selected[0] : selected;
        useStore.getState().setActiveWorkspace(folderPath);
      }
    } catch (e) {
      useStore.getState().addToast(tf("Không mở được project: {error}", { error: String(e) }), "error");
    }
  };

  /**
   * Paperclip → import from disk. Paths stay absolute, so an import does not
   * have to live inside the open project.
   */
  const importAttachment = async (what: "image" | "file" | "folder") => {
    setShowAttachPicker(false);
    const store = useStore.getState();
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open(
        what === "folder"
          ? { directory: true, multiple: true, title: t("Chọn thư mục để đính kèm") }
          : {
              multiple: true,
              title: what === "image" ? t("Chọn ảnh để đính kèm") : t("Chọn tệp để đính kèm"),
              defaultPath: currentProject?.path,
              filters:
                what === "image"
                  ? [{ name: t("Ảnh"), extensions: IMAGE_FILTER_EXTS }]
                  : undefined,
            }
      );
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : [])
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
      if (paths.length === 0) return;
      if (what === "folder") {
        for (const dir of paths) await store.attachFolder(dir);
      } else {
        await store.attachFromPaths(paths);
      }
    } catch (e) {
      store.addToast(tf("Không nhập được tệp: {error}", { error: String(e) }), "error");
    }
  };

  return (
    <div className="relative flex flex-col flex-1 bg-background overflow-hidden">
      {projectBanner && (
        <div
          className={`absolute top-2 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-1.5 min-h-9 rounded-xl border text-ui-sm leading-tight shadow-md animate-fade-in max-w-[92%] ${projectBanner.tone}`}
        >
          <projectBanner.Icon className={projectBanner.iconClass} />
          {/* Wraps instead of truncating: in the error state the backend message
              *is* the diagnosis, so cutting it off defeats the point. */}
          <span className="min-w-0">{projectBanner.message}</span>
          {projectBanner.retry && (
            <button
              onClick={() => void useStore.getState().ensureProjectOpen({ force: true })}
              className="shrink-0 flex items-center gap-1 h-6 px-2 rounded-md text-ui-xs font-medium bg-foreground/10 hover:bg-foreground/20 transition-colors"
            >
              <RefreshCw className="size-3" />
              {t("Thử lại")}
            </button>
          )}
          <button
            onClick={pickProjectFolder}
            className="shrink-0 flex items-center gap-1 h-6 px-2 rounded-md text-ui-xs font-medium bg-foreground/10 hover:bg-foreground/20 transition-colors"
          >
            <FolderOpen className="size-3" />
            {t("Mở project")}
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {!activeConversation || activeConversation.messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-12 h-12 rounded-xl bg-surface border border-border flex items-center justify-center mb-4">
              <Terminal size={22} className="text-brand" />
            </div>
            <h2 className="text-ui-lg font-semibold text-foreground mb-1.5">lvaigent</h2>
            <p className="text-ui-base text-foreground-subtle max-w-sm mb-7">
              {currentProject
                ? tf("Đang làm việc trong “{name}”.", { name: currentProject.name })
                : t("Trợ lý code chạy trên lvaigent. Mở một project để bắt đầu.")}
            </p>
            <div className="grid grid-cols-2 gap-2 max-w-md w-full">
              {suggestions.map((s) => (
                <button
                  key={s.text}
                  onClick={() => setInput(s.text)}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-border bg-surface/60 text-ui-sm text-foreground-subtle hover:bg-surface hover:text-foreground hover:border-border-hover transition-colors text-left"
                >
                  <s.icon size={14} className="shrink-0 text-foreground-subtlest" />
                  {s.text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-6 py-4">
            {activeConversation.messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {showReviewChip && (
              <button
                onClick={() => useStore.getState().setShowReview(true)}
                className="mb-3 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-surface text-ui-sm text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              >
                <Diff size={13} className="text-brand" />
                {t("Xem thay đổi của agent")}
                <span className="text-ui-xs text-foreground-subtlest">(/review)</span>
              </button>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Tool permission prompt — ZCode's PermissionDialog, incl. Full access */}
      {pendingApproval && (
        <PermissionPrompt
          tool={pendingApproval.tool}
          args={pendingApproval.args}
          onDecide={(decision) => answerApproval(pendingApproval.id, decision)}
        />
      )}

      {/* Composer */}
      <div className="px-6 pb-5 pt-1 shrink-0">
        <div className="max-w-3xl mx-auto">
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachedFiles.map((f) => {
                const KindIcon =
                  f.kind === "image" ? ImagePlus : f.kind === "folder" ? Folder : Check;
                return (
                <HoverPreview
                  key={f.path}
                  name={f.name}
                  path={f.path}
                  kind={f.kind}
                  content={f.kind === "image" ? undefined : f.content}
                >
                  <span
                    className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-surface border border-border text-ui-xs text-foreground-subtle"
                  >
                    <KindIcon size={10} className="text-brand shrink-0" />
                    <span className="max-w-[180px] truncate">{f.name}</span>
                    {f.truncated && <span className="text-ui-xs text-foreground-subtlest">({t("cắt")})</span>}
                    <button
                      onClick={() => detachFile(f.path)}
                      className="p-0.5 rounded hover:bg-destructive/15 hover:text-destructive transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </span>
                </HoverPreview>
                );
              })}
            </div>
          )}

          {isStreaming && (
            <div className="flex justify-center mb-2 animate-fade-in">
              <button
                onClick={() => stopAgent()}
                title={t("Dừng phản hồi")}
                className="group flex items-center gap-2 px-3.5 h-8 rounded-full border border-border bg-surface hover:bg-surface-hover text-ui-sm font-medium text-foreground shadow-md transition-colors"
              >
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex size-full rounded-full bg-brand opacity-60 animate-ping" />
                  <span className="relative inline-flex size-2 rounded-full bg-brand" />
                </span>
                <span>{t("Agent đang chạy")}</span>
                <span className="flex items-center gap-1 text-destructive">
                  <Square size={10} fill="currentColor" />
                  {t("Dừng")}
                </span>
              </button>
            </div>
          )}

          <div className="relative rounded-2xl border border-input-border bg-input focus-within:border-input-border-focused transition-colors">
            {/* Slash command palette (when input starts with "/") */}
            {slashOpen && filteredSlash.length > 0 && (
              <div className="menu-surface absolute bottom-full left-0 right-0 mb-2 flex flex-col gap-0.5 animate-scale-in z-50">
                {filteredSlash.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => {
                      setSlashOpen(false);
                      if (c.custom) {
                        // Custom command: keep the typed args in the input.
                        setInput(c.name + " ");
                      } else {
                        setInput("");
                        void c.run("");
                      }
                    }}
                    className="menu-row"
                  >
                    <Slash className="size-3 shrink-0 text-foreground-subtle" />
                    <span className={`font-mono ${c.custom ? "text-plugin-node-foreground" : "text-foreground"}`}>{c.name}</span>
                    <span className="text-ui-xs text-foreground-subtlest truncate">{c.description}</span>
                  </button>
                ))}
              </div>
            )}

            {/* @file fuzzy picker */}
            {atOpen && filteredAtFiles.length > 0 && (
              <div className="menu-surface absolute bottom-full left-0 right-0 mb-2 flex flex-col gap-0.5 max-h-56 overflow-y-auto animate-scale-in z-50">
                {filteredAtFiles.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => insertAtFile(f.path)}
                    className="menu-row"
                  >
                    <AtSign className="size-3 shrink-0 text-foreground-subtle" />
                    <span className="truncate text-foreground-subtle font-mono">{f.path}</span>
                  </button>
                ))}
              </div>
            )}

            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setSlashOpen(e.target.value.startsWith("/"));
                setAtOpen(e.target.value.includes("@"));
              }}
              onKeyDown={handleKeyDown}
              placeholder={currentProject ? t("Hỏi về project này… (Shift+Enter xuống dòng)") : t("Nhập câu hỏi… (Shift+Enter xuống dòng)")}
              className="w-full bg-transparent px-4 pt-3.5 pb-12 text-ui-base text-foreground placeholder-foreground-subtlest outline-none resize-none min-h-[52px] max-h-[220px]"
              rows={1}
            />

            {/* Bottom bar inside composer */}
            <div className="absolute left-0 right-0 bottom-0 flex items-center justify-between px-2.5 pb-2.5">
              <div className="flex items-center gap-1">
                <div className="relative">
                  <button
                    onClick={() => setShowModelPicker(!showModelPicker)}
                    className="flex items-center gap-1.5 h-7 px-2 rounded-md hover:bg-hover transition-colors text-ui-sm text-foreground-subtle"
                  >
                    <span className="text-foreground-subtlest hidden md:inline">{activeProv?.name ?? ""}</span>
                    <span className="text-foreground-subtle">·</span>
                    <span className="text-foreground">{selectedModel?.name ?? settings.selectedModel}</span>
                    <ChevronDown className="size-3" />
                  </button>
                  {showModelPicker && (
                    <div className="menu-surface absolute bottom-full left-0 mb-2 w-60 flex flex-col gap-0.5 animate-scale-in z-50">
                      {activeProv && activeProv.models.length > 0 ? (
                        activeProv.models
                          .filter((m) => m.enabled)
                          .map((model) => (
                            <button
                              key={model.id}
                              onClick={() => {
                                useStore.getState().updateSettings({ selectedModel: model.id });
                                setShowModelPicker(false);
                              }}
                              className="menu-row justify-between"
                            >
                              {model.name}
                              {settings.selectedModel === model.id && <Check className="size-3" />}
                            </button>
                          ))
                      ) : (
                        <div className="px-2 py-2.5 text-ui-sm text-foreground-subtlest">
                          {t("Chưa có model — mở Settings → Providers để lấy model.")}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Run menu: agent mode and Full access are two halves of the
                 * same decision ("how much may the agent do without asking"),
                 * so they share one trigger instead of two competing chips.
                 * The trigger shows both at a glance — mode first, then the
                 * permission level, which stays warning-tinted whenever Full
                 * access is on so the risk is never muted. */}
                <div className="relative" ref={runMenuRef}>
                  <button
                    onClick={() => setShowRunMenu(!showRunMenu)}
                    aria-haspopup="menu"
                    aria-expanded={showRunMenu}
                    title={t("Chế độ chạy & quyền của agent")}
                    className={`flex items-center gap-1.5 h-7 px-2 rounded-md transition-colors text-ui-xs font-medium ${
                      showRunMenu || agentMode === "plan"
                        ? "bg-selected text-foreground"
                        : "text-foreground-subtle hover:bg-hover hover:text-foreground"
                    }`}
                  >
                    {agentMode === "plan" ? (
                      <ClipboardList className="size-3" />
                    ) : (
                      <HammerIcon className="size-3" />
                    )}
                    {agentMode === "plan" ? "Plan" : "Build"}
                    {fullAccess && (
                      <>
                        <span className="text-foreground-subtlest">·</span>
                        <ShieldAlert className="size-3 text-warning" />
                        <span className="text-warning">Full access</span>
                      </>
                    )}
                    <ChevronDown className="size-3 opacity-70" />
                  </button>

                  {showRunMenu && (
                    <div
                      role="menu"
                      className="menu-surface absolute bottom-full left-0 mb-2 w-72 flex flex-col gap-0.5 animate-scale-in z-50"
                    >
                      <div className="px-2 h-6 flex items-center gap-2 text-ui-xs font-semibold text-foreground-subtlest uppercase tracking-wider">
                        {t("Chế độ")}
                        <span className="ml-auto normal-case tracking-normal font-normal opacity-70">
                          {t("Tab để đổi nhanh")}
                        </span>
                      </div>
                      {(
                        [
                          {
                            id: "build" as const,
                            icon: HammerIcon,
                            label: "Build",
                            desc: t("Agent đọc và sửa file trong project."),
                          },
                          {
                            id: "plan" as const,
                            icon: ClipboardList,
                            label: "Plan",
                            desc: t("Chỉ đọc và đề xuất kế hoạch, không sửa file."),
                          },
                        ] as const
                      ).map((m) => {
                        const selected = agentMode === m.id;
                        return (
                          <button
                            key={m.id}
                            role="menuitemradio"
                            aria-checked={selected}
                            data-selected={selected}
                            onClick={() => {
                              setAgentMode(m.id);
                              setShowRunMenu(false);
                            }}
                            className="menu-row-stacked"
                          >
                            <m.icon className="size-3.5 mt-0.5 shrink-0 text-foreground-subtle" />
                            <span className="flex-1 min-w-0">
                              <span className="block text-ui-base text-foreground">{m.label}</span>
                              <span className="block text-ui-xs text-foreground-subtlest">
                                {m.desc}
                              </span>
                            </span>
                            {selected && <Check className="size-3.5 mt-0.5 shrink-0" />}
                          </button>
                        );
                      })}

                      <div className="menu-separator" />

                      {/* Deliberately does NOT close the menu: flipping it is a
                       * risk decision, so the row should stay visible to confirm
                       * the new state (and the trigger updating behind it). */}
                      <button
                        role="menuitemcheckbox"
                        aria-checked={fullAccess}
                        onClick={() => setFullAccess(!fullAccess)}
                        className="menu-row-stacked"
                      >
                        <ShieldAlert
                          className={`size-3.5 mt-0.5 shrink-0 ${
                            fullAccess ? "text-warning" : "text-foreground-subtle"
                          }`}
                        />
                        <span className="flex-1 min-w-0">
                          <span
                            className={`block text-ui-base ${
                              fullAccess ? "text-warning" : "text-foreground"
                            }`}
                          >
                            Full access
                          </span>
                          <span className="block text-ui-xs text-foreground-subtlest">
                            {t("Cho agent chạy lệnh và sửa file không hỏi lại.")}
                          </span>
                        </span>
                        <span
                          className={`relative w-8 h-[18px] rounded-full shrink-0 mt-0.5 transition-colors ${
                            fullAccess ? "bg-warning" : "bg-border"
                          }`}
                        >
                          <span
                            className={`absolute top-[2px] size-3.5 rounded-full bg-white transition-transform ${
                              fullAccess ? "translate-x-[16px]" : "translate-x-[2px]"
                            }`}
                          />
                        </span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="relative">
                  <button
                    onClick={() => setShowAttachPicker(!showAttachPicker)}
                    title={t("Đính kèm ảnh, tệp hoặc thư mục")}
                    className={`flex items-center justify-center size-7 rounded-md transition-colors ${
                      showAttachPicker
                        ? "bg-selected text-foreground"
                        : "text-foreground-subtlest hover:bg-hover hover:text-foreground"
                    }`}
                  >
                    <Paperclip className="size-4" />
                  </button>
                  {showAttachPicker && (
                    <div className="menu-surface absolute bottom-full left-0 mb-2 w-72 max-h-[60vh] overflow-y-auto flex flex-col gap-0.5 animate-scale-in z-50">
                      <div className="px-2 h-6 flex items-center text-ui-xs font-semibold text-foreground-subtlest uppercase tracking-wider">
                        {t("Nhập từ máy")}
                      </div>
                      <button
                        onClick={() => void importAttachment("image")}
                        className="menu-row"
                        title={t("Chọn một hay nhiều ảnh")}
                      >
                        <ImagePlus className="size-3.5 shrink-0" />
                        <span>{t("Ảnh…")}</span>
                      </button>
                      <button
                        onClick={() => void importAttachment("file")}
                        className="menu-row"
                        title={t("Chọn một hay nhiều tệp văn bản/bất kỳ")}
                      >
                        <FileText className="size-3.5 shrink-0" />
                        <span>{t("Tệp…")}</span>
                      </button>
                      <button
                        onClick={() => void importAttachment("folder")}
                        className="menu-row"
                        title={t("Chọn cả thư mục: cây tệp + nội dung các tệp văn bản")}
                      >
                        <FolderOpen className="size-3.5 shrink-0" />
                        <span>{t("Thư mục…")}</span>
                      </button>

                      {currentProject && (
                        <>
                          <div className="mt-1 px-2 h-6 flex items-center text-ui-xs font-semibold text-foreground-subtlest uppercase tracking-wider truncate">
                            {tf("Tệp trong {name}", { name: currentProject.name })}
                          </div>
                          {pickableFiles.map((f) => {
                            const attached = attachedPaths.has(f.path);
                            return (
                              <button
                                key={f.path}
                                onClick={() => (attached ? detachFile(f.path) : attachFile(f.path))}
                                className={`menu-row ${attached ? "text-foreground" : "text-foreground-subtle"}`}
                                style={{ paddingLeft: `${8 + f.depth * 12}px` }}
                              >
                                <span className="truncate">{f.name}</span>
                                {attached && <Check className="size-3 ml-auto shrink-0" />}
                              </button>
                            );
                          })}
                          {pickableFiles.length === 0 && (
                            <div className="px-2 py-3 text-center text-ui-sm text-foreground-subtlest">
                              {t("Không có file")}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {isStreaming ? (
                <button
                  onClick={() => stopAgent()}
                  title={t("Dừng phản hồi")}
                  className="flex items-center justify-center size-8 rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-colors"
                >
                  <Square className="size-3.5" fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="flex items-center justify-center size-8 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-25 disabled:hover:opacity-25 transition-colors"
                >
                  <Send className="size-4" />
                </button>
              )}
            </div>
          </div>

          <p className="flex items-center justify-center gap-1.5 text-ui-xs text-foreground-subtlest text-center mt-2.5">
            <User size={9} />
            {t("lvaigent — agent tự xác minh mọi thay đổi trước khi hoàn tất")}
          </p>
        </div>
      </div>
    </div>
  );
}

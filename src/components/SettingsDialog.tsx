import { useState, useEffect } from "react";
import {
  X,
  SlidersHorizontal,
  Settings2,
  Globe,
  Check,
  XCircle,
  RefreshCw,
  Plus,
  Trash2,
  Sparkles,
  Boxes,
} from "lucide-react";
import { useStore } from "../store";
import { t as tr, tf as trf, useLang } from "../lib/i18n";
import Select from "./Select";
import SkillsPromptSection, { ToggleRow } from "./SkillsPromptSection";
import PluginsSection from "./PluginsSection";
import { AGENT_PROFILES } from "../agents/profiles";
import { API_PRESETS, makeProvider } from "../providers/presets";
import AddProviderDialog from "./AddProviderDialog";
import { fetchApiModels, pingProviderApi } from "../lib/api-chat";
import PermissionRules from "./PermissionRules";
import PathDirsSettings from "./PathDirsSettings";
import {
  getBridgeWatcherStatus,
  refreshBridgeSession,
  scanBridgeSession,
  type BridgeWatcherStatus,
} from "../lib/bridge-watcher";

function formatAge(ms: number): string {
  if (ms < 10_000) return tr("vừa xong");
  if (ms < 60_000) return trf("{n} giây", { n: Math.floor(ms / 1000) });
  if (ms < 3_600_000) return trf("{n} phút", { n: Math.floor(ms / 60_000) });
  return trf("{n} giờ", { n: Math.floor(ms / 3_600_000) });
}

/** "... trước" — but "vừa xong" already reads as *just now*, so it stands alone. */
function ago(ms: number): string {
  const a = formatAge(ms);
  return a === tr("vừa xong") ? a : trf("{age} trước", { age: a });
}

/** One dot + label + value line in the bridge status grid. */
function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  useLang();
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${ok ? "bg-success" : "bg-warning"}`}
        title={ok ? "OK" : tr("chưa sẵn sàng")}
      />
      <span className="text-foreground-subtlest shrink-0">{label}:</span>
      <span className="text-foreground-subtle truncate" title={value}>
        {value}
      </span>
    </div>
  );
}

const tabs = [
  { key: "general", label: "General", icon: SlidersHorizontal },
  { key: "models", label: "Models", icon: Settings2 },
  { key: "providers", label: "Providers", icon: Globe },
  { key: "skills", label: "Skills & Prompt", icon: Sparkles },
  { key: "plugins", label: "Plugins", icon: Boxes },
] as const;

type TabKey = (typeof tabs)[number]["key"];

interface Props {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: Props) {
  useLang();
  const {
    settings,
    updateSettings,
    providers,
    updateProvider,
    addProvider,
    removeProvider,
    addToast,
  } = useStore();
  const [tab, setTab] = useState<TabKey>("general");
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<Record<string, string>>({});
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState<Record<string, string>>({});
  const [headerDraft, setHeaderDraft] = useState({ key: "", value: "" });
  const [testResult, setTestResult] = useState<
    Record<string, { ok: boolean; msg: string }>
  >({});

  /** Full API check: one real chat turn through the provider's protocol. */
  const handleTestConnection = async (p: (typeof providers)[number]) => {
    setFetchingId(p.id);
    setFetchError((m) => ({ ...m, [p.id]: "" }));
    setTestResult((m) => ({ ...m, [p.id]: { ok: false, msg: tr("đang kiểm thử…") } }));
    const t0 = performance.now();
    try {
      let model = (p.models.find((m) => m.enabled) ?? p.models[0])?.id ?? "";
      if (!model) {
        // No models configured and some gateways expose no /models either —
        // discovery first, then ping with whatever we found.
        const found = await fetchApiModels(p);
        model = found[0]?.id ?? "";
        if (model) {
          updateProvider(p.id, {
            models: found.map((m) => ({ id: m.id, name: m.name, enabled: true })),
          });
        }
      }
      if (!model) throw new Error(tr("provider không có model nào để kiểm thử"));
      const reply = await pingProviderApi(p, model);
      const ms = Math.round(performance.now() - t0);
      updateProvider(p.id, { status: "connected" });
      setTestResult((m) => ({
        ...m,
        [p.id]: { ok: true, msg: `OK · ${model} · ${ms}ms · "${reply.slice(0, 40)}"` },
      }));
      addToast(trf("{name}: API kiểm thử đạt ({ms}ms)", { name: p.name, ms }), "success");
    } catch (e) {
      updateProvider(p.id, { status: "error" });
      setTestResult((m) => ({ ...m, [p.id]: { ok: false, msg: String(e).slice(0, 220) } }));
      addToast(trf("{name}: API kiểm thử lỗi", { name: p.name }), "error");
    } finally {
      setFetchingId(null);
    }
  };

  const handleFetchModels = async (p: (typeof providers)[number]) => {
    setFetchingId(p.id);
    setFetchError((m) => ({ ...m, [p.id]: "" }));
    try {
      const models = await fetchApiModels(p);
      if (models.length === 0) throw new Error(tr("danh sách model rỗng"));
      updateProvider(p.id, {
        models: models.map((m) => ({ id: m.id, name: m.name, enabled: true })),
        status: "connected",
      });
      // Auto-select the first model if none is set for this provider.
      const s = useStore.getState().settings;
      if (s.selectedProvider === p.id && !models.some((m) => m.id === s.selectedModel)) {
        updateSettings({ selectedModel: models[0].id });
      }
      addToast(trf("Đã lấy {n} model từ {name}", { n: models.length, name: p.name }), "success");
    } catch (e) {
      updateProvider(p.id, { status: "error" });
      setFetchError((m) => ({ ...m, [p.id]: String(e).slice(0, 200) }));
    } finally {
      setFetchingId(null);
    }
  };
  const [bridgeWStatus, setBridgeWStatus] = useState<BridgeWatcherStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /** Poll watcher status every 2s while the dialog is open. */
  useEffect(() => {
    setBridgeWStatus(getBridgeWatcherStatus());
    const t = setInterval(() => setBridgeWStatus(getBridgeWatcherStatus()), 2000);
    return () => clearInterval(t);
  }, []);

  /**
   * Opening the panel scans the duck.ai browser at once, then keeps scanning
   * every few seconds until both the cookie set and the PoW hash have arrived.
   * Without this the panel can sit on "chưa có" for up to a watcher tick,
   * which reads as "the app is not collecting anything" and pushes the user
   * back toward pasting values by hand.
   */
  useEffect(() => {
    let cancelled = false;
    const scanIfIncomplete = async () => {
      const st = getBridgeWatcherStatus();
      if (st.scanning || (st.cookieUpdatedAt && st.powUpdatedAt)) return;
      await scanBridgeSession();
      if (!cancelled) setBridgeWStatus(getBridgeWatcherStatus());
    };
    void scanIfIncomplete();
    const t = setInterval(() => void scanIfIncomplete(), 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const handleRefreshSession = async () => {
    setRefreshing(true);
    try {
      const r = await refreshBridgeSession();
      setBridgeWStatus(getBridgeWatcherStatus());
      addToast(
        r.cookies && r.pow
          ? tr("Đã quét lại từ Browser (cookie + PoW)")
          : r.cookies
            ? tr("Đã nhận cookie lvaigent (PoW chưa xong — sẽ tự thử lại)")
            : r.pow
              ? tr("Đã giải PoW mới (chưa lấy được cookie — Browser chưa sẵn sàng)")
              : tr("Chưa quét được — Browser chưa sẵn sàng"),
        r.cookies || r.pow ? "success" : "error"
      );
    } finally {
      setRefreshing(false);
    }
  };

  const duckProvider = providers.find((p) => p.id === "provider_duckai");
  const activeProv = providers.find((p) => p.id === settings.selectedProvider) ?? providers[0];

  const handleRefreshModels = async () => {
    if (!activeProv) return;
    if (activeProv.id !== "provider_duckai") {
      await handleFetchModels(activeProv);
      return;
    }
    try {
      const res = await fetch(`${activeProv.baseUrl}/models`);
      if (res.ok) {
        const data = await res.json();
        const models = (data.models ?? []).map((m: any) => ({
          id: m.id,
          name: m.name ?? m.id,
          enabled: true,
          supportsImage: m.supportsImageUpload ?? false,
        }));
        updateProvider(activeProv.id, { models, status: "connected" });
      }
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div className="dialog-surface flex w-[780px] h-[560px] overflow-hidden animate-scale-in">
        {/* Left Nav */}
        <div className="w-[180px] bg-background border-r border-border py-4 px-3 flex flex-col">
          <div className="flex items-center justify-between mb-4 px-1">
            <span className="text-ui-base font-semibold text-foreground">Settings</span>
            <button
              onClick={onClose}
              className="p-1 rounded-md hover:bg-card text-foreground-subtle hover:text-foreground transition-colors"
            >
              <X size={14} />
            </button>
          </div>

          <div className="space-y-0.5">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-ui-base transition-colors ${
                  tab === t.key
                    ? "bg-card text-foreground font-medium"
                    : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground-subtle"
                }`}
              >
                <t.icon size={14} />
                {t.label}
              </button>
            ))}
          </div>

          <div className="mt-auto px-1">
            <div className="text-ui-xs text-foreground-subtlest">lvaigent v0.1.0</div>
          </div>
        </div>

        {/* Right Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* GENERAL TAB */}
          {tab === "general" && (
            <div className="space-y-5">
              <h3 className="text-ui-base font-semibold text-foreground">General</h3>

              <div>
                <label className="text-ui-sm font-medium text-foreground-subtle mb-1.5 block">{tr("Ngôn ngữ")}</label>
                <Select
                  ariaLabel={tr("Ngôn ngữ")}
                  value={settings.language}
                  onChange={(v) => updateSettings({ language: v })}
                  options={[
                    { value: "vi", label: "Tiếng Việt" },
                    { value: "en", label: "English" },
                  ]}
                />
              </div>

              <div>
                <label className="text-ui-sm font-medium text-foreground-subtle mb-1.5 block">Agent Profile</label>
                <Select
                  ariaLabel="Agent Profile"
                  value={settings.agentProfile}
                  onChange={(v) => updateSettings({ agentProfile: v })}
                  options={AGENT_PROFILES.map((p) => ({
                    value: p.id,
                    label: `${p.name} — ${p.description}`,
                  }))}
                />
              </div>

              <div>
                <label className="text-ui-sm font-medium text-foreground-subtle mb-1.5 block">Terminal Shell</label>
                <Select
                  ariaLabel="Terminal Shell"
                  value={settings.terminalShell}
                  onChange={(v) => updateSettings({ terminalShell: v })}
                  options={[
                    { value: "powershell", label: "PowerShell" },
                    { value: "cmd", label: "Command Prompt" },
                    { value: "bash", label: "Bash" },
                    { value: "zsh", label: "Zsh" },
                  ]}
                />
              </div>

              <PathDirsSettings />

              <div className="space-y-3 pt-2">
                <ToggleRow
                  title="Show Reasoning"
                  desc="Display model reasoning process in chat"
                  value={settings.showReasoning}
                  onChange={(v) => updateSettings({ showReasoning: v })}
                />
                <ToggleRow
                  title="Full access"
                  desc={tr("Cấp cho agent toàn quyền dùng mọi tool — kể cả ghi file và chạy lệnh — không hỏi lại. Các tool bị chặn ở mục 'Luật cấp quyền' bên dưới vẫn bị chặn.")}
                  value={settings.autoAcceptPermissions}
                  onChange={(v) => updateSettings({ autoAcceptPermissions: v })}
                  tone="warning"
                />
              </div>

              {/* Always-allow / always-deny rules (ZCode's addRules scopes). */}
              <div className="pt-4">
                <h4 className="text-ui-sm font-medium text-foreground mb-1">{tr("Luật cấp quyền")}</h4>
                <p className="text-ui-xs text-foreground-subtlest mb-2">
                  {tr("Rule đặt trong hộp thoại cấp quyền. \"Luôn chặn\" thắng \"Full access\".")}
                </p>
                <PermissionRules />
              </div>
            </div>
          )}

          {/* SKILLS & PROMPT TAB */}
          {tab === "skills" && <SkillsPromptSection />}

          {tab === "plugins" && <PluginsSection />}

          {/* MODELS TAB */}
          {tab === "models" && (
            <div className="space-y-5">
              <h3 className="text-ui-base font-semibold text-foreground">
                Model Selection — {activeProv?.name ?? "Duckai"}
              </h3>

              <div>
                <label className="text-ui-sm font-medium text-foreground-subtle mb-1.5 block">Primary Model</label>
                <Select
                  ariaLabel="Primary Model"
                  value={settings.selectedModel}
                  onChange={(v) => updateSettings({ selectedModel: v })}
                  options={(activeProv?.models ?? [])
                    .filter((m) => m.enabled)
                    .map((model) => ({ value: model.id, label: model.name }))}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-ui-sm font-medium text-foreground-subtle">
                    Available Models ({activeProv?.models.length ?? 0})
                  </label>
                  <button
                    onClick={handleRefreshModels}
                    className="flex items-center gap-1 text-ui-xs text-brand hover:brightness-110 transition-colors"
                  >
                    <RefreshCw size={11} />
                    Refresh
                  </button>
                </div>
                <div className="space-y-1">
                  {activeProv?.models.map((model) => (
                    <div
                      key={model.id}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface border border-border"
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${model.enabled ? "bg-success" : "bg-foreground-subtlest"}`} />
                        <span className="text-ui-base text-foreground">{model.name}</span>
                      </div>
                      <button
                        onClick={() => {
                          const updated = activeProv!.models.map((m) =>
                            m.id === model.id ? { ...m, enabled: !m.enabled } : m
                          );
                          updateProvider(activeProv!.id, { models: updated });
                        }}
                        className={`px-2 py-0.5 rounded text-ui-xs transition-colors ${
                          model.enabled
                            ? "bg-primary/15 text-brand"
                            : "bg-card text-foreground-subtlest hover:text-foreground-subtle"
                        }`}
                      >
                        {model.enabled ? "ON" : "OFF"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* PROVIDERS TAB */}
          {tab === "providers" && (
            <div className="space-y-4">
              <h3 className="text-ui-base font-semibold text-foreground">Providers</h3>
              <p className="text-ui-xs text-foreground-subtlest leading-relaxed">
                {tr("Chọn provider dùng để chat. Provider API (OpenAI, Anthropic, OpenRouter, Groq, Ollama...) gọi trực tiếp chuẩn REST — ổn định hơn bridge Duckai.")}
              </p>

              {/* Provider list */}
              <div className="space-y-2">
                {providers.map((p) => {
                  const isActive = settings.selectedProvider === p.id;
                  const isDuck = p.id === "provider_duckai";
                  return (
                    <div
                      key={p.id}
                      className={`rounded-xl border p-3 space-y-3 transition-colors ${
                        isActive
                          ? "border-brand/40 bg-[rgba(255,103,0,0.05)]"
                          : "border-border bg-background"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => updateSettings({ selectedProvider: p.id })}
                          className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${
                            isActive ? "border-brand" : "border-foreground-subtlest hover:border-foreground-subtle"
                          }`}
                          title={isActive ? tr("Đang dùng") : tr("Dùng provider này")}
                        >
                          {isActive && <span className="w-2 h-2 rounded-full bg-primary" />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-ui-base font-medium text-foreground">{p.name}</span>
                            {isDuck && <span className="chip">bridge</span>}
                            {isActive && <span className="text-ui-xs text-brand font-medium uppercase tracking-wide">active</span>}
                          </div>
                          <div className="text-ui-xs text-foreground-subtlest truncate">
                            {p.models.length} models ·{" "}
                            {isDuck ? tr("bridge tích hợp trong app") : p.baseUrl}
                          </div>
                        </div>
                        {!isDuck && (
                          <button
                            onClick={() => { removeProvider(p.id); addToast(trf("Đã xóa {name}", { name: p.name }), "info"); }}
                            className="p-1.5 rounded-lg hover:bg-destructive/15 text-foreground-subtlest hover:text-destructive transition-colors"
                            title={tr("Xóa provider")}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>

                      {!isDuck && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <input
                              value={p.baseUrl}
                              onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                              placeholder="https://host/v1"
                              className="input-field font-mono text-ui-xs py-1.5 flex-1 min-w-0"
                            />
                            <Select
                              ariaLabel="API format"
                              value={p.apiFormat === "anthropic" ? "anthropic" : p.apiFormat === "responses" ? "responses" : "openai"}
                              onChange={(v) => updateProvider(p.id, { apiFormat: v as "openai" | "anthropic" | "responses" })}
                              className="input-field py-1.5 text-ui-sm shrink-0"
                              options={[
                                { value: "openai", label: "OpenAI chat" },
                                { value: "responses", label: "OpenAI responses" },
                                { value: "anthropic", label: "Anthropic" },
                              ]}
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="password"
                              value={p.apiKey}
                              onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                              placeholder="API key (sk-...)"
                              className="input-field font-mono text-ui-xs py-1.5 flex-1"
                            />
                            <button
                              onClick={() => handleFetchModels(p)}
                              disabled={fetchingId === p.id}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-sm font-medium bg-card text-foreground-subtle hover:bg-border hover:text-foreground-subtle transition-colors border border-border disabled:opacity-50 whitespace-nowrap"
                            >
                              {fetchingId === p.id ? (
                                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-dot" />
                              ) : p.status === "connected" ? (
                                <Check size={12} className="text-success" />
                              ) : p.status === "error" ? (
                                <XCircle size={12} className="text-destructive" />
                              ) : (
                                <RefreshCw size={12} />
                              )}
                              {tr("Lấy models")}
                            </button>
                            <button
                              onClick={() => handleTestConnection(p)}
                              disabled={fetchingId === p.id}
                              className="px-2.5 py-1.5 rounded-lg text-ui-xs font-medium border border-border text-foreground-subtle hover:text-foreground hover:border-brand/50 transition-colors disabled:opacity-50 whitespace-nowrap"
                              title={tr("Gửi một request chat thật qua API để kiểm tra key/model/protocol")}
                            >
                              Test
                            </button>
                          </div>
                          {fetchError[p.id] && (
                            <div className="text-ui-xs text-destructive font-mono break-words">{fetchError[p.id]}</div>
                          )}
                          {testResult[p.id] && (
                            <div
                              className={`text-ui-xs font-mono break-words ${
                                testResult[p.id].ok ? "text-success" : "text-destructive"
                              }`}
                            >
                              {testResult[p.id].ok ? "✓ " : "✗ "}
                              {testResult[p.id].msg}
                            </div>
                          )}

                          {/* Models: fetched or hand-written, ZCode-style */}
                          <div className="rounded-lg border border-border bg-surface p-2 space-y-1.5">
                            <div className="text-ui-xs font-semibold text-foreground-subtle uppercase tracking-wider">
                              Models ({p.models.length})
                            </div>
                            {p.models.map((m) => (
                              <div key={m.id} className="flex items-center gap-2">
                                <button
                                  onClick={() =>
                                    updateProvider(p.id, {
                                      models: p.models.map((x) =>
                                        x.id === m.id ? { ...x, enabled: !x.enabled } : x
                                      ),
                                    })
                                  }
                                  className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center transition-colors ${
                                    m.enabled ? "bg-primary border-primary" : "border-foreground-subtlest"
                                  }`}
                                  title={m.enabled ? tr("Đang bật") : tr("Đang tắt")}
                                >
                                  {m.enabled && <Check size={10} className="text-primary-foreground" />}
                                </button>
                                <span className="text-ui-xs text-foreground truncate flex-1 min-w-0" title={m.id}>
                                  {m.name}
                                </span>
                                <span className="text-ui-xs text-foreground-subtlest font-mono truncate max-w-[35%]">
                                  {m.id}
                                </span>
                                <button
                                  onClick={() =>
                                    updateProvider(p.id, { models: p.models.filter((x) => x.id !== m.id) })
                                  }
                                  className="p-1 rounded hover:bg-destructive/15 text-foreground-subtlest hover:text-destructive transition-colors"
                                  title={tr("Xóa model")}
                                >
                                  <Trash2 size={11} />
                                </button>
                              </div>
                            ))}
                            <div className="flex items-center gap-2 pt-1">
                              <input
                                value={modelDraft[p.id] ?? ""}
                                onChange={(e) => setModelDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                                placeholder={tr("Thêm model id thủ công (vd: gpt-4o-mini)")}
                                className="input-field font-mono text-ui-xs py-1 flex-1"
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter") return;
                                  const id = (modelDraft[p.id] ?? "").trim();
                                  if (!id || p.models.some((m) => m.id === id)) return;
                                  updateProvider(p.id, {
                                    models: [...p.models, { id, name: id, enabled: true }],
                                  });
                                  setModelDraft((d) => ({ ...d, [p.id]: "" }));
                                }}
                              />
                              <button
                                disabled={
                                  !(modelDraft[p.id] ?? "").trim() ||
                                  p.models.some((m) => m.id === (modelDraft[p.id] ?? "").trim())
                                }
                                onClick={() => {
                                  const id = (modelDraft[p.id] ?? "").trim();
                                  if (!id || p.models.some((m) => m.id === id)) return;
                                  updateProvider(p.id, {
                                    models: [...p.models, { id, name: id, enabled: true }],
                                  });
                                  setModelDraft((d) => ({ ...d, [p.id]: "" }));
                                }}
                                className="p-1.5 rounded-lg border border-border text-foreground-subtle hover:text-brand hover:border-brand/50 transition-colors disabled:opacity-40"
                                title={tr("Thêm model")}
                              >
                                <Plus size={12} />
                              </button>
                            </div>
                          </div>

                          {/* Custom headers */}
                          <details className="rounded-lg border border-border bg-surface p-2">
                            <summary className="text-ui-xs font-semibold text-foreground-subtle cursor-pointer select-none">
                              {tr("Headers tùy chỉnh")} ({Object.keys(p.extraHeaders ?? {}).length})
                            </summary>
                            <div className="space-y-1.5 pt-2">
                              {Object.entries(p.extraHeaders ?? {}).map(([k, v]) => (
                                <div key={k} className="flex items-center gap-1.5">
                                  <input
                                    value={k}
                                    readOnly
                                    className="input-field font-mono text-ui-xs py-1 w-[38%] bg-transparent"
                                    title={k}
                                  />
                                  <input
                                    value={v}
                                    onChange={(e) =>
                                      updateProvider(p.id, {
                                        extraHeaders: { ...p.extraHeaders, [k]: e.target.value },
                                      })
                                    }
                                    className="input-field font-mono text-ui-xs py-1 flex-1 min-w-0"
                                  />
                                  <button
                                    onClick={() => {
                                      const rec = { ...p.extraHeaders };
                                      delete rec[k];
                                      updateProvider(p.id, { extraHeaders: rec });
                                    }}
                                    className="p-1 rounded hover:bg-destructive/15 text-foreground-subtlest hover:text-destructive transition-colors"
                                    title={tr("Xóa header")}
                                  >
                                    <Trash2 size={11} />
                                  </button>
                                </div>
                              ))}
                              <div className="flex items-center gap-1.5">
                                <input
                                  value={headerDraft.key}
                                  onChange={(e) => setHeaderDraft((d) => ({ ...d, key: e.target.value }))}
                                  placeholder="X-Header"
                                  className="input-field font-mono text-ui-xs py-1 w-[38%]"
                                />
                                <input
                                  value={headerDraft.value}
                                  onChange={(e) => setHeaderDraft((d) => ({ ...d, value: e.target.value }))}
                                  placeholder={tr("giá trị")}
                                  className="input-field font-mono text-ui-xs py-1 flex-1 min-w-0"
                                />
                                <button
                                  disabled={!headerDraft.key.trim() || !!p.extraHeaders?.[headerDraft.key.trim()]}
                                  onClick={() => {
                                    const k = headerDraft.key.trim();
                                    if (!k || p.extraHeaders?.[k]) return;
                                    updateProvider(p.id, {
                                      extraHeaders: { ...p.extraHeaders, [k]: headerDraft.value },
                                    });
                                    setHeaderDraft({ key: "", value: "" });
                                  }}
                                  className="p-1.5 rounded-lg border border-border text-foreground-subtle hover:text-brand hover:border-brand/50 transition-colors disabled:opacity-40"
                                  title={tr("Thêm header")}
                                >
                                  <Plus size={12} />
                                </button>
                              </div>
                            </div>
                          </details>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add provider */}
              <div className="rounded-xl border border-border bg-background p-3 space-y-2.5">
                <div className="text-ui-xs font-semibold text-foreground-subtle uppercase tracking-wider">
                  {tr("Thêm provider")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {API_PRESETS.map((preset) => {
                    const exists = providers.some((x) => x.id === preset.id);
                    return (
                      <button
                        key={preset.id}
                        disabled={exists}
                        onClick={() => {
                          addProvider(makeProvider(preset));
                          addToast(trf("Đã thêm {name}", { name: preset.name }), "success");
                        }}
                        className="chip disabled:opacity-40 hover:border-brand/50 hover:text-brand transition-colors"
                      >
                        <Plus size={10} />
                        {preset.name}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => setAddDialogOpen(true)}
                  className="px-3 py-1.5 rounded-lg text-ui-sm font-medium bg-primary text-primary-foreground hover:brightness-110 transition-colors"
                >
                  {tr("Thêm provider tùy chỉnh…")}
                </button>
              </div>

              {addDialogOpen && (
                <AddProviderDialog
                  onClose={() => setAddDialogOpen(false)}
                  onAdd={(p) => {
                    addProvider(p);
                    setAddDialogOpen(false);
                    addToast(trf("Đã thêm provider {name}", { name: p.name }), "success");
                  }}
                />
              )}

              {/* duck.ai diagnostics (advanced, only when duck.ai active) */}
              {settings.selectedProvider === "provider_duckai" && duckProvider && (
                <details className="rounded-xl border border-border bg-background p-3">
                  <summary className="text-ui-xs font-semibold text-foreground-subtle cursor-pointer select-none">
                    {tr("Duckai nâng cao (PoW, bridge, cookies — tự quét từ Browser)")}
                  </summary>
                  <div className="space-y-3 pt-3">
                    {/* Session panel: everything here is collected by the
                      * watcher straight from the embedded duck.ai page. The one
                      * button only forces the next scan early. */}
                    {bridgeWStatus && (
                      <div className="rounded-lg border border-border bg-surface p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-ui-xs font-semibold text-foreground-subtle">
                            {bridgeWStatus.scanning
                              ? tr("Đang quét Browser…")
                              : tr("Tự quét từ Browser")}
                          </span>
                          <button
                            onClick={handleRefreshSession}
                            disabled={refreshing}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-ui-xs font-medium bg-primary text-primary-foreground hover:brightness-110 disabled:opacity-50 transition-colors"
                          >
                            <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} />
                            {refreshing ? tr("Đang quét…") : tr("Quét lại ngay")}
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-ui-xs">
                          <StatusRow
                            label="Bridge"
                            value={
                              bridgeWStatus.bridgeHealthy
                                ? tr("sẵn sàng (CDP)")
                                : bridgeWStatus.lastScanError ?? tr("đang chờ Browser")
                            }
                            ok={bridgeWStatus.bridgeHealthy}
                          />
                          <StatusRow
                            label="Cookie"
                            value={
                              bridgeWStatus.cookieUpdatedAt
                                ? `${bridgeWStatus.cookieNames.length} cookie · ${ago(
                                    Date.now() - bridgeWStatus.cookieUpdatedAt
                                  )}`
                                : tr("chưa nhận được")
                            }
                            ok={bridgeWStatus.cookieUpdatedAt != null}
                          />
                          <StatusRow
                            label="PoW (Vqd-Hash)"
                            value={
                              bridgeWStatus.powUpdatedAt
                                ? `${ago(Date.now() - bridgeWStatus.powUpdatedAt)}`
                                : tr("chưa giải")
                            }
                            ok={bridgeWStatus.powUpdatedAt != null}
                          />
                          <StatusRow
                            label={tr("Quét gần nhất")}
                            value={
                              bridgeWStatus.lastScanAt === 0
                                ? tr("chưa quét")
                                : `${ago(Date.now() - bridgeWStatus.lastScanAt)}`
                            }
                            ok={bridgeWStatus.lastScanError == null}
                          />
                          <StatusRow
                            label="Polling captcha"
                            value={
                              bridgeWStatus.lastPollAt === 0
                                ? tr("chưa chạy")
                                : `${ago(Date.now() - bridgeWStatus.lastPollAt)}`
                            }
                            ok={bridgeWStatus.lastPollOk}
                          />
                          <StatusRow
                            label="Watcher"
                            value={bridgeWStatus.started ? tr("đang chạy") : tr("dừng")}
                            ok={bridgeWStatus.started}
                          />
                        </div>
                        {(bridgeWStatus.challengeUp || bridgeWStatus.willRetry) && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {bridgeWStatus.challengeUp && (
                              <span className="px-2 py-0.5 rounded-full text-ui-xs font-medium bg-warning/15 text-warning border border-warning/30">
                                {tr("⚠ Captcha đang hiển thị trên Browser")}
                              </span>
                            )}
                            {bridgeWStatus.willRetry && (
                              <span className="px-2 py-0.5 rounded-full text-ui-xs font-medium bg-interaction-ask-surface text-interaction-ask-foreground border border-interaction-ask-foreground/30">
                                {tr("↻ Sẽ tự gửi lại tin nhắn sau khi giải captcha")}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {/* What a scan actually received from the duck.ai page.
                      * Names only: the values are the session secret and are
                      * never rendered or editable here. */}
                    {bridgeWStatus && bridgeWStatus.cookieNames.length > 0 && (
                      <div>
                        <label className="text-ui-xs text-foreground-subtlest mb-1 block">
                          {tr("Cookie đã nhận từ Browser")} ({bridgeWStatus.cookieNames.length})
                        </label>
                        <div className="flex flex-wrap gap-1">
                          {bridgeWStatus.cookieNames.map((n) => (
                            <span
                              key={n}
                              className="px-1.5 py-0.5 rounded-md text-ui-xs font-mono bg-surface border border-border text-foreground-subtle"
                            >
                              {n}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {bridgeWStatus?.lastScanError && (
                      <p className="text-ui-xs text-warning">
                        {tr("Lần quét gần nhất:")} {bridgeWStatus.lastScanError}
                      </p>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


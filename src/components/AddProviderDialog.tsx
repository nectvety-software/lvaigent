import { useState } from "react";
import { Eye, EyeOff, Trash2, X } from "lucide-react";
import Select from "./Select";
import { t as tr, useLang } from "../lib/i18n";
import type { ApiFormat, Provider } from "../types";

interface Props {
  onClose: () => void;
  onAdd: (p: Provider) => void;
}

const TEMPLATES: {
  id: string;
  label: string;
  name: string;
  baseUrl: string;
  apiFormat: ApiFormat;
}[] = [
  { id: "openai", label: "OpenAI Compatible", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiFormat: "openai" },
  { id: "anthropic", label: "Anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", apiFormat: "anthropic" },
  { id: "openrouter", label: "OpenRouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai" },
  { id: "groq", label: "Groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiFormat: "openai" },
  { id: "ollama", label: "Ollama (local)", name: "Ollama", baseUrl: "http://localhost:11434/v1", apiFormat: "openai" },
  { id: "custom", label: "Custom (tùy chỉnh)", name: "", baseUrl: "", apiFormat: "openai" },
];

const API_TYPES: { value: ApiFormat; label: string }[] = [
  { value: "openai", label: "Chat Completions API" },
  { value: "responses", label: "Responses API" },
  { value: "anthropic", label: "Messages API (Anthropic)" },
];

/** ZCode-style "Add provider" wizard (single step): template → API type →
 *  base URL → key → model ids. */
export default function AddProviderDialog({ onClose, onAdd }: Props) {
  useLang();
  const [templateId, setTemplateId] = useState("openai");
  const [customName, setCustomName] = useState("");
  const [apiFormat, setApiFormat] = useState<ApiFormat>("openai");
  const [baseUrl, setBaseUrl] = useState(TEMPLATES[0].baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [modelIds, setModelIds] = useState<string[]>([""]);

  const tpl = TEMPLATES.find((t) => t.id === templateId)!;
  const isCustom = tpl.id === "custom";
  const name = (isCustom ? customName : tpl.name).trim();
  const models = modelIds.map((m) => m.trim()).filter(Boolean);
  const valid = !!name && !!baseUrl.trim();

  const applyTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    setTemplateId(id);
    setBaseUrl(t.baseUrl);
    setApiFormat(t.apiFormat);
  };

  const submit = () => {
    if (!valid) return;
    onAdd({
      id: "provider_custom_" + Date.now().toString(36),
      name,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      apiFormat,
      models: models.map((id) => ({ id, name: id, enabled: true })),
      status: "unknown",
    });
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 backdrop-blur-[2px] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="dialog-surface w-[520px] max-w-[94vw] max-h-[88vh] overflow-y-auto flex flex-col animate-scale-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-ui-base font-semibold text-foreground">Add provider</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-hover text-foreground-subtlest hover:text-foreground transition-colors"
            title={tr("Đóng")}
          >
            <X size={15} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="text-ui-sm font-medium text-foreground-subtle mb-1.5 block">Provider</label>
            <Select
              ariaLabel="Provider"
              value={templateId}
              onChange={applyTemplate}
              options={TEMPLATES.map((t) => ({ value: t.id, label: tr(t.label) }))}
            />
            {isCustom && (
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={tr("Tên provider (vd: MiniMax CN)")}
                className="input-field mt-2 py-1.5 text-ui-sm"
              />
            )}
          </div>

          <div>
            <label className="text-ui-sm font-medium text-foreground-subtle mb-1.5 block">API type</label>
            <Select
              ariaLabel="API type"
              value={apiFormat}
              onChange={(v) => setApiFormat(v as ApiFormat)}
              options={API_TYPES}
            />
          </div>

          <div>
            <label className="text-ui-sm font-medium text-foreground-subtle mb-1.5 block">Base URL</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="input-field w-full py-2 text-ui-sm font-mono"
            />
          </div>

          <div>
            <label className="text-ui-sm font-medium text-foreground-subtle mb-1.5 block">API key</label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your API Key"
                className="input-field w-full py-2 pr-9 text-ui-sm font-mono"
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-foreground-subtlest hover:text-foreground transition-colors"
                title={showKey ? tr("Ẩn key") : tr("Hiện key")}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-ui-sm font-medium text-foreground-subtle">Model IDs</label>
              <button
                onClick={() => setModelIds((m) => [...m, ""])}
                className="text-ui-xs font-medium text-brand hover:underline"
              >
                + Add Model ID
              </button>
            </div>
            <div className="space-y-2">
              {modelIds.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={v}
                    onChange={(e) =>
                      setModelIds((m) => m.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    placeholder="For example, qwen3.8-max"
                    className="input-field flex-1 py-2 text-ui-sm font-mono"
                  />
                  <button
                    onClick={() => setModelIds((m) => m.filter((_, j) => j !== i))}
                    disabled={modelIds.length === 1 && !v}
                    className="p-1.5 rounded-lg hover:bg-destructive/15 text-foreground-subtlest hover:text-destructive transition-colors disabled:opacity-30"
                    title={tr("Xóa dòng")}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-ui-sm font-medium text-foreground-subtle hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!valid}
            className="px-5 py-1.5 rounded-lg text-ui-sm font-semibold bg-primary text-primary-foreground hover:brightness-110 disabled:opacity-40 transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

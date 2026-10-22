import { useEffect, useRef, useState } from "react";
import { HelpCircle, MessageSquareDashed, Check } from "lucide-react";
import { t, useLang } from "../lib/i18n";

interface QuestionPromptProps {
  question: string;
  options: string[];
  multiSelect: boolean;
  onAnswer: (answer: string | null) => void;
}

/**
 * The agent's question, paused mid-run — ZCode's AskUserQuestion dialog.
 *
 * Contract mirrored from ZCode:
 *   - preset answers are a list; "Other" is ALWAYS available as free text
 *   - multiSelect questions allow several answers (comma-joined on submit)
 *   - dismissing the dialog resolves with `null`, which is NOT a refusal —
 *     the model proceeds on its own judgment (see `ask_user`'s handler)
 *   - recommended-first ordering is the model's job; this UI keeps the order
 *     it was given
 */
export default function QuestionPrompt({
  question,
  options,
  multiSelect,
  onAnswer,
}: QuestionPromptProps) {
  useLang();
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCustom) customRef.current?.focus();
  }, [isCustom]);

  const toggle = (option: string) => {
    if (multiSelect) {
      setSelected((prev) =>
        prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]
      );
    } else {
      setSelected([option]);
    }
  };

  const submit = () => {
    const picked = isCustom ? custom.trim() : selected.join(", ");
    if (!picked) return;
    onAnswer(picked);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onAnswer(null);
    }
  };

  const optionRows = [
    ...options.map((o) => ({ label: o, custom: false })),
    { label: t("Khác (tự nhập câu trả lời)"), custom: true },
  ];

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center pt-24 bg-black/45 backdrop-blur-[1px]"
      onKeyDown={handleKeyDown}
    >
      <div
        className="dialog-surface w-[460px] max-w-[92vw] p-4 animate-scale-in"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-2 mb-3">
          <HelpCircle className="size-4 text-brand" />
          <span className="text-ui-base font-semibold text-foreground">
            {t("Agent đang hỏi bạn")}
          </span>
        </div>

        <p className="text-ui-sm text-foreground mb-3 whitespace-pre-wrap break-words">
          {question}
        </p>

        <div className="flex flex-col gap-0.5" role="listbox" aria-label={t("Các đáp án")}>
          {optionRows.map((row) => {
            const active = row.custom ? isCustom : selected.includes(row.label);
            return (
              <button
                key={row.label}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  if (row.custom) {
                    setIsCustom(true);
                    setSelected([]);
                  } else {
                    setIsCustom(false);
                    toggle(row.label);
                  }
                }}
                className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors ${
                  active ? "bg-selected" : "hover:bg-hover"
                }`}
              >
                <span
                  className={`size-4 shrink-0 flex items-center justify-center border ${
                    multiSelect ? "rounded" : "rounded-full"
                  } ${active ? "border-brand bg-brand" : "border-border"}`}
                >
                  {active && <Check className="size-3 text-white" />}
                </span>
                <span className="flex items-center gap-1.5 min-w-0 flex-1 text-ui-base text-foreground">
                  {row.custom && <MessageSquareDashed className="size-3.5 text-foreground-subtle" />}
                  {row.label}
                </span>
              </button>
            );
          })}
        </div>

        {isCustom && (
          <input
            ref={customRef}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder={t("Nhập câu trả lời của bạn…")}
            className="mt-2 w-full px-2.5 py-1.5 rounded-md bg-terminal-bg border border-border text-ui-sm text-foreground outline-none focus:border-brand"
          />
        )}

        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={submit}
            disabled={!isCustom && selected.length === 0}
            className="px-3 py-1.5 rounded-md text-ui-sm font-medium bg-brand text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("Trả lời")}
          </button>
          <button
            type="button"
            onClick={() => onAnswer(null)}
            className="px-3 py-1.5 rounded-md text-ui-sm font-medium border border-border text-foreground-subtle hover:bg-surface-hover transition-colors"
          >
            {t("Bỏ qua")}
          </button>
          <span className="ml-auto text-ui-xs text-foreground-subtlest">
            {multiSelect ? t("Chọn nhiều đáp án") : t("Enter để trả lời · Esc để bỏ qua")}
          </span>
        </div>
      </div>
    </div>
  );
}

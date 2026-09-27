import { useEffect, useRef, useState } from "react";
import { Terminal, ShieldAlert, ShieldOff, Play, Ban, CheckCheck, FileEdit } from "lucide-react";
import type { ApprovalDecision } from "../types";

interface PermissionPromptProps {
  tool: string;
  args: Record<string, string>;
  onDecide: (decision: ApprovalDecision) => void;
}

interface Option {
  id: ApprovalDecision;
  label: string;
  description: string;
  Icon: typeof Play;
  /** High-permission options stay warning-tinted so the risk is never muted. */
  tone?: "warning";
}

/**
 * Option order follows ZCode's `sortPermissionOptions` priority
 * (`getPermissionOptionSortPriority`, with the full-access option pinned to 1.5):
 * allowOnce 0 · allowAlways 1 · allowFullAccess 1.5 · rejectOnce 2 · rejectAlways 3.
 *
 * `PERMISSION_OPTION_PRIORITY` in `types.ts` holds the same numbers; keep both
 * in step. ZCode derives the order from the option list the model returns, so
 * this app states it explicitly.
 *
 * Copy mirrors ZCode's `chat.permission.*` strings; "Full access" is
 * `chat.permission.fullAccess` + `.description` in meaning:
 * "Grant the agent full access without further confirmation."
 */
const OPTIONS: Option[] = [
  {
    id: "allowOnce",
    label: "Chạy lần này",
    description: "Cho phép chạy lệnh này một lần.",
    Icon: Play,
  },
  {
    id: "allowAlways",
    label: "Luôn cho phép",
    description: "Cho phép tool này mọi lần sau, không hỏi lại nữa.",
    Icon: CheckCheck,
  },
  {
    id: "allowFullAccess",
    label: "Full access",
    description: "Cấp cho agent toàn quyền, không hỏi lại nữa.",
    Icon: ShieldAlert,
    tone: "warning",
  },
  {
    id: "rejectOnce",
    label: "Từ chối",
    description: "Không chạy lệnh này.",
    Icon: Ban,
  },
  {
    id: "rejectAlways",
    label: "Luôn chặn",
    description: "Chặn tool này vĩnh viễn, kể cả khi đang bật Full access.",
    Icon: ShieldOff,
    tone: "warning",
  },
];

/**
 * What the agent is about to do, in words.
 *
 * `run_command` shows the command, but `write_file` now asks too and has no
 * command — showing "(no command)" for a file write would make the prompt
 * unreadable, which is the one thing it must never be. Mirrors ZCode, which
 * renders a per-kind block (its `PermissionBlockKind`: "edit" vs "execute").
 */
function describeRequest(tool: string, args: Record<string, string>): {
  Icon: typeof Terminal;
  text: string;
} {
  if (tool === "run_command") {
    return { Icon: Terminal, text: args.command ?? "(no command)" };
  }
  if (tool === "write_file") {
    const bytes = (args.content ?? "").length;
    return {
      Icon: FileEdit,
      text: `${args.path ?? "(no path)"} — sẽ ghi đè toàn bộ file (${bytes} ký tự)`,
    };
  }
  return { Icon: Terminal, text: JSON.stringify(args) };
}

/**
 * Tool permission prompt, ported from ZCode's `PermissionDialog`:
 *   - dialog shell (`rounded-2xl`, `bg-popover`, `shadow-lg`)
 *   - options are a vertical list, each with a label and a description, ordered
 *     by permission priority rather than by visual importance
 *   - arrow keys move the selection, Enter confirms, Escape denies
 *   - the selected option carries `data-permission-option-kind` so the answer
 *     can be targeted without reading the raw command
 */
export default function PermissionPrompt({ tool, args, onDecide }: PermissionPromptProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // ZCode moves focus onto the selected option rather than leaving the dialog
  // root focused, so keyboard confirmation works without a click first.
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      optionRefs.current[selectedIndex]?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % OPTIONS.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onDecide(OPTIONS[selectedIndex].id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDecide("rejectOnce");
    }
  };

  const request = describeRequest(tool, args);

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center pt-24 bg-black/45 backdrop-blur-[1px]"
      onKeyDown={handleKeyDown}
    >
      <div className="dialog-surface w-[460px] max-w-[92vw] p-4 animate-scale-in" role="dialog" aria-modal="true">
        <div className="flex items-center gap-2 mb-3">
          <request.Icon className="size-4 text-foreground-subtle" />
          <span className="text-ui-base font-semibold text-foreground">Cần cấp quyền</span>
        </div>

        <p className="text-ui-xs text-foreground-subtle mb-2">
          Agent muốn dùng <span className="font-mono text-foreground">{tool}</span> trong project của bạn:
        </p>

        <pre className="p-2.5 rounded-md bg-terminal-bg border border-border text-ui-sm font-mono text-terminal-fg whitespace-pre-wrap break-words mb-3 max-h-40 overflow-y-auto">
          {request.text}
        </pre>

        <div className="flex flex-col gap-0.5" role="listbox" aria-label="Tuỳ chọn cấp quyền">
          {OPTIONS.map((option, index) => {
            const isSelected = index === selectedIndex;
            const { Icon } = option;
            return (
              <button
                key={option.id}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                data-permission-option-kind={option.id}
                onClick={() => onDecide(option.id)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`flex items-start gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors ${
                  isSelected ? "bg-selected" : "hover:bg-hover"
                }`}
              >
                <Icon
                  className={`size-4 shrink-0 mt-0.5 ${
                    option.tone === "warning" ? "text-warning" : "text-foreground-subtle"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-ui-base font-medium ${
                      option.tone === "warning" ? "text-warning" : "text-foreground"
                    }`}
                  >
                    {option.label}
                  </span>
                  <span className="block text-ui-xs text-foreground-subtlest">
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-ui-xs text-foreground-subtlest mt-3">
          Dùng ↑ / ↓ để chọn, Enter để xác nhận, Esc để từ chối.
        </p>
      </div>
    </div>
  );
}

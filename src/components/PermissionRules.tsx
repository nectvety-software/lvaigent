import { useStore } from "../store";
import { CheckCheck, ShieldOff, X } from "lucide-react";

/**
 * The always-allow / always-deny rules, as set from the permission prompt
 * (ZCode's `allowAlways` / `rejectAlways` options).
 *
 * These exist as a list the user can inspect and revoke. Without this screen a
 * "Luôn chặn" rule would be invisible and unremovable except by clearing
 * localStorage — and a deny rule outranks Full access, so a stale one would
 * silently break the agent with no way back from the UI.
 */
/** Stable fallback: a fresh `[]` inside the selector would make zustand's
 *  getSnapshot return a new reference every render and loop forever. */
const NO_TOOLS: string[] = [];

export default function PermissionRules() {
  const allowed = useStore((s) => s.settings.alwaysAllowTools) ?? NO_TOOLS;
  const denied = useStore((s) => s.settings.alwaysDenyTools) ?? NO_TOOLS;
  const clearAlwaysRule = useStore((s) => s.clearAlwaysRule);

  if (allowed.length === 0 && denied.length === 0) {
    return (
      <p className="text-ui-xs text-foreground-subtlest px-2 py-1.5">
        Chưa có luật nào. Chọn "Luôn cho phép" hoặc "Luôn chặn" trong hộp thoại cấp quyền.
      </p>
    );
  }

  const render = (tools: string[], kind: "allow" | "deny") =>
    tools.map((tool) => {
      const isDeny = kind === "deny";
      const Icon = isDeny ? ShieldOff : CheckCheck;
      return (
        <div
          key={`${kind}:${tool}`}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-hover group"
        >
          <Icon
            className={`size-3.5 shrink-0 ${isDeny ? "text-warning" : "text-foreground-subtle"}`}
          />
          <span className="font-mono text-ui-xs text-foreground flex-1 min-w-0 truncate">
            {tool}
          </span>
          <span className="text-ui-xs text-foreground-subtlest">
            {isDeny ? "luôn chặn" : "luôn cho phép"}
          </span>
          <button
            type="button"
            onClick={() => clearAlwaysRule(tool)}
            title={`Bỏ luật ${tool}`}
            aria-label={`Bỏ luật ${tool}`}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 rounded hover:bg-selected text-foreground-subtle hover:text-foreground transition-opacity"
          >
            <X className="size-3" />
          </button>
        </div>
      );
    });

  return <div className="space-y-0.5">{render(denied, "deny")}{render(allowed, "allow")}</div>;
}
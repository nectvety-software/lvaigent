import type { DiffLine } from "../lib/diff";

export type DiffRow = DiffLine | { type: "gap"; count: number };

/** Render one diff row list (shared by the review panel and step badges). */
export default function DiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="border-t border-border bg-terminal-bg font-mono text-ui-xs leading-[1.5] max-h-[50vh] overflow-auto">
      {rows.map((row, i) => {
        if (row.type === "gap") {
          return (
            <div key={i} className="px-3 py-0.5 text-foreground-subtlest bg-surface/60 select-none">
              ⋯ {row.count} dòng không đổi
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
        return (
          <div key={i} className={`flex ${bg} whitespace-pre-wrap break-all`}>
            <span className="w-9 shrink-0 text-right pr-1.5 text-foreground-subtlest select-none tabular-nums">
              {row.a ?? row.b ?? ""}
            </span>
            <span className={`w-4 shrink-0 text-center ${signColor} select-none`}>{sign}</span>
            <span className={`flex-1 pr-3 ${textColor}`}>{row.text}</span>
          </div>
        );
      })}
    </div>
  );
}

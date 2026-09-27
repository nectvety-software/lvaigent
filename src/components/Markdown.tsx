import { useState } from "react";
import { Copy, Check } from "lucide-react";

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-border bg-terminal-bg">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface border-b border-border">
        <span className="text-ui-xs text-foreground-subtlest font-mono">{language}</span>
        <button
          onClick={handleCopy}
          className="text-ui-xs text-foreground-subtle hover:text-foreground transition-colors flex items-center gap-1"
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto">
        <code className="text-ui-sm font-mono text-terminal-fg leading-relaxed">{code}</code>
      </pre>
    </div>
  );
}

function renderLine(line: string, key: number) {
  const inline = (text: string) => {
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return parts.map((p, i) => {
      if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
        return (
          <code key={i} className="px-1.5 py-0.5 bg-surface border border-border rounded text-ui-sm font-mono text-brand">
            {p.slice(1, -1)}
          </code>
        );
      }
      if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
        return <strong key={i} className="text-foreground font-semibold">{p.slice(2, -2)}</strong>;
      }
      return <span key={i}>{p}</span>;
    });
  };

  const heading = /^(#{1,3})\s+(.*)$/.exec(line);
  if (heading) {
    const level = heading[1].length;
    const size = level === 1 ? "text-ui-base" : level === 2 ? "text-ui-base" : "text-ui-base";
    return (
      <div key={key} className={`${size} font-semibold text-foreground mt-4 mb-1.5`}>
        {inline(heading[2])}
      </div>
    );
  }

  const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
  if (bullet) {
    return (
      <div key={key} className="flex gap-2 pl-4 my-0.5">
        <span className="text-foreground-subtlest select-none">·</span>
        <span className="flex-1">{inline(bullet[1])}</span>
      </div>
    );
  }

  const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
  if (numbered) {
    return (
      <div key={key} className="flex gap-2 pl-4 my-0.5">
        <span className="text-foreground-subtlest select-none tabular-nums">{numbered[1]}.</span>
        <span className="flex-1">{inline(numbered[2])}</span>
      </div>
    );
  }

  if (line.trim() === "") return <div key={key} className="h-2" />;

  return <div key={key} className="my-0.5">{inline(line)}</div>;
}

export default function Markdown({ text }: { text: string }) {
  const segments = text.split(/(```[\s\S]*?```)/g);
  return (
    <div className="text-ui-base leading-relaxed text-foreground-subtle break-words">
      {segments.map((seg, i) => {
        const codeMatch = seg.match(/^```(\w*)\n?([\s\S]*?)```$/);
        if (codeMatch) {
          return <CodeBlock key={i} language={codeMatch[1] || "text"} code={codeMatch[2]} />;
        }
        return (
          <span key={i}>
            {seg.split("\n").map((line, j) => renderLine(line, j))}
          </span>
        );
      })}
    </div>
  );
}

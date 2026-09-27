/**
 * Tailwind config for the DuckChat design system (ported from ZCode).
 *
 * Token values live in `src/index.css` — see the header comment there for the
 * source of truth (`ZCode/DESIGN.md` + `ZCode/packages/ui/src/styles.css`).
 *
 * Why the colours are functions and not plain `var(--x)` strings:
 * Tailwind v3 cannot apply an alpha modifier to a raw `var()` colour. Writing
 * `bg-destructive/15` against `destructive: "var(--color-destructive)"` emits
 * NO rule at all — the class silently does nothing. Returning a function lets
 * Tailwind hand us the modifier, which we resolve with `color-mix()` instead.
 * Do not "simplify" these back to plain strings.
 */

/** Semantic colour token -> Tailwind colour entry with working alpha support. */
const token = (name) => ({ opacityValue }) =>
  opacityValue === undefined
    ? `var(--color-${name})`
    : `color-mix(in oklab, var(--color-${name}) calc(${opacityValue} * 100%), transparent)`;

/**
 * Every semantic token from the Zai Dark palette. Names are the CSS custom
 * property suffixes, so `--color-diff-added` becomes the `diff-added` key and
 * the `bg-diff-added` / `text-diff-added` / `border-diff-added` utilities.
 */
const SEMANTIC_TOKENS = [
  // base + structure
  "background", "background-alt", "background-win-alt", "brand", "icon-blue",
  // trajectory + workflow
  "trajectory-user", "trajectory-assistant", "trajectory-reasoning",
  "trajectory-tool-call", "trajectory-tool-result",
  "workflow-rule", "workflow-trace", "workflow-trace-strong",
  // surfaces
  "accent", "find-highlight", "find-highlight-active",
  "border", "border-hover", "hover", "selected",
  "header", "panel", "sidebar", "surface", "surface-hover",
  "card", "card-selected", "card-border",
  "popover", "popover-foreground", "popover-header", "popover-border",
  "input", "input-focused", "input-border", "input-border-hover", "input-border-focused",
  "tab", "tab-active", "tab-border", "menu", "menu-hover",
  // terminal
  "terminal-bg", "terminal-fg", "terminal-cursor", "terminal-cursor-accent",
  "terminal-selection", "terminal-selection-inactive",
  "terminal-black", "terminal-red", "terminal-green", "terminal-yellow",
  "terminal-blue", "terminal-magenta", "terminal-cyan", "terminal-white",
  "terminal-bright-black", "terminal-bright-red", "terminal-bright-green",
  "terminal-bright-yellow", "terminal-bright-blue", "terminal-bright-magenta",
  "terminal-bright-cyan", "terminal-bright-white",
  // charts
  "usage-chart-1", "usage-chart-2", "usage-chart-3",
  "usage-chart-4", "usage-chart-5", "usage-chart-6",
  "context-breakdown-1", "context-breakdown-2", "context-breakdown-3",
  "context-breakdown-4", "context-breakdown-5", "context-breakdown-6",
  "context-breakdown-7",
  "usage-heatmap-0", "usage-heatmap-1", "usage-heatmap-2",
  "usage-heatmap-3", "usage-heatmap-4",
  // actions + states
  "primary", "primary-foreground", "secondary",
  "interaction-ask-surface", "interaction-ask-foreground", "interaction-ask-fill",
  "interaction-confirmation-surface", "interaction-confirmation-foreground",
  "foreground", "foreground-subtle", "foreground-subtlest", "foreground-inverse",
  "success", "success-foreground",
  "idle-task", "idle-task-surface",
  "destructive", "destructive-foreground",
  "warning", "warning-foreground", "feedback-privacy-hint",
  "diff-added", "diff-added-foreground", "diff-removed", "diff-removed-foreground",
  "git-none", "git-modified", "git-added", "git-deleted",
  "git-renamed", "git-untracked", "git-ignored", "git-descendant",
  // overlays
  "toast", "tooltip", "tooltip-foreground", "tooltip-tag", "tooltip-tag-foreground",
  "tag", "markdown-inline-code",
  // graph node accents
  "file-node", "file-node-hover", "file-node-foreground",
  "skill-node", "skill-node-hover", "skill-node-foreground",
  "command-node", "command-node-hover", "command-node-foreground",
  "subagent-node", "subagent-node-hover", "subagent-node-foreground",
  "session-node", "session-node-hover", "session-node-foreground",
  "plugin-node", "plugin-node-hover", "plugin-node-foreground",
  "plugin-paid-plan-badge", "plugin-paid-plan-badge-foreground",
];

/**
 * Deprecated pre-port DuckChat names. Kept so an unmigrated component still
 * renders the right colour instead of dropping to transparent. Plain strings
 * on purpose: these are dead ends and nothing should add alpha to them.
 */
const LEGACY_SHIMS = {
  "background-base": "var(--background-base)",
  "background-stronger": "var(--background-stronger)",
  "surface-base": "var(--surface-base)",
  "surface-panel": "var(--surface-panel)",
  "surface-raised": "var(--surface-raised)",
  "surface-raised-hover": "var(--surface-raised-hover)",
  "text-strong": "var(--text-strong)",
  "text-base": "var(--text-base)",
  "text-weak": "var(--text-weak)",
  "text-weaker": "var(--text-weaker)",
  "border-base": "var(--border-base)",
  "border-weak": "var(--border-weak-base)",
  "border-weaker": "var(--border-weaker-base)",
  "icon-base": "var(--icon-base)",
  "icon-strong": "var(--icon-strong)",
  "icon-interactive": "var(--icon-interactive)",
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ...Object.fromEntries(SEMANTIC_TOKENS.map((name) => [name, token(name)])),
        ...LEGACY_SHIMS,
      },
      fontSize: {
        // DESIGN.md: all interface typography uses this scale. `ui-2xs` is
        // restricted to workflow-graph axis furniture, never content.
        "ui-xl": "var(--text-ui-xl)",
        "ui-lg": "var(--text-ui-lg)",
        "ui-base": "var(--text-ui-base)",
        "ui-caption": "var(--text-ui-caption)",
        "ui-sm": "var(--text-ui-sm)",
        "ui-xs": "var(--text-ui-xs)",
        "ui-2xs": "var(--text-ui-2xs)",
        "mobile-input-safe": "var(--text-mobile-input-safe)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        // Ported from ZCode: keep the platform monospace faces, but put CJK
        // sans in front of the generic fallback so non-latin text does not drop
        // to a serif face.
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "Microsoft YaHei UI",
          "Microsoft YaHei",
          "PingFang SC",
          "Noto Sans CJK SC",
          "monospace",
        ],
      },
      // Elevation is restrained: overlays only. Values are kept for the classes
      // already referenced by components; new work should prefer shadow-md/lg.
      boxShadow: {
        soft: "0 1px 2px rgba(0, 0, 0, 0.24)",
        panel: "0 4px 12px -2px rgba(0, 0, 0, 0.4)",
        "xs-border": "0 1px 2px rgba(0, 0, 0, 0.3)",
        "sm-border": "0 1px 3px rgba(0, 0, 0, 0.4)",
        "lg-border": "0 4px 15px -3px rgba(0, 0, 0, 0.5)",
      },
      keyframes: {
        "slide-up": {
          "0%": { transform: "translateY(6px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "scale-in": {
          "0%": { transform: "scale(0.98)", opacity: "0" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
      },
      animation: {
        "slide-up": "slide-up 0.14s ease-out",
        "fade-in": "fade-in 0.12s ease-out",
        "scale-in": "scale-in 0.12s ease-out",
        "pulse-dot": "pulse-dot 1.5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

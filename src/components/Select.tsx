import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Trigger styling. Defaults to the shared Settings input look. */
  className?: string;
  /** Accessible name, for the cases where no visible <label> is tied to it. */
  ariaLabel?: string;
}

const GAP = 4;
const VIEWPORT_MARGIN = 8;
const MAX_LIST_H = 264;

export interface Placement {
  top: number;
  left: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  /** True when the list was flipped above the trigger. */
  flipped: boolean;
}

export interface PlacementInput {
  trigger: { top: number; bottom: number; left: number; width: number };
  /** Measured height of the list content, before clamping. */
  listHeight: number;
  viewportHeight: number;
  viewportWidth: number;
}

/**
 * Pure placement maths, exported so it can be tested directly.
 *
 * It lives outside the component because the flip-up branch is not reachable
 * through the Settings UI today — the dialog is a fixed 560px tall, so every
 * select in it has room below. Testing this through a screenshot would mean
 * claiming coverage of a path the DOM never takes.
 */
export function computePlacement({
  trigger,
  listHeight,
  viewportHeight,
  viewportWidth,
}: PlacementInput): Placement {
  const below = viewportHeight - trigger.bottom - GAP - VIEWPORT_MARGIN;
  const above = trigger.top - GAP - VIEWPORT_MARGIN;

  // Only flip when the list genuinely does not fit below AND above is roomier.
  const flipped = listHeight > below && above > below;
  const maxHeight = Math.max(96, Math.min(MAX_LIST_H, flipped ? above : below));
  const height = Math.min(listHeight, maxHeight);

  const top = flipped
    ? Math.max(VIEWPORT_MARGIN, trigger.top - GAP - height)
    : trigger.bottom + GAP;

  // Clamp on both sides: a trigger can also start left of the margin.
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, trigger.left),
    Math.max(VIEWPORT_MARGIN, viewportWidth - trigger.width - VIEWPORT_MARGIN),
  );

  return {
    top,
    left,
    minWidth: trigger.width,
    maxWidth: Math.max(160, viewportWidth - VIEWPORT_MARGIN * 2),
    maxHeight,
    flipped,
  };
}

/**
 * Themed replacement for the native `<select>`.
 *
 * Why not keep the native one: on Windows the option popup is drawn by the OS,
 * so it ignores the app theme — a white list under light-grey text on a dark UI.
 * `background-color` on `<option>` is unreliable across engines, so the only
 * dependable fix is to draw the list ourselves.
 *
 * The list is portalled to `document.body` and positioned `fixed`, deliberately
 * — not `absolute` inside the trigger's subtree. Both the Settings dialog shell
 * (`overflow-hidden`) and its content pane (`overflow-y-auto`) would clip an
 * absolutely-positioned list, which is the same failure that once made the
 * workspace switcher look broken.
 */
export default function Select({
  value,
  options,
  onChange,
  className,
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();

    // Measure the real list height instead of assuming MAX_LIST_H, so a
    // two-item list does not flip upwards the way a thirty-item list must.
    setPlacement(
      computePlacement({
        trigger: { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
        listHeight: listRef.current?.offsetHeight ?? MAX_LIST_H,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      }),
    );
  }, []);

  // Layout effect, not a plain effect: this runs before paint, so the list is
  // never visible at its provisional top-left position.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    place();
  }, [open, options.length, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // `capture` so the list follows the trigger when an ancestor scrolls —
    // scroll events do not bubble.
    const onReflow = () => place();

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, place]);

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const openList = () => {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const commit = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onTriggerKeyDown}
        className={className ?? DEFAULT_TRIGGER_CLS}
      >
        {/* Fall back to the raw value rather than a bare dash: a stale id (say a
            model that is now disabled) is more useful to show than nothing. */}
        <span className="truncate text-left">{selected?.label ?? (value || "—")}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-foreground-subtlest transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            data-flipped={placement?.flipped ? "true" : "false"}
            style={{
              position: "fixed",
              top: placement?.top ?? 0,
              left: placement?.left ?? 0,
              minWidth: placement?.minWidth,
              maxWidth: placement?.maxWidth,
              maxHeight: placement?.maxHeight,
              // Hidden for the single frame before the layout effect measures.
              visibility: placement ? "visible" : "hidden",
            }}
            className="menu-surface flex flex-col gap-0.5 overflow-y-auto animate-scale-in z-[60]"
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                // aria-selected marks the chosen value; data-selected drives the
                // hover/arrow-key highlight, which is a different thing.
                aria-selected={o.value === value}
                data-index={i}
                data-selected={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(i)}
                className="menu-row"
              >
                <span className="flex-1 truncate">{o.label}</span>
                {o.value === value && <Check size={13} className="shrink-0 text-brand" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Mirrors the Settings `inputCls` so the trigger is visually unchanged. */
const DEFAULT_TRIGGER_CLS =
  "w-full flex items-center justify-between gap-2 bg-surface border border-border rounded-lg px-3 py-2.5 text-ui-base text-foreground focus:outline-none focus:border-border-hover transition-colors";

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Globe } from "lucide-react";
import { t, useLang } from "../lib/i18n";

interface Props {
  width: number;
  onClose: () => void;
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** True while a modal covers the app: the native child webview always
   *  paints on top of the page, so it must be parked until the modal closes. */
  paused: boolean;
}

/** Where the parked child webview waits — far outside the parent's client
 *  area, so Windows clips it but the renderer (and its CDP target) lives. */
const PARK = { x: -10000, y: -10000, w: 480, h: 640 };

/**
 * CSS pixels of the pane's left edge kept free of the native view.
 *
 * The child webview is a real window, so it wins hit-testing against the DOM
 * handle underneath it. Without this gutter the grab strip would be dead over
 * almost its whole height. It also keeps a drag alive: the pane's left edge
 * tracks the pointer 1:1, so a cursor that starts inside the gutter never
 * wanders over the native view mid-drag.
 */
const HANDLE_GUTTER = 8;

/**
 * Where the native view goes for a given pane body rect.
 *
 * Two contracts live here. `place_duckai`/`set_bounds` speak PHYSICAL pixels
 * while `getBoundingClientRect` is CSS, so every number is scaled by DPR —
 * getting this wrong leaves the view a quarter off screen at 125% scaling. And
 * the left edge keeps the handle gutter free: the child window always wins
 * hit-testing over the DOM, so covering the grab strip makes the pane
 * unresizable.
 */
export function childBoundsFor(
  rect: { left: number; top: number; width: number; height: number },
  dpr: number
): { x: number; y: number; w: number; h: number } {
  const gutter = HANDLE_GUTTER * dpr;
  return {
    x: Math.round(rect.left * dpr + gutter),
    y: Math.round(rect.top * dpr),
    w: Math.round(rect.width * dpr - gutter),
    h: Math.round(rect.height * dpr),
  };
}

/**
 * Whether the duck.ai browser pane starts open.
 *
 * A persistence decision with a silent failure mode: reading the flag wrong
 * leaves the toggle showing "on" while the native view is parked, and nothing
 * tells the user. The contract is "absent means on" — a fresh install gets the
 * browser pane the user asked for, and only an explicit "false" keeps it closed.
 */
export function initialBrowserSplit(stored: string | null): boolean {
  if (stored === null) return true;
  return stored !== "false";
}

/**
 * The duck.ai browser pane — one window, like terminal/output.
 *
 * The page itself is a NATIVE child webview inside the main window (the
 * `duckai` view in src-tauri). This component owns the layout column and
 * measures the body rect; `place_duckai` moves the native view onto it.
 * Every number crosses the IPC boundary in PHYSICAL pixels (CSS x DPR).
 */
export default function BrowserPane({ width, onClose, onResizeStart, paused }: Props) {
  useLang();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // set_bounds calls are async IPC; concurrent ones can land out of order,
    // so a fast drag or a maximize could leave the native view at a stale
    // rect. Chain every placement and measure only when it's this call's turn.
    let chain: Promise<void> = Promise.resolve();
    let scheduled = false;

    const runPlace = () => {
      scheduled = false;
      chain = chain.then(async () => {
        const el = bodyRef.current;
        if (!el || cancelled || paused) return;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const dpr = window.devicePixelRatio || 1;
        try {
          await invoke("place_duckai", childBoundsFor(r, dpr));
        } catch (e) {
          if (!cancelled) console.error("place_duckai failed:", e);
        }
      });
    };
    const place = () => {
      if (scheduled || cancelled) return;
      scheduled = true;
      requestAnimationFrame(runPlace);
    };
    void place();

    // Any layout change (window resize, sidebar toggle, drag, captcha
    // overlay closing) must re-measure; ResizeObserver covers the column
    // itself, the events cover moves that keep the size but shift the origin.
    const ro = new ResizeObserver(() => void place());
    if (bodyRef.current) ro.observe(bodyRef.current);
    const relayout = () => {
      void place();
      // Maximize/restore keeps the pane's CSS size but the native window
      // settles one frame later; a trailing pass re-anchors the final rect.
      requestAnimationFrame(() => requestAnimationFrame(() => void place()));
    };
    window.addEventListener("resize", relayout);
    window.addEventListener("duckai:relayout", relayout);
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("resize", relayout);
      window.removeEventListener("duckai:relayout", relayout);
    };
  }, [width, paused]);

  // Park when paused or unmounted — the SPA must never be destroyed, only
  // moved out of the parent's visible client area.
  useEffect(() => {
    if (!paused) return;
    void invoke("place_duckai", PARK).catch(() => {});
  }, [paused]);
  useEffect(
    () => () => {
      void invoke("place_duckai", PARK).catch(() => {});
    },
    []
  );

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-panel"
      style={{ width }}
    >
      {/* Drag handle on the left edge: the boundary between the agent area
        * and the browser pane, like the side pane's own handle. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
        title={t("Kéo để thay đổi độ rộng Browser")}
        className="group/browser-handle absolute inset-y-0 left-0 z-20 flex w-2 shrink-0 cursor-col-resize items-center justify-center"
      >
        <span className="pointer-events-none absolute inset-y-3 w-0.5 rounded-full bg-foreground-subtlest/50 opacity-0 transition-opacity group-hover/browser-handle:opacity-100" />
      </div>

      <div className="flex h-12 shrink-0 items-center justify-between gap-2 p-2">
        <div className="flex min-w-0 items-center gap-2 px-1 text-sm text-foreground-subtle">
          <Globe className="size-4 shrink-0" />
          <span className="truncate">Browser</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t("Đóng Browser")}
          aria-label="Close browser pane"
          className="flex size-8 items-center justify-center rounded-lg text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* The native webview paints exactly over this box; the frame colour
        * shows through the header only. */}
      <div ref={bodyRef} className="min-h-0 flex-1" />
    </aside>
  );
}

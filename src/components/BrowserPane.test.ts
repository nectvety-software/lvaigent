import { describe, expect, it } from "vitest";
import { initialBrowserSplit, childBoundsFor } from "./BrowserPane";

/**
 * The duck.ai browser pane (embedded child webview) starts open by default
 * and stays as the user left it.
 *
 * The failure this guards is silent: if the stored flag is misread, the toggle
 * shows "split on" while the native view is still parked outside the window,
 * and nothing tells the user their browser pane is missing. "Absent means on"
 * keeps a fresh install on the layout that was asked for.
 */
describe("initialBrowserSplit", () => {
  it("defaults to on with nothing stored", () => {
    expect(initialBrowserSplit(null)).toBe(true);
  });

  it("stays off when the user explicitly turned it off", () => {
    // The one thing that must survive a restart: a deliberate choice.
    expect(initialBrowserSplit("false")).toBe(false);
  });

  it("stays on when the user explicitly turned it on", () => {
    expect(initialBrowserSplit("true")).toBe(true);
  });

  it("treats an unrecognised value as on rather than silently closing the pane", () => {
    // A corrupt or future value must not turn the browser pane off without the
    // user asking; the safe default is the layout they were last shown.
    expect(initialBrowserSplit("")).toBe(true);
    expect(initialBrowserSplit("yes")).toBe(true);
    expect(initialBrowserSplit("0")).toBe(true);
  });
});

/**
 * The CSS -> physical translation the native child view is placed with.
 *
 * `set_bounds` on the backend takes physical pixels; the DOM measures in CSS.
 * At 125% scaling (this app's dev machine) mixing the two puts the view ~20%
 * off its column, and at 100% the bug is invisible — which is exactly why the
 * units need a test rather than a screenshot on one machine.
 */
describe("childBoundsFor", () => {
  const rect = { left: 400, top: 52, width: 600, height: 700 };

  it("scales every edge by the device pixel ratio", () => {
    expect(childBoundsFor(rect, 2)).toEqual({
      x: 400 * 2 + 8 * 2,
      y: 52 * 2,
      w: 600 * 2 - 8 * 2,
      h: 700 * 2,
    });
  });

  it("keeps the left handle gutter free so the native view cannot swallow the drag strip", () => {
    // The child window hit-tests above the DOM, so any pixel of the gutter the
    // view covers is a pixel the user cannot grab.
    const at1x = childBoundsFor(rect, 1);
    const at125 = childBoundsFor(rect, 1.25);
    expect(at1x.x).toBe(rect.left + 8);
    expect(at125.x).toBe(Math.round(rect.left * 1.25 + 10));
    // The right edge still lands on the pane's right edge: the gutter is taken
    // out of the width, not added to it.
    expect(at1x.x + at1x.w).toBe((rect.left + rect.width) * 1);
    expect(at125.x + at125.w).toBe(Math.round((rect.left + rect.width) * 1.25));
  });
});

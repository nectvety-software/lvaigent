import { describe, expect, it } from "vitest";
import { computePlacement } from "../components/Select";

const VIEW = { viewportHeight: 800, viewportWidth: 1280 };

/** A trigger 200px from the top of the viewport, 558px wide at x=200. */
const trigger = (top: number, left = 200, width = 558) => ({
  top,
  bottom: top + 32,
  left,
  width,
});

describe("computePlacement", () => {
  it("opens downward when the list fits below", () => {
    const p = computePlacement({ ...VIEW, trigger: trigger(200), listHeight: 188 });
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(232 + 4);
    expect(p.maxHeight).toBe(264);
  });

  it("flips above when there is no room below but more above", () => {
    // Trigger 60px from the bottom, list 188px tall: 60-4-8 = 48px below.
    const p = computePlacement({ ...VIEW, trigger: trigger(740), listHeight: 188 });
    expect(p.flipped).toBe(true);
    // Sits above the trigger, with the gap, and never past the top margin.
    expect(p.top + Math.min(188, p.maxHeight)).toBeLessThanOrEqual(740 - 4 + 0.001);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it("stays below when above is not roomier, even if it must scroll", () => {
    // Trigger high up: below has 196px, above only 48px. Flipping would put the
    // list off-screen, so it must stay below and scroll instead.
    const p = computePlacement({
      viewportHeight: 300,
      viewportWidth: 1280,
      trigger: trigger(60),
      listHeight: 264,
    });
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(92 + 4);
    expect(p.maxHeight).toBe(196);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(300);
  });

  it("never lets the flipped list cover its own trigger", () => {
    for (const top of [400, 500, 600, 700, 760]) {
      const p = computePlacement({ ...VIEW, trigger: trigger(top), listHeight: 264 });
      const bottom = p.top + Math.min(264, p.maxHeight);
      if (p.flipped) {
        expect(bottom, `flipped list at trigger.top=${top}`).toBeLessThanOrEqual(top - 4 + 0.001);
      }
    }
  });

  it("clamps a long list to a scrollable height instead of overflowing", () => {
    const p = computePlacement({ ...VIEW, trigger: trigger(100), listHeight: 900 });
    expect(p.maxHeight).toBeLessThanOrEqual(264);
    expect(p.maxHeight).toBeGreaterThanOrEqual(96);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(800);
  });

  it("keeps a floor of 96px so a squeezed list is still usable", () => {
    const p = computePlacement({
      viewportHeight: 120,
      viewportWidth: 1280,
      trigger: trigger(40),
      listHeight: 264,
    });
    expect(p.maxHeight).toBe(96);
  });

  it("matches the trigger width and clamps horizontally on both sides", () => {
    const wide = computePlacement({ ...VIEW, trigger: trigger(100), listHeight: 100 });
    expect(wide.minWidth).toBe(558);
    expect(wide.left).toBe(200);

    // A trigger hanging off the right edge must be pulled back inside.
    const right = computePlacement({
      ...VIEW,
      trigger: trigger(100, 1200, 558),
      listHeight: 100,
    });
    expect(right.left).toBe(1280 - 558 - 8);

    // ...and one starting left of the margin pushed in.
    const left = computePlacement({ ...VIEW, trigger: trigger(100, -30, 558), listHeight: 100 });
    expect(left.left).toBe(8);
  });
});

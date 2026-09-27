import { describe, expect, it } from "vitest";
import { isDuckCookieDomain } from "./duckai-driver";
import { cookieNames } from "./bridge-watcher";

/**
 * The duck.ai cookie set is read out of the browser's own jar over CDP, so two
 * details decide whether the scan returns a session or nothing: which domains
 * count as duck.ai's, and the fact that a real jar stores the same cookie both
 * as "duck.ai" and as ".duck.ai".
 *
 * The failure mode this pins is silent — a filter that only accepts the
 * dot-prefixed spelling harvests zero cookies, and the app then looks like the
 * duck.ai session expired instead of like the filter is wrong.
 */
describe("isDuckCookieDomain", () => {
  it("accepts both spellings of the same host", () => {
    expect(isDuckCookieDomain("duck.ai")).toBe(true);
    expect(isDuckCookieDomain(".duck.ai")).toBe(true);
    expect(isDuckCookieDomain("chat.duck.ai")).toBe(true);
    expect(isDuckCookieDomain(".duckduckgo.com")).toBe(true);
  });

  it("rejects lookalike hosts", () => {
    // The session cookies are forwarded to DuckDuckGo's API only; a suffix test
    // without the dot would hand them to any domain ending in the same text.
    expect(isDuckCookieDomain("notduck.ai")).toBe(false);
    expect(isDuckCookieDomain("evil-duckduckgo.com")).toBe(false);
    expect(isDuckCookieDomain("google.com")).toBe(false);
    expect(isDuckCookieDomain("")).toBe(false);
  });
});

/** Names only: the panel shows what was received without rendering secrets. */
describe("cookieNames", () => {
  it("lists names and never values", () => {
    expect(cookieNames("b=secret; a=1;  c=")).toEqual(["a", "b", "c"]);
  });

  it("returns nothing for an empty header", () => {
    expect(cookieNames("")).toEqual([]);
    expect(cookieNames("  ;  ")).toEqual([]);
  });
});

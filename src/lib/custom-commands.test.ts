import { describe, expect, it } from "vitest";
import { fillCommandTemplate } from "./custom-commands";

/**
 * The same renderer serves project commands and installed plugin commands, so
 * every argument form a marketplace `.md` can contain has to resolve — an
 * unfilled `${ARGUMENTS:-.}` would reach the agent as literal shell text.
 */
describe("fillCommandTemplate", () => {
  it("fills the bare and braced argument forms", () => {
    expect(fillCommandTemplate("commit $ARGUMENTS now", "fix auth")).toBe("commit fix auth now");
    expect(fillCommandTemplate("scan ${ARGUMENTS}", "src/")).toBe("scan src/");
  });

  it("uses the default only when no arguments were typed", () => {
    expect(fillCommandTemplate("scan ${ARGUMENTS:-.}", "")).toBe("scan .");
    expect(fillCommandTemplate("scan ${ARGUMENTS:-.}", "payload")).toBe("scan payload");
    expect(fillCommandTemplate("scan ${ARGUMENTS:-$PWD/src}", "")).toBe("scan $PWD/src");
  });

  it("keeps positional arguments working", () => {
    expect(fillCommandTemplate("$1 into $2", "a b")).toBe("a into b");
  });
});

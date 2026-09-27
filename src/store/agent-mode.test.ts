import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "./index";

/**
 * The composer's run menu merges the agent mode (Build/Plan) with Full access
 * into one control. It drives mode through `setAgentMode`, which previously had
 * no caller in the composer — only the Tab shortcut's `toggleAgentMode` did. So
 * the "mode survives a reload" contract needs locking down: the menu would look
 * right while silently failing to persist.
 */
beforeEach(() => {
  useStore.setState({
    agentMode: "build",
    settings: { ...useStore.getState().settings, agentMode: "build" },
  });
});

describe("agent mode", () => {
  it("defaults to build", () => {
    expect(useStore.getState().agentMode).toBe("build");
  });

  it("setAgentMode updates the live mode and the persisted setting together", () => {
    useStore.getState().setAgentMode("plan");

    expect(useStore.getState().agentMode).toBe("plan");
    // The setting is what gets written to localStorage, so it must not drift
    // from the live value — otherwise the menu resets on the next launch.
    expect(useStore.getState().settings.agentMode).toBe("plan");
  });

  it("toggleAgentMode flips both ways", () => {
    useStore.getState().toggleAgentMode();
    expect(useStore.getState().agentMode).toBe("plan");
    expect(useStore.getState().settings.agentMode).toBe("plan");

    useStore.getState().toggleAgentMode();
    expect(useStore.getState().agentMode).toBe("build");
    expect(useStore.getState().settings.agentMode).toBe("build");
  });

  it("selecting the mode already in effect is a no-op, not a toggle", () => {
    // The merged menu uses setAgentMode (not toggle), so clicking the checked
    // row must leave the mode alone rather than flipping to the other one.
    useStore.getState().setAgentMode("build");
    expect(useStore.getState().agentMode).toBe("build");

    useStore.getState().setAgentMode("plan");
    useStore.getState().setAgentMode("plan");
    expect(useStore.getState().agentMode).toBe("plan");
  });
});

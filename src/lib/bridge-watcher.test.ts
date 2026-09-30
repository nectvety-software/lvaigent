// Tests for the parked-send recovery: a duck.ai send that neither the direct
// PoW transport nor the bridge could carry is kept by the watcher and resent
// once the bridge answers, without the user retyping it.
//
// The gate is the driver, not the captcha: "no challenge on screen" is also
// what the probe answers when there is no page to ask, so the retry must not
// fire just because the captcha poll came back negative.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./duckai", () => ({
  ensureVqdHash: async () => "test-hash",
  generateDurableStream: async () => ({ messageId: "m", conversationId: "c", publicKey: "p" }),
  getFeSignals: () => ({}),
  invalidateVqdHash: () => {},
  getCachedVqdInfo: () => null,
}));

/** The bridge, as the watcher sees it: either attachable or not. */
let bridgeUp = false;
/** How many re-attach attempts the watcher made — probing reloads duck.ai. */
let driverProbes = 0;
vi.mock("./duckai-driver", () => ({
  getDriver: async () => {
    driverProbes++;
    return bridgeUp ? { healthy: true } : null;
  },
}));

import {
  flushParkedRetry,
  getBridgeWatcherStatus,
  setPendingSendRetry,
  stopBridgeWatcherForTests
} from "./bridge-watcher";
import { useStore } from "../store";
import type { Conversation } from "../types";

function seedConv(messages: Conversation["messages"]): void {
  useStore.setState({
    providers: [],
    conversations: [
      {
        id: "c1",
        title: "t",
        messages,
        model: "claude-haiku-4-5",
        createdAt: 1,
        updatedAt: 1,
        workspacePath: "D:\\proj",
      },
    ],
    activeConversationId: "c1",
    settings: { ...useStore.getState().settings, duckaiCookies: "" },
  });
}

/** Record the resend without running the transport. */
function spySend(): (string | undefined)[][] {
  const calls: (string | undefined)[][] = [];
  useStore.setState({
    sendDuckChat: (async (
      conversationId: string,
      content: string,
      forceLegacy?: boolean,
      opts?: { preferBridge?: boolean }
    ) => {
      calls.push([conversationId, content, String(forceLegacy), String(opts?.preferBridge)]);
    }) as never,
  });
  return calls;
}

describe("the parked 418 send is resent when the bridge answers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    stopBridgeWatcherForTests();
    bridgeUp = false;
    driverProbes = 0;
    vi.useRealTimers();
  });

  it("enters through the bridge path so the user turn is not added twice", async () => {
    seedConv([
      { id: "u1", role: "user", content: "Trả lời đúng một từ: ok", timestamp: 1 },
      { id: "a1", role: "assistant", content: "⚠️ Bridge chưa sẵn sàng", timestamp: 1 },
    ]);
    const calls = spySend();
    setPendingSendRetry("c1", "Trả lời đúng một từ: ok");
    expect(getBridgeWatcherStatus().willRetry).toBe(true);

    bridgeUp = true;
    await flushParkedRetry("bridge");

    expect(calls).toEqual([["c1", "Trả lời đúng một từ: ok", "false", "true"]]);
    expect(
      getBridgeWatcherStatus().willRetry,
      "the retry fired twice — the park was not cleared"
    ).toBe(false);
  });

  it("waits while the bridge is still unreachable", async () => {
    seedConv([{ id: "u1", role: "user", content: "tin nhắn", timestamp: 1 }]);
    const calls = spySend();
    setPendingSendRetry("c1", "tin nhắn");

    await flushParkedRetry("bridge");

    expect(calls).toEqual([]);
    expect(getBridgeWatcherStatus().willRetry).toBe(true);
  });

  it("does not interrupt a run the user started in the meantime", async () => {
    seedConv([
      {
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 1,
        isStreaming: true,
      },
    ]);
    const calls = spySend();
    setPendingSendRetry("c1", "tin nhắn");
    bridgeUp = true;

    await flushParkedRetry("bridge");

    expect(calls, "a parked send must not cut off the reply on screen").toEqual([]);
    expect(getBridgeWatcherStatus().willRetry).toBe(true);
  });

  it("does not re-probe the bridge on every poll while a send is parked", async () => {
    seedConv([{ id: "u1", role: "user", content: "tin nhắn", timestamp: 1 }]);
    const calls = spySend();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    setPendingSendRetry("c1", "tin nhắn");

    // Each failed probe re-navigates the parked webview, so three polls in a
    // row may only cost one attach attempt — otherwise duck.ai never finishes
    // booting and the send is parked forever.
    await flushParkedRetry("bridge");
    await flushParkedRetry("bridge");
    await flushParkedRetry("bridge");
    expect(driverProbes).toBe(1);
    expect(calls).toEqual([]);

    vi.setSystemTime(new Date("2026-09-30T10:00:20Z"));
    bridgeUp = true;
    await flushParkedRetry("bridge");
    expect(driverProbes).toBe(2);
    expect(calls).toEqual([["c1", "tin nhắn", "false", "true"]]);
  });

  it("drops a park that has gone stale instead of resending an old turn", async () => {
    seedConv([{ id: "u1", role: "user", content: "tin nhắn", timestamp: 1 }]);
    const calls = spySend();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    setPendingSendRetry("c1", "tin nhắn");
    // Past the retry window: the conversation has moved on.
    vi.setSystemTime(new Date("2026-09-30T10:11:00Z"));
    bridgeUp = true;

    await flushParkedRetry("bridge");

    expect(calls).toEqual([]);
    expect(getBridgeWatcherStatus().willRetry).toBe(false);
  });
});

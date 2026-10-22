import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The free model lane is posted from Rust, not from the webview.
 *
 * The gateway matches a client fingerprint whose User-Agent must be the
 * official client's string ALONE — a browser `fetch` can neither set that
 * header nor reach the lane at all — so the transport is the Rust command
 * `free_model_chat`, and this file pins the contract the frontend has with
 * it: the command name, the argument shape, the session seed that pins one
 * conversation to one upstream session, and the deltas that come back.
 */

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
    // The Rust side pushes deltas through this handle; the test fires them.
    emit(payload: unknown) {
      this.onmessage?.(payload);
    }
  },
}));

import { fetchApiModels, streamApiChat } from "./api-chat";
import type { Provider } from "../types";

const freeProvider: Provider = {
  id: "provider_free",
  name: "Our Free Model",
  baseUrl: "https://opencode.ai/inference/v1",
  apiKey: "public",
  apiFormat: "free",
  models: [],
  status: "unknown",
};

const messages = [
  { role: "system" as const, content: "sys prompt" },
  { role: "user" as const, content: "hi" },
  { role: "tool" as const, content: "result-1" },
];

beforeEach(() => {
  invokeMock.mockReset();
});

describe("the free lane transport", () => {
  it("posts through the Rust command, not through fetch", async () => {
    let channel: { emit: (p: unknown) => void } | null = null;
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd !== "free_model_chat") throw new Error(`unexpected command ${cmd}`);
      channel = args.onEvent;
      // The Rust side resolves when the stream ends.
      args.onEvent.emit({ event: "delta", data: { text: "free " } });
      args.onEvent.emit({ event: "delta", data: { text: "answer" } });
      return undefined;
    });

    const partials: string[] = [];
    const out = await streamApiChat(freeProvider, {
      model: "deepseek-v4.1-flash-free",
      messages,
      session: "conv-1",
      onProgress: (p) => partials.push(p),
    });

    expect(out).toBe("free answer");
    expect(partials).toEqual(["free ", "free answer"]);
    const call = invokeMock.mock.calls.find((c) => c[0] === "free_model_chat");
    expect(call, "the free lane never reached the backend").toBeTruthy();
    const args = call![1] as any;
    expect(args.model).toBe("deepseek-v4.1-flash-free");
    // The session seed is what pins the conversation to one upstream session.
    expect(args.sessionSeed).toBe("conv-1");
    // The tool feedback travels as plain text, so it is a `tool` role here
    // and the Rust side folds it into a user turn.
    expect(args.messages).toEqual(messages);
  });

  it("lets the backend's refusal reach the user", async () => {
    invokeMock.mockRejectedValue(
      "gateway từ chối client fingerprint của lvaigent trên làn miễn phí (403)"
    );
    await expect(
      streamApiChat(freeProvider, { model: "m", messages, session: "conv-1" })
    ).rejects.toThrow(/fingerprint/);
  });

  it("asks Rust for the model list, so the fingerprint is sent with it", async () => {
    invokeMock.mockResolvedValue([
      { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash", supportsImage: true },
    ]);
    const models = await fetchApiModels(freeProvider);
    expect(models).toEqual([{ id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash" }]);
    expect(invokeMock).toHaveBeenCalledWith("free_model_models");
  });
});

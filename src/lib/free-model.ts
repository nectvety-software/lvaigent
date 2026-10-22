// The keyless free model lane (OpenCode Zen gateway).
//
// The request cannot go through the webview's `fetch`: the gateway matches
// the client fingerprint, and the User-Agent it accepts is the official
// client's string ALONE — any prefix or suffix stops it from being "a v2
// client" and the gateway answers 403. A browser `fetch` also cannot set
// User-Agent at all. So the turn is posted from Rust, which owns the exact
// headers, and the deltas come back over a channel.
//
// Everything else about the lane is ordinary: no account, no API key, no
// local service. The pooled credential is the literal string `public`.

import { invoke, Channel } from "@tauri-apps/api/core";
import type { ApiChatMessage, ApiStreamOptions } from "./api-chat";
import type { Provider } from "../types";

/** One streamed event from the Rust side. */
export interface FreeEvent {
  event: "delta" | "done";
  data?: { text?: string };
}

/** One model of the lane, as the Rust side reports it. */
export interface FreeModelInfo {
  id: string;
  name: string;
  supportsImage: boolean;
}

/**
 * Stream one reply from the free lane.
 *
 * The session seed pins the turn to one upstream session: the gateway
 * accounts the free quota per session, so a conversation must keep the same
 * id for its whole life. The seed is the conversation id, and the Rust side
 * derives the gateway's own session encoding from it.
 */
export async function streamFreeModel(
  provider: Provider,
  opts: ApiStreamOptions
): Promise<string> {
  const onEvent = new Channel<FreeEvent>();
  let acc = "";
  onEvent.onmessage = (ev) => {
    if (ev.event === "delta" && ev.data?.text) {
      acc += ev.data.text;
      opts.onProgress?.(acc);
    }
  };
  await invoke("free_model_chat", {
    model: opts.model,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    sessionSeed: opts.session ?? null,
    maxTokens: null,
    onEvent,
  });
  return acc;
}

/** The models the lane serves right now. */
export async function fetchFreeModels(): Promise<FreeModelInfo[]> {
  return invoke<FreeModelInfo[]>("free_model_models");
}

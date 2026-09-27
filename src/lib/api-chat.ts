// Standard API transport: OpenAI-compatible and Anthropic chat streaming.
//
// Replaces the duck.ai bridge for users who bring their own API key. The
// agent loop (tool blocks, steps, feedback) is unchanged; only the wire
// protocol differs.

import type { Provider } from "../types";

export interface ApiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ApiStreamOptions {
  model: string;
  messages: ApiChatMessage[];
  signal?: AbortSignal;
  onProgress?: (partial: string) => void;
}

/** Map our roles to Anthropic's schema (tool -> user with a prefix). */
function toAnthropicMessages(messages: ApiChatMessage[]) {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  let system = "";
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else if (m.role === "tool") {
      out.push({ role: "user", content: `[tool_result] ${m.content}` });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return { system, messages: out };
}

async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

/** Stream one assistant reply from an OpenAI-compatible /chat/completions API. */
async function streamOpenAiCompatible(
  provider: Provider,
  opts: ApiStreamOptions
): Promise<string> {
  // The agent's tool feedback is plain text, so it can't carry the
  // tool_call_id that OpenAI's strict `tool` role demands (400 without it).
  // Map it to a user message like the other two transports do.
  const messages = opts.messages.map((m) =>
    m.role === "tool" ? { role: "user" as const, content: `[tool_result] ${m.content}` } : m
  );
  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...(provider.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }
  let acc = "";
  for await (const payload of sseLines(res)) {
    if (!payload || payload === "[DONE]") continue;
    try {
      const o = JSON.parse(payload);
      const delta = o?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        acc += delta;
        opts.onProgress?.(acc);
      }
    } catch {
      /* skip malformed keepalive lines */
    }
  }
  return acc;
}

/** Stream one assistant reply from an Anthropic /v1/messages API. */
async function streamAnthropic(
  provider: Provider,
  opts: ApiStreamOptions
): Promise<string> {
  const { system, messages } = toAnthropicMessages(opts.messages);
  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(provider.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: opts.model,
      system: system || undefined,
      messages,
      stream: true,
      max_tokens: 8192,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }
  let acc = "";
  for await (const payload of sseLines(res)) {
    if (!payload) continue;
    try {
      const o = JSON.parse(payload);
      if (o?.type === "content_block_delta" && o?.delta?.text) {
        acc += o.delta.text;
        opts.onProgress?.(acc);
      } else if (o?.type === "error") {
        throw new Error(o?.error?.message ?? "anthropic stream error");
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }
  return acc;
}

/** Stream one assistant reply from an OpenAI /v1/responses API. */
async function streamOpenAiResponses(
  provider: Provider,
  opts: ApiStreamOptions
): Promise<string> {
  let instructions = "";
  const input: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of opts.messages) {
    if (m.role === "system") {
      instructions = instructions ? `${instructions}\n\n${m.content}` : m.content;
    } else if (m.role === "tool") {
      input.push({ role: "user", content: `[tool_result] ${m.content}` });
    } else {
      input.push({ role: m.role, content: m.content });
    }
  }
  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...(provider.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: opts.model,
      instructions: instructions || undefined,
      input,
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }
  let acc = "";
  for await (const payload of sseLines(res)) {
    if (!payload || payload === "[DONE]") continue;
    try {
      const o = JSON.parse(payload);
      if (o?.type === "response.output_text.delta" && typeof o.delta === "string") {
        acc += o.delta;
        opts.onProgress?.(acc);
      } else if (o?.type === "error") {
        throw new Error(o?.message ?? o?.error?.message ?? "responses stream error");
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }
  return acc;
}

/** Stream a reply from whatever API format the provider uses. */
export async function streamApiChat(
  provider: Provider,
  opts: ApiStreamOptions
): Promise<string> {
  if (provider.apiFormat === "anthropic") return streamAnthropic(provider, opts);
  if (provider.apiFormat === "responses") return streamOpenAiResponses(provider, opts);
  return streamOpenAiCompatible(provider, opts);
}

/**
 * End-to-end provider check: one minimal chat turn through the provider's real
 * wire protocol. /models reachability is NOT proof the key can generate, so
 * this is what Settings → Test runs. Rejects after `timeoutMs`.
 */
export async function pingProviderApi(
  provider: Provider,
  model: string,
  timeoutMs = 20000
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const reply = await streamApiChat(provider, {
      model,
      messages: [{ role: "user", content: "Trả lời đúng một từ: OK" }],
      signal: ctrl.signal,
    });
    if (!reply.trim()) throw new Error("model trả về nội dung rỗng");
    return reply.trim();
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`hết thời gian chờ (${timeoutMs / 1000}s)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the model list for a provider (OpenAI /models, best-effort). */
export async function fetchApiModels(provider: Provider): Promise<{ id: string; name: string }[]> {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    ...(provider.extraHeaders ?? {}),
  };
  if (provider.apiFormat === "anthropic") {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    delete headers.Authorization;
  }
  const res = await fetch(`${base}/models`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  const list: { id: string; name: string }[] = data?.data ?? data?.models ?? [];
  return list
    .map((m) => ({ id: typeof m === "string" ? m : m.id, name: typeof m === "string" ? m : (m.name ?? m.id) }))
    .filter((m) => m.id);
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchApiModels, pingProviderApi, streamApiChat } from "./api-chat";
import type { Provider } from "../types";

/**
 * Exercises all three wire formats against real sockets: an in-process HTTP
 * server speaks the actual SSE shapes of /chat/completions, /responses and
 * /messages, so the stream parsers are tested without an API key.
 */

let server: http.Server;
let base = "";
const received: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];

function sse(res: http.ServerResponse, events: string[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const e of events) res.write(`data: ${e}\n\n`);
  res.end();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      received.push({ path: req.url!, headers: req.headers, body });
      if (req.url === "/slow/chat/completions") {
        return; // never answers — exercises the ping timeout
      } else if (req.url === "/o/models" || req.url === "/r/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m1", name: "Model One" }] }));
      } else if (req.url === "/o/chat/completions") {
        sse(res, [
          JSON.stringify({ choices: [{ delta: { content: "hello " } }] }),
          JSON.stringify({ choices: [{ delta: { content: "world" } }] }),
          "[DONE]",
        ]);
      } else if (req.url === "/r/responses") {
        sse(res, [
          JSON.stringify({ type: "response.created", response: { id: "r1" } }),
          JSON.stringify({ type: "response.output_text.delta", delta: "resp-" }),
          JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
          JSON.stringify({ type: "response.completed" }),
        ]);
      } else if (req.url === "/a/messages") {
        sse(res, [
          JSON.stringify({ type: "content_block_delta", delta: { text: "anth-" } }),
          JSON.stringify({ type: "content_block_delta", delta: { text: "ok" } }),
        ]);
      } else {
        res.writeHead(404).end("no route");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function provider(apiFormat: Provider["apiFormat"], path: string): Provider {
  return {
    id: "p1",
    name: "test",
    baseUrl: base + path,
    apiKey: "k-123",
    apiFormat,
    models: [],
    status: "unknown",
    extraHeaders: { "x-custom": "yes" },
  };
}

const messages: any[] = [
  { role: "system", content: "sys prompt" },
  { role: "user", content: "hi" },
  { role: "tool", content: "result-1" },
];

describe("streamApiChat over real HTTP", () => {
  it("openai chat/completions streams deltas and sends auth + extra headers", async () => {
    let partial = "";
    const out = await streamApiChat(provider("openai", "/o"), {
      model: "m1",
      messages,
      onProgress: (p) => (partial = p),
    });
    expect(out).toBe("hello world");
    expect(partial).toBe("hello world");
    const req = received.find((r) => r.path === "/o/chat/completions")!;
    expect(req.headers.authorization).toBe("Bearer k-123");
    expect(req.headers["x-custom"]).toBe("yes");
    expect(req.body.stream).toBe(true);
    // OpenAI rejects role:"tool" without tool_call_id — must be folded to user.
    expect(req.body.messages.every((m: any) => m.role !== "tool")).toBe(true);
    expect(req.body.messages.some((m: any) => m.role === "user" && m.content === "[tool_result] result-1")).toBe(true);
  });

  it("openai responses maps system→instructions, tool→user input", async () => {
    const out = await streamApiChat(provider("responses", "/r"), {
      model: "m1",
      messages,
    });
    expect(out).toBe("resp-ok");
    const req = received.find((r) => r.path === "/r/responses")!;
    expect(req.body.instructions).toBe("sys prompt");
    expect(req.body.input).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "[tool_result] result-1" },
    ]);
    expect(req.headers.authorization).toBe("Bearer k-123");
  });

  it("anthropic messages uses x-api-key headers and content_block_delta", async () => {
    const out = await streamApiChat(provider("anthropic", "/a"), {
      model: "m1",
      messages,
    });
    expect(out).toBe("anth-ok");
    const req = received.find((r) => r.path === "/a/messages")!;
    expect(req.headers["x-api-key"]).toBe("k-123");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["x-custom"]).toBe("yes");
    expect(req.body.system).toBe("sys prompt");
  });

  it("fetchApiModels lists models and carries extra headers", async () => {
    const models = await fetchApiModels(provider("openai", "/o"));
    expect(models).toEqual([{ id: "m1", name: "Model One" }]);
    const req = received.find((r) => r.path === "/o/models")!;
    expect(req.headers["x-custom"]).toBe("yes");
  });
});

describe("pingProviderApi", () => {
  it("runs one real chat turn and returns the trimmed reply", async () => {
    const reply = await pingProviderApi(provider("openai", "/o"), "m1");
    expect(reply).toBe("hello world");
  });

  it("rejects with a timeout message when the server never responds", async () => {
    // /slow/chat/completions is routed by the mock server but never answered.
    const p2 = { ...provider("openai", "/slow"), apiKey: "k" };
    await expect(pingProviderApi(p2, "m1", 400)).rejects.toThrow(/hết thời gian chờ/);
  });
});

// Dev helper: call a Tauri command from the main window over CDP.
// Usage: node scripts/cdp-invoke.mjs <command> [jsonArgs]
const [cmd, argJson] = [process.argv[2], process.argv[3] ?? "{}"];
const LIST = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const main = LIST.find((t) => t.url?.includes("localhost:1420"));
if (!main) { console.log("no main target"); process.exit(1); }
const ws = new WebSocket(main.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const expr = `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(JSON.parse(argJson))}).then(r=>JSON.stringify(r)).catch(e=>JSON.stringify(String(e)))`;
const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout: 60000 });
if (r.exceptionDetails) console.log("EVAL_ERR:", r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
else console.log("RESULT:", r.result.value);
ws.close();
process.exit(0);

// Dev helper: inspect main window + bridge geometry over CDP (DuckChat).
const LIST = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const main = LIST.find((t) => t.url?.includes("localhost:1420"));
if (!main) { console.log("no main target", LIST.map(t=>t.url)); process.exit(1); }
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

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { ERR: r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails) };
  return r.result.value;
};

console.log("MAIN:", await evalJs(`JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,sw:screen.width,sh:screen.height,paneW:getComputedStyle(document.documentElement).getPropertyValue('--browser-pane-w')})`));
console.log("DIAG:", await evalJs(`window.__TAURI_INTERNALS__.invoke('bridge_diag').then(d=>JSON.stringify(d))`));
ws.close();
process.exit(0);

// Dev helper: run a JS expression in the main window over CDP and print the
// JSON result. Usage: node scripts/cdp-eval.mjs "<expression>"
const expr = process.argv[2];
if (!expr) {
  console.log("usage: cdp-eval <expr>");
  process.exit(1);
}
const LIST = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const main = LIST.find((t) => t.url?.includes("localhost:1420"));
if (!main) {
  console.log("no main target");
  process.exit(1);
}
const ws = new WebSocket(main.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((res, rej) => {
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
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
const r = await send("Runtime.evaluate", {
  expression: `(async()=>{${expr}})()`,
  returnByValue: true,
  awaitPromise: true,
  timeout: 30000,
});
if (r.exceptionDetails)
  console.log(
    "EVAL_ERR:",
    r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)
  );
else console.log("RESULT:", JSON.stringify(r.result.value));
ws.close();
process.exit(0);

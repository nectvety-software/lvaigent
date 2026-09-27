// Drive a real pointer drag over the split handle in the MAIN window via CDP
// Input events, then report the resulting geometry. Usage:
//   node scripts/cdp-drag.mjs <startX> <startY> <endX> <endY>
const [sx, sy, ex, ey] = process.argv.slice(2).map(Number);
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const t = list.find((x) => x.url.includes("localhost:1420"));
if (!t) {
  console.log("NO_MAIN_TARGET");
  process.exit(1);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const mouse = (type, x, y, button) =>
  send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0,
    buttons: type === "mouseReleased" ? 0 : 1,
  });

await send("Runtime.enable");
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  return r.result?.result?.value;
};

console.log("BEFORE iw:", await evalJs("innerWidth"), "paneW:", await evalJs("localStorage.getItem('duckchat.browserPaneW')"));
await mouse("mousePressed", sx, sy, "left");
// Give the renderer time to process pointerdown (capture + listener attach)
// before the first move, matching real human input timing.
await new Promise((r) => setTimeout(r, 200));
const steps = 12;
for (let i = 1; i <= steps; i++) {
  await mouse("mouseMoved", sx + ((ex - sx) * i) / steps, sy + ((ey - sy) * i) / steps);
  await new Promise((r) => setTimeout(r, 120));
}
await mouse("mouseReleased", ex, ey, "left");
await new Promise((r) => setTimeout(r, 1200));
console.log("AFTER  iw:", await evalJs("innerWidth"), "paneW:", await evalJs("localStorage.getItem('duckchat.browserPaneW')"));
ws.close();

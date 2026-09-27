// Capture a screenshot of a CDP target (default: the duck.ai bridge page) to
// prove the pane renderer is alive and showing content. Usage:
//   node scripts/cdp-shot.mjs [urlSubstring] [outPath]
import { writeFileSync } from "node:fs";

const sub = process.argv[2] || "duck.ai";
const out = process.argv[3] || "C:/Users/doxuanhop/AppData/Local/Temp/cdp-shot.png";

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const t = list.find((x) => x.url.includes(sub));
if (!t) {
  console.log("NO_TARGET matching", sub, "have:", list.map((x) => x.url));
  process.exit(1);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
const id = Math.floor(Math.random() * 1e9);
ws.send(
  JSON.stringify({ id, method: "Page.captureScreenshot", params: { format: "png" } })
);
const data = await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error("timeout")), 15000);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === id) {
      clearTimeout(to);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result.data);
    }
  };
});
writeFileSync(out, Buffer.from(data, "base64"));
console.log("SAVED", out, "target:", t.url, "bytes:", data.length);
ws.close();

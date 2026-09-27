// Dev helper: evaluate inside the duck.ai child target and screenshot it.
const LIST = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const t = LIST.find((x) => x.url?.includes("duck.ai"));
if (!t) { console.log("no duck.ai target", LIST.map(x=>x.url)); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m,p) => new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.onmessage = (ev)=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id); m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}};
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
const expr = process.argv[2] ?? "JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,ow:outerWidth,oh:outerHeight,title:document.title})";
const r = await send("Runtime.evaluate",{expression:`(function(){${expr}})()`,returnByValue:true,awaitPromise:true});
console.log("CHILD:", JSON.stringify(r.result?.value ?? r.exceptionDetails));
if (process.argv[3]) {
  const s = await send("Page.captureScreenshot",{format:"png"});
  const fs = await import("node:fs");
  fs.writeFileSync(process.argv[3], Buffer.from(s.data,"base64"));
  console.log("shot ->", process.argv[3]);
}
ws.close(); process.exit(0);

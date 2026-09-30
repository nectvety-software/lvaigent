// Duck.ai PoW challenge solver.
//
// The server hands out a base64 obfuscated async IIFE that probes the
// execution environment and returns {server_hashes, client_hashes, signals,
// meta}. `client_hashes` is [UA, <sum of browser-fidelity probes>, ...] and
// the backend re-computes what a genuine Chromium would have produced; any
// divergence is answered with 418 ERR_CHALLENGE.
//
// Algorithm:
//  1. decode base64 challenge -> JS expression.
//  2. eval it in a sandbox scope (stubs.js-equivalent DOM fakes) whose HTML
//     handling is pre-computed with the platform parser, then await the
//     promise.
//  3. OVERRIDE client_hashes[0] with the wire UA, then b64(sha256) each entry.
//  4. envelope JSON -> base64 -> X-Vqd-Hash-1.

const STUBS = `
var __ua = __DDG_REAL_UA__;
var __HTML_LOOKUP = __DDG_HTML_LOOKUP__ || {};

function __makeHtmlElement(tag) {
  var state = { _innerHTML: '', _qsaCount: 0, _cssText: '' };
  var styleObj = {};
  Object.defineProperty(styleObj, 'cssText', {
    get: function(){ return state._cssText; },
    set: function(v){ state._cssText = String(v||''); },
    enumerable: true, configurable: true
  });
  var el = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [], childNodes: [], classList: [],
    style: styleObj, dataset: {},
    offsetWidth: 100, offsetHeight: 20, scrollHeight: 20,
    offsetTop: 100, offsetLeft: 0, offsetParent: null,
    clientWidth: 100, clientHeight: 20,
    getBoundingClientRect: function(){
      return { width: 100, height: 20, top: 100, left: 0, right: 100, bottom: 120, x: 0, y: 100 };
    },
    getClientRects: function(){
      return [{ width: 100, height: 20, top: 100, left: 0, right: 100, bottom: 120 }];
    },
    setAttribute: function(){}, removeAttribute: function(){},
    getAttribute: function(a){ if(a==='srcdoc') return state._srcdoc||''; return null; },
    hasAttribute: function(){ return false; },
    appendChild: function(c){ return c; },
    removeChild: function(c){ return c; },
    addEventListener: function(){}, removeEventListener: function(){},
    querySelector: function(){ return null; },
    querySelectorAll: function(s){
      if (s === '*') { var arr = []; arr.length = state._qsaCount; return arr; }
      return [];
    },
    cloneNode: function(){ return __makeHtmlElement(tag); },
    _getState: function(){ return state; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function(){ return state._innerHTML; },
    set: function(v){
      var key = String(v);
      var entry = __HTML_LOOKUP[key];
      if (entry) { state._innerHTML = String(entry.html); state._qsaCount = entry.count|0; }
      else { state._innerHTML = key; state._qsaCount = 0; }
    },
    enumerable: true, configurable: true
  });
  Object.defineProperty(el, 'outerHTML', { get: function(){ return '<' + tag + '>' + state._innerHTML + '</' + tag + '>'; }, enumerable: true });
  Object.defineProperty(el, 'srcdoc', { get: function(){ return state._srcdoc||''; }, set: function(v){ state._srcdoc = String(v); }, enumerable: true });
  Object.defineProperty(el, 'contentWindow', { get: function(){
    var w = {};
    w.document = __ifDoc;
    w.Proxy = Proxy;
    w.self = w;
    w.top = w;
    w.parent = w;
    w.window = w;
    return w;
  }, enumerable: true });
  Object.defineProperty(el, 'contentDocument', { get: function(){ return __ifDoc; }, enumerable: true });
  return el;
}

function __mkObj(name, base) {
  base = base || {};
  return new Proxy(base, {
    get: function(t, k) {
      if (k in t) return t[k];
      if (k === Symbol.toPrimitive) return function(){ return ''; };
      if (k === Symbol.iterator) return undefined;
      if (k === 'then' || k === 'catch' || k === 'finally') return undefined;
      if (k === 'constructor') return Object;
      if (k === 'toString' || k === 'valueOf') return function(){ return '[object ' + name + ']'; };
      if (k === 'length') return 0;
      if (k === 'nodeType') return 1;
      if (k === 'tagName' || k === 'nodeName') return 'DIV';
      if (k === 'innerHTML' || k === 'outerHTML' || k === 'textContent' || k === 'innerText' || k === 'value') return '';
      if (k === 'children' || k === 'childNodes' || k === 'classList') return [];
      if (typeof k === 'string' && (k.indexOf('get') === 0 || k.indexOf('query') === 0 || k.indexOf('find') === 0)) {
        return function(arg){
          if (k === 'querySelectorAll' || k === 'getElementsByTagName' || k === 'getElementsByClassName') return [];
          return null;
        };
      }
      return function(){ return __mkObj(name + '.' + String(k)); };
    },
    has: function(t, k){ return k in t; },
    set: function(t, k, v){ t[k] = v; return true; }
  });
}

var __ifMeta = __mkObj('meta', {
  getAttribute: function(a){ return a==='content' ? "default-src 'none'; script-src 'unsafe-inline';" : null; },
  hasAttribute: function(a){ return a==='content'; },
  tagName: 'META', nodeName: 'META'
});
var __ifDoc;
__ifDoc = __mkObj('iframeDoc', {
  querySelector: function(s){
    if (s && s.indexOf('Content-Security-Policy') !== -1) return __ifMeta;
    if (s === 'meta') return __ifMeta;
    return null;
  },
  querySelectorAll: function(s){
    if (s && s.indexOf('Content-Security-Policy') !== -1) return [__ifMeta];
    if (s === 'meta') return [__ifMeta];
    return [];
  },
  getElementsByTagName: function(t){ return t && t.toLowerCase()==='meta' ? [__ifMeta] : []; },
  body: __mkObj('iframeBody', {
    querySelector: function(s){ return s && s.indexOf('Content-Security-Policy')!==-1 ? __ifMeta : null; },
    querySelectorAll: function(s){ return s && s.indexOf('Content-Security-Policy')!==-1 ? [__ifMeta] : []; },
    appendChild: function(){}, removeChild: function(){}
  }),
  head: __mkObj('iframeHead', {
    querySelector: function(s){ return s && s.indexOf('Content-Security-Policy')!==-1 ? __ifMeta : null; },
    querySelectorAll: function(s){ return s && s.indexOf('Content-Security-Policy')!==-1 ? [__ifMeta] : []; },
    appendChild: function(){}, removeChild: function(){}
  }),
  documentElement: __mkObj('iframeRoot'),
  createElement: function(){ return __mkObj('elem', {setAttribute:function(){}, appendChild:function(){}, removeChild:function(){}, getAttribute:function(){return null;}, hasAttribute:function(){return false;}}); },
  cookie: '', readyState: 'complete'
});

var __iframeEl = __mkObj('iframe', {
  contentDocument: __ifDoc,
  contentWindow: __mkObj('iframeWin', { document: __ifDoc, top: undefined, parent: undefined }),
  document: __ifDoc,
  getAttribute: function(a){
    if (a==='sandbox') return 'allow-scripts allow-same-origin';
    if (a==='srcdoc') return '';
    if (a==='id') return 'jsa';
    return null;
  },
  hasAttribute: function(a){ return a==='sandbox'||a==='id'; },
  tagName: 'IFRAME', nodeName: 'IFRAME', id: 'jsa'
});

var document = __mkObj('document', {
  querySelector: function(s){
    if (s === '#jsa') return __iframeEl;
    if (s && s.indexOf('Content-Security-Policy') !== -1) return __ifMeta;
    return null;
  },
  querySelectorAll: function(s){
    if (s === '#jsa') return [__iframeEl];
    if (s && s.indexOf('Content-Security-Policy') !== -1) return [__ifMeta];
    return [];
  },
  getElementById: function(id){ return id==='jsa' ? __iframeEl : null; },
  getElementsByTagName: function(t){ if(t&&t.toLowerCase()==='iframe') return [__iframeEl]; return []; },
  getElementsByClassName: function(){ return []; },
  body: __mkObj('body', {appendChild:function(){}, removeChild:function(){}, querySelector:function(s){return s==='#jsa'?__iframeEl:null;}, querySelectorAll:function(s){return s==='#jsa'?[__iframeEl]:[];}}),
  head: __mkObj('head', {appendChild:function(){}, removeChild:function(){}, querySelector:function(){return null;}, querySelectorAll:function(){return [];}}),
  documentElement: __mkObj('root'),
  createElement: function(tag){ return __makeHtmlElement(tag||'div'); },
  createTextNode: function(t){ return {nodeType:3, nodeValue:String(t||''), textContent:String(t||'')}; },
  cookie: '', readyState: 'complete', title: '',
  addEventListener: function(){}, removeEventListener: function(){}
});

var window;
window = __mkObj('window', {
  document: document,
  __DDG_BE_VERSION__: 1, __DDG_FE_CHAT_HASH__: 1,
  navigator: __mkObj('navigator', { userAgent: __ua, webdriver: false, language: 'en-US', languages: ['en-US','en'], platform: 'MacIntel', vendor: 'Apple Computer, Inc.', appVersion: '5.0', cookieEnabled: true, onLine: true, hardwareConcurrency: 8, deviceMemory: 8 }),
  innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 800, devicePixelRatio: 1,
  screen: __mkObj('screen', { width:1920, height:1080, availWidth:1920, availHeight:1080, colorDepth:24, pixelDepth:24 }),
  location: __mkObj('location', { href:'https://duckduckgo.com/', origin:'https://duckduckgo.com', host:'duckduckgo.com', hostname:'duckduckgo.com', protocol:'https:', pathname:'/', search:'', hash:'', port:'' }),
  performance: __mkObj('perf', { now: function(){ return 0; }, timeOrigin: 0 }),
  history: __mkObj('history', { length: 1, state: null }),
  localStorage: __mkObj('ls', { getItem:function(){return null;}, setItem:function(){}, removeItem:function(){}, clear:function(){}, length:0, key:function(){return null;} }),
  sessionStorage: __mkObj('ss', { getItem:function(){return null;}, setItem:function(){}, removeItem:function(){}, clear:function(){}, length:0, key:function(){return null;} }),
  addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;},
  getComputedStyle: function(el){
    var css = (el && el.style && el.style.cssText) || '';
    return {
      getPropertyValue: function(p){
        var m = css.match(new RegExp(p + '\\\\s*:\\\\s*([^;]+)', 'i'));
        if (m) return m[1].trim();
        if (p === 'display') return 'block';
        return '';
      },
      display: (css.match(/display\\s*:\\s*([^;]+)/i)||[])[1]||'block'
    };
  },
  setTimeout: function(fn){ try{fn();}catch(e){} return 0; }, clearTimeout: function(){},
  setInterval: function(){ return 0; }, clearInterval: function(){},
  requestAnimationFrame: function(fn){ try{fn();}catch(e){} return 0; }, cancelAnimationFrame: function(){},
  matchMedia: function(){ return __mkObj('mq', {matches:false, media:'', addListener:function(){}, removeListener:function(){}, addEventListener:function(){}, removeEventListener:function(){}}); },
  hasOwnProperty: function(k){
    if (k==='__DDG_BE_VERSION__'||k==='__DDG_FE_CHAT_HASH__') return true;
    return Object.prototype.hasOwnProperty.call(this,k);
  },
  alert: function(){}, confirm: function(){return true;}, prompt: function(){return '';},
  open: function(){return null;}, close: function(){}, focus: function(){}, blur: function(){}
});
window.top = window; window.self = window; window.window = window; window.parent = window; window.globalThis = window;
var top = window, self = window, parent = window;
var navigator = window.navigator;
var location = window.location;
var screen = window.screen;
var performance = window.performance;
var history = window.history;
var localStorage = window.localStorage;
var sessionStorage = window.sessionStorage;
var getComputedStyle = function(el){ return window.getComputedStyle(el); };
var __R = null, __E = null;
function __HTMLClass(name){ var c = function(){}; c.prototype = __mkObj(name+'.proto'); return c; }
var HTMLElement = __HTMLClass('HTMLElement');
var HTMLDivElement = __HTMLClass('HTMLDivElement');
var HTMLIFrameElement = __HTMLClass('HTMLIFrameElement');
var HTMLDocument = __HTMLClass('HTMLDocument');
var Document = __HTMLClass('Document');
var Element = __HTMLClass('Element');
var Node = __HTMLClass('Node');
var Window = __HTMLClass('Window');
var Event = __HTMLClass('Event');
var MouseEvent = __HTMLClass('MouseEvent');
var KeyboardEvent = __HTMLClass('KeyboardEvent');
var TouchEvent = __HTMLClass('TouchEvent');
var XMLHttpRequest = __HTMLClass('XMLHttpRequest');
var WebSocket = __HTMLClass('WebSocket');
var Image = __HTMLClass('Image');
var FormData = __HTMLClass('FormData');
var Blob = __HTMLClass('Blob');
var File = __HTMLClass('File');
var FileReader = __HTMLClass('FileReader');
var URL = __HTMLClass('URL');
var URLSearchParams = __HTMLClass('URLSearchParams');
var Headers = __HTMLClass('Headers');
var Request = __HTMLClass('Request');
var Response = __HTMLClass('Response');
var fetch = function(){ return Promise.resolve(__mkObj('resp', {ok:true, status:200, json:function(){return Promise.resolve({});}, text:function(){return Promise.resolve('');}})); };
`.trim();

/**
 * Run the challenge expression inside a sandboxed scope whose globals are the
 * DOM stubs. We use a plain (non-indirect) eval inside an arrow function body,
 * so the stubs' `var` declarations are local to that body and never touch the
 * WebView's real `window`/`document`. The challenge typically resolves a
 * Promise; resolve/keep it via __R and then return the object.
 */
function evaluateSandbox(src: string, ua: string, htmlLookup: Record<string, { html: string; count: number }>): Promise<unknown> {
  const stubs = STUBS
    .replace("__DDG_REAL_UA__", JSON.stringify(ua))
    .replace("__DDG_HTML_LOOKUP__", JSON.stringify(htmlLookup));
  const body = `${stubs}\n;var __SRC_RET=Promise.resolve().then(function(){ return (${src}); });`;
  return new Promise((resolve, reject) => {
    const fn = new Function(
      "__DDG_RESOLVE__",
      "__DDG_REJECT__",
      `${body}
       __SRC_RET.then(function(v){ __DDG_RESOLVE__(v); }, function(e){ __DDG_REJECT__(String((e&&e.stack)||e)); });`
    ) as (a: (v: unknown) => void, b: (e: string) => void) => void;
    fn(resolve, reject);
  });
}

/**
 * Run the challenge inside a fresh same-origin iframe realm and return its
 * result. This is the preferred path: the app ships in a Chromium WebView, so
 * a real realm answers every v:4 probe (native `toString`, `[object Window]`,
 * `this === window`, `NodeList`, the DOM prototype chain, layout boxes)
 * exactly as genuine Chrome does — which is what the backend recomputes.
 *
 * The realm's own UA is irrelevant: `client_hashes[0]` is overridden with the
 * wire UA before hashing.
 */
function evaluateInRealm(src: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined" || !document.body) {
      reject(new Error("no DOM realm available"));
      return;
    }
    const frame = document.createElement("iframe");
    frame.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;";
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      frame.remove();
    };
    document.body.appendChild(frame);
    const win = frame.contentWindow as (Window & { eval?: (code: string) => unknown }) | null;
    if (!win || typeof win.eval !== "function") {
      cleanup();
      reject(new Error("iframe realm is not evaluable"));
      return;
    }
    try {
      // The challenge is an async IIFE expression; eval inside the realm makes
      // every global it touches (window, document, navigator) the realm's own.
      Promise.resolve(win.eval(`(${src})`)).then(
        (v) => {
          cleanup();
          resolve(v);
        },
        (e) => {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      );
    } catch (e) {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Pull quoted HTML-ish strings out of the challenge JS, like p2d. */
function extractHtmlInputs(js: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(["'])(<[^"']{1,400}?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(js)) !== null) {
    const s = m[2];
    if (!seen.has(s)) {
      seen.add(s);
      found.push(s);
    }
  }
  return found;
}

/** Best-effort HTML normalisation using the platform DOM (html5lib equivalent). */
function normalizeHtml(s: string): { html: string; count: number } {
  try {
    const doc = new DOMParser().parseFromString(s, "text/html");
    const body = doc.body;
    // The challenge asks the *element* it just assigned this HTML to for
    // `querySelectorAll('*').length` — that is every descendant, not the top
    // level children. `<div><div></div><div></div` normalises to one child but
    // three descendants; counting children made every HTML probe come out
    // short and the backend answered 418 ERR_CHALLENGE.
    const count = body.querySelectorAll("*").length;
    return { html: body.innerHTML, count };
  } catch {
    return { html: s, count: 0 };
  }
}

function buildHtmlLookup(js: string): Record<string, { html: string; count: number }> {
  const lookup: Record<string, { html: string; count: number }> = {};
  for (const s of extractHtmlInputs(js)) {
    const { html, count } = normalizeHtml(s);
    lookup[s] = { html, count };
  }
  return lookup;
}

function b64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function sha256B64(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export interface SolvedChallenge {
  hash: string;
  signals: Record<string, unknown>;
}

/**
 * Solve the challenge and return the X-Vqd-Hash-1 value plus the challenge's
 * internal signals (kept inside the envelope). Mirrors p2d: client_hashes[0]
 * is OVERRIDDEN with the wire UA before hashing.
 */
export async function solveChallenge(
  challengeB64: string,
  userAgent: string
): Promise<SolvedChallenge> {
  if (!challengeB64) throw new Error("empty challenge");
  const started = Date.now();
  const src = b64ToUtf8(challengeB64);
  const htmlLookup = buildHtmlLookup(src);

  let obj: Record<string, unknown>;
  try {
    let v: unknown;
    try {
      v = await evaluateInRealm(src);
    } catch {
      // No evaluable realm (locked-down CSP / headless test runner): the stub
      // scope is still better than not answering at all.
      v = await evaluateSandbox(src, userAgent, htmlLookup);
    }
    const rec = v as Record<string, unknown>;
    if (!rec || typeof rec !== "object" || !Array.isArray(rec.client_hashes)) {
      throw new Error("challenge did not return {client_hashes}");
    }
    obj = rec;
  } catch (e) {
    // Server still accepts error envelopes in place of a solved hash.
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack ?? "" : "";
    const orig = challengeB64;
    const env = utf8ToB64([orig, msg, stack, "https://duck.ai"].join("::"));
    return { hash: env, signals: {} };
  }

  const hashes = obj.client_hashes as unknown[];
  if (hashes.length === 0) {
    const msg = "challenge returned empty client_hashes";
    const stack = "";
    const orig = challengeB64;
    const env = utf8ToB64([orig, msg, stack, "https://duck.ai"].join("::"));
    return { hash: env, signals: {} };
  }
  // p2d: client_hashes[0] is replaced with the wire UA, then all are hashed.
  hashes[0] = userAgent;
  const hashed: unknown[] = [];
  for (const item of hashes) {
    if (typeof item === "string") hashed.push(await sha256B64(item));
    else hashed.push(item);
  }

  const envelope = {
    server_hashes: obj.server_hashes ?? [],
    client_hashes: hashed,
    signals: obj.signals ?? {},
    meta: {
      ...((obj.meta as Record<string, unknown>) ?? {}),
      origin: "https://duck.ai",
      duration: String(Date.now() - started),
    },
  };
  return {
    hash: utf8ToB64(JSON.stringify(envelope)),
    signals: (obj.signals as Record<string, unknown>) ?? {},
  };
}

/**
 * `x-fe-signals` request header value. Replicates p2d's make_fe_signals(): a
 * plausible base64 JSON telemetry blob of fake UI events (the server accepts
 * this; a manual DevTools hash has no companion signals so we fall back to
 * the challenge's own signals, else an empty object).
 */
export function makeFeSignals(): string {
  const rand = (min: number, max: number) =>
    Math.floor(Math.random() * (max - min + 1)) + min;
  const now = Date.now();
  const durationMs = 3000;
  const startMs = now - durationMs;
  const events: { name: string; delta: number }[] = [];
  let t = rand(80, 180);
  events.push({ name: "onboarding_impression_1", delta: t });
  t += rand(120, 260);
  events.push({ name: "onboarding_impression_2", delta: t });
  t += rand(200, 500);
  events.push({ name: "startNewChat", delta: t });
  const nKeys = rand(6, 18);
  for (let i = 0; i < nKeys; i++) {
    t += rand(40, 180);
    events.push({ name: "user_input", delta: t });
  }
  t += rand(120, 350);
  events.push({ name: "user_submit", delta: t });
  const payload = {
    start: startMs,
    events,
    end: Math.max(t + rand(20, 90), durationMs),
  };
  return utf8ToB64(JSON.stringify(payload));
}

// Real-SPA transport: drives the genuine duck.ai page running in the embedded
// "duckai" child webview inside the main window over the Chrome DevTools
// Protocol.
//
// Why this exists: as of 2026-09 duck.ai's bot detection only accepts
// per-session token sets (x-vqd-hash-1 envelope + x-fe-signals +
// x-ddg-journey-id) minted by the real SPA inside a real browser session.
// Self-solved envelopes get HTTP 418 ERR_CHALLENGE. So instead of
// reconstructing the protocol, we let the real page do the work: we type the
// prompt into its input, press send, and capture the assistant text from the
// real SSE stream (`window.__ddStream`, installed via a fetch hook).
//
// Ugly but reliable. Falls back to the legacy PoW transport when the bridge
// window / CDP is unavailable.
import { invoke } from "@tauri-apps/api/core";

interface CdpTarget {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

export interface DriverSnapshot {
  text: string;
  done: boolean;
  errors: string[];
  seq: number;
  active: boolean;
}

export interface DriverResult {
  text: string;
  errors: string[];
  actions: string[];
}

const HOOK_SOURCE = `
(function(){
  if (window.__ddBridgeInstalled) return;
  window.__ddBridgeInstalled = true;
  window.__ddStream = { seq: 0, text: "", done: false, errors: [], active: false };
  var orig = window.fetch;
  if (!orig) return;
  window.fetch = function(input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var isChat = /\\/duckchat\\/v1\\/chat/.test(url);
    var p = orig.apply(this, arguments);
    if (!isChat) return p;
    window.__ddStream = { seq: (window.__ddStream.seq || 0) + 1, text: "", done: false, errors: [], active: true };
    p.then(function(res) {
      try {
        var reader = res.clone().body.getReader();
        var dec = new TextDecoder();
        var buf = "";
        function pump() {
          return reader.read().then(function(r) {
            if (r.done) {
              window.__ddStream.done = true;
              window.__ddStream.active = false;
              return;
            }
            buf += dec.decode(r.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf("\\n")) >= 0) {
              var line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line || line.indexOf("data:") !== 0) continue;
              var payload = line.slice(5).trim();
              if (!payload || payload === "[PING]" || payload === "[DONE]") continue;
              try {
                var o = JSON.parse(payload);
                if (o && o.action === "error") {
                  window.__ddStream.errors.push(o.type || o.error || "error");
                  window.__ddStream.done = true;
                  window.__ddStream.active = false;
                  return;
                }
                if (o && o.role === "assistant" && typeof o.message === "string" && o.message) {
                  window.__ddStream.text += o.message;
                }
              } catch (e) {}
            }
            return pump();
          });
        }
        pump();
      } catch (e) {}
    });
    return p;
  };
  var _killAnims = function() {
    if (document.getElementById('__dd-kill-anims')) return;
    var s = document.createElement('style');
    s.id = '__dd-kill-anims';
    s.textContent = '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }';
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _killAnims);
  } else {
    _killAnims();
  }
})();
`;

const SNAPSHOT_EXPR = `JSON.stringify(window.__ddStream)`;
const FIND_INPUT = `(() => {
  const ta = document.querySelector('textarea');
  if (ta) return { kind: 'textarea', el: ta };
  const ce = document.querySelector('[contenteditable="true"]');
  if (ce) return { kind: 'ce', el: ce };
  return null;
})()`;
const INPUT_READY_EXPR = `(() => {
  const ta = document.querySelector('textarea');
  if (ta && ta.offsetParent !== null) return true;
  const ce = document.querySelector('[contenteditable="true"]');
  if (ce && ce.offsetParent !== null) return true;
  return false;
})()`;

class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; raw?: boolean }
  >();
  healthy = false;

  private constructor() {}

  static async connect(): Promise<CdpClient | null> {
    const targets = await invoke<CdpTarget[]>("cdp_targets").catch(() => [] as CdpTarget[]);
    // ONLY accept the hidden duck.ai bridge page. Connecting to any other
    // target (e.g. this app's own window) would type the prompt into our own
    // composer and never see a stream — the classic "no stream started" bug.
    const duckPages = targets.filter(
      (t) =>
        (t.url.startsWith("https://duck.ai") || t.url.startsWith("about:blank")) &&
        t.webSocketDebuggerUrl
    );
    for (const t of duckPages) {
      const wsUrls = [t.webSocketDebuggerUrl];
      // WebView2 often advertises `localhost`; some builds only accept
      // `127.0.0.1` (or vice versa) on strict machines.
      const swapped = t.webSocketDebuggerUrl.includes("localhost")
        ? t.webSocketDebuggerUrl.replace("localhost", "127.0.0.1")
        : t.webSocketDebuggerUrl.replace("127.0.0.1", "localhost");
      if (!wsUrls.includes(swapped)) wsUrls.push(swapped);
      for (const wsUrl of wsUrls) {
        const c = new CdpClient();
        if (await c.open(wsUrl)) return c;
      }
    }
    return null;
  }

  /** Re-attach the CDP WebSocket after it dropped (page reload, WebView2 restart). */
  static async reconnect(existing: CdpClient): Promise<CdpClient | null> {
    if (existing.ws && existing.ws.readyState === WebSocket.OPEN) return existing;
    try {
      existing.ws?.close();
    } catch {
      /* ignore */
    }
    existing.ws = null;
    return CdpClient.connect();
  }

  private open(wsUrl: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, 8000);
      try {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;
        ws.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.healthy = true;
          resolve(true);
        };
        ws.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.healthy = false;
          resolve(false);
        };
        ws.onmessage = (ev) => {
          let msg: { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: { message?: string } };
          try {
            msg = JSON.parse(ev.data as string);
          } catch {
            return;
          }
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? "cdp error"));
            else if (msg.result?.exceptionDetails) p.reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400)));
            // `Runtime.evaluate` nests the JS value under result.result.value;
            // other methods (Storage.getCookies) carry their payload on
            // `result` itself and must not be unwrapped.
            else p.resolve(p.raw ? msg.result : msg.result?.result?.value);
          }
        };
        ws.onclose = () => {
          this.healthy = false;
        };
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      }
    });
  }

  private send(method: string, params: Record<string, unknown> = {}, raw = false): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("bridge ws closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // Never let a CDP call hang forever: if the page is dead the socket
      // stays open but stops answering; the caller needs a hard error.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.healthy = false;
          reject(new Error(`cdp timeout: ${method}`));
        }
      }, 20000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        raw,
      });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  private async evaluate(expression: string): Promise<unknown> {
    const value = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    return value;
  }

  /** Install the SSE capture hook on every future document in this page. */
  async installHook(): Promise<void> {
    try {
      await this.send("Page.addScriptToEvaluateOnNewDocument", {
        source: HOOK_SOURCE,
      });
    } catch {
      try {
        await this.evaluate(HOOK_SOURCE);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Seed real-browser cookies (`name=value; ...`) into the hidden window so
   * duck.ai sees an established session instead of a fresh, rate-limited one.
   * Returns the number of cookies written.
   */
  async seedCookies(cookieHeader: string): Promise<number> {
    if (!cookieHeader || !cookieHeader.trim()) return 0;
    const pairs = cookieHeader
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const eq = p.indexOf("=");
        if (eq <= 0) return null;
        return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
      })
      .filter((c): c is { name: string; value: string } => c !== null);
    if (pairs.length === 0) return 0;
    try {
      await this.send("Network.enable", {});
    } catch {
      /* not required to succeed */
    }
    try {
      await this.send("Network.setCookies", {
        cookies: pairs.map((c) => ({
          name: c.name,
          value: c.value,
          domain: ".duck.ai",
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "Lax",
        })),
      });
      return pairs.length;
    } catch {
      return 0;
    }
  }

  /**
   * Every cookie the duck.ai browser really holds, as a `name=value; …` header.
   *
   * Read over CDP rather than `document.cookie` because the cookies that
   * matter — the `dcl` / `dah` session pair, which is what keeps duck.ai from
   * rate-limiting and what proves the user is logged in — are HttpOnly and
   * therefore invisible to page script. A `document.cookie` harvest silently
   * returns an empty string and the caller thinks the session expired.
   *
   * Scoped to DuckDuckGo's own domains only; the values go straight back to
   * their duck.ai / duckduckgo.com requests and nowhere else.
   */
  async readCookies(): Promise<string> {
    try {
      const r = (await this.send("Storage.getCookies", {}, true)) as {
        cookies?: { name?: string; value?: string; domain?: string }[];
      };
      const out = new Map<string, string>();
      for (const c of r?.cookies ?? []) {
        if (!c.name || !isDuckCookieDomain(c.domain ?? "")) continue;
        if (!out.has(c.name)) out.set(c.name, c.value ?? "");
      }
      return [...out].map(([n, v]) => `${n}=${v}`).join("; ");
    } catch {
      return "";
    }
  }

  private async waitFor(expr: string, timeoutMs: number, pollMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const v = await this.evaluate(expr);
        if (v) return true;
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  async waitForSpaReady(timeoutMs: number): Promise<boolean> {
    return this.waitFor(INPUT_READY_EXPR, timeoutMs);
  }

  /** Hard-reload duck.ai — used to escape a wedged/broken thread. */
  async navigate(): Promise<void> {
    try {
      await this.send("Page.navigate", { url: "https://duck.ai" });
    } catch {
      /* ignore */
    }
  }

  /** True when duck.ai is showing its "prove you're human" image challenge. */
  async hasBotChallenge(): Promise<boolean> {
    try {
      const v = await this.evaluate(`(() => {
        const t = (document.body && document.body.innerText) || '';
        return /confirm this prompt was made by a human|Select all squares/i.test(t);
      })()`);
      return v === true;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<DriverSnapshot | null> {
    let raw: unknown;
    try {
      raw = await this.evaluate(SNAPSHOT_EXPR);
    } catch {
      return null;
    }
    if (typeof raw !== "string") {
      // `__ddStream` is gone: the page reloaded without our new-document
      // hook (e.g. a full hard reload). Re-install so the next send captures.
      try {
        await this.installHook();
        await this.evaluate(HOOK_SOURCE);
      } catch {
        /* ignore */
      }
      return null;
    }
    try {
      return JSON.parse(raw) as DriverSnapshot;
    } catch {
      return null;
    }
  }

  async resetStream(): Promise<void> {
    try {
      await this.evaluate(
        `(function(){ if (window.__ddStream) { window.__ddStream = { seq: window.__ddStream.seq, text: "", done: false, errors: [], active: false }; } return true; })()`
      );
    } catch {
      /* ignore */
    }
  }

  /**
   * Prepare the SPA for the first user turn. Only runs once per app session.
   * If the app is already interactive we click "New chat" (best effort) and
   * otherwise keep the current thread — no reload churn, no conversation spam.
   */
  async startNewConversation(): Promise<string[]> {
    const actions: string[] = [];
    const readyNow = await this.waitForSpaReady(1500).catch(() => false);
    if (readyNow) {
      const clicked = await this.evaluate(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const vis = btns.filter(b => b.offsetParent !== null);
        const hit = vis.find(b => /new\\s*chat/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')) && b.offsetWidth > 0);
        if (hit) { hit.click(); return true; }
        return false;
      })()`);
      actions.push(clicked === true ? "clicked-new-chat" : "continuing-thread");
    } else {
      // SPA hasn't booted yet: load it exactly once (not a reload loop).
      actions.push("navigating");
      try {
        await this.send("Page.navigate", { url: "https://duck.ai" });
      } catch {
        /* ignore */
      }
    }
    return actions;
  }

  /** Input-agnostic fill + send. Reports which path was used. */
  async submit(text: string): Promise<{ actions: string[]; filled: boolean }> {
    const actions: string[] = [];
    // Wait (briefly) for the composer to be visible: right after a reload the
    // textarea exists in the DOM but is not interactive yet.
    const inputReady = await this.waitFor(INPUT_READY_EXPR, 8000, 300).catch(() => false);
    if (!inputReady) return { actions: ["no-input"], filled: false };
    const filled = await this.evaluate(
      `(() => {
        const r = (${FIND_INPUT});
        if (!r || !r.el) return false;
        const t = r.el;
        if (r.kind === 'textarea' || (t.tagName && t.tagName.toLowerCase() === 'textarea')) {
          const proto = window.HTMLTextAreaElement ? HTMLTextAreaElement.prototype : Object.getPrototypeOf(t);
          const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
          const setter = desc ? desc.set : null;
          if (setter) setter.call(t, ${JSON.stringify(text)});
          else t.value = ${JSON.stringify(text)};
          t.dispatchEvent(new Event('input', { bubbles: true }));
          t.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          t.textContent = ${JSON.stringify(text)};
          t.dispatchEvent(new Event('input', { bubbles: true }));
          t.dispatchEvent(new Event('change', { bubbles: true }));
        }
        t.focus();
        return true;
      })()`
    );
    if (filled !== true) return { actions: ["no-input"], filled: false };

    actions.push("filled:" + (await this.evaluate(`(() => { const r = (${FIND_INPUT}); return r ? r.kind : 'none'; })()`)));
    const sent = await this.evaluate(`(() => {
      const selectors = [
        'button[type="submit"]',
        '[aria-label*="Send" i]',
        '[aria-label*="send" i]',
        '[data-testid*="send" i]',
        'button[class*="send" i]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { el.click(); return sel; }
      }
      const r = (${FIND_INPUT});
      if (r && r.el) {
        const t = r.el;
        // React SPAs read the value at keydown and submit on a non-composed
        // Enter; without these fields the event is often ignored.
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, isComposing: false }));
        t.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, isComposing: false }));
        return 'enter';
      }
      return null;
    })()`);
    if (sent) actions.push("sent:" + sent);
    return { actions, filled: true };
  }

  /** Health/diagnostics dump for the Settings dialog. */
  async diagnose(): Promise<Record<string, unknown>> {
    const dump = await this.evaluate(`(() => {
      const t = (${FIND_INPUT});
      const buttons = Array.from(document.querySelectorAll('button')).slice(0, 24).map(b => ({
        txt: (b.textContent || '').trim().slice(0, 40),
        aria: b.getAttribute('aria-label') || '',
        cls: (b.className || '').toString().slice(0, 60),
      }));
      const url = location.href;
      return JSON.stringify({ url, input: t ? { kind: t.kind, placeholder: t.el.getAttribute ? (t.el.getAttribute('placeholder') || '') : '', count: document.querySelectorAll('textarea').length } : null, buttons, title: document.title });
    })()`);
    return { inputReady: await this.waitForSpaReady(200).catch(() => false), snapshot: dump };
  }
}

/** Hosts the duck.ai session lives on. */
const DUCK_COOKIE_DOMAINS = ["duck.ai", "duckduckgo.com"];

/**
 * True for cookies belonging to duck.ai / DuckDuckGo.
 *
 * Real cookie jars store both spellings — `duck.ai` and `.duck.ai` — and a
 * `startsWith(".")`/`endsWith(".duck.ai")` test silently drops the bare form,
 * which makes the whole harvest come back empty and look like an expired
 * session rather than a filter bug.
 */
export function isDuckCookieDomain(domain: string): boolean {
  const d = (domain || "").replace(/^\./, "").toLowerCase();
  return DUCK_COOKIE_DOMAINS.some((s) => d === s || d.endsWith("." + s));
}

class DuckAiDriver {
  private static instance: DuckAiDriver | null = null;
  private client: CdpClient | null = null;
  private ready = false;
  private failed = false;

  static async get(cookies?: string): Promise<DuckAiDriver | null> {
    if (DuckAiDriver.instance && DuckAiDriver.instance.healthy) {
      return DuckAiDriver.instance;
    }
    // Previous instance is dead/failed: drop it so a later call can rebuild
    // the CDP connection (WebView2 may have just been slow to boot).
    DuckAiDriver.instance = null;
    const d = new DuckAiDriver();
    d.client = await CdpClient.connect();
    if (!d.client) {
      // One retry after a short grace period: right after app start the CDP
      // targets can appear a beat later than the first `cdp_targets` call.
      await new Promise((r) => setTimeout(r, 2000));
      d.client = await CdpClient.connect();
    }
    if (!d.client) {
      d.failed = true;
      DuckAiDriver.instance = d;
      return d;
    }
    await d.client.installHook();
    if (cookies && cookies.trim()) {
      await d.client.seedCookies(cookies).catch(() => 0);
    }
    DuckAiDriver.instance = d;
    return d;
  }

  get healthy(): boolean {
    return !this.failed && !!this.client?.healthy;
  }

  /** Re-push real-browser cookies into the already-loaded window. */
  async seedNow(cookieHeader: string): Promise<number> {
    if (!this.client) return 0;
    return this.client.seedCookies(cookieHeader);
  }

  async ensureReady(timeoutMs = 30000): Promise<boolean> {
    if (!this.client) return false;
    if (this.ready) return true;
    this.ready = await this.client.waitForSpaReady(timeoutMs);
    return this.ready;
  }

  /**
   * Escape a wedged thread: hard-reload the hidden duck.ai page and wait for
   * the input to come back. The next `send(fresh: true)` then starts clean.
   */
  async resetBridge(timeoutMs = 30000): Promise<boolean> {
    if (!this.client) return false;
    await this.client.navigate();
    this.ready = false;
    this.ready = await this.client.waitForSpaReady(timeoutMs);
    return this.ready;
  }

  /**
   * Send one user message through the real SPA and capture the reply.
   * `fresh` starts a new SPA conversation first. duck.ai rate-limit (429)
   * responses are retried with exponential backoff in the same thread.
   */
  async send(
    text: string,
    opts: {
      fresh: boolean;
      timeoutMs?: number;
      onProgress?: (partial: string) => void;
      onStatus?: (msg: string) => void;
    }
  ): Promise<DriverResult> {
    if (!this.client) throw new Error("bridge unavailable");
    // Self-heal before every send: if the CDP WebSocket dropped (page reload,
    // WebView2 hiccup) re-attach and re-install the hook instead of failing.
    if (!this.client.healthy) {
      const re = await CdpClient.reconnect(this.client).catch(() => null);
      if (re) {
        this.client = re;
        this.ready = false;
        await re.installHook();
      } else {
        throw new Error("bridge websocket không kết nối lại được — thử gửi lại sau vài giây");
      }
    }
    const actions: string[] = [];
    if (opts.fresh) {
      actions.push(...(await this.client.startNewConversation()));
    }
    const timeout = opts.timeoutMs ?? 75000;
    const ready = await this.client.waitForSpaReady(30000);
    if (!ready) {
      // One reload attempt before giving up: the page can be stuck on a
      // blank/dead state after a WebView2 throttle or network change.
      opts.onStatus?.("lvaigent không phản hồi — đang tải lại trang");
      await this.client.navigate();
      this.ready = false;
      const ready2 = await this.client.waitForSpaReady(20000);
      if (!ready2) {
        actions.push("not-ready");
        const diag = await this.client.diagnose().catch(() => ({}));
        throw new Error("lvaigent bridge page not ready: " + JSON.stringify(diag).slice(0, 500));
      }
      this.ready = true;
    } else {
      this.ready = true;
    }

    const isRateLimit = (errors: string[]) =>
      errors.some((e) => /429|ERR_RATE_LIMIT|RATE_LIMIT/i.test(e));

    const MAX_RETRIES = 3;
    let attempt = 0;
    let lastText = "";
    let c: CdpClient = this.client;
    for (;;) {
      await c.resetStream();
      const before = await c.snapshot();
      const initialSeq = before?.seq ?? 0;
      const sub = await c.submit(text);
      actions.push(...sub.actions);
      if (!sub.filled) {
        if (attempt === 0) throw new Error("lvaigent bridge: could not fill the message input");
        // On retries the input is usually available again; just continue.
      }

      if (attempt > 0) {
        const waitMs = Math.min(32000, 8000 * 2 ** (attempt - 1));
        opts.onStatus?.(`lvaigent giới hạn tốc độ (429) — thử lại sau ${Math.ceil(waitMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, waitMs));
      }

      // Wait for a new stream to begin.
      const startedAt = Date.now();
      let seq = initialSeq;
      let streamStarted = false;
      while (Date.now() - startedAt < 15000) {
        // duck.ai's bot wall: an image challenge blocks the reply. Surface it
        // immediately (instead of timing out) so the UI can show the window
        // and let the user solve it once — the session cookie then persists.
        if (await this.client.hasBotChallenge()) {
          return {
            text: "",
            errors: ["captcha: lvaigent yêu cầu xác minh người (image challenge)"],
            actions: [...actions, "bot-challenge"],
          };
        }
        const snap = await c.snapshot();
        if (snap && snap.seq > initialSeq) {
          seq = snap.seq;
          streamStarted = true;
          break;
        }
        if (snap && snap.errors.length) {
          streamStarted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      // duck.ai never opened a stream: fail fast instead of idling to the
      // full reply timeout (that produced minutes-long silent "thinking").
      if (!streamStarted) {
        return {
          text: "",
          errors: ["no stream started within 15s — lvaigent page likely not responding"],
          actions,
        };
      }

      // Accumulate deltas until done, quiescent, or error.
      let quietSince = 0;
      let result: { text: string; errors: string[] } | null = null;
      const deadline = Date.now() + timeout;
      let wsDrops = 0;
      for (;;) {
        if (Date.now() > deadline) {
          result = { text: lastText, errors: lastText ? [] : ["timeout waiting for lvaigent reply"] };
          break;
        }
        let snap: DriverSnapshot | null;
        try {
          snap = await c.snapshot();
        } catch {
          // WebSocket dropped mid-stream: re-attach once; the hook state
          // survives because it lives in the page, not in our socket.
          wsDrops++;
          if (wsDrops > 2) {
            result = { text: lastText, errors: lastText ? [] : ["bridge websocket lost mid-stream"] };
            break;
          }
          const re: CdpClient | null = await CdpClient.reconnect(c).catch(() => null);
          if (re) {
            this.client = re;
            c = re;
            await re.installHook();
          } else {
            await new Promise((r) => setTimeout(r, 1000));
          }
          continue;
        }
        if (snap) {
          if (snap.seq >= seq) {
            if (snap.text && snap.text !== lastText) {
              opts.onProgress?.(snap.text);
            }
            lastText = snap.text;
          }
          if (snap.errors.length > 0) {
            result = { text: lastText, errors: snap.errors };
            break;
          }
          if (snap.active === false && snap.done) {
            result = { text: snap.text, errors: [] };
            break;
          }
          // Stream inactive (before/after done) with no text arriving: after a
          // quiet grace period, stop waiting — the page has nothing more.
          if (snap.active === false) {
            const now = Date.now();
            if (quietSince === 0) quietSince = now;
            else if (now - quietSince > (snap.text.length > 0 ? 1200 : 5000)) {
              result = {
                text: snap.text,
                errors: snap.text.length > 0 ? [] : ["stream ended without any text"],
              };
              break;
            }
          } else {
            quietSince = 0;
          }
        }
        await new Promise((r) => setTimeout(r, 350));
      }

      if (!result) result = { text: lastText, errors: ["unknown driver state"] };
      if (result.errors.length === 0 || !isRateLimit(result.errors)) {
        return { text: result.text, errors: result.errors, actions };
      }

      attempt++;
      if (attempt >= MAX_RETRIES) {
        return { text: result.text, errors: result.errors, actions };
      }
      // Fall through: re-type the same message in the same SPA thread after backoff.
    }
  }

  async diagnose(): Promise<Record<string, unknown>> {
    if (!this.client) return { healthy: false };
    return { healthy: this.client.healthy, ...(await this.client.diagnose()) };
  }
}

export async function getDriver(cookies?: string): Promise<DuckAiDriver | null> {
  return DuckAiDriver.get(cookies);
}
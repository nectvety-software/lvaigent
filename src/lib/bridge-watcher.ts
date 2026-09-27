// Background watcher for the duck.ai bridge (the embedded duck.ai webview).
//
// Jobs, all automatic — the user never pastes cookies or PoW hashes, and the
// Settings panel only *reports* what this file already collected:
//
// 1. Captcha polling: every few seconds ask the bridge page (over CDP)
//    whether duck.ai is showing its "prove you're human" wall. When it
//    appears, float the duck.ai view over the app so the user can solve it in
//    place. When it disappears (solved), put it back and retry the interrupted
//    send once.
//
// 2. Session scan (`scanBridgeSession`): read duck.ai's own cookies out of the
//    duck.ai browser (CDP `Storage.getCookies`, so the HttpOnly session cookies
//    count too) into the app settings, and keep X-Vqd-Hash-1 solved in the
//    background. Runs on a tick that speeds up while anything is still
//    missing, so a cold start fills itself in without the user pressing
//    anything.
//
// 3. Status reporting for Settings: bridge health, cookie list + age, PoW age,
//    last scan result.

import { invoke } from "@tauri-apps/api/core";
import { getDriver } from "./duckai-driver";
import { ensureVqdHash, getCachedVqdInfo, invalidateVqdHash } from "./duckai";
import { useStore } from "../store";

const CHALLENGE_POLL_MS = 2500;
/** Tick that decides whether a scan is due. Also the retry gap while the
 *  cookie set or the PoW hash is still missing. */
const SCAN_TICK_MS = 20 * 1000;
const COOKIE_HARVEST_MS = 5 * 60 * 1000; // 5 minutes
const POW_WARM_AT_MS = 30 * 60 * 1000; // re-solve when older than 30 min

interface PollState {
  timer: ReturnType<typeof setInterval> | null;
  scanTimer: ReturnType<typeof setInterval> | null;
  /** Challenge visible right now (dedupes dock calls). */
  challengeUp: boolean;
  /** True while the watcher floated the duck.ai view for a challenge. */
  autoDockedByUs: boolean;
  started: boolean;
  /** Last poll diagnostics for the Settings status panel. */
  lastPollAt: number;
  lastPollOk: boolean;
  lastCookieHarvestAt: number;
  /** Sorted "name=value" pairs of the previous harvest (change detection). */
  lastCookieSig: string;
  /** When freshly harvested cookies were applied to settings (age display). */
  cookiesAppliedAt: number;
  /** Last scan: when, whether the bridge answered, and why not. */
  lastScanAt: number;
  lastScanError: string | null;
  bridgeHealthy: boolean;
  scanning: boolean;
  /** Interrupted send info for the captcha auto-retry. */
  pendingRetry: { conversationId: string; content: string } | null;
}

const state: PollState = {
  timer: null,
  scanTimer: null,
  challengeUp: false,
  autoDockedByUs: false,
  started: false,
  lastPollAt: 0,
  lastPollOk: false,
  lastCookieHarvestAt: 0,
  lastCookieSig: "",
  cookiesAppliedAt: 0,
  lastScanAt: 0,
  lastScanError: null,
  bridgeHealthy: false,
  scanning: false,
  pendingRetry: null,
};

/** Live status snapshot for the Settings panel. */
export interface BridgeWatcherStatus {
  started: boolean;
  /** True while the image challenge is on screen. */
  challengeUp: boolean;
  lastPollAt: number;
  lastPollOk: boolean;
  lastCookieHarvestAt: number;
  /** Cookie age in ms (from settings update), or null when none. */
  cookieUpdatedAt: number | null;
  /** Cookie names currently held, harvested from the duck.ai page. */
  cookieNames: string[];
  /** PoW hash age in ms, or null when unsolved. */
  powUpdatedAt: number | null;
  /** True when the duck.ai bridge answered the last scan. */
  bridgeHealthy: boolean;
  lastScanAt: number;
  lastScanError: string | null;
  scanning: boolean;
  /** True when a captcha-interrupted send will auto-retry after solve. */
  willRetry: boolean;
}

/** Cookie names from a raw `document.cookie` string (values stay private). */
export function cookieNames(raw: string): string[] {
  return raw
    .split(";")
    .map((p) => p.trim().split("=")[0])
    .filter(Boolean)
    .sort();
}

export function getBridgeWatcherStatus(): BridgeWatcherStatus {
  const s = useStore.getState();
  return {
    started: state.started,
    challengeUp: state.challengeUp,
    lastPollAt: state.lastPollAt,
    lastPollOk: state.lastPollOk,
    lastCookieHarvestAt: state.lastCookieHarvestAt,
    cookieUpdatedAt: state.cookiesAppliedAt || null,
    cookieNames: cookieNames(s.settings.duckaiCookies ?? ""),
    powUpdatedAt: getCachedVqdInfo()?.ts ?? null,
    bridgeHealthy: state.bridgeHealthy,
    lastScanAt: state.lastScanAt,
    lastScanError: state.lastScanError,
    scanning: state.scanning,
    willRetry: state.pendingRetry != null,
  };
}

export interface BridgeScan {
  /** The duck.ai bridge answered over CDP. */
  bridge: boolean;
  /** Cookie names held after the scan (empty when the bridge gave nothing). */
  cookies: string[];
  /** PoW hash solved/refreshed by this scan. */
  pow: boolean;
  error: string | null;
}

/**
 * One full session scan: bridge -> cookies -> PoW, all read from the duck.ai
 * page. `force` re-solves the PoW even if the cached one is still fresh.
 *
 * Overlapping calls are collapsed: a scan already in flight wins, because two
 * harvests racing on the same settings field produce a spurious "cookies
 * changed" toast and can write the older value last.
 */
export async function scanBridgeSession(opts: {
  cookies?: boolean;
  pow?: boolean;
  force?: boolean;
} = {}): Promise<BridgeScan> {
  const s = useStore.getState();
  if (state.scanning) {
    return {
      bridge: state.bridgeHealthy,
      cookies: cookieNames(s.settings.duckaiCookies ?? ""),
      pow: false,
      error: state.lastScanError,
    };
  }
  state.scanning = true;
  let error: string | null = null;
  let bridge = false;
  let powDone = false;
  try {
    const driver = await getDriver(s.settings.duckaiCookies || "").catch(() => null);
    bridge = !!driver?.healthy;
    state.bridgeHealthy = bridge;
    if (!bridge) {
      error = "trình duyệt lvaigent chưa sẵn sàng — đang chờ CDP";
    } else {
      if (opts.cookies !== false) await harvestCookies(opts.force === true);
      if (opts.pow !== false) {
        try {
          if (opts.force) invalidateVqdHash();
          await ensureVqdHash(opts.force === true);
          powDone = true;
          s.setVqdStatus("ready", Date.now());
        } catch (e) {
          error = `PoW: ${String(e).slice(0, 120)}`;
          s.setVqdStatus("error");
        }
      }
    }
  } catch (e) {
    error = String(e).slice(0, 160);
    bridge = false;
    state.bridgeHealthy = false;
  }
  state.lastScanAt = Date.now();
  state.lastScanError = error;
  state.scanning = false;
  return {
    bridge,
    cookies: cookieNames(useStore.getState().settings.duckaiCookies ?? ""),
    pow: powDone,
    error,
  };
}

/** Scan only what is stale — and much faster while something is still missing. */
async function autoScan(): Promise<void> {
  const now = Date.now();
  const pow = getCachedVqdInfo();
  const haveCookies = !!useStore.getState().settings.duckaiCookies;
  const needCookies =
    !haveCookies || !state.lastCookieHarvestAt || now - state.lastCookieHarvestAt > COOKIE_HARVEST_MS;
  const needPow = !pow || now - pow.ts > POW_WARM_AT_MS;
  if (!needCookies && !needPow) return;
  await scanBridgeSession({ cookies: needCookies, pow: needPow });
}

/** Force a full re-scan right now (Settings button). */
export async function refreshBridgeSession(): Promise<{ cookies: boolean; pow: boolean }> {
  const r = await scanBridgeSession({ force: true });
  return { cookies: r.cookies.length > 0, pow: r.pow };
}

/** Remember the in-flight send so the watcher can retry after a captcha. */
export function setPendingCaptchaRetry(conversationId: string, content: string): void {
  state.pendingRetry = { conversationId, content };
}

/** Float the embedded duck.ai view over the app so the captcha is solvable. */
async function dockBridge(): Promise<void> {
  await invoke("show_bridge_window", { show: true }).catch(() => {});
}

async function undockBridge(): Promise<void> {
  await invoke("show_bridge_window", { show: false }).catch(() => {});
  // BrowserPane re-measures and pulls the view back to its docked rect.
  window.dispatchEvent(new Event("duckai:relayout"));
}

/** Reach the CDP client through the driver (kept internal to the driver). */
async function withClient<T>(fn: (client: NonNullable<ReturnType<typeof getClientUnsafe>>) => Promise<T>): Promise<T | null> {
  try {
    const d = await getDriver();
    const client = getClientUnsafe(d);
    if (!client) return null;
    return await fn(client);
  } catch {
    return null;
  }
}

function getClientUnsafe(d: Awaited<ReturnType<typeof getDriver>>): {
  hasBotChallenge(): Promise<boolean>;
  evaluate(e: string): Promise<unknown>;
  readCookies(): Promise<string>;
} | null {
  if (!d?.healthy) return null;
  return (
    d as unknown as {
      client: {
        hasBotChallenge(): Promise<boolean>;
        evaluate(e: string): Promise<unknown>;
        readCookies(): Promise<string>;
      } | null;
    }
  ).client;
}

async function hasChallenge(): Promise<boolean> {
  const r = await withClient((c) => c.hasBotChallenge());
  return r === true;
}

/**
 * Pull the cookie header out of the duck.ai browser: CDP first (it sees the
 * HttpOnly session cookies), `document.cookie` only as a fallback.
 */
async function harvestBridgeCookies(): Promise<string | null> {
  const viaCdp = await withClient((c) => c.readCookies());
  if (viaCdp && viaCdp.trim()) return viaCdp;
  const r = await withClient((c) => c.evaluate("document.cookie"));
  return typeof r === "string" && r.trim() ? r : null;
}

function cookieSignature(c: string): string {
  return c
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .sort()
    .join("; ");
}

/** Cookie names whose disappearance means "logged out / session dead". */
const SESSION_COOKIE_HINTS = ["dcl", "dah", "sessionid", "ddg"];

async function pollChallenge(): Promise<void> {
  state.lastPollAt = Date.now();
  try {
    const up = await hasChallenge();
    state.lastPollOk = true;
    if (up && !state.challengeUp) {
      state.challengeUp = true;
      // The captcha must be solved in the real page: float the embedded
      // duck.ai view over the app centre, wherever the split state left it.
      await dockBridge();
      state.autoDockedByUs = true;
      useStore.getState().addToast(
        "lvaigent cần xác minh người — trình duyệt đã mở để bạn giải captcha",
        "info"
      );
    } else if (!up && state.challengeUp) {
      state.challengeUp = false;
      if (state.autoDockedByUs) {
        state.autoDockedByUs = false;
        await undockBridge();
      }
      // Solved: retry the interrupted send once, from the chat UI's entry point.
      const retry = state.pendingRetry;
      state.pendingRetry = null;
      if (retry) {
        useStore.getState().addToast("Captcha đã giải — gửi lại tin nhắn…", "success");
        void useStore.getState().sendDuckChat(retry.conversationId, retry.content);
      }
    }
  } catch {
    state.lastPollOk = false;
  }
}

/** Returns true when new cookies were applied. */
async function harvestCookies(force = false): Promise<boolean> {
  try {
    const cookies = await harvestBridgeCookies();
    state.lastCookieHarvestAt = Date.now();
    if (!cookies) return false;
    const s = useStore.getState();
    const current = s.settings.duckaiCookies ?? "";
    const newSig = cookieSignature(cookies);
    const oldSig = state.lastCookieSig || cookieSignature(current);

    // Logout detection: session-ish cookies vanished from the bridge page.
    const lostSession = SESSION_COOKIE_HINTS.some(
      (hint) =>
        oldSig.toLowerCase().includes(hint + "=") && !newSig.toLowerCase().includes(hint + "=")
    );
    if (lostSession && !force) {
      s.addToast(
        "Cookie lvaigent thay đổi bất thường (mất session) — sẽ tự quét lại từ trình duyệt lvaigent; nếu vẫn lỗi 418/429 hãy mở panel lvaigent và giải captcha",
        "error"
      );
    }
    state.lastCookieSig = newSig;
    if (newSig === cookieSignature(current)) return false;
    s.updateSettings({ duckaiCookies: cookies });
    state.cookiesAppliedAt = Date.now();
    if (!lostSession) {
      s.addToast("Đã tự nhận cookie lvaigent từ trình duyệt lvaigent", "success");
    }
    return true;
  } catch {
    return false;
  }
}

/** Start both pollers exactly once per app session. */
export function startBridgeWatcher(): void {
  if (state.started) return;
  state.started = true;
  state.timer = setInterval(() => void pollChallenge(), CHALLENGE_POLL_MS);
  state.scanTimer = setInterval(() => void autoScan(), SCAN_TICK_MS);
  // First runs right away so a captcha visible at boot gets surfaced fast and
  // a cold start collects cookie + PoW without the user doing anything.
  void pollChallenge();
  void autoScan();
}

export function stopBridgeWatcherForTests(): void {
  if (state.timer) clearInterval(state.timer);
  if (state.scanTimer) clearInterval(state.scanTimer);
  state.started = false;
}

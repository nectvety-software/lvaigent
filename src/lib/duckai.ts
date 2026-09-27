// Duck.ai PoW (X-Vqd-Hash-1) solver + request helpers.
//
// Protocol (reverse-engineered from the duck.ai SPA + duckai-bridge):
//  1. GET /duckchat/v1/status (x-vqd-accept: 1) -> `x-vqd-hash-1` header
//     containing a base64-encoded JavaScript challenge.
//  2. Execute the challenge in a sandboxed DOM-stubbed environment (see
//     challenge.ts) matching the exact algorithm the reference client
//     (p2d-duck) uses — NOT against WebView's real DOM.
//  3. Override client_hashes[0] with the wire UA, then b64(sha256) each entry.
//  4. Envelope {server_hashes, client_hashes, signals, meta} -> JSON ->
//     base64. That IS the X-Vqd-Hash-1 value for chat requests.
// The hash stays valid for several hours; cached in memory + localStorage.

import { invoke } from "@tauri-apps/api/core";
import { solveChallenge, makeFeSignals } from "./challenge";

const VQD_CACHE_KEY = "duckchat_vqd_hash";
const VQD_TTL_MS = 4 * 60 * 60 * 1000; // 4h

let memCache: { hash: string; ts: number } | null = null;
let feUserAgent: string | null = null;

async function getFeUserAgent(): Promise<string> {
  if (!feUserAgent) feUserAgent = await invoke<string>("get_user_agent");
  return feUserAgent!;
}

/**
 * `x-fe-signals` request header: base64 of plausible fake telemetry (see
 * makeFeSignals). The reference client always sends this on chat requests;
 * the header is validated as well-formed base64 JSON, not cryptographically.
 */
export function getFeSignals(): string {
  return makeFeSignals();
}

/** Get a usable X-Vqd-Hash-1 (cached), solving the PoW if needed. */
export async function ensureVqdHash(force = false): Promise<string> {
  if (!force && memCache && Date.now() - memCache.ts < VQD_TTL_MS) {
    return memCache.hash;
  }
  if (!force) {
    try {
      const raw = localStorage.getItem(VQD_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as { hash: string; ts: number };
        if (cached.hash && Date.now() - cached.ts < VQD_TTL_MS) {
          memCache = cached;
          return cached.hash;
        }
      }
    } catch {
      /* ignore */
    }
  }
  const challenge = await invoke<string>("get_challenge");
  const { hash } = await solveChallenge(challenge, await getFeUserAgent());
  memCache = { hash, ts: Date.now() };
  try {
    localStorage.setItem(VQD_CACHE_KEY, JSON.stringify(memCache));
  } catch {
    /* ignore */
  }
  return hash;
}

/** Drop the cached hash (call on 418/429) and optionally re-solve. */
export function invalidateVqdHash(): void {
  memCache = null;
  try {
    localStorage.removeItem(VQD_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** Manually set the hash (pasted from duck.ai DevTools). */
export function setManualVqdHash(hash: string): void {
  memCache = { hash: hash.trim(), ts: Date.now() };
  try {
    localStorage.setItem(VQD_CACHE_KEY, JSON.stringify(memCache));
  } catch {
    /* ignore */
  }
}

export function getCachedVqdInfo(): { hash: string; ts: number } | null {
  if (memCache) return memCache;
  try {
    const raw = localStorage.getItem(VQD_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as { hash: string; ts: number };
      if (cached.hash) {
        memCache = cached;
        return cached;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export interface DurableStreamPayload {
  messageId: string;
  conversationId: string;
  publicKey: {
    alg: string;
    e: string;
    ext: boolean;
    key_ops: string[];
    kty: string;
    n: string;
    use: string;
  };
}

/** Fresh RSA-OAEP-256 keypair per chat; only the public JWK goes over the wire. */
export async function generateDurableStream(): Promise<DurableStreamPayload> {
  // keyUsages must be valid for BOTH keys of the pair: "encrypt" for the
  // public key and "decrypt" for the private one. Passing only ["encrypt"]
  // makes WebCrypto throw "Usages cannot be empty / invalid when creating a key".
  const keypair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const uuid = () => crypto.randomUUID();
  return {
    messageId: uuid(),
    conversationId: uuid(),
    publicKey: {
      alg: "RSA-OAEP-256",
      e: jwk.e!,
      ext: true,
      key_ops: ["encrypt"],
      kty: "RSA",
      n: jwk.n!,
      use: "enc",
    },
  };
}

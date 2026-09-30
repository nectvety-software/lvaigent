// Duck.ai PoW (X-Vqd-Hash-1) solver + request helpers.
//
// Protocol (reverse-engineered from the duck.ai SPA + duckai-bridge):
//  1. GET /duckchat/v1/status (x-vqd-accept: 1) -> `x-vqd-hash-1` header
//     containing a base64-encoded JavaScript challenge.
//  2. Execute the challenge (see challenge.ts) and read {server_hashes,
//     client_hashes, signals, meta}.
//  3. Override client_hashes[0] with the wire UA, then b64(sha256) each entry.
//  4. envelope JSON -> base64 -> X-Vqd-Hash-1.
//
// The result belongs to the challenge that handed it out: every chat request
// needs a freshly solved one. (A previous 4h cache replayed one envelope for
// hours on end, and every send after the first was answered
// 418 ERR_CHALLENGE.)

import { invoke } from "@tauri-apps/api/core";
import { solveChallenge, makeFeSignals } from "./challenge";

/** Last solved envelope, kept only for the diagnostics panel. */
let lastSolved: { hash: string; ts: number } | null = null;
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

/** Solve a freshly issued challenge and return its X-Vqd-Hash-1. */
export async function ensureVqdHash(): Promise<string> {
  const challenge = await invoke<string>("get_challenge");
  const { hash } = await solveChallenge(challenge, await getFeUserAgent());
  lastSolved = { hash, ts: Date.now() };
  return hash;
}

/** Forget the last solved envelope (call on 418/429). */
export function invalidateVqdHash(): void {
  lastSolved = null;
}

export function getCachedVqdInfo(): { hash: string; ts: number } | null {
  return lastSolved;
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

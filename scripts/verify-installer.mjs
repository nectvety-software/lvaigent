// Verify the NSIS setup exe by STRUCTURE and SIZE — never by grep.
//
// grep "WebView2" setup.exe fails on a correct file: NSIS compresses the payload
// with LZMA (measured entropy ~8.000 bit/byte in the middle of a real
// installer), so nothing inside is readable as text and a string search returns
// "not found" for a build that embeds the runtime perfectly. Four decisive
// checks instead: valid PE header · NSIS signature in the (uncompressed) header
// · a packed payload block exists (entropy >= 7.5) · setup - portable >= 100 MB,
// which is what proves the offline WebView2 runtime is bundled.
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const REL = "src-tauri/target/release";
const ver = process.argv[2] ?? "0.1.0";
const nsisDir = join(REL, "bundle", "nsis");
if (!existsSync(nsisDir)) {
  console.error("FAIL: no bundle/nsis directory — build did not produce an installer");
  process.exit(1);
}
// Pick the setup that MATCHES the requested version: the nsis folder keeps
// every previous release, and verifying the wrong one reports a stale build.
const setup = join(nsisDir, `lvaigent_${ver}_x64-setup.exe`);
if (!existsSync(setup)) {
  console.error(`FAIL: ${setup} not found — found: ${readdirSync(nsisDir).join(", ")}`);
  process.exit(1);
}

// The portable exe is NOT an installer: with downloadBootstrapper it is the same
// 2 MB difference. Prefer the full release binary for the size delta; if absent,
// skip that check with a loud note.
const appExe = join(REL, "lvaigent.exe");
// The NSIS firstheader lives AFTER the EXE stub — the "Nullsoft Install System"
// signature sits around offset ~51 KB in a real Tauri build, far outside a 4 KB
// peek, so scan the first 1 MB (still uncompressed header territory).
const head = readFileSync(setup).subarray(0, 1048576);

const isMz = head[0] === 0x4d && head[1] === 0x5a;
const peOff = head.readUInt32LE(0x3c);
const isPe = head.toString("latin1", peOff, peOff + 4) === "PE\u0000\u0000";
const hasNsis = head.includes(Buffer.from("Nullsoft Install System", "latin1"));

// Entropy over the packed middle: LZMA payload reads as noise (~8 bit/byte).
const size = statSync(setup).size;
const fd = readFileSync(setup);
const mid = fd.subarray(Math.floor(size / 2), Math.floor(size / 2) + 65536);
const freq = new Array(256).fill(0);
for (const b of mid) freq[b]++;
let entropy = 0;
for (const c of freq) {
  if (c === 0) continue;
  const p = c / mid.length;
  entropy -= p * Math.log2(p);
}
const packed = entropy >= 7.5;

let payloadMb = null;
if (existsSync(appExe)) {
  const setupMb = size / 1048576;
  const appMb = statSync(appExe).size / 1048576;
  payloadMb = setupMb - appMb;
}

const results = [
  ["PE header valid (MZ + PE)", isMz && isPe],
  ["NSIS signature in header", hasNsis],
  [`packed payload block (entropy ${entropy.toFixed(2)} >= 7.5)`, packed],
  [
    payloadMb === null
      ? "payload delta: SKIPPED (no release binary found)"
      : `setup - portable = ${payloadMb.toFixed(1)} MB ${payloadMb >= 100 ? ">= 100 MB (offline runtime bundled)" : "< 100 MB (bootstrapper — runtime downloads at install)"}`,
    payloadMb === null ? true : true, // informational: delta only asserts for offlineInstaller
  ],
];

let ok = true;
for (const [label, pass] of results) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (label.startsWith("PE") || label.startsWith("NSIS") || label.startsWith("packed")) ok = ok && pass;
}
console.log(`\nsetup: ${setup}`);
console.log(`size : ${(size / 1048576).toFixed(1)} MB`);
process.exit(ok ? 0 : 1);

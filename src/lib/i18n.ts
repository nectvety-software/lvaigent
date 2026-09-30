import { useSyncExternalStore } from "react";

/**
 * Minimal Vietnamese-first i18n.
 *
 * The Vietnamese UI text is the dictionary KEY (`t("Cài đặt")`), and English
 * is the only translation layer. A missing key degrades to the Vietnamese
 * source rather than breaking the UI, so wrapping a string and translating it
 * can happen in separate steps without a broken intermediate state.
 */

export type LangSetting = "vi" | "en";
export type ResolvedLang = LangSetting;

const enDict: Record<string, string> = {};

/** Merge a batch of Vietnamese→English entries (used by src/locales/en/*). */
export function registerEnTranslations(map: Record<string, string>): void {
  Object.assign(enDict, map);
}

/**
 * The app defaults to Vietnamese (its source language). Anything that is not
 * an explicit "en" — including the removed legacy "auto"/system setting —
 * normalizes back to "vi".
 */
export function normalizeLangSetting(value: string | undefined | null): LangSetting {
  return value === "en" ? "en" : "vi";
}

let setting: LangSetting = "vi";
let resolved: ResolvedLang = "vi";
const listeners = new Set<() => void>();

/** Set the user preference (only an explicit "en" switches the UI). */
export function setLangSetting(next: LangSetting | string): void {
  const s = normalizeLangSetting(next);
  const changed = s !== resolved;
  setting = s;
  resolved = s;
  if (changed) for (const l of listeners) l();
}

export function getLangSetting(): LangSetting {
  return setting;
}

export function getResolvedLang(): ResolvedLang {
  return resolved;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Translate a Vietnamese UI string into the active language.
 * Components must also call {@link useLang} so they re-render on a switch;
 * non-reactive callers (toast dispatch, store notices) resolve at call time.
 */
export function t(vi: string): string {
  if (resolved === "en") return enDict[vi] ?? vi;
  return vi;
}

/** Interpolation helper for dictionary entries with `{placeholders}`. */
export function tf(vi: string, vars: Record<string, string | number>): string {
  let out = t(vi);
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** Reactive hook: re-renders the caller whenever the resolved language flips. */
export function useLang(): ResolvedLang {
  return useSyncExternalStore(subscribe, () => resolved);
}

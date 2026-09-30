import { describe, it, expect } from "vitest";
import {
  getResolvedLang,
  normalizeLangSetting,
  registerEnTranslations,
  setLangSetting,
  t,
  tf,
} from "./i18n";

describe("t()", () => {
  registerEnTranslations({ "Bảng điều khiển": "Dashboard" });

  it("returns the Vietnamese key unchanged when the language is vi", () => {
    setLangSetting("vi");
    expect(t("Bảng điều khiển")).toBe("Bảng điều khiển");
  });

  it("translates known keys when the language is en", () => {
    setLangSetting("en");
    expect(getResolvedLang()).toBe("en");
    expect(t("Bảng điều khiển")).toBe("Dashboard");
  });

  it("falls back to the Vietnamese source for unknown keys", () => {
    setLangSetting("en");
    expect(t("Chuỗi chưa có trong từ điển")).toBe("Chuỗi chưa có trong từ điển");
  });
});

describe("tf()", () => {
  registerEnTranslations({ "Đã lấy {n} model từ {p}": "Fetched {n} models from {p}" });

  it("interpolates placeholders into the translated string", () => {
    setLangSetting("en");
    expect(tf("Đã lấy {n} model từ {p}", { n: 3, p: "OpenAI" })).toBe(
      "Fetched 3 models from OpenAI"
    );
  });

  it("interpolates into the Vietnamese source when lang is vi", () => {
    setLangSetting("vi");
    expect(tf("Đã lấy {n} model từ {p}", { n: 1, p: "Ollama" })).toBe(
      "Đã lấy 1 model từ Ollama"
    );
  });
});

describe("language defaults", () => {
  it("Vietnamese is the default and cannot be flipped by stale values", () => {
    // e.g. the removed "auto"/system setting persisted by an older build
    for (const stale of ["auto", "ja", "ko", "", undefined, null] as const) {
      setLangSetting(stale as string);
      expect(getResolvedLang()).toBe("vi");
    }
  });

  it("explicit en/vi selections are honored and switch reactively", () => {
    setLangSetting("en");
    expect(getResolvedLang()).toBe("en");
    setLangSetting("vi");
    expect(getResolvedLang()).toBe("vi");
  });
});

describe("normalizeLangSetting", () => {
  it("only an explicit 'en' yields en; everything else falls back to vi", () => {
    expect(normalizeLangSetting("en")).toBe("en");
    expect(normalizeLangSetting("vi")).toBe("vi");
    expect(normalizeLangSetting("auto")).toBe("vi");
    expect(normalizeLangSetting("ja")).toBe("vi");
    expect(normalizeLangSetting(undefined)).toBe("vi");
    expect(normalizeLangSetting(null)).toBe("vi");
  });
});

import { useEffect, useMemo, useState } from "react";
import { Boxes, RefreshCw, Search, ShieldAlert, Trash2, Download, Power } from "lucide-react";
import { useStore, MARKETPLACE_CACHE_TTL_MS } from "../store";
import { ToggleRow } from "./SkillsPromptSection";
import { t, tf, useLang } from "../lib/i18n";
import {
  OFFICIAL_MARKETPLACE,
  filterMarketplaceEntries,
  marketplaceCategories,
  pickLocalized,
  trustedIconUrl,
  type MarketplaceEntry,
} from "../lib/plugins";

/** Category names are stable ids in marketplace.json; only the label is translated. */
function categoryLabel(id: string): string {
  switch (id) {
    case "developer-tools":
      return t("Công cụ dev");
    case "productivity":
      return t("Năng suất");
    case "utilities":
      return t("Tiện ích");
    case "finance":
      return t("Tài chính");
    case "guides":
      return t("Tài liệu hướng dẫn");
    default:
      return t("Khác");
  }
}

/** A cached catalog states its own age: a bare clock time would make a list
 *  from last week look like it was fetched a moment ago. */
function formatFetched(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleDateString();
}

export default function PluginsSection() {
  useLang();
  const settings = useStore((s) => s.settings);
  const marketplace = useStore((s) => s.marketplace);
  const pluginContent = useStore((s) => s.pluginContent);
  const pluginBusy = useStore((s) => s.pluginBusy);
  const refreshMarketplace = useStore((s) => s.refreshMarketplace);
  const installPlugin = useStore((s) => s.installPlugin);
  const uninstallPlugin = useStore((s) => s.uninstallPlugin);
  const setPluginEnabled = useStore((s) => s.setPluginEnabled);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");

  const installed = settings.installedPlugins ?? [];
  const disabled = new Set(settings.disabledPlugins ?? []);

  // The catalog is fetched when the tab is first opened, not at boot: it is a
  // network read, and most launches never visit this tab. A cached list still
  // refreshes once it is older than the TTL, so the row is never quietly stale.
  useEffect(() => {
    const stale =
      marketplace.status === "idle" ||
      !marketplace.fetchedAt ||
      Date.now() - marketplace.fetchedAt > MARKETPLACE_CACHE_TTL_MS;
    if (stale) void refreshMarketplace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(
    () => ({
      skills: pluginContent.skills.reduce((n, s) => n + (disabled.has(s.plugin) ? 0 : 1), 0),
      commands: pluginContent.commands.filter((c) => !disabled.has(c.plugin)).length,
    }),
    [pluginContent, disabled]
  );

  const cats = useMemo(() => marketplaceCategories(marketplace.entries), [marketplace.entries]);
  const rows = useMemo(
    () =>
      filterMarketplaceEntries(marketplace.entries, {
        query,
        category,
        installed: installed.map((p) => p.name),
      }),
    [marketplace.entries, query, category, installed]
  );

  const skillsOf = (name: string) => pluginContent.skills.filter((s) => s.plugin === name).length;
  const commandsOf = (name: string) =>
    pluginContent.commands.filter((c) => c.plugin === name).length;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-ui-base font-semibold text-foreground">{t("Plugins")}</h3>
        <p className="text-ui-sm text-foreground-subtle mt-1">
          {t("Cài plugin theo định dạng marketplace của ZCode. Plugin thêm skill và lệnh /… vào agent; lvaigent chỉ đọc phần markdown, không chạy hook hay MCP server của plugin.")}
        </p>
        <div className="flex items-center gap-2 mt-2 text-ui-xs text-foreground-subtlest">
          <Power className="size-3.5 shrink-0" />
          <span className="font-mono">{OFFICIAL_MARKETPLACE.repo}</span>
          <span>· {marketplace.source === OFFICIAL_MARKETPLACE.repo ? OFFICIAL_MARKETPLACE.label : marketplace.source}</span>
          {marketplace.fetchedAt && (
            <span>
              · {t("làm mới lúc")} {formatFetched(marketplace.fetchedAt)}
            </span>
          )}
        </div>
      </div>

      {/* Installed first: turning a plugin off or removing it must be reachable
          without scrolling past the catalog. */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-ui-sm font-semibold text-foreground-subtle uppercase tracking-wider">
            <Boxes className="size-3.5" />
            {tf("Đã cài ({n})", { n: installed.length })}
          </div>
          <button
            onClick={() => void refreshMarketplace()}
            disabled={marketplace.status === "loading"}
            className="h-7 px-2.5 rounded-md text-ui-xs font-medium bg-surface border border-border text-foreground-subtle hover:bg-hover hover:text-foreground transition inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${marketplace.status === "loading" ? "animate-spin" : ""}`} />
            {t("Làm mới catalog")}
          </button>
        </div>

        {installed.length === 0 ? (
          <p className="text-ui-xs text-foreground-subtlest rounded-xl border border-dashed border-border bg-surface px-3 py-2.5">
            {t("Chưa cài plugin nào. Chọn một plugin bên dưới rồi bấm Cài đặt.")}
          </p>
        ) : (
          <div className="space-y-2">
            {installed.map((p) => {
              const on = !disabled.has(p.name);
              return (
                <div key={p.name} className="rounded-xl border border-border bg-surface px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-ui-base font-medium text-foreground">{p.name}</span>
                        <span className="text-ui-xs font-mono text-foreground-subtlest">v{p.version}</span>
                        <span className="text-ui-xs text-foreground-subtlest">{categoryLabel(p.category)}</span>
                      </div>
                      <div className="text-ui-xs text-foreground-subtle mt-0.5 line-clamp-2">{p.description}</div>
                      <div className="text-ui-xs text-foreground-subtlest mt-1">
                        {tf("{skills} skill · {commands} lệnh", {
                          skills: skillsOf(p.name),
                          commands: commandsOf(p.name),
                        })}
                        {p.unsupported.length > 0 && (
                          <span className="text-foreground-subtle">
                            {" "}
                            · {t("không chạy")}: {p.unsupported.join(", ")}
                          </span>
                        )}
                      </div>
                      <div className="text-ui-xs font-mono text-foreground-subtlest mt-1 truncate" title={p.dir}>
                        {p.dir}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => void uninstallPlugin(p.name)}
                        disabled={pluginBusy !== null}
                        className="p-1.5 rounded-md text-foreground-subtlest hover:text-danger hover:bg-hover transition-colors disabled:opacity-40"
                        title={t("Gỡ plugin")}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 border-t border-border/60 pt-1">
                    <ToggleRow
                      title={t("Bật plugin")}
                      desc={on ? t("Skill và lệnh của plugin này đang được gửi cho agent.") : t("Đang tắt — không có gì từ plugin vào prompt.")}
                      value={on}
                      onChange={(v) => setPluginEnabled(p.name, v)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {installed.length > 0 && (
          <p className="text-ui-xs text-foreground-subtlest mt-2 inline-flex items-start gap-1.5">
            <ShieldAlert className="size-3.5 text-warning shrink-0 mt-0.5" />
            {t("Markdown của plugin trở thành chỉ dẫn agent làm theo. Chỉ cài plugin bạn tin nguồn.")}
          </p>
        )}
      </div>

      {/* Catalog */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-ui-sm font-semibold text-foreground-subtle uppercase tracking-wider">
            <Search className="size-3.5" />
            {t("Catalog")}
            {marketplace.entries.length > 0 && (
              <span className="text-foreground-subtlest normal-case font-normal">
                · {rows.length}/{marketplace.entries.length}
              </span>
            )}
          </div>
          {counts.skills + counts.commands > 0 && (
            <span className="text-ui-xs text-foreground-subtlest">
              {tf("Đang bật: {skills} skill, {commands} lệnh", {
                skills: counts.skills,
                commands: counts.commands,
              })}
            </span>
          )}
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Tìm plugin…")}
          className="w-full h-8 rounded-lg bg-surface border border-border px-2.5 text-ui-sm text-foreground placeholder:text-foreground-subtlest focus:outline-none focus:border-primary/60"
        />

        {cats.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            <button
              onClick={() => setCategory("all")}
              className={`h-6 px-2 rounded-full text-ui-xs border transition ${
                category === "all"
                  ? "border-primary text-foreground bg-primary/10"
                  : "border-border text-foreground-subtle hover:bg-hover"
              }`}
            >
              {t("Tất cả")}
            </button>
            {cats.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={`h-6 px-2 rounded-full text-ui-xs border transition ${
                  category === c.id
                    ? "border-primary text-foreground bg-primary/10"
                    : "border-border text-foreground-subtle hover:bg-hover"
                }`}
              >
                {categoryLabel(c.id)} ({c.count})
              </button>
            ))}
          </div>
        )}

        {marketplace.status === "loading" && marketplace.entries.length === 0 && (
          <p className="text-ui-xs text-foreground-subtlest mt-3">{t("Đang tải catalog…")}</p>
        )}
        {marketplace.status === "error" && (
          <p className="text-ui-xs text-danger mt-3 rounded-lg border border-danger/40 bg-danger/5 px-2.5 py-2">
            {t("Không tải được catalog")}: {marketplace.error}
          </p>
        )}

        {marketplace.entries.length > 0 && rows.length === 0 && (
          <p className="text-ui-xs text-foreground-subtlest mt-3">
            {t("Không có plugin nào khớp bộ lọc này.")}
          </p>
        )}

        <div className="space-y-2 mt-2">
          {rows.map((entry) => (
            <CatalogRow
              key={entry.name}
              entry={entry}
              lang={settings.language}
              installed={installed.some((p) => p.name === entry.name)}
              busy={pluginBusy === entry.name}
              anyBusy={pluginBusy !== null}
              onInstall={() => void installPlugin(entry.name)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function CatalogRow({
  entry,
  lang,
  installed,
  busy,
  anyBusy,
  onInstall,
}: {
  entry: MarketplaceEntry;
  lang: string;
  installed: boolean;
  busy: boolean;
  anyBusy: boolean;
  onInstall: () => void;
}) {
  const description = pickLocalized(lang, entry.descriptionI18n, entry.description);
  const iconSrc = trustedIconUrl(entry.icon);
  return (
    <div className="rounded-xl border border-border bg-surface px-3 py-2.5 flex items-start gap-3">
      <div className="size-9 rounded-lg border border-border bg-hover shrink-0 overflow-hidden grid place-items-center">
        {iconSrc ? (
          // Remote icon, host-checked: the catalog names these, and an arbitrary
          // URL here would be an outbound request the app did not choose.
          <img src={iconSrc} alt="" className="size-full object-contain" loading="lazy" />
        ) : (
          <Boxes className="size-4 text-foreground-subtlest" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-ui-base font-medium text-foreground">
            {entry.displayName ?? entry.name}
          </span>
          <span className="text-ui-xs font-mono text-foreground-subtlest">v{entry.version}</span>
          <span className="text-ui-xs text-foreground-subtlest">{categoryLabel(entry.category)}</span>
          {entry.source.kind === "archive" && (
            <span className="text-ui-xs text-warning">{t("chỉ phát hành dạng zip")}</span>
          )}
        </div>
        <p className="text-ui-xs text-foreground-subtle mt-1 line-clamp-3">{description}</p>
        {entry.author?.name && (
          <p className="text-ui-xs text-foreground-subtlest mt-1">
            {t("Tác giả")}: {entry.author.name}
          </p>
        )}
      </div>
      <button
        onClick={onInstall}
        disabled={installed || anyBusy || entry.source.kind === "archive"}
        className="h-7 px-2.5 rounded-md text-ui-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition inline-flex items-center gap-1.5 disabled:opacity-40 shrink-0"
      >
        <Download className="size-3.5" />
        {installed ? t("Đã cài") : busy ? t("Đang cài…") : t("Cài đặt")}
      </button>
    </div>
  );
}

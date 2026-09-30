import { registerEnTranslations } from "../../lib/i18n";
import chat from "./chat";
import plugins from "./plugins";
import review from "./review";
import settings from "./settings";
import sidebar from "./sidebar";
import store from "./store";

/**
 * Aggregated English dictionary, split by UI domain so each surface can be
 * translated without merge conflicts. Imported once from main.tsx before the
 * first render; `t()` falls back to the Vietnamese key for anything missing.
 */
registerEnTranslations({
  ...store,
  ...sidebar,
  ...settings,
  ...chat,
  ...plugins,
  ...review,
});

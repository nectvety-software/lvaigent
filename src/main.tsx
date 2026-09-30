import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./locales/en";
import { getLangSetting, setLangSetting } from "./lib/i18n";
import "./index.css";

// The store resolved the language before the dictionary was registered;
// re-run it now so an already-English user never sees a Vietnamese flash.
setLangSetting(getLangSetting());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

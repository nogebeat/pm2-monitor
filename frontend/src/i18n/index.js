import { createI18n } from "vue-i18n";
import fr from "./locales/fr.json";
import en from "./locales/en.json";

const STORAGE_KEY = "pm2-monitor-locale";
const SUPPORTED = ["fr", "en"];

function detectLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED.includes(stored)) return stored;
  } catch (e) {
    /* localStorage indisponible : on retombe sur la détection navigateur */
  }
  const nav = (navigator.language || "fr").slice(0, 2).toLowerCase();
  return SUPPORTED.includes(nav) ? nav : "fr";
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { fr, en },
});

export function setLocale(locale) {
  if (!SUPPORTED.includes(locale)) return;
  i18n.global.locale.value = locale;
  document.documentElement.setAttribute("lang", locale);
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch (e) {
    /* stockage indisponible : la langue reste appliquée pour la session en cours */
  }
}

document.documentElement.setAttribute("lang", i18n.global.locale.value);

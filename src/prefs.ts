// App language and theme. Persisted on the Rust side (settings.json): in release the window
// origin changes on every launch (random port), so localStorage cannot be used.
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { Lang, setLang } from "./i18n";

export type Theme = "light" | "dark";

export const prefs = { lang: "en" as Lang, theme: "light" as Theme, zoom: 1 };

/** Zoom steps, like browsers use. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const systemLang = (): Lang => (navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en");

export function applyTheme(theme: Theme): void {
  prefs.theme = theme;
  document.documentElement.dataset.theme = theme;
  // read by adrix-plugin.php (same origin) to theme Adminer
  document.cookie = `adrix_theme=${theme}; path=/; SameSite=Strict; max-age=31536000`;
  // native title bar; raw IPC call so we don't bundle the whole @tauri-apps/api/window module
  invoke("plugin:window|set_theme", { label: "main", value: theme }).catch(() => {});
}

/** Zooms the whole webview (app UI and Adminer iframes). */
export function applyZoom(zoom: number): void {
  prefs.zoom = Math.min(Math.max(zoom, ZOOM_STEPS[0]), ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  invoke("plugin:webview|set_webview_zoom", { label: "main", value: prefs.zoom }).catch(console.error);
}

export function applyLang(lang: Lang): void {
  prefs.lang = lang;
  setLang(lang);
}

export function initPrefs(saved?: { lang: string; theme: string; zoom: number }): void {
  if (saved?.zoom && saved.zoom !== 1) applyZoom(saved.zoom);
  applyLang(saved?.lang === "ru" || saved?.lang === "en" ? saved.lang : systemLang());
  applyTheme(saved?.theme === "light" || saved?.theme === "dark" ? saved.theme : systemDark() ? "dark" : "light");
}

export function savePrefs(): Promise<void> {
  return api.saveSettings({ lang: prefs.lang, theme: prefs.theme, zoom: prefs.zoom });
}

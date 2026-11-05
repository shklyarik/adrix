import "./styles.css";
import { api, AppInfo, Connection, describe, SessionInfo } from "./api";
import { h } from "./dom";
import { Finder } from "./find";
import { openConnectionForm } from "./form";
import { Lang, t } from "./i18n";
import { applyLang, applyTheme, applyZoom, initPrefs, prefs, savePrefs, Theme, ZOOM_STEPS } from "./prefs";

interface Tab {
  key: string; // unique within the UI
  conn: Connection;
  session: SessionInfo | null;
  el: HTMLButtonElement; // button in the tab strip
  pane: HTMLDivElement; // content: iframe or error
  frame: HTMLIFrameElement | null;
  finder: Finder;
  findQuery: string;
  status: Status;
}

type Status = "idle" | "connecting" | "connected" | "error";

const DRIVER_BADGE: Record<Connection["driver"], string> = { mysql: "mysql", pgsql: "pg", sqlite: "sqlite" };

/** Connection status for the sidebar dot, derived from its open tabs. */
function connStatus(id: string): Status {
  const tabs = state.tabs.filter((t) => t.conn.id === id);
  if (tabs.some((t) => t.status === "connected")) return "connected";
  if (tabs.some((t) => t.status === "connecting")) return "connecting";
  if (tabs.some((t) => t.status === "error")) return "error";
  return "idle";
}

const state = {
  connections: [] as Connection[],
  tabs: [] as Tab[],
  active: null as Tab | null,
  filter: "",
  info: null as AppInfo | null,
};

// ───────────────────────── layout ─────────────────────────

const connList = h("ul", { class: "conn-list" });
const tabBar = h("div", { class: "tabs" });
const panes = h("div", { class: "panes" });
const welcome = h("div", { class: "welcome" });

const findInput = h("input", { type: "text", spellcheck: false });
const findCount = h("span", { class: "find-count" });
const findBar = h("div", { class: "find-bar hidden" },
  findInput,
  findCount,
  h("button", { class: "ghost icon", "data-t": "find.prev", onclick: () => findStep(-1) }, "↑"),
  h("button", { class: "ghost icon", "data-t": "find.next", onclick: () => findStep(1) }, "↓"),
  h("button", { class: "ghost icon", "data-t": "find.close", onclick: () => closeFind() }, "✕"),
);

const sidebar = h("aside", { class: "sidebar" },
  h("div", { class: "brand" },
    h("button", { class: "ghost icon collapse-btn", onclick: () => setCollapsed(!collapsed) }, "‹"),
    h("span", { class: "logo" }, "Adrix"),
    h("button", { class: "ghost icon new-btn", "data-t": "side.new", onclick: () => editConnection(null) }, "+"),
  ),
  h("input", { class: "search", type: "search", "data-tp": "side.search", oninput: (e: Event) => {
    state.filter = (e.target as HTMLInputElement).value.toLowerCase();
    renderConnections();
  } }),
  connList,
  h("div", { class: "side-footer" }),
);
const sideFooter = sidebar.querySelector<HTMLDivElement>(".side-footer")!;

document.getElementById("app")!.append(
  sidebar,
  h("main", { class: "main" }, tabBar, h("div", { class: "content" }, welcome, panes, findBar)),
);

// ───────────────────────── connections ─────────────────────────

function renderConnections(): void {
  // user-defined order (drag & drop); the filter keeps that order
  const items = state.connections.filter(
    (c) => !state.filter || `${c.name} ${describe(c)}`.toLowerCase().includes(state.filter),
  );

  connList.replaceChildren(
    ...items.map((c) =>
      h("li", {
        class: `conn ${state.active?.conn.id === c.id ? "active" : ""}`,
        title: describe(c),
        "data-id": c.id,
        onclick: (e: MouseEvent) => !suppressClick && openTab(c, e.ctrlKey || e.metaKey),
        onauxclick: (e: MouseEvent) => e.button === 1 && openTab(c, true),
        onpointerdown: (e: PointerEvent) => { hideTip(); startDrag(e); },
        onpointerenter: (e: PointerEvent) => collapsed && showTip(e.currentTarget as HTMLElement, c),
        onpointerleave: hideTip,
      },
        h("span", { class: `dot ${connStatus(c.id)}` }),
        h("span", { class: "avatar", style: `--hue:${hue(c.name)}` }, initials(c.name), h("span", { class: `dot ${connStatus(c.id)}` })),
        h("div", { class: "conn-text" },
          h("div", { class: "conn-name" },
            h("span", { class: "conn-title" }, c.name),
            h("span", { class: "badge" }, DRIVER_BADGE[c.driver]),
            c.ssh ? h("span", { class: "badge" }, "ssh") : null,
          ),
          h("div", { class: "conn-sub" }, describe(c)),
        ),
        h("button", { class: "ghost icon edit", title: t("side.edit"), onclick: (e: Event) => { e.stopPropagation(); editConnection(c); } }, "✎"),
      ),
    ),
  );
  if (!state.connections.length) {
    connList.append(h("li", { class: "empty" }, t("side.empty")));
  }
  renderWelcome();
}

// ───────────────────────── collapsible sidebar ─────────────────────────

let collapsed = false;

function setCollapsed(value: boolean): void {
  collapsed = value;
  hideTip();
  document.body.classList.toggle("sidebar-collapsed", value);
  const btn = sidebar.querySelector<HTMLButtonElement>(".collapse-btn")!;
  btn.textContent = value ? "›" : "‹";
  btn.title = t(value ? "side.expand" : "side.collapse");
}

/** Up to two letters: first letters of the first two words ("CP2 [PROD]" → "CP"). */
function initials(name: string): string {
  const words = name.replace(/[[\](){}]/g, " ").trim().split(/[\s_-]+/).filter(Boolean);
  const s = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return s.toUpperCase();
}

/** Stable colour per name for avatars. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// tooltip for the collapsed rail (a floating element: the sidebar clips overflow)
const tip = h("div", { class: "rail-tip hidden" });
document.body.append(tip);

function showTip(el: HTMLElement, c: Connection): void {
  const r = el.getBoundingClientRect();
  tip.replaceChildren(h("div", { class: "tip-name" }, c.name), h("div", { class: "tip-sub" }, describe(c)));
  tip.style.top = `${r.top + r.height / 2}px`;
  tip.style.left = `${r.right + 8}px`;
  tip.classList.remove("hidden");
}

function hideTip(): void {
  tip.classList.add("hidden");
}

// ───────────────────────── drag & drop ordering ─────────────────────────
// Pointer events instead of HTML5 DnD: Tauri's file-drop handler breaks HTML5 DnD on Windows.

let suppressClick = false;

function startDrag(e: PointerEvent): void {
  const li = e.currentTarget as HTMLLIElement;
  if (e.button !== 0 || state.filter || (e.target as HTMLElement).closest("button")) return;
  const startY = e.clientY;
  let dragging = false;

  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(ev.clientY - startY) < 5) return;
      dragging = true;
      li.setPointerCapture(ev.pointerId);
      li.classList.add("dragging");
      connList.classList.add("sorting");
    }
    // live reorder: move the item before the first sibling whose middle is below the pointer
    const others = [...connList.querySelectorAll<HTMLLIElement>("li.conn")].filter((x) => x !== li);
    const before = others.find((x) => {
      const r = x.getBoundingClientRect();
      return ev.clientY < r.top + r.height / 2;
    });
    if (before) {
      if (li.nextElementSibling !== before) connList.insertBefore(li, before);
    } else if (connList.lastElementChild !== li) {
      connList.append(li);
    }
  };

  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (!dragging) return;
    li.classList.remove("dragging");
    connList.classList.remove("sorting");
    suppressClick = true;
    setTimeout(() => (suppressClick = false));
    const ids = [...connList.querySelectorAll<HTMLLIElement>("li.conn")].map((x) => x.dataset.id!);
    state.connections.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    api.reorder(ids).catch(console.error);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

async function reloadConnections(): Promise<void> {
  state.connections = await api.list();
  renderConnections();
}

async function editConnection(c: Connection | null): Promise<void> {
  const res = await openConnectionForm(c);
  if (res.saved || res.deletedId) await reloadConnections();
  if (res.saved) {
    for (const t of state.tabs) if (t.conn.id === res.saved.id) t.conn = res.saved;
    renderTabs();
  }
}

function renderWelcome(): void {
  welcome.replaceChildren(h("div", {},
    h("h1", {}, "Adrix"),
    h("p", {}, t("app.tagline")),
    h("button", { class: "primary", onclick: () => editConnection(null) }, t("welcome.new")),
    h("dl", { class: "keys" },
      ...[
        ["Ctrl+N", t("keys.new")],
        ["Ctrl+F", t("keys.find")],
        ["Ctrl+W", t("keys.close")],
        ["Ctrl+Tab", t("keys.next")],
        ["Ctrl+1…9", t("keys.num")],
        ["F5 / Ctrl+R", t("keys.reload")],
        ["Ctrl+B", t("keys.sidebar")],
        ["Ctrl+= / Ctrl+- / Ctrl+0", t("keys.zoom")],
        [t("keys.dup"), t("keys.dupText")],
      ].flatMap(([k, v]) => [h("dt", {}, h("kbd", {}, k)), h("dd", {}, v)]),
    ),
    state.info && !state.info.keyringOk
      ? h("p", { class: "warn" }, t("app.keyringWarn"))
      : null,
    state.info ? h("p", { class: "muted" }, `v${state.info.version}`) : null,
  ));
}

// ───────────────────────── tabs ─────────────────────────

let tabSeq = 0;

function openTab(conn: Connection, forceNew = false): void {
  setCollapsed(true); // more room for Adminer; hover the rail to see names
  const existing = !forceNew && state.tabs.find((t) => t.conn.id === conn.id);
  if (existing) return activate(existing);

  const key = `t${++tabSeq}`;
  const tab: Tab = {
    key,
    conn,
    session: null,
    el: h("button", { class: "tab" }),
    pane: h("div", { class: "pane" }),
    frame: null,
    finder: new Finder(),
    findQuery: "",
    status: "connecting",
  };
  tab.el.addEventListener("click", () => activate(tab));
  tab.el.addEventListener("auxclick", (e) => e.button === 1 && closeTab(tab));
  state.tabs.push(tab);
  panes.append(tab.pane);
  activate(tab);
  connect(tab);
}

async function connect(tab: Tab): Promise<void> {
  tab.pane.replaceChildren(h("div", { class: "pane-msg" }, h("div", { class: "spinner" }), t("tab.connecting", { name: tab.conn.name })));
  setStatus(tab, "connecting");
  try {
    tab.session = await api.openSession(tab.conn.id);
  } catch (e) {
    if (!state.tabs.includes(tab)) return;
    setStatus(tab, "error");
    tab.pane.replaceChildren(
      h("div", { class: "pane-msg error" },
        h("pre", {}, String(e)),
        h("div", {},
          h("button", { class: "primary", onclick: () => connect(tab) }, t("tab.retry")),
          " ",
          h("button", { class: "ghost", onclick: () => editConnection(tab.conn) }, t("tab.settings")),
        ),
      ),
    );
    return;
  }
  if (!state.tabs.includes(tab)) {
    // the tab was closed while connecting
    api.closeSession(tab.session.sessionId);
    return;
  }
  setStatus(tab, "connected");
  mountFrame(tab, tab.session);
}

function setStatus(tab: Tab, status: Status): void {
  tab.status = status;
  renderTabs();
  renderConnections();
}

/** iframe + POST of Adminer's login form into it (the password never appears in a URL). */
function mountFrame(tab: Tab, s: SessionInfo): void {
  const name = `adminer-${s.sessionId}`;
  const frame = h("iframe", { name, src: "about:blank", class: "frame" });
  frame.addEventListener("load", () => onFrameLoad(tab));
  tab.frame = frame;
  tab.pane.replaceChildren(frame);

  const form = h("form", { method: "post", action: "/adminer/", target: name, class: "hidden" });
  const fields: Record<string, string> = {
    "auth[driver]": s.driver,
    "auth[server]": s.server,
    "auth[username]": s.username,
    "auth[password]": s.password,
    "auth[db]": s.database,
    "auth[adrix]": s.token,
  };
  for (const [k, v] of Object.entries(fields)) form.append(h("input", { type: "hidden", name: k, value: v }));
  document.body.append(form);
  form.submit();
  form.remove();
}

function frameDoc(tab: Tab | null): Document | null {
  try {
    const doc = tab?.frame?.contentDocument;
    return doc && doc.URL !== "about:blank" ? doc : null;
  } catch {
    return null; // different origin (should not happen)
  }
}

function onFrameLoad(tab: Tab): void {
  const doc = frameDoc(tab);
  if (!doc) return;
  // shortcuts also work while focus is inside Adminer
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("wheel", onWheel, { capture: true, passive: false });
  tab.el.title = doc.title;
  tab.finder.attach(doc);
  if (state.active === tab && !findBar.classList.contains("hidden") && tab.findQuery) {
    showFindResult(tab.finder.refresh());
  }
}

function activate(tab: Tab): void {
  if (state.active && state.active !== tab) state.active.finder.clear();
  state.active = tab;
  for (const t of state.tabs) t.pane.classList.toggle("visible", t === tab);
  renderTabs();
  renderConnections();
  if (!findBar.classList.contains("hidden")) {
    findInput.value = tab.findQuery;
    showFindResult(tab.finder.search(tab.findQuery));
  }
  tab.frame?.focus();
}

function closeTab(tab: Tab): void {
  const i = state.tabs.indexOf(tab);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  tab.pane.remove();
  if (tab.session) api.closeSession(tab.session.sessionId);
  if (state.active === tab) {
    state.active = null;
    const next = state.tabs[i] ?? state.tabs[i - 1];
    if (next) activate(next);
    else closeFind();
  }
  // last connection closed: bring the full connection list back
  if (!state.tabs.length) setCollapsed(false);
  renderTabs();
  renderConnections();
}

function renderTabs(): void {
  const counts = new Map<string, number>();
  tabBar.replaceChildren(
    ...state.tabs.map((tab) => {
      const n = (counts.get(tab.conn.id) ?? 0) + 1;
      counts.set(tab.conn.id, n);
      tab.el.className = `tab ${tab === state.active ? "active" : ""}`;
      tab.el.replaceChildren(
        h("span", { class: `dot ${tab.status}` }),
        h("span", { class: "tab-name" }, tab.conn.name + (n > 1 ? ` (${n})` : "")),
        h("span", { class: "tab-close", title: t("tab.close"), onclick: (e: Event) => { e.stopPropagation(); closeTab(tab); } }, "×"),
      );
      return tab.el;
    }),
  );
  welcome.classList.toggle("hidden", state.tabs.length > 0);
  // .panes covers the whole content area; hide it without tabs or it swallows clicks on the welcome screen
  panes.classList.toggle("hidden", state.tabs.length === 0);
}

function reloadActive(): void {
  const tab = state.active;
  if (!tab) return;
  if (!tab.session) return void connect(tab);
  reloadFrame(tab);
}

/** Reload via GET of the current URL: reload() would re-send a POST (e.g. an SQL command). */
function reloadFrame(tab: Tab): void {
  try {
    const loc = tab.frame?.contentWindow?.location;
    if (loc && loc.href !== "about:blank") loc.replace(loc.href);
  } catch {
    connect(tab);
  }
}

// ───────────────────────── find ─────────────────────────

function openFind(): void {
  if (!state.active) return;
  findBar.classList.remove("hidden");
  const sel = frameDoc(state.active)?.getSelection()?.toString().trim();
  if (sel && !sel.includes("\n") && sel.length < 200) findInput.value = sel;
  findInput.focus();
  findInput.select();
  runFind();
}

function closeFind(): void {
  findBar.classList.add("hidden");
  state.active?.finder.clear();
  state.active?.frame?.focus();
}

let findTimer = 0;
function runFind(): void {
  const tab = state.active;
  if (!tab) return;
  tab.findQuery = findInput.value;
  showFindResult(tab.finder.search(tab.findQuery));
}

function findStep(dir: 1 | -1): void {
  if (state.active) showFindResult(state.active.finder.step(dir));
}

function showFindResult(r: { count: number; index: number; capped: boolean }): void {
  findCount.textContent = findInput.value ? `${r.count ? r.index + 1 : 0}/${r.count}${r.capped ? "+" : ""}` : "";
  findBar.classList.toggle("nomatch", !!findInput.value && r.count === 0);
}

findInput.addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = window.setTimeout(runFind, 120);
});
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(findTimer);
    if (state.active?.findQuery !== findInput.value) runFind();
    else findStep(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});

// ───────────────────────── keyboard ─────────────────────────

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  let handled = true;

  if (mod && !e.shiftKey && (key === "f" || e.code === "KeyF")) openFind();
  else if (e.key === "F3" || (mod && (key === "g" || e.code === "KeyG"))) {
    if (findBar.classList.contains("hidden")) openFind();
    else findStep(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape" && !findBar.classList.contains("hidden")) closeFind();
  else if (mod && (key === "w" || e.code === "KeyW")) state.active && closeTab(state.active);
  else if (mod && e.key === "Tab") cycleTab(e.shiftKey ? -1 : 1);
  else if (mod && e.key === "PageDown") cycleTab(1);
  else if (mod && e.key === "PageUp") cycleTab(-1);
  else if (mod && /^[1-9]$/.test(e.key)) {
    const t = e.key === "9" ? state.tabs.at(-1) : state.tabs[Number(e.key) - 1];
    if (t) activate(t);
  } else if (e.key === "F5" || (mod && (key === "r" || e.code === "KeyR"))) reloadActive();
  else if (mod && (key === "n" || e.code === "KeyN")) editConnection(null);
  else if (mod && (key === "b" || e.code === "KeyB")) setCollapsed(!collapsed);
  else if (mod && (key === "=" || key === "+" || e.code === "Equal" || e.code === "NumpadAdd")) zoomStep(1);
  else if (mod && (key === "-" || e.code === "Minus" || e.code === "NumpadSubtract")) zoomStep(-1);
  else if (mod && (key === "0" || e.code === "Digit0" || e.code === "Numpad0")) setZoom(1);
  else handled = false;

  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function cycleTab(dir: 1 | -1): void {
  if (!state.tabs.length) return;
  const i = state.active ? state.tabs.indexOf(state.active) : -1;
  activate(state.tabs[(i + dir + state.tabs.length) % state.tabs.length]);
}

window.addEventListener("keydown", onKeyDown, true);
window.addEventListener("wheel", onWheel, { capture: true, passive: false });

// ───────────────────────── zoom ─────────────────────────

const zoomBadge = h("div", { class: "zoom-badge hidden" });
document.body.append(zoomBadge);
let zoomBadgeTimer = 0;
let zoomSaveTimer = 0;

function setZoom(z: number): void {
  applyZoom(z);
  zoomBadge.textContent = `${Math.round(prefs.zoom * 100)}%`;
  zoomBadge.classList.remove("hidden");
  clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = window.setTimeout(() => zoomBadge.classList.add("hidden"), 1200);
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = window.setTimeout(() => savePrefs().catch(console.error), 400);
}

function zoomStep(dir: 1 | -1): void {
  const cur = prefs.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.001);
  if (next) setZoom(next);
}

let wheelLock = 0;
function onWheel(e: WheelEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  // touchpads fire many small events; one step per ~120 ms
  const now = performance.now();
  if (now - wheelLock < 120 || e.deltaY === 0) return;
  wheelLock = now;
  zoomStep(e.deltaY < 0 ? 1 : -1);
}

// ───────────────────────── boot ─────────────────────────

// ───────────────────────── language / theme ─────────────────────────

/** Static labels: data-t → title, data-tp → placeholder. */
function relabel(): void {
  findInput.placeholder = t("find.placeholder");
  for (const el of document.querySelectorAll<HTMLElement>("[data-t]")) el.title = t(el.dataset.t as never);
  for (const el of document.querySelectorAll<HTMLInputElement>("[data-tp]")) el.placeholder = t(el.dataset.tp as never);
  renderFooter();
  renderTabs();
  renderConnections();
}

function renderFooter(): void {
  const seg = <T extends string>(label: string, value: T, options: [T, string][], onpick: (v: T) => void) =>
    h("div", { class: "seg", title: label, role: "group" },
      ...options.map(([v, text]) =>
        h("button", { class: v === value ? "on" : "", onclick: () => onpick(v) }, text),
      ),
    );
  sideFooter.replaceChildren(
    seg<Theme>(t("side.theme"), prefs.theme, [["light", "☀ " + t("theme.light")], ["dark", "☾ " + t("theme.dark")]], setTheme),
    seg<Lang>(t("side.lang"), prefs.lang, [["en", "EN"], ["ru", "RU"]], setLanguage),
    // compact toggles shown only in the collapsed rail
    h("button", { class: "ghost icon rail-only", title: t("side.theme"), onclick: () => setTheme(prefs.theme === "dark" ? "light" : "dark") },
      prefs.theme === "dark" ? "☾" : "☀"),
    h("button", { class: "ghost icon rail-only rail-lang", title: t("side.lang"), onclick: () => setLanguage(prefs.lang === "ru" ? "en" : "ru") },
      prefs.lang.toUpperCase()),
  );
  setCollapsed(collapsed); // refresh the collapse button title for the new language
}

function setTheme(theme: Theme): void {
  if (theme === prefs.theme) return;
  applyTheme(theme);
  savePrefs().catch(console.error);
  renderFooter();
  // Adminer reads the theme cookie on page load
  for (const tab of state.tabs) reloadFrame(tab);
}

function setLanguage(lang: Lang): void {
  if (lang === prefs.lang) return;
  applyLang(lang);
  savePrefs().catch(console.error);
  relabel();
}

(async () => {
  try {
    state.info = await api.appInfo();
  } catch (e) {
    console.error(e);
  }
  initPrefs(state.info?.settings);
  relabel();
  await reloadConnections();
})();

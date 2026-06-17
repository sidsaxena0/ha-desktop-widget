import { getCurrentWindow } from "@tauri-apps/api/window";
import { activeProfile, setSortBy } from "./actions";
import { cardUpdaters, entityLabel, renderCustomize } from "./components/card";
import { renderDetail } from "./components/detail";
import { computeRooms, renderGrid } from "./components/grid";
import { renderOnboarding } from "./components/onboarding";
import { renderSettings } from "./components/settings";
import { api, events } from "./ha";
import { patchState, setAreas, setStates, state, type View } from "./store";
import "./vendor/mdi.css";
import "./styles.css";
import { domainOf, type Theme } from "./types";
import { el } from "./util";

const appRoot = document.getElementById("app")!;
let bodyEl: HTMLElement | null = null;
let dotEl: HTMLElement | null = null;
let bannerEl: HTMLElement | null = null;

function currentTheme(): Theme {
  return state.config?.settings.theme === "dark" ? "dark" : "light";
}
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

function setView(v: View) {
  state.view = v;
  renderShell();
}
function renderShellIfGrid() {
  if (state.view !== "grid") return;
  const top = bodyEl?.scrollTop ?? 0;
  renderShell();
  if (bodyEl) bodyEl.scrollTop = top;
}

// ---- top-level structure ----

function renderShell() {
  appRoot.innerHTML = "";

  if (state.view === "onboarding") {
    appRoot.append(topbar(false), renderOnboarding(() => setView("grid")));
    return;
  }

  appRoot.appendChild(topbar(true));
  if (state.view === "grid") appRoot.appendChild(renderTabs());
  if (state.view === "grid" && state.searchOpen) appRoot.appendChild(renderSearchRow());

  bannerEl = el("div", { class: "banner hidden" });
  appRoot.appendChild(bannerEl);

  bodyEl = el("div", { class: "body" });
  if (state.view === "settings") bodyEl.appendChild(renderSettings(() => setView("grid")));
  else bodyEl.appendChild(renderGrid(activeProfile(), state.states, state.activeRoom));
  appRoot.appendChild(bodyEl);

  updateStatus();
}

function topbar(full: boolean): HTMLElement {
  const bar = el("div", { class: "topbar", attrs: { "data-tauri-drag-region": "" } });
  bar.appendChild(renderSwitcher());

  if (full) {
    const btns = el("div", { class: "tb-btns" });
    const mk = (mdiName: string, title: string, fn: () => void, active = false) => {
      const b = el("button", {
        class: `tb ${active ? "active" : ""}`,
        html: `<i class="mdi mdi-${mdiName}" aria-hidden="true"></i>`,
        attrs: { title },
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const dark = currentTheme() === "dark";
    const pinned = !!state.config?.settings.alwaysOnTop;
    const searching = state.searchOpen || !!state.search.trim();
    btns.append(
      mk("magnify", "Search", () => toggleSearch(), searching),
      renderSortControl(),
      mk(dark ? "white-balance-sunny" : "weather-night", "Toggle theme", () => void toggleTheme()),
      mk(pinned ? "pin" : "pin-off", pinned ? "Always on top: on" : "Always on top: off", () => void toggleAlwaysOnTop(), pinned),
      mk("cog-outline", "Settings", () => setView(state.view === "settings" ? "grid" : "settings")),
    );
    bar.appendChild(btns);
  }
  return bar;
}

async function toggleAlwaysOnTop() {
  if (!state.config) return;
  const next = !state.config.settings.alwaysOnTop;
  state.config.settings.alwaysOnTop = next;
  try {
    await getCurrentWindow().setAlwaysOnTop(next);
  } catch {
    /* ignore */
  }
  renderShell();
  await api.saveConfig(state.config);
}

// House switcher in the topbar: the active house name; if there's more than
// one house it becomes a dropdown to pin any house (or resume auto-switch).
function renderSwitcher(): HTMLElement {
  const profiles = state.config?.profiles ?? [];
  const wrap = el("div", { class: "switcher" });

  const btn = el("button", { class: "brand-btn" });
  dotEl = el("span", { class: "dot" });
  btn.append(dotEl, el("span", { class: "brand-name", text: activeProfile()?.name ?? "HA Widget" }));
  if (profiles.length > 1) {
    btn.appendChild(el("i", { class: "mdi mdi-chevron-down caret", attrs: { "aria-hidden": "true" } }));
  }
  wrap.appendChild(btn);

  if (profiles.length <= 1) return wrap;

  const menu = el("div", { class: "switcher-menu hidden" });
  const item = (label: string, checked: boolean, fn: () => void) => {
    const it = el("button", { class: `switcher-item ${checked ? "checked" : ""}`, text: label });
    it.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.add("hidden");
      fn();
    });
    return it;
  };

  menu.appendChild(item("Auto-switch", !state.manualOverride, () => void api.resumeAutoSwitch()));
  for (const p of profiles) {
    menu.appendChild(
      item(p.name || "(unnamed)", state.manualOverride === p.id, () =>
        void api.setActiveProfile(p.id),
      ),
    );
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden");
    if (opening) {
      setTimeout(() => document.addEventListener("click", () => menu.classList.add("hidden"), { once: true }), 0);
    }
  });
  wrap.appendChild(menu);
  return wrap;
}

function renderTabs(): HTMLElement {
  const wrap = el("div", { class: "tabs" });
  const rooms = computeRooms(state.states);
  const favCount = activeProfile()?.favorites.length ?? 0;

  const tabDefs: { id: string; name: string }[] = [{ id: "all", name: "All" }];
  if (favCount > 0) tabDefs.push({ id: "fav", name: "★ Favorites" });
  for (const r of rooms) tabDefs.push({ id: r.id, name: r.name });

  if (!tabDefs.some((t) => t.id === state.activeRoom)) state.activeRoom = "all";

  for (const t of tabDefs) {
    const tab = el("button", {
      class: `tab ${t.id === state.activeRoom ? "active" : ""}`,
      text: t.name,
    });
    tab.addEventListener("click", () => {
      state.activeRoom = t.id;
      renderShell();
    });
    wrap.appendChild(tab);
  }
  return wrap;
}

// Sort menu (Name / Manual), anchored under its toolbar button.
function renderSortControl(): HTMLElement {
  const wrap = el("div", { class: "switcher" });
  const btn = el("button", { class: "tb", html: `<i class="mdi mdi-sort" aria-hidden="true"></i>`, attrs: { title: "Sort" } });
  wrap.appendChild(btn);

  const menu = el("div", { class: "switcher-menu right hidden" });
  const cur = activeProfile()?.sortBy ?? "name";
  const item = (label: string, val: "name" | "manual") => {
    const it = el("button", { class: `switcher-item ${cur === val ? "checked" : ""}`, text: label });
    it.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.add("hidden");
      setSortBy(val);
      renderShell();
    });
    return it;
  };
  menu.append(item("Name (A–Z)", "name"), item("Manual (drag to reorder)", "manual"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden");
    if (opening) {
      setTimeout(() => document.addEventListener("click", () => menu.classList.add("hidden"), { once: true }), 0);
    }
  });
  wrap.appendChild(menu);
  return wrap;
}

function toggleSearch() {
  state.searchOpen = !state.searchOpen;
  if (!state.searchOpen) state.search = "";
  renderShell();
}

function renderSearchRow(): HTMLElement {
  const row = el("div", { class: "search-row" });
  const input = el("input", { class: "search-input", attrs: { type: "text", placeholder: "Search devices…" } });
  input.value = state.search;
  input.addEventListener("input", () => {
    state.search = input.value;
    refreshGrid();
  });
  const clear = el("button", { class: "tb", html: `<i class="mdi mdi-close" aria-hidden="true"></i>`, attrs: { title: "Close search" } });
  clear.addEventListener("click", () => toggleSearch());
  row.append(input, clear);
  setTimeout(() => input.focus(), 0);
  return row;
}

// ---- in-place refreshers ----

function refreshGrid() {
  if (state.view !== "grid" || !bodyEl) return;
  const top = bodyEl.scrollTop;
  bodyEl.innerHTML = "";
  bodyEl.appendChild(renderGrid(activeProfile(), state.states, state.activeRoom));
  bodyEl.scrollTop = top;
}

// ---- entity detail sheet ----

let detailEl: HTMLElement | null = null;
function openDetail(entityId: string) {
  closeDetail();
  const st = state.states.get(entityId);
  detailEl = renderDetail(entityId, st, entityLabel(entityId, st), closeDetail);
  document.body.appendChild(detailEl);
}
function closeDetail() {
  detailEl?.remove();
  detailEl = null;
}

let customizeEl: HTMLElement | null = null;
function openCustomize(entityId: string) {
  closeCustomize();
  const prof = activeProfile();
  if (!prof) return;
  customizeEl = renderCustomize(prof, entityId, domainOf(entityId), closeCustomize);
  document.body.appendChild(customizeEl);
}
function closeCustomize() {
  if (!customizeEl) return;
  customizeEl.remove();
  customizeEl = null;
  refreshGrid(); // reflect icon/colour/label edits on the tiles
}

function updateStatus() {
  const st = state.status;
  let dot = "off";
  let msg = "";
  if (st) {
    if (st.connected && st.kind === "ok") dot = "ok";
    else if (st.kind === "connecting") {
      dot = "warn";
      msg = "Connecting…";
    } else if (st.kind === "auth") {
      dot = "err";
      msg = "Token rejected — update the access token in Settings.";
    } else {
      dot = "err";
      msg = `Can't reach Home Assistant${st.message ? ` (${st.message})` : ""}.`;
    }
  }
  if (dotEl) dotEl.className = `dot ${dot}`;
  if (bannerEl) {
    if (msg) {
      bannerEl.textContent = msg;
      bannerEl.classList.remove("hidden");
    } else {
      bannerEl.classList.add("hidden");
    }
  }
}

async function toggleTheme() {
  if (!state.config) return;
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  state.config.settings.theme = next;
  applyTheme(next);
  renderShell();
  await api.saveConfig(state.config);
}

async function loadAreas() {
  try {
    setAreas(await api.getAreas());
    renderShellIfGrid();
  } catch {
    /* registries unreadable (e.g. non-admin token) — fall back to "Other" */
  }
}

// ---- bootstrap ----

async function init() {
  await events.onStatus((s) => {
    state.status = s;
    updateStatus();
  });
  await events.onActive((a) => {
    state.active = a;
    state.manualOverride = a.manualOverride ? a.profileId : null;
    if (state.config) state.config.activeProfileId = a.profileId;
    renderShellIfGrid();
  });
  await events.onStates((list) => {
    setStates(list);
    renderShellIfGrid();
    void loadAreas();
  });
  await events.onState((s) => {
    // Patch the stored snapshot, then update just this card's DOM in place —
    // no grid rebuild, so scroll position and ordering stay put.
    patchState(s);
    cardUpdaters.get(s.entityId)?.(s);
  });

  // Favorite/override edits change tabs (★) and content — rebuild the grid view.
  window.addEventListener("ha:layout", () => renderShellIfGrid());
  // A card asked to open its detail / customize sheet.
  window.addEventListener("ha:detail", (e) => openDetail((e as CustomEvent).detail.entityId));
  window.addEventListener("ha:customize", (e) => openCustomize((e as CustomEvent).detail.entityId));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDetail();
      closeCustomize();
    }
  });

  state.config = await api.getConfig();
  state.manualOverride = await api.getManualOverride();
  applyTheme(currentTheme());
  state.view = state.config.profiles.length === 0 ? "onboarding" : "grid";
  renderShell();
}

void init();

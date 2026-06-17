// Entity tiles. Each card exposes an `update(state)` registered in
// `cardUpdaters`, so live HA events patch the existing DOM in place instead of
// rebuilding the grid — that's what keeps scroll position and hover stable.

import { getOverride, isFavorite, setOverride, toggleFavorite } from "../actions";
import { api } from "../ha";
import { renderIcon } from "../icons";
import { domainOf, type EntityState, type Profile } from "../types";
import { el, escapeHtml } from "../util";
import { hasDetail } from "./detail";
import { openIconPicker } from "./icon-picker";

/** entity id -> in-place updater for the currently-rendered card. */
export const cardUpdaters = new Map<string, (st?: EntityState) => void>();

const TOGGLE_DOMAINS = new Set(["light", "switch", "input_boolean", "fan"]);

interface Built {
  el: HTMLElement;
  update: (st?: EntityState) => void;
}

function notifyLayoutChanged() {
  window.dispatchEvent(new Event("ha:layout"));
}
function openDetail(entityId: string) {
  window.dispatchEvent(new CustomEvent("ha:detail", { detail: { entityId } }));
}

export function entityLabel(entityId: string, st?: EntityState): string {
  const ov = getOverride(entityId);
  if (ov?.label) return ov.label;
  const f = st?.attributes?.["friendly_name"];
  return typeof f === "string" ? f : entityId;
}

function entityIconName(entityId: string, st?: EntityState): string {
  const ov = getOverride(entityId);
  if (ov?.icon) return ov.icon;
  const ic = st?.attributes?.["icon"];
  return typeof ic === "string" ? ic : "";
}

export function isOn(st?: EntityState): boolean {
  return !!st && st.state === "on";
}
export function isUnavailable(st?: EntityState): boolean {
  return !st || st.state === "unavailable" || st.state === "unknown";
}

async function dispatch(
  domain: string,
  service: string,
  entityId: string,
  card: HTMLElement,
  data?: Record<string, unknown>,
) {
  card.classList.add("busy");
  try {
    await api.callService(domain, service, data, { entity_id: entityId });
  } catch (err) {
    card.classList.add("error");
    card.title = String(err);
    setTimeout(() => card.classList.remove("error"), 1500);
  } finally {
    card.classList.remove("busy");
  }
}

function iconHtml(icon: string, domain: string): string {
  return `<span class="icon">${renderIcon(icon, domain)}</span>`;
}
function toggleSwitch(on: boolean): string {
  return `<span class="switch ${on ? "on" : "off"}"><span class="knob"></span></span>`;
}
function textPill(text: string, cls = ""): string {
  return `<span class="pill text-pill ${cls}"><span class="pill-txt">${escapeHtml(text)}</span></span>`;
}

export function renderCard(entityId: string, st?: EntityState): HTMLElement {
  const domain = domainOf(entityId);
  const label = escapeHtml(entityLabel(entityId, st));
  const icon = entityIconName(entityId, st);

  let built: Built;
  if (domain === "climate") built = climateCard(entityId, domain, label, icon, st);
  else if (domain === "scene" || domain === "script") built = actionCard(entityId, domain, label, icon);
  else if (TOGGLE_DOMAINS.has(domain)) built = toggleCard(entityId, domain, label, icon, st);
  else built = statusCard(domain, label, icon, st);

  cardUpdaters.set(entityId, built.update);
  return wrap(entityId, built.el);
}

function toggleSub(domain: string, st?: EntityState): string {
  if (isUnavailable(st)) return "Unavailable";
  if (!isOn(st)) return "Off";
  if (domain === "light") {
    const b = st?.attributes?.["brightness"];
    if (typeof b === "number") return `${Math.round((b / 255) * 100)}% brightness`;
  }
  if (domain === "fan") {
    const p = st?.attributes?.["percentage"];
    if (typeof p === "number") return `${Math.round(p)}% speed`;
  }
  return "On";
}

function toggleCard(
  entityId: string,
  domain: string,
  label: string,
  icon: string,
  st?: EntityState,
): Built {
  const detail = hasDetail(domain, st);
  const card = el("button", {
    class: "card toggle",
    html: `<div class="card-head">${iconHtml(icon, domain)}${toggleSwitch(isOn(st))}</div><div class="card-foot"><div class="label">${label}</div><div class="sub"></div></div>`,
  });
  const sw = card.querySelector(".switch") as HTMLElement;
  const subEl = card.querySelector(".sub") as HTMLElement;

  const update = (s?: EntityState) => {
    const on = isOn(s);
    const unavail = isUnavailable(s);
    card.classList.toggle("on", on && !unavail);
    card.classList.toggle("off", !(on && !unavail));
    card.classList.toggle("unavailable", unavail);
    sw.classList.toggle("on", on);
    sw.classList.toggle("off", !on);
    subEl.textContent = toggleSub(domain, s);
  };
  update(st);

  sw.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!card.classList.contains("unavailable")) dispatch(domain, "toggle", entityId, card);
  });
  card.addEventListener("click", () => {
    if (detail) openDetail(entityId);
    else if (!card.classList.contains("unavailable")) dispatch(domain, "toggle", entityId, card);
  });
  return { el: card, update };
}

function actionCard(entityId: string, domain: string, label: string, icon: string): Built {
  const verb = domain === "scene" ? "Activate" : "Run";
  const card = el("button", {
    class: "card action",
    html: `<div class="card-head">${iconHtml(icon, domain)}${textPill(verb, "accent")}</div><div class="card-foot"><div class="label">${label}</div></div>`,
  });
  card.addEventListener("click", () => dispatch(domain, "turn_on", entityId, card));
  return { el: card, update: () => {} };
}

function climateCard(
  entityId: string,
  domain: string,
  label: string,
  icon: string,
  st?: EntityState,
): Built {
  let cur = st;
  const card = el("div", {
    class: "card climate",
    html:
      `<div class="card-head">${iconHtml(icon, domain)}${textPill(st?.state ?? "off")}</div>` +
      `<div class="card-foot"><div class="label">${label}</div>` +
      `<div class="sub"></div>` +
      `<div class="stepper"><button class="dec" aria-label="Lower">−</button>` +
      `<button class="inc" aria-label="Raise">+</button></div></div>`,
  });
  const pill = card.querySelector(".text-pill") as HTMLElement;
  const pillTxt = card.querySelector(".pill-txt") as HTMLElement;
  const subEl = card.querySelector(".sub") as HTMLElement;

  const update = (s?: EntityState) => {
    cur = s;
    const mode = s?.state ?? "off";
    const on = mode !== "off" && mode !== "unavailable";
    card.classList.toggle("on", on);
    card.classList.toggle("off", !on);
    pillTxt.textContent = mode;
    pill.classList.toggle("accent", on);
    const c = s?.attributes?.["current_temperature"];
    const t = s?.attributes?.["temperature"];
    const cT = typeof c === "number" ? `${c}°` : "–";
    const tT = typeof t === "number" ? `${t}°` : "–";
    subEl.innerHTML = `${cT} → <span class="target">${tT}</span>`;
  };
  update(st);

  const step = (d: number) => {
    const t = cur?.attributes?.["temperature"];
    if (typeof t === "number") {
      const next = Math.round((t + d) * 10) / 10;
      dispatch(domain, "set_temperature", entityId, card, { temperature: next });
    }
  };
  card.querySelector(".dec")?.addEventListener("click", (e) => {
    e.stopPropagation();
    step(-0.5);
  });
  card.querySelector(".inc")?.addEventListener("click", (e) => {
    e.stopPropagation();
    step(0.5);
  });
  card.addEventListener("click", () => openDetail(entityId));
  return { el: card, update };
}

function statusCard(domain: string, label: string, icon: string, st?: EntityState): Built {
  const card = el("div", {
    class: "card status",
    html: `<div class="card-head">${iconHtml(icon, domain)}${textPill(st?.state ?? "–")}</div><div class="card-foot"><div class="label">${label}</div></div>`,
  });
  const pillTxt = card.querySelector(".pill-txt") as HTMLElement;
  const update = (s?: EntityState) => {
    pillTxt.textContent = s?.state ?? "–";
  };
  return { el: card, update };
}

function wrap(entityId: string, control: HTMLElement): HTMLElement {
  const box = el("div", { class: "card-wrap" });
  const color = getOverride(entityId)?.color;
  if (color) box.style.setProperty("--card-accent", color);
  box.appendChild(control);

  const actions = el("div", { class: "card-actions" });
  const star = el("button", {
    class: `act star ${isFavorite(entityId) ? "on" : ""}`,
    text: isFavorite(entityId) ? "★" : "☆",
    attrs: { title: "Favorite" },
  });
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(entityId);
    notifyLayoutChanged();
  });
  const edit = el("button", { class: "act edit", text: "✎", attrs: { title: "Customize" } });
  edit.addEventListener("click", (e) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent("ha:customize", { detail: { entityId } }));
  });
  actions.append(star, edit);
  box.append(actions);
  return box;
}

// ---------------------------------------------------------------------------
// Customize sheet (overlay; opened from a card's ✎). Rendered outside the grid
// so live updates can't destroy it.
// ---------------------------------------------------------------------------

const EDIT_COLORS = [
  "#2f6bff",
  "#22c55e",
  "#14b8a6",
  "#facc15",
  "#fb923c",
  "#ef4444",
  "#ec4899",
  "#a855f7",
];

export function renderCustomize(
  profile: Profile,
  entityId: string,
  domain: string,
  onClose: () => void,
): HTMLElement {
  const backdrop = el("div", { class: "sheet-backdrop" });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) onClose();
  });
  const sheet = el("div", { class: "sheet" });

  const head = el("div", { class: "sheet-head" });
  const headIcon = el("span", { class: "icon" });
  head.append(headIcon, el("div", { class: "sheet-title", text: "Customize" }));
  const x = el("button", { class: "act", html: `<i class="mdi mdi-close" aria-hidden="true"></i>` });
  x.addEventListener("click", onClose);
  head.appendChild(x);

  const sync = () => {
    headIcon.innerHTML = renderIcon(getOverride(entityId)?.icon ?? "", domain);
    const c = getOverride(entityId)?.color;
    if (c) sheet.style.setProperty("--card-accent", c);
    else sheet.style.removeProperty("--card-accent");
  };

  sheet.append(head, buildCustomizeFields(profile, entityId, domain, sync));
  sync();
  backdrop.appendChild(sheet);
  return backdrop;
}

function ctl(label: string): HTMLElement {
  const c = el("div", { class: "ctl" });
  c.appendChild(el("div", { class: "ctl-head", html: `<span class="ctl-label"></span>` }));
  c.querySelector(".ctl-label")!.textContent = label;
  return c;
}

function buildCustomizeFields(
  profile: Profile,
  entityId: string,
  domain: string,
  onChange: () => void,
): HTMLElement {
  const body = el("div", { class: "sheet-body" });

  // Label
  const labelCtl = ctl("Label");
  const labelI = el("input", { attrs: { type: "text", placeholder: "Use Home Assistant name" } });
  labelI.value = getOverride(entityId)?.label ?? "";
  labelI.addEventListener("change", () => setOverride(entityId, { label: labelI.value.trim() }));
  labelCtl.appendChild(labelI);
  body.appendChild(labelCtl);

  // Icon — big preview + picker + reset
  const iconCtl = ctl("Icon");
  const iconRow = el("div", { class: "icon-edit" });
  const preview = el("span", { class: "icon lg" });
  const refreshPreview = () => {
    preview.innerHTML = renderIcon(getOverride(entityId)?.icon ?? "", domain);
    onChange();
  };
  const choose = el("button", { class: "small", text: "Choose icon" });
  choose.addEventListener("click", () =>
    openIconPicker(getOverride(entityId)?.icon ?? "", (icon) => {
      setOverride(entityId, { icon });
      refreshPreview();
    }),
  );
  const reset = el("button", { class: "small", text: "Reset" });
  reset.addEventListener("click", () => {
    setOverride(entityId, { icon: "" });
    refreshPreview();
  });
  iconRow.append(preview, choose, reset);
  iconCtl.appendChild(iconRow);
  body.appendChild(iconCtl);
  refreshPreview();

  // Color swatches (+ Default)
  const colorCtl = ctl("Color");
  const swatches = el("div", { class: "swatches" });
  const cur = (getOverride(entityId)?.color ?? "").toLowerCase();
  const pick = (btn: HTMLElement, color: string) => {
    swatches.querySelectorAll(".swatch").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    setOverride(entityId, { color });
    onChange();
  };
  const def = el("button", { class: `swatch is-default ${cur ? "" : "active"}`, attrs: { title: "Default" } });
  def.addEventListener("click", () => pick(def, ""));
  swatches.appendChild(def);
  for (const hex of EDIT_COLORS) {
    const b = el("button", { class: `swatch ${cur === hex ? "active" : ""}`, attrs: { style: `--sw:${hex}`, title: hex } });
    b.addEventListener("click", () => pick(b, hex));
    swatches.appendChild(b);
  }
  colorCtl.appendChild(swatches);
  body.appendChild(colorCtl);

  // Custom group (only when groups exist)
  if (profile.groups.length) {
    const groupCtl = ctl("Custom group");
    const groupSel = el("select");
    groupSel.appendChild(el("option", { text: "Ungrouped", attrs: { value: "" } }));
    for (const g of profile.groups) {
      const o = el("option", { text: g.name, attrs: { value: g.id } });
      if (g.id === getOverride(entityId)?.groupId) o.selected = true;
      groupSel.appendChild(o);
    }
    groupSel.addEventListener("change", () => setOverride(entityId, { groupId: groupSel.value }));
    groupCtl.appendChild(groupSel);
    body.appendChild(groupCtl);
  }

  return body;
}

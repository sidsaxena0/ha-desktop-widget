// Per-entity detail sheet with domain-specific controls (brightness / color /
// color-temp for lights, speed / preset / oscillate for fans, hvac mode + target
// temp + fan mode for climate). Capabilities are read from the entity's
// attributes, so only supported controls are shown. All actions go through the
// existing `ha_call_service` command.

import { api } from "../ha";
import { renderIcon } from "../icons";
import { domainOf, type EntityState } from "../types";
import { el, escapeHtml, throttle } from "../util";

// ---- capability detection ----

interface LightCaps {
  brightness: boolean;
  colorTemp: boolean;
  color: boolean;
  any: boolean;
}
function lightCaps(st?: EntityState): LightCaps {
  const modes = (st?.attributes?.["supported_color_modes"] as string[] | undefined) ?? [];
  const onoffOnly = modes.length === 0 || (modes.length === 1 && modes[0] === "onoff");
  const brightness = !onoffOnly;
  const colorTemp = modes.includes("color_temp");
  const color = modes.some((m) => ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(m));
  return { brightness, colorTemp, color, any: brightness || colorTemp || color };
}

interface FanCaps {
  speed: boolean;
  preset: boolean;
  oscillate: boolean;
  any: boolean;
}
function fanCaps(st?: EntityState): FanCaps {
  const f = Number(st?.attributes?.["supported_features"] ?? 0);
  const presets = (st?.attributes?.["preset_modes"] as string[] | undefined) ?? [];
  const speed = (f & 1) !== 0;
  const preset = (f & 8) !== 0 && presets.length > 0;
  const oscillate = (f & 2) !== 0;
  return { speed, preset, oscillate, any: speed || preset || oscillate };
}

/** Whether tapping a card should open the detail sheet (vs. just toggling). */
export function hasDetail(domain: string, st?: EntityState): boolean {
  if (domain === "climate") return true;
  if (domain === "light") return lightCaps(st).any;
  if (domain === "fan") return fanCaps(st).any;
  return false;
}

// ---- service helper ----

function call(domain: string, service: string, entityId: string, data: Record<string, unknown>) {
  void api.callService(domain, service, data, { entity_id: entityId });
}

// ---- sheet ----

export function renderDetail(
  entityId: string,
  st: EntityState | undefined,
  label: string,
  onClose: () => void,
): HTMLElement {
  const domain = domainOf(entityId);

  const backdrop = el("div", { class: "sheet-backdrop" });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) onClose();
  });

  const sheet = el("div", { class: "sheet" });
  const head = el("div", { class: "sheet-head" });
  const iconName = (st?.attributes?.["icon"] as string | undefined) ?? "";
  head.innerHTML = `<span class="icon">${renderIcon(iconName, domain)}</span><div class="sheet-title">${escapeHtml(label)}</div>`;
  const close = el("button", { class: "act", html: `<i class="mdi mdi-close" aria-hidden="true"></i>` });
  close.addEventListener("click", onClose);
  head.appendChild(close);
  sheet.appendChild(head);

  // Tints the sheet with the bulb's current colour ("glow").
  const setGlow = (rgb: [number, number, number] | null) => {
    if (rgb) {
      sheet.style.setProperty("--glow", `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
      sheet.classList.add("glow");
    } else {
      sheet.classList.remove("glow");
    }
  };

  const body = el("div", { class: "sheet-body" });
  if (domain === "light") {
    buildLight(body, entityId, st, setGlow);
    const rgb = currentRgb(st);
    if (st?.state === "on" && rgb) setGlow(rgb);
  } else if (domain === "fan") {
    buildFan(body, entityId, st);
  } else if (domain === "climate") {
    buildClimate(body, entityId, st);
  }
  sheet.appendChild(body);

  backdrop.appendChild(sheet);
  return backdrop;
}

// ---- reusable controls ----

function powerRow(domain: string, entityId: string, on: boolean): HTMLElement {
  const row = el("div", { class: "ctl ctl-row" });
  row.appendChild(el("span", { class: "ctl-label", text: "Power" }));
  const sw = el("span", { class: `switch ${on ? "on" : "off"}`, html: `<span class="knob"></span>` });
  sw.addEventListener("click", () => call(domain, "toggle", entityId, {}));
  row.appendChild(sw);
  return row;
}

function slider(
  label: string,
  min: number,
  max: number,
  value: number,
  unit: string,
  cls: string,
  onChange: (v: number) => void,
  opts: { big?: boolean; ends?: [string, string] } = {},
): HTMLElement {
  const wrap = el("div", { class: "ctl" });
  const headEl = el("div", { class: "ctl-head" });
  const val = el("span", { class: `ctl-val${opts.big ? " big accent" : ""}`, text: `${value}${unit}` });
  headEl.append(el("span", { class: "ctl-label", text: label }), val);
  const input = el("input", {
    class: `slider ${cls}`,
    attrs: {
      type: "range",
      min: String(min),
      max: String(max),
      value: String(Math.min(Math.max(value, min), max)),
    },
  });
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  input.style.setProperty("--fill", `${pct(Number(input.value))}%`);
  const send = throttle((v: number) => onChange(v), 200);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    val.textContent = `${v}${unit}`;
    input.style.setProperty("--fill", `${pct(v)}%`);
    send(v);
  });
  wrap.append(headEl, input);
  if (opts.ends) {
    const ends = el("div", { class: "slider-ends" });
    ends.append(el("span", { text: opts.ends[0] }), el("span", { text: opts.ends[1] }));
    wrap.appendChild(ends);
  }
  return wrap;
}

// Preset color palette (label-friendly, vivid). Tap to set, or use the custom picker.
const PRESET_COLORS: Array<[string, [number, number, number]]> = [
  ["#8b5cf6", [139, 92, 246]],
  ["#3b6bff", [59, 107, 255]],
  ["#38bdf8", [56, 189, 248]],
  ["#22d3ee", [34, 211, 238]],
  ["#22c55e", [34, 197, 94]],
  ["#facc15", [250, 204, 21]],
  ["#fb923c", [251, 146, 60]],
  ["#ec4899", [236, 72, 153]],
  ["#ef4444", [239, 68, 68]],
  ["#fde68a", [253, 230, 138]],
];

function colorClose(a: [number, number, number], b: [number, number, number]): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= 18);
}

type Glow = (rgb: [number, number, number] | null) => void;

function colorSection(id: string, st: EntityState | undefined, setGlow: Glow): HTMLElement {
  const a = st?.attributes ?? {};
  const cur = Array.isArray(a["rgb_color"]) ? (a["rgb_color"] as number[]) : null;
  const wrap = el("div", { class: "ctl" });
  wrap.appendChild(el("div", { class: "ctl-head", html: `<span class="ctl-label">Color</span>` }));

  const grid = el("div", { class: "swatches" });
  const clearActive = () => grid.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));

  for (const [hex, rgb] of PRESET_COLORS) {
    const b = el("button", { class: "swatch", attrs: { style: `--sw:${hex}`, "aria-label": `color ${hex}` } });
    if (cur && colorClose([cur[0], cur[1], cur[2]], rgb)) b.classList.add("active");
    b.addEventListener("click", () => {
      clearActive();
      b.classList.add("active");
      call("light", "turn_on", id, { rgb_color: rgb });
      setGlow(rgb);
    });
    grid.appendChild(b);
  }
  wrap.appendChild(grid);
  return wrap;
}

// A proper hue/saturation wheel: hue around the circle, saturation = radius.
function colorWheel(id: string, st: EntityState | undefined, setGlow: Glow): HTMLElement {
  const a = st?.attributes ?? {};
  const wrap = el("div", { class: "ctl" });
  wrap.appendChild(el("div", { class: "ctl-head", html: `<span class="ctl-label">Color wheel</span>` }));

  const wheel = el("div", { class: "wheel" });
  // Build a hue ring aligned to our pointer math (hue = atan2(-y, x), CCW from right).
  const stops: string[] = [];
  for (let phi = 0; phi <= 360; phi += 30) {
    const hue = ((90 - phi) % 360 + 360) % 360;
    stops.push(`hsl(${hue}, 100%, 50%) ${phi}deg`);
  }
  wheel.style.background = `radial-gradient(circle at center, #fff 0%, rgba(255,255,255,0) 70%), conic-gradient(from 0deg, ${stops.join(", ")})`;
  const handle = el("div", { class: "wheel-handle" });
  wheel.appendChild(handle);

  const place = (hue: number, sat: number) => {
    const r = (Math.min(sat, 100) / 100) * 50;
    const ang = (hue * Math.PI) / 180;
    handle.style.left = `${50 + Math.cos(ang) * r}%`;
    handle.style.top = `${50 - Math.sin(ang) * r}%`;
  };
  const hs = Array.isArray(a["hs_color"]) ? (a["hs_color"] as number[]) : null;
  place(hs ? hs[0] : 0, hs ? hs[1] : 0);

  const send = throttle((h: number, s: number) => {
    call("light", "turn_on", id, { hs_color: [h, s] });
    setGlow(hsToRgb(h, s));
  }, 120);

  let dragging = false;
  const onMove = (clientX: number, clientY: number) => {
    const rect = wheel.getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    let ang = (Math.atan2(-y, x) * 180) / Math.PI;
    if (ang < 0) ang += 360;
    const dist = Math.min(Math.hypot(x, y), rect.width / 2);
    const hue = Math.round(ang);
    const sat = Math.round((dist / (rect.width / 2)) * 100);
    place(hue, sat);
    send(hue, sat);
  };
  wheel.addEventListener("pointerdown", (e) => {
    dragging = true;
    wheel.setPointerCapture(e.pointerId);
    onMove(e.clientX, e.clientY);
  });
  wheel.addEventListener("pointermove", (e) => {
    if (dragging) onMove(e.clientX, e.clientY);
  });
  const stop = () => {
    dragging = false;
  };
  wheel.addEventListener("pointerup", stop);
  wheel.addEventListener("pointercancel", stop);

  wrap.appendChild(wheel);
  return wrap;
}

const HVAC_ICON: Record<string, string> = {
  off: "power",
  cool: "snowflake",
  heat: "fire",
  heat_cool: "sun-snowflake-variant",
  auto: "autorenew",
  dry: "water-percent",
  fan_only: "fan",
};

// A grid of selectable mode tiles (icon + label) — used for HVAC modes etc.
function tileGrid(
  label: string,
  options: string[],
  current: string | undefined,
  iconFor: (o: string) => string,
  onSelect: (o: string) => void,
): HTMLElement {
  const wrap = el("div", { class: "ctl" });
  wrap.appendChild(el("div", { class: "ctl-head", html: `<span class="ctl-label">${escapeHtml(label)}</span>` }));
  const grid = el("div", { class: "tile-grid" });
  for (const o of options) {
    const t = el("button", {
      class: `mode-tile ${o === current ? "active" : ""}`,
      html: `<i class="mdi mdi-${iconFor(o)}" aria-hidden="true"></i><span>${escapeHtml(o.replace(/_/g, " "))}</span>`,
    });
    t.addEventListener("click", () => {
      grid.querySelectorAll(".mode-tile").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      onSelect(o);
    });
    grid.appendChild(t);
  }
  wrap.appendChild(grid);
  return wrap;
}

function segment(
  label: string,
  options: string[],
  current: string | undefined,
  onSelect: (v: string) => void,
): HTMLElement {
  const wrap = el("div", { class: "ctl" });
  wrap.appendChild(el("div", { class: "ctl-head", html: `<span class="ctl-label">${escapeHtml(label)}</span>` }));
  const seg = el("div", { class: "seg-wrap" });
  for (const opt of options) {
    const b = el("button", { class: `seg-chip ${opt === current ? "active" : ""}`, text: opt });
    b.addEventListener("click", () => {
      seg.querySelectorAll(".seg-chip").forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      onSelect(opt);
    });
    seg.appendChild(b);
  }
  wrap.appendChild(seg);
  return wrap;
}

// ---- light ----

function buildLight(body: HTMLElement, id: string, st: EntityState | undefined, setGlow: Glow) {
  const a = st?.attributes ?? {};
  const caps = lightCaps(st);
  body.appendChild(powerRow("light", id, st?.state === "on"));

  if (caps.brightness) {
    const bRaw = a["brightness"];
    const cur = typeof bRaw === "number" ? Math.round((bRaw / 255) * 100) : 100;
    body.appendChild(
      slider("Brightness", 1, 100, cur, "%", "bright", (v) => call("light", "turn_on", id, { brightness_pct: v }), {
        big: true,
        ends: ["Off", "100%"],
      }),
    );
  }
  if (caps.color) {
    body.appendChild(colorSection(id, st, setGlow));
    body.appendChild(colorWheel(id, st, setGlow));
  }
  if (caps.colorTemp) {
    const min = Number(a["min_color_temp_kelvin"] ?? 2000);
    const max = Number(a["max_color_temp_kelvin"] ?? 6500);
    const curRaw = a["color_temp_kelvin"];
    const cur = typeof curRaw === "number" ? curRaw : Math.round((min + max) / 2);
    body.appendChild(
      slider("Tone glow", min, max, cur, "K", "temp", (v) => call("light", "turn_on", id, { color_temp_kelvin: v }), {
        ends: ["Warm", "Cool"],
      }),
    );
  }
}

// ---- fan ----

function buildFan(body: HTMLElement, id: string, st?: EntityState) {
  const a = st?.attributes ?? {};
  const caps = fanCaps(st);
  body.appendChild(powerRow("fan", id, st?.state === "on"));

  if (caps.speed) {
    const pRaw = a["percentage"];
    const cur = typeof pRaw === "number" ? Math.round(pRaw) : 0;
    body.appendChild(
      slider("Speed", 0, 100, cur, "%", "bright", (v) => call("fan", "set_percentage", id, { percentage: v }), {
        big: true,
        ends: ["Off", "Max"],
      }),
    );
  }
  if (caps.preset) {
    const presets = (a["preset_modes"] as string[]) ?? [];
    body.appendChild(
      tileGrid("Preset", presets, a["preset_mode"] as string | undefined, () => "fan", (v) =>
        call("fan", "set_preset_mode", id, { preset_mode: v }),
      ),
    );
  }
  if (caps.oscillate) {
    const row = el("div", { class: "ctl ctl-row" });
    row.appendChild(el("span", { class: "ctl-label", text: "Oscillate" }));
    const on = a["oscillating"] === true;
    const sw = el("span", { class: `switch ${on ? "on" : "off"}`, html: `<span class="knob"></span>` });
    sw.addEventListener("click", () => {
      const next = !sw.classList.contains("on");
      sw.classList.toggle("on", next);
      sw.classList.toggle("off", !next);
      call("fan", "oscillate", id, { oscillating: next });
    });
    row.appendChild(sw);
    body.appendChild(row);
  }
}

// ---- climate ----

function buildClimate(body: HTMLElement, id: string, st?: EntityState) {
  const a = st?.attributes ?? {};

  const cur = a["current_temperature"];
  const hum = a["current_humidity"];
  const readout = el("div", { class: "readout" });
  if (typeof cur === "number") readout.appendChild(stat("Current", `${cur}°`));
  if (typeof hum === "number") readout.appendChild(stat("Humidity", `${hum}%`));
  if (readout.childElementCount) body.appendChild(readout);

  // Target temperature — circular dial.
  const target = typeof a["temperature"] === "number" ? (a["temperature"] as number) : null;
  if (target !== null) body.appendChild(climateDial(id, st, target));

  const hvacModes = (a["hvac_modes"] as string[] | undefined) ?? [];
  if (hvacModes.length) {
    body.appendChild(
      tileGrid("Mode", hvacModes, st?.state, (m) => HVAC_ICON[m] ?? "thermostat", (v) =>
        call("climate", "set_hvac_mode", id, { hvac_mode: v }),
      ),
    );
  }
  const fanModes = (a["fan_modes"] as string[] | undefined) ?? [];
  if (fanModes.length) {
    body.appendChild(
      segment("Fan", fanModes, a["fan_mode"] as string | undefined, (v) =>
        call("climate", "set_fan_mode", id, { fan_mode: v }),
      ),
    );
  }
}

// Draggable circular temperature dial (270° sweep, gap at the bottom).
function climateDial(id: string, st: EntityState | undefined, target: number): HTMLElement {
  const a = st?.attributes ?? {};
  const min = Number(a["min_temp"] ?? 16);
  const max = Number(a["max_temp"] ?? 30);
  const step = Number(a["target_temp_step"] ?? 0.5);
  const START = 135;
  const SWEEP = 270;
  const R = 78;
  const CX = 100;
  const CY = 100;

  const tempToAngle = (v: number) => START + ((v - min) / (max - min)) * SWEEP;
  const pt = (deg: number, r: number): [number, number] => {
    const rad = (deg * Math.PI) / 180;
    return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
  };
  const arc = (a0: number, a1: number, r: number) => {
    const [x0, y0] = pt(a0, r);
    const [x1, y1] = pt(a1, r);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };

  const wrap = el("div", { class: "dial-wrap" });
  wrap.innerHTML = `
    <svg viewBox="0 0 200 200" class="dial">
      <circle class="dial-hit" cx="100" cy="100" r="98" fill="transparent"/>
      <path class="dial-track" d="${arc(START, START + SWEEP, R)}"/>
      <path class="dial-value" d="${arc(START, tempToAngle(target), R)}"/>
      <circle class="dial-handle" r="9"/>
      <text class="dial-temp" x="100" y="98">${target}°</text>
      <text class="dial-sub" x="100" y="120">Target</text>
    </svg>`;

  const valuePath = wrap.querySelector(".dial-value") as SVGPathElement;
  const handle = wrap.querySelector(".dial-handle") as SVGCircleElement;
  const label = wrap.querySelector(".dial-temp") as SVGTextElement;
  const svg = wrap.querySelector("svg") as SVGSVGElement;

  const place = (v: number) => {
    const ang = tempToAngle(v);
    valuePath.setAttribute("d", arc(START, ang, R));
    const [hx, hy] = pt(ang, R);
    handle.setAttribute("cx", hx.toFixed(1));
    handle.setAttribute("cy", hy.toFixed(1));
    label.textContent = `${v}°`;
  };
  place(target);

  const send = throttle((v: number) => call("climate", "set_temperature", id, { temperature: v }), 200);
  const snap = (v: number) => Math.round(v / step) * step;

  const onMove = (clientX: number, clientY: number) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((clientX - rect.left) / rect.width) * 200 - CX;
    const vy = ((clientY - rect.top) / rect.height) * 200 - CY;
    let ang = (Math.atan2(vy, vx) * 180) / Math.PI;
    if (ang < 0) ang += 360;
    let rel = ang - START;
    if (rel < 0) rel += 360;
    if (rel > SWEEP) rel = rel - SWEEP < 360 - rel ? SWEEP : 0; // snap out of the bottom gap
    let v = min + (rel / SWEEP) * (max - min);
    v = Math.min(Math.max(snap(v), min), max);
    place(v);
    send(v);
  };

  let dragging = false;
  svg.addEventListener("pointerdown", (e) => {
    dragging = true;
    svg.setPointerCapture(e.pointerId);
    onMove(e.clientX, e.clientY);
  });
  svg.addEventListener("pointermove", (e) => {
    if (dragging) onMove(e.clientX, e.clientY);
  });
  const stop = () => {
    dragging = false;
  };
  svg.addEventListener("pointerup", stop);
  svg.addEventListener("pointercancel", stop);
  return wrap;
}

function stat(label: string, value: string): HTMLElement {
  const s = el("div", { class: "stat" });
  s.append(el("div", { class: "stat-val", text: value }), el("div", { class: "stat-label", text: label }));
  return s;
}

// ---- color helpers ----

function hsToRgb(h: number, s: number): [number, number, number] {
  const sat = s / 100;
  const c = sat; // value fixed at 1 for a vivid glow
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g] = [c, x];
  else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x];
  else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c];
  else [r, b] = [c, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function currentRgb(st?: EntityState): [number, number, number] | null {
  const a = st?.attributes ?? {};
  const rgb = a["rgb_color"];
  if (Array.isArray(rgb) && rgb.length >= 3) return [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
  const hs = a["hs_color"];
  if (Array.isArray(hs) && hs.length >= 2) return hsToRgb(Number(hs[0]), Number(hs[1]));
  return null;
}

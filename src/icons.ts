// Icons via the bundled Material Design Icons webfont (@mdi/font). HA exposes a
// per-entity icon as `mdi:<name>` in `attributes.icon`, which maps 1:1 onto an
// MDI font class — so devices show their real Home Assistant icon. Falls back to
// a sensible per-domain default; a non-mdi value is treated as an emoji.

import { escapeHtml } from "./util";

const DOMAIN_DEFAULT: Record<string, string> = {
  light: "lightbulb",
  switch: "toggle-switch-variant",
  input_boolean: "toggle-switch",
  fan: "fan",
  climate: "thermostat",
  scene: "palette",
  script: "script-text-outline",
};

// MDI class names are lowercase letters, digits, and hyphens.
function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function mdi(name: string): string {
  return `<i class="mdi mdi-${sanitize(name)}" aria-hidden="true"></i>`;
}

/** Render an entity's icon as an HTML string (MDI glyph or emoji). */
export function renderIcon(icon: string, domain: string): string {
  const trimmed = (icon ?? "").trim();
  if (trimmed) {
    if (trimmed.startsWith("mdi:")) {
      const name = sanitize(trimmed.slice(4));
      return mdi(name || DOMAIN_DEFAULT[domain] || "shape-outline");
    }
    // Anything else is treated as an emoji / short text label.
    return `<span class="emoji">${escapeHtml(trimmed)}</span>`;
  }
  return mdi(DOMAIN_DEFAULT[domain] ?? "shape-outline");
}

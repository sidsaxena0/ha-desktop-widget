// Shared mutations over the active profile, used by the grid and cards so
// handlers don't have to prop-drill. Writes are debounced into one saveConfig.

import { api } from "./ha";
import { state } from "./store";
import type { EntityConfig, GroupBy, Profile } from "./types";

export function activeProfile(): Profile | null {
  const cfg = state.config;
  if (!cfg) return null;
  return cfg.profiles.find((p) => p.id === cfg.activeProfileId) ?? cfg.profiles[0] ?? null;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function persist(): void {
  const cfg = state.config;
  if (!cfg) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void api.saveConfig(cfg), 250);
}

export function isFavorite(entityId: string): boolean {
  const p = activeProfile();
  return !!p && p.favorites.includes(entityId);
}

export function toggleFavorite(entityId: string): void {
  const p = activeProfile();
  if (!p) return;
  const i = p.favorites.indexOf(entityId);
  if (i >= 0) p.favorites.splice(i, 1);
  else p.favorites.push(entityId);
  persist();
}

export function getOverride(entityId: string): EntityConfig | undefined {
  return activeProfile()?.entities.find((e) => e.entityId === entityId);
}

export function setOverride(
  entityId: string,
  patch: Partial<Pick<EntityConfig, "label" | "icon" | "groupId" | "color">>,
): void {
  const p = activeProfile();
  if (!p) return;
  let ov = p.entities.find((e) => e.entityId === entityId);
  if (!ov) {
    ov = { entityId, label: "", icon: "", groupId: "", color: "", order: p.entities.length };
    p.entities.push(ov);
  }
  if (patch.label !== undefined) ov.label = patch.label;
  if (patch.icon !== undefined) ov.icon = patch.icon;
  if (patch.groupId !== undefined) ov.groupId = patch.groupId;
  if (patch.color !== undefined) ov.color = patch.color;
  // Drop empty overrides so the config stays clean.
  if (!ov.label && !ov.icon && !ov.groupId && !ov.color) {
    p.entities = p.entities.filter((e) => e.entityId !== entityId);
  }
  persist();
}

export function setFavoritesOnly(v: boolean): void {
  state.favoritesOnly = v;
  const p = activeProfile();
  if (p) {
    p.favoritesOnly = v;
    persist();
  }
}

export function setGroupBy(mode: GroupBy): void {
  const p = activeProfile();
  if (!p) return;
  p.groupBy = mode;
  persist();
}

export function setSortBy(mode: "name" | "manual"): void {
  const p = activeProfile();
  if (!p) return;
  p.sortBy = mode;
  persist();
}

/** Assign manual order (= index) to the given entity ids, creating overrides
 *  as needed. Used by drag-to-reorder. */
export function setOrder(ids: string[]): void {
  const p = activeProfile();
  if (!p) return;
  ids.forEach((id, i) => {
    let ov = p.entities.find((e) => e.entityId === id);
    if (!ov) {
      ov = { entityId: id, label: "", icon: "", groupId: "", color: "", order: i };
      p.entities.push(ov);
    } else {
      ov.order = i;
    }
  });
  persist();
}

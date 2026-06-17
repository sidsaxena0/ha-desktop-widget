// Renders the control grid for the active room tab (or a flat search result).
// Cards register in-place updaters in `cardUpdaters`; live state events patch
// those rather than rebuilding here, so scroll position is preserved.

import { setOrder } from "../actions";
import { state } from "../store";
import { domainOf, isSupportedDomain, type EntityState, type Profile } from "../types";
import { el } from "../util";
import { cardUpdaters, entityLabel, isUnavailable, renderCard } from "./card";

export interface RoomTab {
  id: string; // Area id, or "__un" for unassigned
  name: string;
  count: number;
}

interface Section {
  title: string;
  entityIds: string[];
}

function supportedIds(states: Map<string, EntityState>): string[] {
  const showConfig = state.config?.settings.showConfigEntities ?? false;
  return [...states.keys()].filter((id) => {
    if (!isSupportedDomain(domainOf(id))) return false;
    if (state.entityHidden.has(id)) return false; // hidden in HA
    if (!showConfig) {
      const cat = state.entityCategory.get(id) ?? "";
      if (cat === "config" || cat === "diagnostic") return false;
    }
    return true;
  });
}

/** Room tabs (Areas with ≥1 device) in HA order, plus "Other" for unassigned. */
export function computeRooms(states: Map<string, EntityState>): RoomTab[] {
  const counts = new Map<string, number>();
  for (const id of supportedIds(states)) {
    const a = state.entityArea.get(id) ?? "";
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const tabs: RoomTab[] = [];
  const seen = new Set<string>();
  for (const aid of state.areaOrder) {
    const c = counts.get(aid);
    if (c) {
      tabs.push({ id: aid, name: state.areaNames.get(aid) ?? aid, count: c });
      seen.add(aid);
    }
  }
  for (const [aid, c] of counts) {
    if (aid === "" || seen.has(aid)) continue;
    tabs.push({ id: aid, name: state.areaNames.get(aid) ?? aid, count: c });
  }
  const un = counts.get("");
  if (un) tabs.push({ id: "__un", name: "Other", count: un });
  return tabs;
}

function empty(html: string): HTMLElement {
  return el("div", { class: "empty", html });
}

/** Sort ids: unavailable/unknown always last; then by manual order or name. */
function sortIds(ids: string[], states: Map<string, EntityState>, profile: Profile): string[] {
  const orderOf = new Map(profile.entities.map((e) => [e.entityId, e.order]));
  return [...ids].sort((a, b) => {
    const ua = isUnavailable(states.get(a));
    const ub = isUnavailable(states.get(b));
    if (ua !== ub) return ua ? 1 : -1;
    if (profile.sortBy === "manual") {
      const oa = orderOf.get(a) ?? 1e9;
      const ob = orderOf.get(b) ?? 1e9;
      if (oa !== ob) return oa - ob;
    }
    return entityLabel(a, states.get(a)).localeCompare(entityLabel(b, states.get(b)));
  });
}

function cardsGrid(ids: string[], states: Map<string, EntityState>, profile: Profile): HTMLElement {
  const g = el("div", { class: "cards" });
  const manual = profile.sortBy === "manual" && !state.search.trim();
  if (manual) g.classList.add("reorder");
  for (const id of sortIds(ids, states, profile)) {
    const card = renderCard(id, states.get(id));
    card.dataset.entity = id;
    if (manual) enableDrag(card, g);
    g.appendChild(card);
  }
  return g;
}

// HTML5 drag-to-reorder within one cards container; persists the new order.
function enableDrag(card: HTMLElement, container: HTMLElement) {
  card.setAttribute("draggable", "true");
  card.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    const ids = [...container.querySelectorAll<HTMLElement>("[data-entity]")]
      .map((n) => n.dataset.entity ?? "")
      .filter(Boolean);
    setOrder(ids);
  });
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    const dragging = container.querySelector<HTMLElement>(".dragging");
    if (!dragging || dragging === card) return;
    const rect = card.getBoundingClientRect();
    const after = e.clientY - rect.top > rect.height / 2;
    container.insertBefore(dragging, after ? card.nextSibling : card);
  });
}

export function renderGrid(
  profile: Profile | null,
  states: Map<string, EntityState>,
  activeRoom: string,
): HTMLElement {
  cardUpdaters.clear();
  const root = el("div", { class: "grid-view" });
  if (!profile) {
    root.appendChild(empty("No active profile."));
    return root;
  }

  const all = supportedIds(states);
  const connected = state.status?.connected;

  // Search mode — flat, across all rooms.
  const q = state.search.trim().toLowerCase();
  if (q) {
    const matches = all.filter(
      (id) =>
        id.toLowerCase().includes(q) ||
        entityLabel(id, states.get(id)).toLowerCase().includes(q),
    );
    if (!matches.length) {
      root.appendChild(empty(connected ? "No matching devices." : "Connecting…"));
      return root;
    }
    root.appendChild(cardsGrid(matches, states, profile));
    return root;
  }

  // Favorites tab.
  if (activeRoom === "fav") {
    const favs = new Set(profile.favorites);
    const ids = all.filter((id) => favs.has(id));
    if (!ids.length) {
      root.appendChild(
        empty(connected ? "No favorites yet.<br>Tap a device's ☆ to add it." : "Connecting…"),
      );
      return root;
    }
    root.appendChild(cardsGrid(ids, states, profile));
    return root;
  }

  // All tab: grouped overview.
  if (activeRoom === "all") {
    if (!all.length) {
      root.appendChild(
        empty(connected ? "No supported devices found." : "Connecting to Home Assistant…"),
      );
      return root;
    }
    const sections = profile.groupBy === "custom" ? groupByCustom(profile, all) : groupByRoom(all);
    for (const sec of sections) {
      root.appendChild(el("div", { class: "room-label", text: sec.title }));
      root.appendChild(cardsGrid(sec.entityIds, states, profile));
    }
    return root;
  }

  // A specific room.
  const areaId = activeRoom === "__un" ? "" : activeRoom;
  const ids = all.filter((id) => (state.entityArea.get(id) ?? "") === areaId);
  if (!ids.length) {
    root.appendChild(empty(connected ? "No devices in this room." : "Connecting…"));
    return root;
  }
  root.appendChild(cardsGrid(ids, states, profile));
  return root;
}

function groupByRoom(ids: string[]): Section[] {
  const byArea = new Map<string, string[]>();
  for (const id of ids) {
    const a = state.entityArea.get(id) ?? "";
    if (!byArea.has(a)) byArea.set(a, []);
    byArea.get(a)!.push(id);
  }
  const sections: Section[] = [];
  const seen = new Set<string>();
  for (const aid of state.areaOrder) {
    const list = byArea.get(aid);
    if (list?.length) {
      sections.push({ title: state.areaNames.get(aid) ?? aid, entityIds: list });
      seen.add(aid);
    }
  }
  for (const [aid, list] of byArea) {
    if (aid === "" || seen.has(aid)) continue;
    sections.push({ title: state.areaNames.get(aid) ?? aid, entityIds: list });
  }
  const un = byArea.get("");
  if (un?.length) sections.push({ title: "Other", entityIds: un });
  return sections;
}

function groupByCustom(profile: Profile, ids: string[]): Section[] {
  const groupIds = new Set(profile.groups.map((g) => g.id));
  const ovById = new Map(profile.entities.map((e) => [e.entityId, e]));
  const byGroup = new Map<string, string[]>();
  for (const id of ids) {
    const gid = ovById.get(id)?.groupId;
    const key = gid && groupIds.has(gid) ? gid : "";
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(id);
  }
  const sections: Section[] = [];
  for (const g of [...profile.groups].sort((a, b) => a.order - b.order)) {
    const list = byGroup.get(g.id);
    if (list?.length) sections.push({ title: g.name, entityIds: list });
  }
  const other = byGroup.get("");
  if (other?.length) sections.push({ title: profile.groups.length ? "Other" : "All", entityIds: other });
  return sections;
}

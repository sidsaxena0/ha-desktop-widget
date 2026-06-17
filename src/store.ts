// Tiny reactive store — no framework. Components subscribe and re-render on
// change. Entity state lives in a Map for cheap per-entity updates.

import type {
  ActiveInfo,
  AppConfig,
  AreasResult,
  ConnectionStatus,
  EntityState,
} from "./types";

export type View = "grid" | "settings" | "onboarding";

export interface UiState {
  config: AppConfig | null;
  states: Map<string, EntityState>;
  status: ConnectionStatus | null;
  active: ActiveInfo | null;
  manualOverride: string | null;
  view: View;
  /** HA Area id → name. */
  areaNames: Map<string, string>;
  /** Area ids in display order (as returned by HA). */
  areaOrder: string[];
  /** entity id → Area id. */
  entityArea: Map<string, string>;
  /** entity id → registry category ("config" | "diagnostic" | ""). */
  entityCategory: Map<string, string>;
  /** entity ids hidden in HA (always excluded from the grid). */
  entityHidden: Set<string>;
  /** UI: show only favorites (forced off when favorites is empty). */
  favoritesOnly: boolean;
  /** Section keys currently collapsed in the grid (in-memory). */
  collapsed: Set<string>;
  /** Signature of the section set last used to seed collapse defaults. */
  collapseSig: string;
  /** Active room tab: "all" | "fav" | an Area id. */
  activeRoom: string;
  /** Search query (filters across all rooms while non-empty). */
  search: string;
  /** Whether the search input row is shown. */
  searchOpen: boolean;
}

export const state: UiState = {
  config: null,
  states: new Map(),
  status: null,
  active: null,
  manualOverride: null,
  view: "grid",
  areaNames: new Map(),
  areaOrder: [],
  entityArea: new Map(),
  entityCategory: new Map(),
  entityHidden: new Set(),
  favoritesOnly: false,
  collapsed: new Set(),
  collapseSig: "",
  activeRoom: "all",
  search: "",
  searchOpen: false,
};

/** Store the HA Areas + entity→area mapping from `ha_get_areas`. */
export function setAreas(result: AreasResult): void {
  state.areaNames = new Map(result.areas.map((a) => [a.id, a.name]));
  state.areaOrder = result.areas.map((a) => a.id);
  state.entityArea = new Map(result.entityAreas.map((e) => [e.entityId, e.areaId]));
  state.entityCategory = new Map(result.entityMeta.map((m) => [m.entityId, m.category]));
  state.entityHidden = new Set(result.entityMeta.filter((m) => m.hidden).map((m) => m.entityId));
  notify();
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

/** Replace the entire state snapshot (initial load + reconnects). */
export function setStates(list: EntityState[]): void {
  state.states = new Map(list.map((s) => [s.entityId, s]));
  notify();
}

/** Patch a single entity (live update). */
export function patchState(s: EntityState): void {
  state.states.set(s.entityId, s);
  notify();
}

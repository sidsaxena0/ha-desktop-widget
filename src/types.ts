// Mirrors the Rust models in `src-tauri/src/models.rs` (camelCase across the IPC
// boundary). Keep these in sync if the Rust structs change.

export interface AppConfig {
  version: number;
  activeProfileId: string | null;
  settings: AppSettings;
  profiles: Profile[];
}

export type Theme = "light" | "dark";

export interface AppSettings {
  autostart: boolean;
  alwaysOnTop: boolean;
  autoSwitchByLocation: boolean;
  networkRecheckIntervalSec: number;
  theme: Theme;
  /** Show HA config/diagnostic sub-entities (off by default). */
  showConfigEntities: boolean;
}

export type GroupBy = "room" | "custom";
export type SortBy = "name" | "manual";

export interface Profile {
  id: string;
  name: string;
  internalUrl: string;
  externalUrl: string;
  ssids: string[];
  groups: Group[];
  /** Per-entity overrides (label/icon/custom-group); not every entity is here. */
  entities: EntityConfig[];
  /** Starred entity ids. Empty ⇒ show everything. */
  favorites: string[];
  /** UI pref: show only favorites (ignored when favorites is empty). */
  favoritesOnly: boolean;
  /** Grouping mode: "room" (HA Areas, default) or "custom" (manual groups). */
  groupBy: GroupBy;
  /** Sort within a group: "name" (default) or "manual" (drag order). */
  sortBy: SortBy;
}

export interface AreaInfo {
  id: string;
  name: string;
}

export interface EntityArea {
  entityId: string;
  areaId: string;
}

export interface EntityMeta {
  entityId: string;
  category: string; // "config" | "diagnostic" | ""
  hidden: boolean;
}

export interface AreasResult {
  areas: AreaInfo[];
  entityAreas: EntityArea[];
  entityMeta: EntityMeta[];
}

export interface Group {
  id: string;
  name: string;
  order: number;
}

export interface EntityConfig {
  entityId: string;
  label: string;
  icon: string;
  groupId: string;
  /** Accent colour override (CSS hex), or empty for default. */
  color: string;
  order: number;
}

export interface EntityState {
  entityId: string;
  state: string;
  attributes: Record<string, unknown>;
}

/** `kind` is one of: "ok" | "connecting" | "network" | "auth". */
export interface ConnectionStatus {
  connected: boolean;
  profileId: string | null;
  url: string | null;
  usingInternal: boolean;
  kind: string;
  message?: string;
}

export interface ActiveInfo {
  profileId: string;
  url: string;
  usingInternal: boolean;
  manualOverride: boolean;
}

export type TokenCheck =
  | { result: "valid" }
  | { result: "unauthorized" }
  | { result: "unreachable"; message: string };

export const SUPPORTED_DOMAINS = [
  "light",
  "switch",
  "input_boolean",
  "fan",
  "climate",
  "scene",
  "script",
] as const;

export type Domain = (typeof SUPPORTED_DOMAINS)[number];

export function domainOf(entityId: string): string {
  return entityId.split(".")[0] ?? "";
}

export function isSupportedDomain(d: string): d is Domain {
  return (SUPPORTED_DOMAINS as readonly string[]).includes(d);
}

export function newId(): string {
  return crypto.randomUUID();
}

export function newProfile(name = "New house"): Profile {
  return {
    id: newId(),
    name,
    internalUrl: "",
    externalUrl: "",
    ssids: [],
    groups: [],
    entities: [],
    favorites: [],
    favoritesOnly: false,
    groupBy: "room",
    sortBy: "name",
  };
}

export function emptyConfig(): AppConfig {
  return {
    version: 1,
    activeProfileId: null,
    settings: {
      autostart: false,
      alwaysOnTop: true,
      autoSwitchByLocation: true,
      networkRecheckIntervalSec: 30,
      theme: "light",
      showConfigEntities: false,
    },
    profiles: [],
  };
}

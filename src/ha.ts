// Thin wrappers around the Rust command surface and the live event stream.
// Tauri converts camelCase JS argument keys to the snake_case Rust params.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ActiveInfo,
  AppConfig,
  AreasResult,
  ConnectionStatus,
  EntityState,
  TokenCheck,
} from "./types";

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (config: AppConfig) => invoke<void>("save_config", { config }),
  exportConfig: () => invoke<string>("export_config"),
  importConfig: (json: string) => invoke<AppConfig>("import_config", { json }),

  setToken: (profileId: string, token: string) =>
    invoke<void>("set_token", { profileId, token }),
  hasToken: (profileId: string) => invoke<boolean>("has_token", { profileId }),
  deleteToken: (profileId: string) => invoke<void>("delete_token", { profileId }),

  callService: (
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ) => invoke<unknown>("ha_call_service", { domain, service, data, target }),

  checkToken: (url: string, token: string) =>
    invoke<TokenCheck>("check_token", { url, token }),

  getAreas: () => invoke<AreasResult>("ha_get_areas"),
  reconnect: () => invoke<void>("reconnect"),
  setActiveProfile: (profileId: string) =>
    invoke<void>("set_active_profile", { profileId }),
  resumeAutoSwitch: () => invoke<void>("resume_auto_switch"),
  getManualOverride: () => invoke<string | null>("get_manual_override"),
};

export const events = {
  onStatus: (cb: (s: ConnectionStatus) => void): Promise<UnlistenFn> =>
    listen<ConnectionStatus>("ha://status", (e) => cb(e.payload)),
  onStates: (cb: (s: EntityState[]) => void): Promise<UnlistenFn> =>
    listen<EntityState[]>("ha://states", (e) => cb(e.payload)),
  onState: (cb: (s: EntityState) => void): Promise<UnlistenFn> =>
    listen<EntityState>("ha://state", (e) => cb(e.payload)),
  onActive: (cb: (a: ActiveInfo) => void): Promise<UnlistenFn> =>
    listen<ActiveInfo>("ha://active", (e) => cb(e.payload)),
};

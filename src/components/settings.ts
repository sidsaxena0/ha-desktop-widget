// Settings panel: app settings, multi-house profiles (keychain-backed tokens),
// grouping mode, and manual groups. Entity curation now happens in the grid
// (star + inline card editor), so there's no one-by-one picker here.
// Import/export excludes tokens by construction.

import { api } from "../ha";
import { state } from "../store";
import { emptyConfig, newProfile, type AppConfig, type Profile } from "../types";
import { el } from "../util";

export function renderSettings(onClose: () => void): HTMLElement {
  const root = el("div", { class: "settings" });
  let draft: AppConfig = structuredClone(state.config ?? emptyConfig());
  let editingId: string | null =
    draft.activeProfileId ?? draft.profiles[0]?.id ?? null;

  const persist = async () => {
    await api.saveConfig(draft);
    state.config = structuredClone(draft);
  };

  const editing = (): Profile | undefined =>
    draft.profiles.find((p) => p.id === editingId);

  function build() {
    root.innerHTML = "";
    root.appendChild(header());
    root.appendChild(appSettingsSection());
    root.appendChild(profilesSection());
    const prof = editing();
    if (prof) {
      root.appendChild(layoutSection(prof));
      root.appendChild(groupsSection(prof));
    }
    root.appendChild(importExportSection());
  }

  function header(): HTMLElement {
    const h = el("div", { class: "settings-header" });
    h.appendChild(el("h2", { text: "Settings" }));
    const done = el("button", { class: "primary small", text: "Done" });
    done.addEventListener("click", onClose);
    h.appendChild(done);
    return h;
  }

  function appSettingsSection(): HTMLElement {
    const s = section("App");
    const cfg = draft.settings;

    s.appendChild(toggleRow("Start at login", cfg.autostart, (v) => {
      cfg.autostart = v;
      void persist();
    }));
    s.appendChild(toggleRow("Always on top", cfg.alwaysOnTop, (v) => {
      cfg.alwaysOnTop = v;
      void persist();
    }));
    s.appendChild(
      toggleRow("Auto-switch house by location", cfg.autoSwitchByLocation, (v) => {
        cfg.autoSwitchByLocation = v;
        void persist();
      }),
    );
    s.appendChild(
      toggleRow("Show advanced (config) entities", cfg.showConfigEntities, (v) => {
        cfg.showConfigEntities = v;
        void persist();
      }),
    );

    const num = el("input", { attrs: { type: "number", min: "5", step: "5" } });
    num.value = String(cfg.networkRecheckIntervalSec);
    num.addEventListener("change", () => {
      cfg.networkRecheckIntervalSec = Math.max(5, Number(num.value) || 30);
      void persist();
    });
    const row = el("div", { class: "row" });
    row.appendChild(el("span", { text: "Network re-check interval (s)" }));
    row.appendChild(num);
    s.appendChild(row);
    return s;
  }

  function profilesSection(): HTMLElement {
    const s = section("Houses");
    if (draft.profiles.length === 0) {
      s.appendChild(el("p", { class: "muted", text: "No houses yet." }));
    }

    const picker = el("div", { class: "profile-picker" });
    for (const p of draft.profiles) {
      const chip = el("button", {
        class: `chip ${p.id === editingId ? "active" : ""}`,
        text: p.name || "(unnamed)",
      });
      chip.addEventListener("click", () => {
        editingId = p.id;
        build();
      });
      picker.appendChild(chip);
    }
    const add = el("button", { class: "chip add", text: "+ Add house" });
    add.addEventListener("click", async () => {
      const p = newProfile();
      draft.profiles.push(p);
      editingId = p.id;
      await persist();
      build();
    });
    picker.appendChild(add);
    s.appendChild(picker);

    const prof = editing();
    if (prof) s.appendChild(profileEditor(prof));
    return s;
  }

  function profileEditor(p: Profile): HTMLElement {
    const box = el("div", { class: "profile-editor" });

    box.appendChild(textRow("Name", p.name, (v) => {
      p.name = v;
      void persist();
    }));
    box.appendChild(
      textRow("Internal URL", p.internalUrl, (v) => {
        p.internalUrl = v.trim();
        void persist();
      }, "http://192.168.1.10:8123"),
    );
    box.appendChild(
      textRow("External URL", p.externalUrl, (v) => {
        p.externalUrl = v.trim();
        void persist();
      }, "https://example.ui.nabu.casa"),
    );
    box.appendChild(
      textRow("WiFi SSIDs", p.ssids.join(", "), (v) => {
        p.ssids = v.split(",").map((x) => x.trim()).filter(Boolean);
        void persist();
      }, "comma-separated (tie-breaker only)"),
    );

    // Token controls (keychain-backed).
    const tokenBox = el("div", { class: "token-box" });
    const status = el("span", { class: "token-status", text: "checking…" });
    api.hasToken(p.id).then((has) => {
      status.textContent = has ? "Token stored ✓" : "No token stored";
      status.className = `token-status ${has ? "ok" : "warn"}`;
    });
    const tokenInput = el("input", {
      attrs: { type: "password", placeholder: "Set / replace token" },
    });
    const saveTok = el("button", { class: "small", text: "Save token" });
    saveTok.addEventListener("click", async () => {
      if (!tokenInput.value) return;
      await api.setToken(p.id, tokenInput.value);
      tokenInput.value = "";
      status.textContent = "Token stored ✓";
      status.className = "token-status ok";
      await api.reconnect();
    });
    const delTok = el("button", { class: "small danger", text: "Remove" });
    delTok.addEventListener("click", async () => {
      await api.deleteToken(p.id);
      status.textContent = "No token stored";
      status.className = "token-status warn";
    });
    tokenBox.append(status, tokenInput, saveTok, delTok);
    box.appendChild(labeledRow("Token", tokenBox));

    const actions = el("div", { class: "row actions" });
    const makeActive = el("button", { class: "small", text: "Make active (pin)" });
    makeActive.addEventListener("click", () => api.setActiveProfile(p.id));
    const resume = el("button", { class: "small", text: "Resume auto-switch" });
    resume.addEventListener("click", () => api.resumeAutoSwitch());
    actions.append(makeActive, resume);
    box.appendChild(actions);

    const del = el("button", { class: "small danger", text: "Delete this house" });
    del.addEventListener("click", async () => {
      await api.deleteToken(p.id).catch(() => {});
      draft.profiles = draft.profiles.filter((x) => x.id !== p.id);
      if (draft.activeProfileId === p.id) {
        draft.activeProfileId = draft.profiles[0]?.id ?? null;
      }
      editingId = draft.profiles[0]?.id ?? null;
      await persist();
      build();
    });
    box.appendChild(del);
    return box;
  }

  function layoutSection(p: Profile): HTMLElement {
    const s = section("Layout");
    const row = el("div", { class: "row" });
    row.appendChild(el("span", { text: "Group by" }));
    const seg = el("div", { class: "segment" });
    const mk = (mode: "room" | "custom", label: string) => {
      const b = el("button", {
        class: `seg-btn ${p.groupBy === mode ? "active" : ""}`,
        text: label,
      });
      b.addEventListener("click", async () => {
        p.groupBy = mode;
        await persist();
        build();
      });
      return b;
    };
    seg.append(mk("room", "Room"), mk("custom", "Custom"));
    row.appendChild(seg);
    s.appendChild(row);
    s.appendChild(
      el("p", {
        class: "muted",
        text:
          p.groupBy === "room"
            ? "Devices are grouped by their Home Assistant area."
            : "Devices are grouped by your custom groups (assign via a card's ✎ editor).",
      }),
    );
    return s;
  }

  function groupsSection(p: Profile): HTMLElement {
    const s = section("Custom groups");
    const list = el("div", { class: "group-list" });
    for (const g of [...p.groups].sort((a, b) => a.order - b.order)) {
      const row = el("div", { class: "row" });
      const nameI = el("input");
      nameI.value = g.name;
      nameI.addEventListener("change", () => {
        g.name = nameI.value;
        void persist();
      });
      const del = el("button", { class: "small danger", text: "✕" });
      del.addEventListener("click", async () => {
        p.groups = p.groups.filter((x) => x.id !== g.id);
        for (const e of p.entities) if (e.groupId === g.id) e.groupId = "";
        await persist();
        build();
      });
      row.append(nameI, del);
      list.appendChild(row);
    }
    s.appendChild(list);
    const add = el("button", { class: "small", text: "+ Add group" });
    add.addEventListener("click", async () => {
      p.groups.push({ id: crypto.randomUUID(), name: "New group", order: p.groups.length });
      await persist();
      build();
    });
    s.appendChild(add);
    return s;
  }

  function importExportSection(): HTMLElement {
    const s = section("Backup / share (no tokens)");
    const ta = el("textarea", { attrs: { rows: "6", spellcheck: "false" } });

    const exportBtn = el("button", { class: "small", text: "Export current" });
    exportBtn.addEventListener("click", async () => {
      ta.value = await api.exportConfig();
      try {
        await navigator.clipboard.writeText(ta.value);
      } catch {
        /* clipboard optional */
      }
    });

    const importBtn = el("button", { class: "small", text: "Import from text" });
    const importStatus = el("span", { class: "muted" });
    importBtn.addEventListener("click", async () => {
      try {
        const imported = await api.importConfig(ta.value);
        draft = structuredClone(imported);
        editingId = draft.activeProfileId ?? draft.profiles[0]?.id ?? null;
        importStatus.textContent = "Imported ✓";
        build();
      } catch (err) {
        importStatus.textContent = `Import failed: ${err}`;
      }
    });

    const actions = el("div", { class: "row" });
    actions.append(exportBtn, importBtn, importStatus);
    s.append(actions, ta);
    return s;
  }

  build();
  return root;
}

// ---------------------------------------------------------------------------
// Small row/section builders
// ---------------------------------------------------------------------------

function section(title: string): HTMLElement {
  const s = el("section", { class: "settings-section" });
  s.appendChild(el("h3", { text: title }));
  return s;
}

function toggleRow(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = el("label", { class: "row toggle-row" });
  row.appendChild(el("span", { text: label }));
  const cb = el("input", { attrs: { type: "checkbox" } });
  cb.checked = value;
  cb.addEventListener("change", () => onChange(cb.checked));
  row.appendChild(cb);
  return row;
}

function textRow(
  label: string,
  value: string,
  onChange: (v: string) => void,
  placeholder = "",
): HTMLElement {
  const row = el("label", { class: "row text-row" });
  row.appendChild(el("span", { text: label }));
  const i = el("input", { attrs: { type: "text", placeholder } });
  i.value = value;
  i.addEventListener("change", () => onChange(i.value));
  row.appendChild(i);
  return row;
}

function labeledRow(label: string, content: HTMLElement): HTMLElement {
  const row = el("div", { class: "row text-row" });
  row.appendChild(el("span", { text: label }));
  row.appendChild(content);
  return row;
}

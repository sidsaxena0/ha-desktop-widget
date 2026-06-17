// First-run onboarding: create the first house profile. The token is validated
// with the AUTHENTICATED check (distinct from the reachability probe) so we can
// tell "wrong token" apart from "URL unreachable" and message precisely.

import { api } from "../ha";
import { state } from "../store";
import { emptyConfig, newProfile, type TokenCheck } from "../types";
import { el } from "../util";

function field(
  label: string,
  input: HTMLInputElement,
  hint?: string,
): HTMLElement {
  const wrap = el("label", { class: "field" });
  wrap.appendChild(el("span", { class: "field-label", text: label }));
  wrap.appendChild(input);
  if (hint) wrap.appendChild(el("span", { class: "field-hint", text: hint }));
  return wrap;
}

function input(placeholder: string, type = "text"): HTMLInputElement {
  const i = el("input", { attrs: { type, placeholder } });
  return i;
}

export function renderOnboarding(onDone: () => void): HTMLElement {
  const root = el("div", { class: "onboarding" });
  root.appendChild(el("h1", { text: "Add your first house" }));
  root.appendChild(
    el("p", {
      class: "intro",
      text: "Connect to a Home Assistant instance. The token is stored in your OS keychain, never in the config file.",
    }),
  );

  const nameI = input("Home");
  const internalI = input("http://192.168.1.10:8123");
  const externalI = input("https://example.ui.nabu.casa (optional)");
  const tokenI = input("Long-lived access token", "password");
  const ssidI = input("MyWiFi, MyWiFi-5G (optional, comma-separated)");

  const localWarn = el("span", {
    class: "field-hint warn",
    text: "Tip: an IP address is more reliable than a .local name (mDNS is flaky, especially on Windows).",
  });
  localWarn.style.display = "none";
  internalI.addEventListener("input", () => {
    localWarn.style.display = internalI.value.includes(".local") ? "block" : "none";
  });

  const form = el("div", { class: "form" });
  form.appendChild(field("House name", nameI));
  const internalField = field(
    "Internal URL (LAN)",
    internalI,
    "Used when this house is reachable on your network.",
  );
  internalField.appendChild(localWarn);
  form.appendChild(internalField);
  form.appendChild(
    field("External URL", externalI, "Used when you're away (Nabu Casa / proxy)."),
  );
  form.appendChild(field("Access token", tokenI));
  form.appendChild(field("WiFi SSIDs", ssidI, "Only a tie-breaker; not required."));
  root.appendChild(form);

  const status = el("div", { class: "form-status" });
  root.appendChild(status);

  const submit = el("button", { class: "primary", text: "Connect" });
  root.appendChild(submit);

  const setStatus = (msg: string, cls = "") => {
    status.className = `form-status ${cls}`;
    status.textContent = msg;
  };

  submit.addEventListener("click", async () => {
    const name = nameI.value.trim() || "Home";
    const internalUrl = internalI.value.trim();
    const externalUrl = externalI.value.trim();
    const token = tokenI.value;

    if (!internalUrl && !externalUrl) {
      setStatus("Enter at least one URL.", "error");
      return;
    }
    if (!token) {
      setStatus("A long-lived access token is required.", "error");
      return;
    }

    submit.setAttribute("disabled", "true");
    setStatus("Validating token…");

    // Validate against whichever URL we can reach: try internal, then external.
    let check: TokenCheck | null = null;
    let validatedUrl = "";
    for (const url of [internalUrl, externalUrl].filter(Boolean)) {
      const result = await api.checkToken(url, token);
      validatedUrl = url;
      check = result;
      if (result.result === "valid" || result.result === "unauthorized") break;
    }

    if (check?.result === "unauthorized") {
      setStatus("Home Assistant rejected that token. Check it and try again.", "error");
      submit.removeAttribute("disabled");
      return;
    }
    if (check?.result === "unreachable") {
      // Not necessarily fatal — they may be setting up off-site. Warn + proceed.
      setStatus(`Couldn't reach ${validatedUrl}. Saving anyway — it'll connect when reachable.`, "warn");
    } else {
      setStatus("Token valid. Saving…", "ok");
    }

    const profile = newProfile(name);
    profile.internalUrl = internalUrl;
    profile.externalUrl = externalUrl;
    profile.ssids = ssidI.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const cfg = state.config ?? emptyConfig();
    cfg.profiles.push(profile);
    cfg.activeProfileId = profile.id;

    try {
      await api.setToken(profile.id, token);
      await api.saveConfig(cfg);
      state.config = cfg;
      onDone();
    } catch (err) {
      setStatus(`Failed to save: ${err}`, "error");
      submit.removeAttribute("disabled");
    }
  });

  return root;
}

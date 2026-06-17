# HA Widget

A lightweight, always-on-top desktop widget for controlling **Home Assistant** —
not a browser tab, not a website. Built with [Tauri v2](https://v2.tauri.app)
(Rust core + a tiny vanilla-TypeScript frontend), so the binary is small and
there is **zero telemetry**.

- 🪟 Frameless, always-on-top, draggable, resizable window that remembers its
  position and size.
- ⚡ Live entity state over Home Assistant's **WebSocket API**; toggles reflect
  real state in real time and update instantly when changed elsewhere.
- 🏠 **Multi-house** profiles with **reachability-first** network switching
  (use the LAN URL at home, the remote URL when away — automatically).
- 🔒 Tokens stored in the **OS keychain** (macOS Keychain / Windows Credential
  Manager), never in the config file or any export.
- 🧩 **Zero-config:** on connect it shows **all your devices grouped by room**
  (Home Assistant Areas) — no setup. Supports `light`, `switch`,
  `input_boolean`, `fan`, `climate`, `scene`, and `script`.
- ⭐ **Star to favorite** any device and flip the header toggle to show favorites
  only. Per-device custom label/icon and optional custom groups via each card's
  inline editor. Rooms are collapsible (first expanded).
- 🔁 Autostart at login, system tray (show/hide, switch profile, quit).
- 📤 Import/export layouts as JSON to share with others (tokens excluded).

> **Status:** early/0.1. Contributions welcome.

---

## Requirements

- **Node 18+** and **[pnpm](https://pnpm.io)** (`npm i -g pnpm`)
- **Rust** stable toolchain ([rustup](https://rustup.rs))
- Platform build prerequisites (see the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)):
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Windows:** Microsoft C++ Build Tools + WebView2 (preinstalled on Win 11)

## Quick start (development)

```bash
pnpm install
pnpm app:dev      # launches the widget with hot-reload
```

On first launch you'll be guided through **onboarding** to add your first house:
name, internal URL, optional external URL, a long-lived access token, and any
WiFi SSIDs. Create a token in Home Assistant under your **Profile → Long-lived
access tokens**.

> **Tip:** prefer an **IP address** (e.g. `http://192.168.1.10:8123`) over
> `homeassistant.local` for the internal URL — mDNS `.local` resolution is
> flaky, especially on Windows, and can cause false "unreachable" results.

## How network awareness works

Selection is **reachability-first**, not SSID-first:

1. The app probes each profile's **internal URL** (an unauthenticated request;
   *any* HTTP response, including `401`, counts as "reachable"). Whichever
   answers is the house you're at.
2. **SSID is only a tie-breaker** — used to disambiguate when two houses share
   the same internal IP scheme (e.g. `192.168.1.x` at both). It's never the
   primary signal, which matters because SSID detection is permission-gated and
   flaky on recent macOS.
3. Within the chosen house, the **internal URL** is used if it's reachable,
   otherwise the **external URL** (e.g. Nabu Casa) — you never pick a URL by hand.

Re-checks happen on launch, on a timer, on window focus, and when the WebSocket
disconnects ("I left the house"). Behaviour is configurable:

- **`Auto-switch house by location`** (Settings) — when off, the app stays on
  your chosen house but still picks internal-vs-external by reachability.
- **Manual profile pick** (tray or Settings) is **sticky for the session** and
  overrides auto-switching until you choose **Resume auto-switch**.

A token problem is reported as a **token error**, distinct from a network error —
a bad/expired token never looks like "I'm away from home".

## Where data is stored

| Data | Location |
| --- | --- |
| Config (profiles, layout, settings) | App config dir: `~/Library/Application Support/com.hawidget.desktop/config.json` (macOS) · `%APPDATA%\com.hawidget.desktop\config.json` (Windows) |
| Tokens | OS keychain — service `ha-desktop-widget`, account = profile id |

**Export/Import** (Settings → *Backup / share*) round-trips the config JSON.
Tokens are not part of the config, so shared layouts can never leak credentials —
recipients add their own token after importing.

---

## Building distributables

```bash
# Native target for your current OS:
pnpm app:build

# macOS universal binary (Apple Silicon + Intel):
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm app:build:mac-universal
```

Artifacts land in `src-tauri/target/**/release/bundle/`:

- **macOS:** `.app` and `.dmg`
- **Windows:** `.msi` and `.exe` (NSIS)

> Windows installers **cannot** be cross-compiled from macOS (and vice-versa) —
> build each target on its own OS, or use the included GitHub Actions release
> workflow which builds both.

### Releasing both platforms via CI

Releases are a two-step flow (CI builds; you publish — so no broad token is ever
stored in the repo):

1. Push a version tag:
   ```bash
   git tag -a v0.1.0 -m v0.1.0 && git push origin v0.1.0
   ```
   [`.github/workflows/release.yml`](.github/workflows/release.yml) builds the
   **macOS universal** bundle and **Windows** installers and uploads them as
   workflow artifacts.
2. After the run finishes, publish the GitHub Release from your authenticated
   `gh` session:
   ```bash
   scripts/publish-release.sh v0.1.0
   ```
   This downloads the artifacts and creates the Release with the `.dmg`, `.msi`,
   and `.exe` attached.

## Signing & Gatekeeper / SmartScreen

### macOS — signed + notarized (release)

The release workflow signs and notarizes the macOS build with a **Developer ID**
when these repository **secrets** are set (leave them unset to produce an
unsigned build instead):

| Secret | Meaning |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of your Developer ID `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | an app-specific password for notarization |
| `APPLE_TEAM_ID` | your 10-character Apple Team ID |

### macOS — running an **unsigned** build (contributors without a cert)

If you build locally without signing, macOS Gatekeeper will warn. Allow it with
either:

```bash
xattr -dr com.apple.quarantine "/Applications/HA Widget.app"
```

…or right-click the app → **Open** → **Open** the first time.

### Windows — unsigned

Windows builds are **unsigned**. SmartScreen may show *"Windows protected your
PC"* — click **More info → Run anyway**. Code-signing certificates for Windows
are out of scope for this project.

---

## Project layout

```
src/              # frontend (vanilla TS + Vite)
  components/      # grid, card, settings, onboarding
src-tauri/src/    # Rust core
  ha_client.rs     # WebSocket client (owns the connection + token)
  network.rs       # reachability-first selection + SSID tie-breaker
  config.rs        # token-free config load/save + import/export
  secrets.rs       # keychain-backed token storage
  app_state.rs     # shared state + evaluate-and-apply
  commands.rs      # the IPC command surface
  lib.rs           # app wiring, tray, re-check pipeline
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev notes (including a macOS
dev-keychain stability tip).

## License

[MIT](LICENSE)

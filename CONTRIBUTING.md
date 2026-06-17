# Contributing

Thanks for your interest! This is a small, dependency-light project — please
keep PRs focused and the binary lean.

## Dev setup

```bash
pnpm install
pnpm app:dev
```

- Frontend: `src/` (vanilla TS + Vite). Type-check with `pnpm build`.
- Rust core: `src-tauri/`. Check with `cargo check`, format with `cargo fmt`.

## Architecture notes

- **The Rust side owns the WebSocket connection and the token.** The token is
  read from the keychain inside Rust and used to authenticate the socket; it is
  never sent to the webview. The UI gets state via Tauri events
  (`ha://status`, `ha://states`, `ha://state`) and sends commands via `invoke`.
- **Two distinct network checks** — never conflate them:
  - *Reachability probe* (`network.rs`): unauthenticated, any HTTP response
    (incl. `401`) means reachable. No token sent.
  - *Token validity* (`ha_client.rs::validate_token`): a separate authenticated
    check used by onboarding/connect.
- Connection selection is **reachability-first**; SSID is a tie-breaker only.
  See `network.rs::select_connection`.
- The WebSocket subscribes to `state_changed` **before** `get_states` to avoid a
  startup missed-event race (`ha_client.rs`).

## macOS dev-keychain stability (important)

During development, each rebuild changes the binary's signature, which breaks
Keychain ACLs — so macOS re-prompts *"… wants to use your keychain"* on every
run. Stabilize the identity by **ad-hoc signing** the dev build:

```bash
# after a build, before running (or wire into your own dev loop):
codesign --force --sign - "src-tauri/target/debug/ha-desktop-widget"
```

The first keychain prompt after an ad-hoc sign can be answered **Always Allow**
and will then stick across rebuilds. This is a dev-only nuisance — release
builds are properly signed + notarized, so it does not affect end users.

## Icons (vendored MDI, woff2-only)

Icons use [Material Design Icons](https://pictogrammers.com/library/mdi/) — the
same set Home Assistant uses, so an entity's `mdi:*` icon maps directly to a
font class. To keep the bundle lean we vendor a **woff2-only** stylesheet at
`src/vendor/mdi.css` (the upstream `@mdi/font` CSS also references eot/woff/ttf,
~3.6 MB we don't ship). `@mdi/font` is a devDependency used only to regenerate it.

To update icons after bumping `@mdi/font`:

```bash
cp node_modules/@mdi/font/fonts/materialdesignicons-webfont.woff2 src/vendor/fonts/
python3 - <<'PY'
import re
src = open('node_modules/@mdi/font/css/materialdesignicons.css', encoding='utf-8').read()
good = '@font-face {\n  font-family: "Material Design Icons";\n  src: url("./fonts/materialdesignicons-webfont.woff2") format("woff2");\n  font-weight: normal;\n  font-style: normal;\n}'
open('src/vendor/mdi.css','w',encoding='utf-8').write(re.sub(r'@font-face\s*\{[^}]*\}', good, src, count=1))
PY
```

## Before opening a PR

- `pnpm build` passes (TypeScript clean).
- `cargo fmt` and `cargo check` are clean in `src-tauri/`.
- No personal data, URLs, tokens, or SSIDs committed anywhere.

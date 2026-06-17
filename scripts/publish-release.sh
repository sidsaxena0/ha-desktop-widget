#!/usr/bin/env bash
# Publish a GitHub Release from installers built by the Release workflow.
#
# The CI workflow only *builds* and uploads installers as artifacts (it doesn't
# create the Release, to avoid storing a broad token in CI). This script
# downloads those artifacts with your authenticated `gh` session and publishes
# the Release.
#
# Usage:
#   1. bump the version + push a tag:   git tag -a v0.1.0 -m v0.1.0 && git push origin v0.1.0
#   2. wait for the Release workflow to finish (Actions tab)
#   3. scripts/publish-release.sh v0.1.0
set -euo pipefail

TAG="${1:?Usage: scripts/publish-release.sh vX.Y.Z}"
REPO="${REPO:-sidsaxena0/ha-desktop-widget}"

echo "Finding the latest successful Release build…"
RID="$(gh run list --workflow=release.yml -R "$REPO" --limit 30 \
  --json databaseId,conclusion --jq '[.[] | select(.conclusion=="success")][0].databaseId')"
[ -n "$RID" ] || { echo "No successful Release run found — push $TAG and wait for CI."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading installers from run $RID…"
gh run download "$RID" -R "$REPO" -D "$TMP"

FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(
  find "$TMP" -type f \( -name '*.dmg' -o -name '*.msi' -o -name '*-setup.exe' \)
)
[ "${#FILES[@]}" -gt 0 ] || { echo "No installers found in the artifacts."; exit 1; }
echo "Attaching:"; printf '  %s\n' "${FILES[@]}"

NOTES="$(cat <<'EOF'
Always-on-top desktop widget for controlling Home Assistant.

### Download
- **macOS** — `.dmg` (universal: Apple Silicon + Intel)
- **Windows** — `.msi` or `-setup.exe` installer

### First launch (these builds are unsigned)
- **macOS:** right-click the app → **Open** → **Open**, or run
  `xattr -dr com.apple.quarantine "/Applications/HA Widget.app"`.
- **Windows:** if SmartScreen appears, click **More info → Run anyway**.

See the README for setup.
EOF
)"

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" -R "$REPO" --clobber "${FILES[@]}"
else
  gh release create "$TAG" -R "$REPO" --title "HA Widget $TAG" --notes "$NOTES" "${FILES[@]}"
fi
echo "Published: https://github.com/$REPO/releases/tag/$TAG"

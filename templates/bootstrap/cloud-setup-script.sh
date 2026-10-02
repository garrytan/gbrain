#!/bin/bash
# gbrain — cloud environment setup script.
# Paste this into your cloud environment's setup script (it runs as root
# before the session starts; what it writes to disk is snapshot-cached and
# reused by later sessions). Printed by: gbrain bootstrap cloud-setup-script
set -eu

# 1. Bun runtime, at least GBrain's minimum (1.4.0; older Bun is refused).
#    Installed VIA npm — bun's own package fetching is proxy-incompatible in
#    cloud sandboxes; npm's is not. A preinstalled older Bun stays untouched.
GBRAIN_BUN=$(command -v bun || true)
if [ -z "$GBRAIN_BUN" ] || ! "$GBRAIN_BUN" -e 'process.exit(Bun.semver.satisfies(Bun.version, ">=1.4.0") ? 0 : 1)'; then
  npm install -g bun
  GBRAIN_BUN="$(npm prefix -g)/bin/bun"
fi
export PATH="$(dirname "$GBRAIN_BUN"):$PATH"

# 2. gbrain from the canonical GitHub source. NEVER `npm install -g gbrain`:
#    the npm registry package with that name is unrelated squatter code.
GBRAIN_DIR=/opt/gbrain
# Pinned to latest-stable — the SAME ref the canonical local install uses.
if [ ! -d "$GBRAIN_DIR/.git" ]; then
  git clone --depth 1 --branch latest-stable https://github.com/garrytan/gbrain "$GBRAIN_DIR"
else
  # Fail loud (set -e) on a broken update — never npm-install + run stale code
  # as root against a half-updated checkout.
  git -C "$GBRAIN_DIR" fetch --depth 1 origin latest-stable
  git -C "$GBRAIN_DIR" checkout -q FETCH_HEAD
fi
cd "$GBRAIN_DIR"
# npm (not bun) for dependency fetching — same proxy constraint as above.
npm install --no-audit --no-fund

# 3. PATH-resolved launcher: the repo-committed hook commands and MCP
#    registration expect `gbrain` on PATH (they are fail-open where it isn't).
cat > /usr/local/bin/gbrain <<LAUNCHER
#!/bin/sh
exec '$GBRAIN_BUN' /opt/gbrain/src/cli.ts "\$@"
LAUNCHER
chmod +x /usr/local/bin/gbrain

gbrain --version

# After the session starts, finish wiring INSIDE the session:
#   gbrain bootstrap status --json     # confirms execution_environment: cloud-sandbox
#   gbrain bootstrap attach            # adopt the brain repo this session is opened on
#   gbrain bootstrap hooks --harness claude-code   # committed-carrier hooks (next session picks them up)

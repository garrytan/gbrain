#!/bin/bash
# gbrain — cloud environment setup script.
# Paste this into your cloud environment's setup script (it runs as root
# before the session starts; what it writes to disk is snapshot-cached and
# reused by later sessions). Printed by: gbrain bootstrap cloud-setup-script
set -eu

# 1. Bun runtime (gbrain runs on bun). Installed VIA npm — bun's own package
#    fetching is proxy-incompatible in cloud sandboxes; npm's is not.
command -v bun >/dev/null 2>&1 || npm install -g bun

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
cat > /usr/local/bin/gbrain <<'LAUNCHER'
#!/bin/sh
exec bun /opt/gbrain/src/cli.ts "$@"
LAUNCHER
chmod +x /usr/local/bin/gbrain

gbrain --version

# After the session starts, finish wiring INSIDE the session:
#   gbrain bootstrap status --json     # confirms execution_environment: cloud-sandbox
#   gbrain bootstrap attach            # adopt the brain repo this session is opened on
#   gbrain bootstrap hooks --harness claude-code   # committed-carrier hooks (next session picks them up)

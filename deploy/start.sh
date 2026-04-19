#!/usr/bin/env bash
# GBrain container entrypoint.
# Clones (or pulls) the notes repo, then runs the HTTP MCP wrapper + autopilot.
# Exits if either process dies so Fly restarts the whole machine.
set -euo pipefail

NOTES_DIR="${NOTES_DIR:-/notes}"
NOTES_REPO="${NOTES_REPO:?NOTES_REPO env var required (e.g. git@github.com:user/notes.git)}"
SYNC_INTERVAL="${SYNC_INTERVAL:-300}"

# SSH deploy key for cloning a private repo. Provided via Fly secret as base64.
if [ -n "${SSH_DEPLOY_KEY_B64:-}" ]; then
  mkdir -p /root/.ssh
  printf '%s' "$SSH_DEPLOY_KEY_B64" | base64 -d > /root/.ssh/id_ed25519
  chmod 600 /root/.ssh/id_ed25519
  ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
fi

# Clone or pull notes
if [ ! -d "$NOTES_DIR/.git" ]; then
  echo "Cloning $NOTES_REPO -> $NOTES_DIR"
  git clone --depth 1 "$NOTES_REPO" "$NOTES_DIR"
else
  echo "Pulling latest $NOTES_DIR"
  git -C "$NOTES_DIR" pull --ff-only || echo "warn: initial pull failed, autopilot will retry"
fi

# Forward SIGTERM/SIGINT to children so Fly can stop us cleanly.
trap 'kill -TERM "$WRAPPER_PID" "$AUTOPILOT_PID" 2>/dev/null || true; wait' TERM INT

# Run HTTP MCP wrapper (foreground-ish)
bun run /app/deploy/http-wrapper.ts &
WRAPPER_PID=$!

# Run autopilot in the same container. It does git pull + sync + extract + embed
# on its own interval; we don't need a separate cron.
bun run /app/src/cli.ts autopilot --repo "$NOTES_DIR" --interval "$SYNC_INTERVAL" &
AUTOPILOT_PID=$!

echo "wrapper pid=$WRAPPER_PID  autopilot pid=$AUTOPILOT_PID"

# Exit (and let Fly restart us) as soon as either process dies.
wait -n "$WRAPPER_PID" "$AUTOPILOT_PID"
EXIT=$?
echo "child exited with $EXIT — shutting down container"
kill -TERM "$WRAPPER_PID" "$AUTOPILOT_PID" 2>/dev/null || true
exit "$EXIT"

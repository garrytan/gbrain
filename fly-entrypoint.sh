#!/bin/bash
set -e

/usr/bin/ollama serve &
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
  sleep 1
done

# Warm the embedding model before serving traffic. A cold llama-server load
# takes longer than gbrain's embedding-call timeout (observed: aborted loads +
# HTTP 499 after ~4.5s), so lazy loading meant remote semantic queries failed
# on every cold start. OLLAMA_KEEP_ALIVE=-1 (fly.toml) keeps it resident after.
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:11434/api/embed \
    -H 'Content-Type: application/json' \
    -d '{"model":"nomic-embed-text","input":"warmup"}' >/dev/null 2>&1 && break
  sleep 2
done

cd /app

# Background worker: autopilot enqueues cycles and hosts the minion worker.
# Respawn loop instead of a supervisor: on the laptop, supervisor lock-loss
# (network blips) exited permanently by design; here we just restart. Skipped
# entirely if the model-call token is absent so a half-configured deploy
# serves reads instead of crash-looping cycles.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  (
    while true; do
      gbrain autopilot --interval 900 >>/tmp/autopilot.log 2>&1 || true
      echo "[entrypoint] autopilot exited, respawning in 10s" >>/tmp/autopilot.log
      sleep 10
    done
  ) &
  # Second queue worker: autopilot's embedded worker alone (concurrency 1)
  # falls behind cycle+subagent arrivals (observed 2026-08-09: 211-job
  # backlog). 0.42.76 dropped `jobs supervisor`; a plain extra `jobs work`
  # process doubles claim throughput. Respawn loop covers DB-blip exits.
  (
    while true; do
      gbrain jobs work >>/tmp/worker2.log 2>&1 || true
      echo "[entrypoint] worker2 exited, respawning in 10s" >>/tmp/worker2.log
      sleep 10
    done
  ) &
else
  echo "[entrypoint] CLAUDE_CODE_OAUTH_TOKEN not set; autopilot disabled" >&2
fi

exec bun src/cli.ts serve --http --port 8790 --bind 0.0.0.0 --enable-dcr \
  --public-url "${GBRAIN_PUBLIC_URL:-https://gbrain-chris.fly.dev}"

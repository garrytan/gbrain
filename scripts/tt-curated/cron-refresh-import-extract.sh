#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="/home/tt/workspace/tools/gbrain/scripts/tt-curated"
LOG_DIR="/home/tt/workspace/tools/gbrain-curated-logs"
STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/cron-refresh-import-extract-$STAMP.log"
OPENCLAW_CONFIG="/home/tt/.openclaw/openclaw.json"
CHAT_ID="477144117"
SMOKE_JSON="$LOG_DIR/refresh-smoke-last.json"

mkdir -p "$LOG_DIR"

send_failure_alert() {
  local body="$1"
  /usr/bin/python3 - <<'PY' "$OPENCLAW_CONFIG" "$CHAT_ID" "$body"
import json, pathlib, sys, urllib.parse, urllib.request
config_path = pathlib.Path(sys.argv[1])
chat_id = sys.argv[2]
body = sys.argv[3]
config = json.loads(config_path.read_text())
token = config["channels"]["telegram"]["botToken"]
url = f"https://api.telegram.org/bot{token}/sendMessage"
data = urllib.parse.urlencode({"chat_id": chat_id, "text": body}).encode()
req = urllib.request.Request(url, data=data, method="POST")
with urllib.request.urlopen(req, timeout=20) as resp:
    resp.read()
PY
}

{
  echo "[$(date '+%F %T')] start curated refresh/import/extract"
  "$SCRIPT_DIR/run-refresh-import-extract.sh"
  echo "[$(date '+%F %T')] smoke check"
  "$SCRIPT_DIR/refresh-smoke-check.sh"
  echo "[$(date '+%F %T')] done"
} >"$LOG_FILE" 2>&1 || {
  tail_text="$(tail -n 40 "$LOG_FILE")"
  smoke_fail="$(/usr/bin/python3 - <<'PY' "$SMOKE_JSON"
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
if not path.exists():
    print('')
    raise SystemExit(0)
obj = json.loads(path.read_text())
failed = [r['id'] for r in obj.get('results', []) if not r.get('ok')]
print(', '.join(failed[:10]))
PY
)"
  message="gbrain refresh FAIL\nlog: $LOG_FILE"
  if [[ -n "$smoke_fail" ]]; then
    message+="\nsmoke: $smoke_fail"
  fi
  message+="\n\n$tail_text"
  send_failure_alert "$message" || true
  echo "FAILED: $LOG_FILE"
  exit 1
}

echo "OK: $LOG_FILE"

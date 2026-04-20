#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
eval "$(/usr/bin/python3 "$SCRIPT_DIR/config_loader.py" shell)"
LOG_DIR="$CURATED_LOG_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/cron-refresh-import-extract-$STAMP.log"
CHAT_ID="$TELEGRAM_CHAT_ID"
SMOKE_JSON="$SMOKE_LAST_JSON"

mkdir -p "$LOG_DIR"
TAIL_LINES="${CRON_REFRESH_LOG_TAIL_LINES:-40}"
FAILED_CASE_LIMIT="${CRON_REFRESH_FAILED_CASE_LIMIT:-10}"
ALERT_PREFIX="${CRON_REFRESH_ALERT_PREFIX:-gbrain refresh FAIL}"

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
  tail_text="$(tail -n "$TAIL_LINES" "$LOG_FILE")"
  smoke_fail="$(/usr/bin/python3 - <<'PY' "$SMOKE_JSON" "$FAILED_CASE_LIMIT"
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
limit = int(sys.argv[2])
if not path.exists():
    print('')
    raise SystemExit(0)
obj = json.loads(path.read_text())
failed = [r['id'] for r in obj.get('results', []) if not r.get('ok')]
print(', '.join(failed[:limit]))
PY
)"
  message="$ALERT_PREFIX\nlog: $LOG_FILE"
  if [[ -n "$smoke_fail" ]]; then
    message+="\nsmoke: $smoke_fail"
  fi
  message+="\n\n$tail_text"
  send_failure_alert "$message" || true
  echo "FAILED: $LOG_FILE"
  exit 1
}

echo "OK: $LOG_FILE"

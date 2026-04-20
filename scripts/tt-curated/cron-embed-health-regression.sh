#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
eval "$(/usr/bin/python3 "$SCRIPT_DIR/config_loader.py" shell)"
LOG_DIR="$CURATED_LOG_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/cron-embed-health-regression-$STAMP.log"
JSON_FILE="$REGRESSION_LAST_JSON"
CHAT_ID="$TELEGRAM_CHAT_ID"

mkdir -p "$LOG_DIR"
TAIL_LINES="${CRON_NIGHTLY_LOG_TAIL_LINES:-40}"
FAILED_CASE_LIMIT="${CRON_NIGHTLY_FAILED_CASE_LIMIT:-10}"
SEVERE_DRIFT_CASE_LIMIT="${CRON_NIGHTLY_SEVERE_DRIFT_CASE_LIMIT:-5}"
ALERT_PREFIX="${CRON_NIGHTLY_ALERT_PREFIX:-gbrain nightly FAIL}"
REGRESSION_ALERT_PREFIX="${CRON_NIGHTLY_REGRESSION_ALERT_PREFIX:-gbrain regression FAIL}"

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
  echo "[$(date '+%F %T')] start curated embed/health/regression"
  "$SCRIPT_DIR/run-embed-health.sh"
  echo "[$(date '+%F %T')] done"
} >"$LOG_FILE" 2>&1 || {
  tail_text="$(tail -n "$TAIL_LINES" "$LOG_FILE")"
  message="$ALERT_PREFIX\nlog: $LOG_FILE\n\n$tail_text"
  send_failure_alert "$message" || true
  echo "FAILED: $LOG_FILE"
  exit 1
}

if [[ -f "$JSON_FILE" ]]; then
  status="$(/usr/bin/python3 - <<'PY' "$JSON_FILE"
import json, sys
obj = json.load(open(sys.argv[1]))
print('ok' if obj.get('ok') else 'fail')
PY
)"
  if [[ "$status" != "ok" ]]; then
    summary="$(/usr/bin/python3 - <<'PY' "$JSON_FILE" "$FAILED_CASE_LIMIT"
import json, sys
obj = json.load(open(sys.argv[1]))
limit = int(sys.argv[2])
failed = [r['id'] for r in obj.get('results', []) if not r.get('ok')]
print(', '.join(failed[:limit]))
PY
)"
    drift="$(/usr/bin/python3 - <<'PY' "$JSON_FILE" "$SEVERE_DRIFT_CASE_LIMIT"
import json, sys
obj = json.load(open(sys.argv[1]))
limit = int(sys.argv[2])
parts = []
for item in obj.get('severe_drift_cases', [])[:limit]:
    priority = item.get('priority', 'high')
    seg = f"{item['id']}[{priority}]"
    if item.get('rank_shift') is not None:
        seg += f" r+{item['rank_shift']}"
    if item.get('score_drop') is not None:
        seg += f" s-{item['score_drop']:.3f}"
    parts.append(seg)
print('; '.join(parts))
PY
)"
    message="$REGRESSION_ALERT_PREFIX\nlog: $LOG_FILE"
    if [[ -n "$summary" ]]; then
      message+="\nfailed: $summary"
    fi
    if [[ -n "$drift" ]]; then
      message+="\ndrift: $drift"
    fi
    send_failure_alert "$message" || true
    echo "REGRESSION_FAILED: $LOG_FILE"
    exit 1
  fi
fi

echo "OK: $LOG_FILE"

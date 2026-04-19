#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="/home/tt/workspace/tools/gbrain/scripts/tt-curated"
LOG_DIR="/home/tt/workspace/tools/gbrain-curated-logs"
STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/cron-embed-health-regression-$STAMP.log"
JSON_FILE="$LOG_DIR/query-regression-last.json"
OPENCLAW_CONFIG="/home/tt/.openclaw/openclaw.json"
CHAT_ID="477144117"

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
  echo "[$(date '+%F %T')] start curated embed/health/regression"
  "$SCRIPT_DIR/run-embed-health.sh"
  echo "[$(date '+%F %T')] done"
} >"$LOG_FILE" 2>&1 || {
  tail_text="$(tail -n 40 "$LOG_FILE")"
  message="gbrain nightly FAIL\nlog: $LOG_FILE\n\n$tail_text"
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
    summary="$(/usr/bin/python3 - <<'PY' "$JSON_FILE"
import json, sys
obj = json.load(open(sys.argv[1]))
failed = [r['id'] for r in obj.get('results', []) if not r.get('ok')]
print(', '.join(failed[:10]))
PY
)"
    drift="$(/usr/bin/python3 - <<'PY' "$JSON_FILE"
import json, sys
obj = json.load(open(sys.argv[1]))
parts = []
for item in obj.get('severe_drift_cases', [])[:5]:
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
    message="gbrain regression FAIL\nlog: $LOG_FILE"
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

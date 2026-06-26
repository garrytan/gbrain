#!/usr/bin/env bash
set -u

REPO_DIR="${GBRAIN_OPERATOR_BRIEF_REPO:-/Users/sawbeck/gbrain}"
RECEIPT_DIR="${GBRAIN_OPERATOR_BRIEF_DIR:-$HOME/.gbrain/operator-briefs}"
SOURCE_DRIFT_DIR="${GBRAIN_SOURCE_DRIFT_DIR:-$HOME/.gstack/projects/garrytan-gbrain/source-drift-previews}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RECEIPT="$RECEIPT_DIR/gbrain-operator-brief-$STAMP.md"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gbrain-operator-brief.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$RECEIPT_DIR"
cd "$REPO_DIR" || {
  printf 'Could not cd to GBrain repo: %s\n' "$REPO_DIR" >&2
  exit 1
}

run_capture() {
  local name="$1"
  shift
  local out="$TMP_DIR/$name.out"
  local err="$TMP_DIR/$name.err"
  if "$@" >"$out" 2>"$err"; then
    printf '0' >"$TMP_DIR/$name.code"
  else
    printf '%s' "$?" >"$TMP_DIR/$name.code"
  fi
}

json_get() {
  local file="$1"
  local expr="$2"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const expr = process.argv[2];
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { process.exit(2); }
    const fn = new Function("data", `return (${expr});`);
    const value = fn(data);
    if (value === undefined || value === null) process.exit(1);
    if (typeof value === "object") console.log(JSON.stringify(value));
    else console.log(String(value));
  ' "$file" "$expr" 2>/dev/null
}

latest_file() {
  local dir="$1"
  local pattern="$2"
  [ -d "$dir" ] || return 1
  find "$dir" -type f -name "$pattern" -print 2>/dev/null | sort | tail -n 1
}

run_capture git_status git -C "$REPO_DIR" status --short --branch
run_capture git_head git -C "$REPO_DIR" log --oneline --decorate -1
run_capture current_source gbrain sources current --json
run_capture status gbrain status --json --fast
run_capture supervisor gbrain jobs supervisor status --json
run_capture active_jobs gbrain jobs list --status active
run_capture doctor_plan gbrain doctor --remediation-plan --json
run_capture budget_daily gbrain budget daily --json

latest_drift_json="$(latest_file "$SOURCE_DRIFT_DIR" 'rehome-preview-*.json' || true)"
latest_drift_md="$(latest_file "$SOURCE_DRIFT_DIR" 'rehome-preview-*.md' || true)"

generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
branch_status="$(cat "$TMP_DIR/git_status.out" 2>/dev/null | head -n 1)"
head_line="$(cat "$TMP_DIR/git_head.out" 2>/dev/null | head -n 1)"
source_id="$(json_get "$TMP_DIR/current_source.out" 'data.source_id' || printf 'unknown')"
source_detail="$(json_get "$TMP_DIR/current_source.out" 'data.detail' || printf 'unknown')"
queue_active="$(json_get "$TMP_DIR/status.out" 'data.queue && data.queue.active' || printf '?')"
queue_waiting="$(json_get "$TMP_DIR/status.out" 'data.queue && data.queue.waiting' || printf '?')"
queue_failed="$(json_get "$TMP_DIR/status.out" 'data.queue && data.queue.failed' || printf '?')"
autopilot_running="$(json_get "$TMP_DIR/status.out" 'data.autopilot && data.autopilot.running' || printf 'unknown')"
worker_crashes="$(json_get "$TMP_DIR/status.out" 'data.workers && data.workers.crashes_24h' || printf '?')"
supervisor_running="$(json_get "$TMP_DIR/supervisor.out" 'data.running' || printf 'unknown')"
manual_workers="$(json_get "$TMP_DIR/supervisor.out" 'Array.isArray(data.workers) ? data.workers.length : 0' || printf '?')"
doctor_score="$(json_get "$TMP_DIR/doctor_plan.out" 'data.brain_score_current' || printf '?')"
doctor_target="$(json_get "$TMP_DIR/doctor_plan.out" 'data.brain_score_target' || printf '?')"
doctor_reachable="$(json_get "$TMP_DIR/doctor_plan.out" 'data.max_reachable_score' || printf '?')"
doctor_cost="$(json_get "$TMP_DIR/doctor_plan.out" 'data.est_total_usd_cost' || printf '?')"
doctor_steps="$(json_get "$TMP_DIR/doctor_plan.out" 'Array.isArray(data.plan) ? data.plan.map((s) => `${s.id} ($${s.est_usd_cost})`).join(", ") : ""' || printf '')"

budget_status="unavailable"
if [ "$(cat "$TMP_DIR/budget_daily.code")" = "0" ]; then
  budget_status="available"
fi

{
  printf '# GBrain Operator Brief\n\n'
  printf -- '- Generated: `%s`\n' "$generated_at"
  printf -- '- Repo: `%s`\n' "$REPO_DIR"
  printf -- '- Git: `%s`\n' "$branch_status"
  printf -- '- HEAD: `%s`\n' "$head_line"
  printf -- '- Current source: `%s` (%s)\n' "$source_id" "$source_detail"
  printf -- '- Receipt: `%s`\n\n' "$RECEIPT"

  printf '## Today\n\n'
  printf -- '- Active queue: `%s`; waiting: `%s`; failed: `%s`\n' "$queue_active" "$queue_waiting" "$queue_failed"
  printf -- '- Supervisor running: `%s`; manual workers listed: `%s`\n' "$supervisor_running" "$manual_workers"
  printf -- '- Autopilot running: `%s`\n' "$autopilot_running"
  printf -- '- Worker crashes in 24h: `%s`\n' "$worker_crashes"
  printf -- '- Doctor preview: score `%s/%s`, max reachable `%s`, estimated spend `$%s`\n' "$doctor_score" "$doctor_target" "$doctor_reachable" "$doctor_cost"
  if [ -n "$doctor_steps" ]; then
    printf -- '- Doctor preview steps: %s\n' "$doctor_steps"
  else
    printf -- '- Doctor preview steps: none reported\n'
  fi
  printf -- '- Budget daily readback: `%s`\n\n' "$budget_status"

  printf '## Active Jobs\n\n'
  printf '```text\n'
  cat "$TMP_DIR/active_jobs.out"
  if [ -s "$TMP_DIR/active_jobs.err" ]; then
    printf '\n[stderr]\n'
    cat "$TMP_DIR/active_jobs.err"
  fi
  printf '\n```\n\n'

  printf '## Source Drift Preview\n\n'
  if [ -n "$latest_drift_json" ]; then
    printf -- '- Latest JSON receipt: `%s`\n' "$latest_drift_json"
    if [ -n "$latest_drift_md" ]; then
      printf -- '- Latest markdown receipt: `%s`\n' "$latest_drift_md"
    fi
    node -e '
      const fs = require("fs");
      const path = process.argv[1];
      try {
        const data = JSON.parse(fs.readFileSync(path, "utf8"));
        const candidates = data.candidates || data.items || [];
        const total = data.total_candidates ?? data.total ?? candidates.length;
        const bySource = {};
        for (const c of candidates) {
          const source = c.source_id || c.source || c.current_source || "unknown";
          bySource[source] = (bySource[source] || 0) + 1;
        }
        console.log(`- Candidates: \`${total}\``);
        const entries = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 6);
        if (entries.length) console.log(`- Top sources: ${entries.map(([k, v]) => `\`${k}\` ${v}`).join(", ")}`);
      } catch {
        console.log("- Could not parse latest source drift JSON receipt.");
      }
    ' "$latest_drift_json"
  else
    printf -- '- No source drift preview receipt found in `%s`.\n' "$SOURCE_DRIFT_DIR"
  fi
  printf '\n'

  printf '## Doctor Preview JSON\n\n'
  printf '```json\n'
  cat "$TMP_DIR/doctor_plan.out"
  printf '\n```\n\n'

  printf '## Status JSON\n\n'
  printf '```json\n'
  cat "$TMP_DIR/status.out"
  printf '\n```\n'
} >"$RECEIPT"

cat "$RECEIPT"

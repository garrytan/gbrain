#!/usr/bin/env bash
# scripts/eval-spend-guard.sh — hard spend cap for paid eval runs.
#
# INVARIANT: a paid command never launches when (ledger total + estimate) would
# exceed the cap, and the money is on the ledger BEFORE it can be spent: a
# reservation row (cost = estimate) is appended before the command starts, so a
# concurrent guard, a SIGKILLed guard, a crashed host, or a Ctrl-C all leave
# the spend counted. The running total can only ever UNDER-state spend if the
# command itself lies about its cost. The guard FAILS CLOSED on anything it
# cannot account for: a missing ledger, an unparseable ledger line, a signed or
# malformed amount, a ledger it cannot append to. No jq / bun dependency at
# runtime.
#
# Usage:
#   scripts/eval-spend-guard.sh <cap_usd> <estimate_usd> -- <command...>
#
# Amounts are UNSIGNED decimals (`3`, `1.25`, `.5`, `2e-1`); a sign is a usage
# error — a negative estimate would drive the ledger backwards. Both are
# normalized to %.6f before they are compared or written.
#
# Ledger: $GBRAIN_EVAL_SPEND_LEDGER (default ~/gbrain-lme-receipts/spend.jsonl),
# one JSON object per line with a numeric `cost_usd` field. The file MUST
# already exist: the first run sets GBRAIN_EVAL_SPEND_LEDGER_INIT=1 (or
# pre-creates the file), which prints a loud NEW LEDGER line — a ledger that
# silently starts at $0 because a path was mistyped is how a cap gets blown.
# Every non-empty line must parse (`{…"cost_usd":<number>…}`); otherwise the
# guard names the offending line numbers and refuses to launch (exit 3).
#
# Rows. Every launch writes TWO rows that share a unique run_id:
#   reservation — appended BEFORE the command starts, counted at the estimate:
#     {"ts":"<UTC ISO>","run_id":"<id>","status":"running","estimate_usd":E,"cost_usd":E,"exit_code":null,"command":"..."}
#   reconciliation — appended after it exits, supersedes the reservation:
#     {"ts":"<UTC ISO>","run_id":"<id>","status":"done","estimate_usd":E,"cost_usd":C,"exit_code":N,"command":"..."}
# Ledger total = every row that is not a reservation + every reservation whose
# run_id has no reconciliation (a run still in flight, or one whose guard died
# before it could reconcile). Rows without run_id/status (older ledgers) are
# final rows. C comes from $GBRAIN_EVAL_ACTUAL_COST_FILE when the command wrote
# one (a bare unsigned number, or a JSON object carrying `cost_usd`) AND it is
# positive; a malformed, signed, or non-positive cost falls back to the
# estimate (over-stating spend is the safe direction). When
# GBRAIN_EVAL_ACTUAL_COST_FILE is unset, a temp path is exported to the child
# so harnesses can report usage-derived cost without operator setup.
#
# Signals: on INT/TERM/HUP the guard sends SIGTERM to the command, waits up to
# $GBRAIN_EVAL_SPEND_GUARD_KILL_GRACE_SECONDS (default 10) for it to exit, then
# SIGKILLs it, reconciles at the ESTIMATE with exit_code 128+N, and exits
# 128+N. An EXIT trap reconciles at the estimate on any other early exit. The
# traps are installed BEFORE the reservation row is appended (a RESERVED flag
# tells them whether there is anything to reconcile), so a signal landing in
# the instant between the append and the launch still reconciles. SIGKILL
# cannot be trapped — the reservation row is what keeps that spend counted. If
# the reconciliation append itself fails the guard says so and exits 3; the
# reservation stays on the books. Where `flock` exists, audit → cap check →
# reservation is serialized across concurrent guards via <ledger>.lock.
#
# The audit itself is fail-closed: a ledger that exists but cannot be read, an
# awk that exits non-zero, or an audit line that is not `<int> <int> <decimal>
# <int> …` refuses the launch (exit 3) — an empty audit must never read as $0.
#
# Exit codes: the wrapped command's exit code (128+N when the guard was
# signalled) · 2 usage error · 3 refused (cap exceeded, ledger missing,
# unreadable, unparseable, or unwritable).

set -u

usage() {
  echo "usage: $0 <cap_usd> <estimate_usd> -- <command...>" >&2
  exit 2
}

# Unsigned decimal / exponent only. `+1`, `-1`, `1.`-with-sign, `abc`, '' → 1.
is_number() {
  case "$1" in
    ''|*[!0-9.eE+-]*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$'
}

# Canonical %.6f so every value written into the ledger is valid JSON
# (`1.` and `.5` are not) and every comparison uses the same precision.
norm6() {
  awk -v x="$1" 'BEGIN { printf "%.6f", x + 0 }'
}

[ $# -ge 4 ] || usage
CAP="$1"; EST="$2"; SEP="$3"; shift 3
[ "$SEP" = "--" ] || usage
is_number "$CAP" || { echo "eval-spend-guard: cap_usd '$CAP' is not an unsigned number" >&2; exit 2; }
is_number "$EST" || { echo "eval-spend-guard: estimate_usd '$EST' is not an unsigned number (signed / negative estimates are refused)" >&2; exit 2; }
[ $# -ge 1 ] || usage
CAP="$(norm6 "$CAP")"
EST="$(norm6 "$EST")"

LEDGER="${GBRAIN_EVAL_SPEND_LEDGER:-$HOME/gbrain-lme-receipts/spend.jsonl}"
if [ ! -f "$LEDGER" ]; then
  if [ "${GBRAIN_EVAL_SPEND_LEDGER_INIT:-}" = "1" ]; then
    mkdir -p "$(dirname "$LEDGER")" || { echo "eval-spend-guard: cannot create ledger dir for $LEDGER" >&2; exit 2; }
    : > "$LEDGER" || { echo "eval-spend-guard: cannot create ledger $LEDGER" >&2; exit 2; }
    echo "eval-spend-guard: NEW LEDGER — created $LEDGER (spend history starts at \$0.000000; GBRAIN_EVAL_SPEND_LEDGER_INIT=1)" >&2
  else
    echo "eval-spend-guard: REFUSED — ledger does not exist: $LEDGER" >&2
    echo "eval-spend-guard: a missing ledger is NOT a \$0 ledger. Pre-create the file, or set GBRAIN_EVAL_SPEND_LEDGER_INIT=1 for the first run only." >&2
    echo "eval-spend-guard: command NOT run: $*" >&2
    exit 3
  fi
fi

# Audit + sum the ledger in one awk pass (no jq). A line counts ONLY when it
# is a complete JSON object (`{…}`) carrying an UNSIGNED numeric cost_usd
# followed by `,` or `}` — a truncated tail, a string-typed cost, a signed
# cost, or junk all count as unparseable. A `"status":"running"` row with a
# run_id is a reservation: it is summed only while no other row carries the
# same run_id. Prints: <lines> <parsed> <sum> <open-reservations> <bad-line-list>
ledger_audit() {
  awk '
    /^[[:space:]]*$/ { next }
    {
      n++
      if (!($0 ~ /^[[:space:]]*\{.*\}[[:space:]]*$/ &&
            match($0, /"cost_usd"[[:space:]]*:[[:space:]]*([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?[[:space:]]*[,}]/))) {
        badn++; bad = bad (bad == "" ? "" : ",") NR
        next
      }
      tok = substr($0, RSTART, RLENGTH)
      sub(/^"cost_usd"[[:space:]]*:[[:space:]]*/, "", tok)
      sub(/[[:space:]]*[,}]$/, "", tok)
      c = tok + 0
      id = ""
      if (match($0, /"run_id"[[:space:]]*:[[:space:]]*"[^"]+"/)) {
        id = substr($0, RSTART, RLENGTH)
        sub(/^"run_id"[[:space:]]*:[[:space:]]*"/, "", id)
        sub(/"$/, "", id)
      }
      if (id != "" && $0 ~ /"status"[[:space:]]*:[[:space:]]*"running"/) {
        reserved[id] += c
      } else {
        s += c
        if (id != "") done[id] = 1
      }
    }
    END {
      for (id in reserved) if (!(id in done)) { s += reserved[id]; open++ }
      printf "%d %d %.6f %d %s\n", n + 0, n - badn, s + 0, open + 0, bad
    }
  ' "$1"
}

refuse_unparseable() {
  echo "eval-spend-guard: REFUSED — ledger $LEDGER has $((LINES - PARSED)) unparseable line(s) out of $LINES (line numbers: $BAD)" >&2
  echo "eval-spend-guard: every line must be a complete JSON object with an unsigned numeric cost_usd; repair or remove the offending lines — never guess spend" >&2
  echo "eval-spend-guard: command NOT run: $*" >&2
  exit 3
}

# Serialize audit → cap check → reservation across concurrent guards where
# flock exists; elsewhere the reservation row still shrinks the race from the
# command's whole runtime to the instant between the read and the append.
LOCK="$LEDGER.lock"
if command -v flock >/dev/null 2>&1 && ( : >> "$LOCK" ) 2>/dev/null && exec 9>>"$LOCK"; then
  flock -w 60 9 || { echo "eval-spend-guard: REFUSED — could not lock $LOCK within 60s (another guard holds it); command NOT run: $*" >&2; exit 3; }
fi

# An audit the guard cannot trust is a refusal, never a $0 ledger: gawk exits 0
# with an all-zero END line on a file it could not open, so the read check, the
# awk status AND the shape of every field are all required.
refuse_audit() {  # <reason>
  echo "eval-spend-guard: REFUSED — cannot audit ledger $LEDGER: $1" >&2
  echo "eval-spend-guard: an unreadable ledger is NOT a \$0 ledger; fix the file's permissions or contents — never guess spend" >&2
  echo "eval-spend-guard: command NOT run: $CMD_WORDS" >&2
  exit 3
}
audit_shape_ok() {  # <lines> <parsed> <total> <open>
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  case "$2" in ''|*[!0-9]*) return 1 ;; esac
  case "$3" in ''|*[!0-9.]*|.|*.*.*) return 1 ;; esac
  case "$4" in ''|*[!0-9]*) return 1 ;; esac
  return 0
}
CMD_WORDS="$*"
[ -r "$LEDGER" ] || refuse_audit "file is not readable"
AUDIT="$(ledger_audit "$LEDGER")" || refuse_audit "awk exited $? while summing it"
read -r LINES PARSED TOTAL OPEN BAD <<< "$AUDIT"
audit_shape_ok "${LINES:-}" "${PARSED:-}" "${TOTAL:-}" "${OPEN:-}" || refuse_audit "audit line is malformed ('$AUDIT')"
[ "$LINES" = "$PARSED" ] || refuse_unparseable "$@"

PROJECTED="$(awk -v a="$TOTAL" -v b="$EST" 'BEGIN { printf "%.6f", a + b }')"
OVER="$(awk -v p="$PROJECTED" -v c="$CAP" 'BEGIN { print (p > c) ? 1 : 0 }')"

if [ "$OVER" = "1" ]; then
  echo "eval-spend-guard: REFUSED — ledger \$${TOTAL} + estimate \$${EST} = \$${PROJECTED} exceeds cap \$${CAP} (ledger: $LEDGER)" >&2
  [ "$OPEN" != "0" ] && echo "eval-spend-guard: $OPEN in-flight reservation(s) counted at their estimate (a concurrent run, or a guard that died before reconciling)" >&2
  echo "eval-spend-guard: command NOT run: $*" >&2
  exit 3
fi
echo "eval-spend-guard: ledger \$${TOTAL} ($LINES row(s)) + estimate \$${EST} = \$${PROJECTED} <= cap \$${CAP}; launching" >&2
[ "$OPEN" != "0" ] && echo "eval-spend-guard: $OPEN in-flight reservation(s) counted at their estimate" >&2

# JSON-escape the command (backslash, quote, EVERY control char) without jq —
# a character walk in awk under LC_ALL=C, so it is byte-exact and portable
# (GNU sed's `\t` is not: BSD/macOS sed would have matched a literal `t`).
# Tabs / CR / LF get their short escapes, other controls `\u00XX`; multi-byte
# UTF-8 passes through untouched.
json_escape() {
  printf '%s' "$1" | LC_ALL=C awk '
    BEGIN { for (i = 1; i < 32; i++) ctl[sprintf("%c", i)] = i; u = "\\" "u%04x" }
    {
      if (NR > 1) printf "\\n"
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (c == "\\") printf "\\\\"
        else if (c == "\"") printf "\\\""
        else if (c == "\t") printf "\\t"
        else if (c == "\r") printf "\\r"
        else if (c in ctl) printf u, ctl[c]
        else printf "%s", c
      }
    }'
}
CMD_JSON="$(json_escape "$*")"
RUN_ID="$(uuidgen 2>/dev/null || printf '%s-%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$$" "$RANDOM$RANDOM")"

append_row() {  # <status> <cost> <exit_code|null>; non-zero when the append fails
  printf '{"ts":"%s","run_id":"%s","status":"%s","estimate_usd":%s,"cost_usd":%s,"exit_code":%s,"command":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_ID" "$1" "$EST" "$2" "$3" "$CMD_JSON" >> "$LEDGER"
}

# Cost file: honor the operator's path or hand the child a scratch one.
CLEANUP_COST_FILE=0
if [ -z "${GBRAIN_EVAL_ACTUAL_COST_FILE:-}" ]; then
  GBRAIN_EVAL_ACTUAL_COST_FILE="$(mktemp "${TMPDIR:-/tmp}/gbrain-eval-cost.XXXXXX")"
  rm -f "$GBRAIN_EVAL_ACTUAL_COST_FILE"
  CLEANUP_COST_FILE=1
fi
export GBRAIN_EVAL_ACTUAL_COST_FILE

# Reconcile exactly once (normal exit, signal, or EXIT-trap backstop), and
# only once there is a reservation to reconcile (RESERVED).
RESERVED=0
RECONCILED=0
reconcile() {  # <cost> <exit_code>; returns 1 when the ledger append fails
  [ "$RECONCILED" = "1" ] && return 0
  RECONCILED=1
  [ "$CLEANUP_COST_FILE" = "1" ] && rm -f "$GBRAIN_EVAL_ACTUAL_COST_FILE"
  if ! append_row done "$1" "$2"; then
    echo "eval-spend-guard: FAILED to append the reconciliation row to $LEDGER — the \$${EST} reservation for run $RUN_ID stays on the books" >&2
    return 1
  fi
  AFTER="$(ledger_audit "$LEDGER" 2>/dev/null)" || AFTER=""
  read -r _ _ AFTER _ <<< "$AFTER"
  case "${AFTER:-}" in ''|*[!0-9.]*) AFTER="(unreadable)" ;; *) AFTER="\$${AFTER}" ;; esac
  echo "eval-spend-guard: recorded cost \$${1} (exit $2); ledger now ${AFTER}" >&2
}

# Stop the command: SIGTERM, then up to KILL_GRACE seconds (10 by default;
# GBRAIN_EVAL_SPEND_GUARD_KILL_GRACE_SECONDS overrides) before SIGKILL, so a
# command that ignores SIGTERM cannot keep the guard — and its reservation —
# hanging forever. Polled in 0.1 s steps; `wait` reaps it either way.
KILL_GRACE="${GBRAIN_EVAL_SPEND_GUARD_KILL_GRACE_SECONDS:-10}"
case "$KILL_GRACE" in ''|*[!0-9]*) KILL_GRACE=10 ;; esac
CHILD=""
stop_child() {
  [ -n "$CHILD" ] || return 0
  kill -TERM "$CHILD" 2>/dev/null
  i=0
  while [ "$i" -lt "$((KILL_GRACE * 10))" ] && kill -0 "$CHILD" 2>/dev/null; do
    sleep 0.1
    i=$((i + 1))
  done
  if kill -0 "$CHILD" 2>/dev/null; then
    echo "eval-spend-guard: command did not exit within ${KILL_GRACE}s of SIGTERM — sending SIGKILL" >&2
    kill -KILL "$CHILD" 2>/dev/null
  fi
  wait "$CHILD" 2>/dev/null
}
on_signal() {  # <signal number>
  trap - INT TERM HUP
  echo "eval-spend-guard: interrupted (signal $1) — stopping the command and recording the estimate" >&2
  stop_child
  if [ "$RESERVED" = "1" ]; then reconcile "$EST" "$((128 + $1))" || exit 3; fi
  exit "$((128 + $1))"
}
on_exit() {  # <exit status>
  [ "$RESERVED" = "1" ] || return 0
  reconcile "$EST" "$1" || exit 3
}
# Traps BEFORE the reservation: a signal in the append→launch window must
# still reconcile (RESERVED gates whether there is anything to reconcile).
trap 'on_signal 2' INT
trap 'on_signal 15' TERM
trap 'on_signal 1' HUP
trap 'on_exit $?' EXIT

# Reservation first: a launch that is not on the books is a cap that cannot be
# enforced against it, so an unwritable ledger refuses the launch. RESERVED is
# raised BEFORE the append so a signal mid-append reconciles (over-stating by
# the estimate at worst — the safe direction); a failed append lowers it again.
RESERVED=1
if ! append_row running "$EST" null; then
  RESERVED=0
  echo "eval-spend-guard: REFUSED — cannot append the reservation row to ledger $LEDGER" >&2
  echo "eval-spend-guard: command NOT run: $*" >&2
  exit 3
fi
exec 9>&-   # release the lock (if held) before the command starts
echo "eval-spend-guard: reserved \$${EST} (run $RUN_ID)" >&2

# Run the command as a job so a trapped signal interrupts `wait` (a foreground
# child would defer the trap until it exited). `<&0` keeps the child's stdin.
"$@" <&0 &
CHILD=$!
wait "$CHILD"
CODE=$?
trap - INT TERM HUP

# Actual cost: bare unsigned number or JSON with unsigned cost_usd, and it
# must be POSITIVE; anything else (malformed, signed, zero) → the estimate.
COST="$EST"
if [ -f "$GBRAIN_EVAL_ACTUAL_COST_FILE" ]; then
  RAW="$(tr -d '[:space:]' < "$GBRAIN_EVAL_ACTUAL_COST_FILE")"
  CANDIDATE=""
  if is_number "$RAW"; then
    CANDIDATE="$RAW"
  else
    FROM_JSON="$(grep -oE '"cost_usd"[[:space:]]*:[[:space:]]*([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?[[:space:]]*[,}]' "$GBRAIN_EVAL_ACTUAL_COST_FILE" 2>/dev/null \
      | head -1 | sed -E 's/^"cost_usd"[[:space:]]*:[[:space:]]*//; s/[[:space:]]*[,}]$//')"
    if [ -n "$FROM_JSON" ] && is_number "$FROM_JSON"; then CANDIDATE="$FROM_JSON"; fi
  fi
  if [ -n "$CANDIDATE" ]; then
    CANDIDATE="$(norm6 "$CANDIDATE")"
    POSITIVE="$(awk -v c="$CANDIDATE" 'BEGIN { print (c > 0) ? 1 : 0 }')"
    if [ "$POSITIVE" = "1" ]; then
      COST="$CANDIDATE"
    else
      echo "eval-spend-guard: cost file $GBRAIN_EVAL_ACTUAL_COST_FILE reports non-positive cost \$${CANDIDATE}; recording the estimate instead" >&2
    fi
  else
    echo "eval-spend-guard: cost file $GBRAIN_EVAL_ACTUAL_COST_FILE unreadable (need an unsigned number or {\"cost_usd\":<number>}); recording the estimate" >&2
  fi
fi

reconcile "$COST" "$CODE" || exit 3
exit "$CODE"

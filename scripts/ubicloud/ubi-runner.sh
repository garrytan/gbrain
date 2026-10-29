#!/usr/bin/env bash
# ubi-runner — run a command on an ephemeral Ubicloud VM.
#
#   UBICLOUD_API_KEY=... scripts/ubicloud/ubi-runner.sh run --setup S.sh -- 'make test'
#
# Vendored from the gstack Ubicloud runner. gbrain additions: UBICLOUD_API_TOKEN
# is accepted as an alias for UBICLOUD_API_KEY, SSH connections are multiplexed
# per VM (scripts/ci-ubicloud.ts issues hundreds of short commands per VM), and
# `pack` / `unpack` upload one prebuilt checkout tarball to many VMs.
#
# Creates a VM (standard-16 by default), streams the checkout to it (tracked +
# untracked-unignored files + .git, so uncommitted edits are included), runs an
# optional setup script and the command, copies requested artifacts back, and
# destroys the VM on every exit path. Exits with the command's status.
# Needs only bash, curl, python3, ssh, ssh-keygen, and tar locally, so it works
# from dev boxes, containers, and cloud sandboxes.
#
# Ownership: VMs are named ubirun-<owner>-<epoch>-<suffix>. <owner> is UBI_OWNER
# (lowercased, letters and digits only, at most 12 characters, starting with a
# letter) or a random per-machine id kept in $STATE_ROOT/owner-id. up, run and
# verify refuse (exit 2) without UBI_OWNER unless UBI_OWNER_OPTOUT=1, so every
# VM traces to a thread. Ubicloud names allow 63 characters of [a-z0-9-], so a full name stays under 40.
#
# TTL and reaper (gstack's scheme, so gstack-ubi and this runner reap each
# other's VMs): a name this script generates ends in -t<hours>,
# ubirun-<owner>-<epoch>-<suffix>-t<hours>, the creator's declaration of how
# long the VM may live: UBI_TTL_HOURS (default 4; 0 omits it), or --ttl-hours H
# on `up` and `run` (ci:ubicloud names its own VMs this way, 2 hours by
# default). `reap` destroys every VM in the project whose TTL ended more than
# ten minutes ago, whichever owner made it, and every `up` runs it first
# (UBI_REAP=0 skips it), so a runner killed by a sleeping machine leaves
# nothing behind for longer than its TTL; the operator reaper
# (scripts/ubicloud/reap-expired.ts) reads the same names. Names without a
# TTL (-n NAME, UBI_TTL_HOURS=0) are never reaped: use them, or a long TTL,
# for dev, benchmark and eval VMs. The legacy expiring form
# ubirun-<owner>-<epoch>-x<expiry epoch>-<suffix> that older branches still
# write is read and reaped the same way. A full name stays under 50 characters.
#
# Teardown: `up` records each VM's state (location, create status) before it
# sends the create request, and `down` destroys and polls until the VM is
# confirmed gone or provably never existed, waiting out a create that may still
# be in flight. An interrupted `up` or `run` (EXIT, INT, TERM, HUP, QUIT) runs
# that `down`; further signals are ignored until it finishes. A create refused
# for vCPU quota prints the project's usage per owner.
#
# Quota preflight: when the project's vCPU ceiling is known (UBI_QUOTA_VCPUS, or
# the maximum a refusal printed, cached in $STATE_ROOT/quota-max for a day),
# `up` adds the size's vCPUs to the project's VMs and refuses before any create
# when that exceeds it; UBI_QUOTA_WAIT=<seconds> waits for room instead.
#
# Watchdog: `run`, `verify` and `ssh NAME COMMAND` stream the remote output
# through a watchdog that logs a heartbeat every UBI_HEARTBEAT seconds (300)
# and kills a command silent for UBI_IDLE_TIMEOUT seconds (1800) or older than
# UBI_RUN_TIMEOUT seconds (0, unlimited), exiting 124 with the last 40 lines,
# so a hung command fails fast instead of holding the VM until its TTL.
#
# `verify` is the one entry point for the repository's single-VM remote
# verify: it reads .gstack/ubicloud.json (setup, command, size, location, env,
# pass, pull) and runs it through `run`. A variable reaches a VM only when
# named (--env, --pass, a granted pass entry), and UBICLOUD_* never does.
#
# Stale-VM sweeps are off by default. With UBI_GC_HOURS set to a positive
# number, every `up` first destroys this owner's VMs older than that; `gc HOURS`
# runs the same sweep on demand. Neither ever touches another owner's VMs.
#
# "This owner's VMs" (`list --mine`, `gc`, the `up` sweep) are the VMs tagged
# with the caller's owner tag plus every VM this machine created under any tag:
# `up` keeps a VM's state here until `down` confirms it gone, so a run started
# with UBI_OWNER=x whose teardown never ran is still found by a later call that
# did not export the same UBI_OWNER.
set -Eeuo pipefail
# Keep heredoc bodies on temp files, not the pipe window (test/heredoc-pipe-deadlock.test.ts).
BASH_COMPAT=50

API="${UBICLOUD_API_URL:-https://api.ubicloud.com}"
STATE_ROOT="${UBI_RUNNER_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/ubi-runner}"
DEFAULT_SIZE="${UBI_SIZE:-standard-16}"
DEFAULT_LOCATION="${UBI_LOCATION:-eu-central-h1}"
GC_HOURS="${UBI_GC_HOURS:-0}"
API_TIMEOUT="${UBI_API_TIMEOUT:-120}"
CREATE_GRACE="${UBI_CREATE_GRACE:-180}"
DOWN_TIMEOUT="${UBI_DOWN_TIMEOUT:-900}"
POLL="${UBI_POLL_SECONDS:-5}"
TTL_HOURS="${UBI_TTL_HOURS:-4}"
REAP="${UBI_REAP:-1}"
REAP_GRACE=600
QUOTA_VCPUS="${UBI_QUOTA_VCPUS:-}"
QUOTA_WAIT="${UBI_QUOTA_WAIT:-0}"
IDLE_TIMEOUT="${UBI_IDLE_TIMEOUT:-1800}"
RUN_TIMEOUT="${UBI_RUN_TIMEOUT:-0}"
HEARTBEAT="${UBI_HEARTBEAT:-300}"
PREFIX="ubirun"

die() { echo "ubi-runner: $*" >&2; exit 1; }
log() { echo "ubi-runner: $*" >&2; }

# Bash 5.2 can lose a signal trap: when the signal lands just before the shell
# parses a $(...), the trap runs inside that parse, fails to parse itself
# ("trap: line 2: unexpected EOF while looking for matching `)'") and the shell
# exits 2 without running it (fixed in bash 5.3). The EXIT trap still runs.
# The only other exit 2 here is a failed command, which sets FAILED through
# the ERR trap, so finish reports an exit 2 without FAILED as the signal's 130.
FAILED=""
trap 'FAILED=1' ERR

# finish STATUS NAME: EXIT handler of `up` and `run`. Destroys NAME unless it
# is empty, then exits with STATUS.
finish() {
  local rc=$1
  [ "$rc" != 2 ] || [ -n "$FAILED" ] || rc=130
  [ -z "$2" ] || cmd_down "$2" || log "WARNING: failed to destroy $2; run: $0 down $2"
  exit "$rc"
}

for bin in curl python3 ssh ssh-keygen tar; do
  command -v "$bin" >/dev/null || die "$bin is required"
done
UBICLOUD_API_KEY="${UBICLOUD_API_KEY:-${UBICLOUD_API_TOKEN:-}}"
[[ "$GC_HOURS" =~ ^[0-9]+$ ]] || die "UBI_GC_HOURS must be a whole number of hours (unset or 0 disables the sweep)"
for v in IDLE_TIMEOUT RUN_TIMEOUT HEARTBEAT QUOTA_WAIT; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || die "UBI_$v must be a whole number of seconds (0 disables it)"
done
[ -z "$QUOTA_VCPUS" ] || [[ "$QUOTA_VCPUS" =~ ^[0-9]+$ ]] || die "UBI_QUOTA_VCPUS must be a whole number of vCPUs"
[[ "$TTL_HOURS" =~ ^(0|[1-9][0-9]{0,2})$ ]] || die "UBI_TTL_HOURS must be a whole number of hours from 0 to 999 with no leading zero (0 names VMs without a TTL)"

owner_id() {
  local raw=${UBI_OWNER:-} file="$STATE_ROOT/owner-id" tmp
  if [ -z "$raw" ]; then
    if [ ! -s "$file" ]; then
      mkdir -p "$STATE_ROOT"
      tmp="$file.$$"
      echo "m$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$tmp"
      mv -n "$tmp" "$file"
      rm -f "$tmp"
    fi
    raw=$(cat "$file")
  fi
  raw=$(printf %s "$raw" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')
  [ -n "$raw" ] || die "UBI_OWNER must contain letters or digits"
  [[ "$raw" =~ ^[a-z] ]] || raw="u$raw"
  echo "${raw:0:12}"
}
OWNER=$(owner_id)

# api OUT ARGS...: send one Ubicloud CLI command, write the body to OUT, and
# print the HTTP status (000 when no response arrived).
api() {
  local out=$1 code
  shift
  code=$(python3 -c 'import json,sys; print(json.dumps({"argv": sys.argv[1:]}))' "$@" \
    | curl -sS -o "$out" -w '%{http_code}' --max-time "$API_TIMEOUT" -X POST \
        -H "Authorization: Bearer $UBICLOUD_API_KEY" \
        -H 'Accept: text/plain' -H 'Content-Type: application/json' \
        -H 'X-Ubi-Version: 1.0.0' --data @- "$API/cli") || true
  echo "${code:-000}"
}

cli() {
  local out code
  out=$(mktemp)
  code=$(api "$out" "$@")
  if [ "$code" = 000 ]; then
    rm -f "$out"
    die "request failed: ubi $*"
  fi
  if [ "$code" != 200 ]; then
    cat "$out" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

state_dir() { echo "$STATE_ROOT/$1"; }

load() {
  local dir
  dir=$(state_dir "$1")
  [ -f "$dir/env" ] || die "no local state for VM '$1' (created on another machine?)"
  # shellcheck disable=SC1091
  . "$dir/env"
  KEY="$dir/key"
}

ssh_opts() {
  echo -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ConnectTimeout=10 \
    -o ControlMaster=auto -o "ControlPath=$(dirname "$KEY")/ctl" -o ControlPersist=300
}

# Ubuntu's default umask (002) leaves new directories group-writable, which
# permission-checking code under test rejects; every remote command uses 022.
remote() {
  local name=$1; shift
  load "$name"
  # shellcheck disable=SC2046
  ssh $(ssh_opts) "ubi@$IP" "umask 022; $*"
}

# sq STRING: STRING as one single-quoted shell word.
sq() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }

# remote_cancel NAME SIDFILE: end the session a watched command started on the
# VM (its leader pid is in SIDFILE there), bounded to 20 seconds. Killing the
# local ssh client alone leaves a silent remote command running until it next
# writes to the closed channel.
remote_cancel() {
  local name=$1 sidf=$2 cpid i=0
  remote "$name" "sid=\$(cat $sidf 2>/dev/null); rm -f $sidf; [ -z \"\$sid\" ] || { pkill -TERM -s \"\$sid\"; sleep 2; pkill -KILL -s \"\$sid\"; }; true" >/dev/null 2>&1 </dev/null &
  cpid=$!
  while kill -0 "$cpid" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 1; i=$(( i + 1 )); done
  kill "$cpid" 2>/dev/null || true
  wait "$cpid" 2>/dev/null || true
}

# watched NAME PHASE COMMAND: run COMMAND on the VM, streaming its output,
# with a heartbeat line every HEARTBEAT seconds and a watchdog that kills it
# after IDLE_TIMEOUT seconds of silence or RUN_TIMEOUT seconds in total: exit
# 124, the reason and the last 40 lines on stderr. Both streams are copied to
# PHASE-<pid>.log in the VM's state dir (one file per call, since ci:ubicloud
# runs several commands on one VM at once), kept only after a kill. The ssh
# runs in its own session (python3's setsid) so the watchdog kills it and
# anything it started; on the VM the command runs in its own session too
# (setsid where the image has it), whose leader pid is written to
# ~/.ubirun-PHASE-<pid>.sid so remote_cancel can end it.
watched() {
  local name=$1 phase=$2 cmd=$3 out pid rc=0 start now last_beat idle elapsed why="" old_traps inner sidf
  sidf="~/.ubirun-$phase-$$.sid"
  load "$name"
  out="$(state_dir "$name")/$phase-$$.log"
  : >"$out"
  inner=$(sq "printf %s \$\$ >$sidf; $cmd")
  # The sid file outlives the command on purpose: a background child it left
  # behind keeps the ssh channel open after the wrapper exits, and remote_cancel
  # still needs the session id to end it. remote_cancel removes the file.
  cmd="if command -v setsid >/dev/null 2>&1; then setsid -w bash -c $inner; else bash -c $inner; fi"
  # The caller's stdin is handed to the background ssh explicitly (a background
  # job in a non-interactive shell would otherwise read /dev/null).
  exec 3<&0
  # shellcheck disable=SC2046
  ( exec python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
      ssh $(ssh_opts) "ubi@$IP" "umask 022; $cmd" ) <&3 > >(tee -a "$out") 2> >(tee -a "$out" >&2) &
  pid=$!
  exec 3<&-
  # A signal to this process takes the ssh session down with it.
  old_traps=$(trap -p INT TERM)
  trap 'kill -TERM -- "-$pid" 2>/dev/null; exit 130' INT TERM
  start=$(date +%s)
  last_beat=$start
  while :; do
    sleep 1
    kill -0 "$pid" 2>/dev/null || break
    now=$(date +%s)
    elapsed=$(( now - start ))
    idle=$(( now - $(mtime "$out") ))
    if [ "$IDLE_TIMEOUT" -gt 0 ] && [ "$idle" -ge "$IDLE_TIMEOUT" ]; then
      why="printed nothing for ${idle}s (UBI_IDLE_TIMEOUT=$IDLE_TIMEOUT)"
    elif [ "$RUN_TIMEOUT" -gt 0 ] && [ "$elapsed" -ge "$RUN_TIMEOUT" ]; then
      why="ran ${elapsed}s (UBI_RUN_TIMEOUT=$RUN_TIMEOUT)"
    fi
    if [ -n "$why" ]; then
      # A command that finished while the clock was read is never a timeout.
      kill -0 "$pid" 2>/dev/null || break
      log "watchdog: $phase $why; killing it. Last output:"
      tail -n 40 "$out" >&2
      kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || rc=$?
      trap - INT TERM; eval "$old_traps"
      if [ "$rc" -eq 0 ]; then
        log "watchdog: $phase finished before it could be killed; its exit 0 stands"
        rm -f "$out"
        return 0
      fi
      remote_cancel "$name" "$sidf"
      log "watchdog: kept the output in $out"
      return 124
    fi
    if [ "$HEARTBEAT" -gt 0 ] && [ $(( now - last_beat )) -ge "$HEARTBEAT" ]; then
      log "heartbeat: $phase ${elapsed}s elapsed, last output ${idle}s ago"
      last_beat=$now
    fi
  done
  wait "$pid" || rc=$?
  trap - INT TERM; eval "$old_traps"
  rm -f "$out"
  return "$rc"
}

# vm_rows: "location name owner expires" for every VM in the project; owner
# is "-" for untagged ubirun-<epoch>-* names and "." for VMs this runner did
# not name; expires is the epoch the name's TTL ends at (-t<hours> after its
# creation epoch, or a legacy -x<expiry epoch>- later than its creation), or "-".
vm_rows() {
  local loc name owner created expires
  cli vm list -N -f location,name | while read -r loc name; do
    owner=. created="" expires=-
    if [[ "$name" =~ ^${PREFIX}-([a-z][a-z0-9]{0,11})-([0-9]{10})- ]]; then
      owner=${BASH_REMATCH[1]} created=${BASH_REMATCH[2]}
      if [[ "$name" =~ ^${PREFIX}-[a-z][a-z0-9]{0,11}-[0-9]{10}-x([0-9]{10})-[a-z0-9]+$ ]] && [ "${BASH_REMATCH[1]}" -gt "$created" ]; then
        expires=$(( 10#${BASH_REMATCH[1]} ))
      fi
    elif [[ "$name" =~ ^${PREFIX}-([0-9]{10})- ]]; then
      owner=- created=${BASH_REMATCH[1]}
    fi
    if [ -n "$created" ] && [[ "$name" =~ -t([1-9][0-9]{0,2})$ ]]; then
      expires=$(( 10#$created + 10#${BASH_REMATCH[1]} * 3600 ))
    fi
    echo "$loc $name $owner $expires"
  done
}

# mine_rows: vm_rows for the VMs tagged with this owner or created from this machine (their `up` state is still here).
mine_rows() {
  local loc name owner expires
  vm_rows | while read -r loc name owner expires; do
    if [ "$owner" = "$OWNER" ] || [ -f "$(state_dir "$name")/env" ]; then echo "$loc $name $owner $expires"; fi
  done
}

# reap: destroy every VM whose name carries a TTL that ended more than
# REAP_GRACE seconds ago, whichever owner created it (the TTL is that owner's
# own declaration). Names without a TTL are never touched.
cmd_reap() {
  local now rows loc name owner expires n=0 failed=0
  now=$(date +%s)
  rows=$(vm_rows) || { log "reap: could not list the project's VMs; nothing destroyed"; return 1; }
  while read -r loc name owner expires; do
    [ -n "$name" ] || continue
    [ "$expires" != - ] || continue
    [ "$now" -ge $(( expires + REAP_GRACE )) ] || continue
    n=$(( n + 1 ))
    log "reaping expired $loc/$name (owner $owner; its TTL ended $(( (now - expires) / 60 )) min ago)"
    cmd_down "$name" -l "$loc" || { failed=$(( failed + 1 )); log "failed to reap $loc/$name"; }
  done <<<"$rows"
  [ "$n" -gt 0 ] || log "reap: no expired VMs"
  [ "$failed" -eq 0 ] || { log "reap: $failed of $n expired VMs could not be destroyed"; return 1; }
}

cmd_gc() {
  local hours=${1:-$GC_HOURS} now loc name owner
  if ! [[ "$hours" =~ ^[0-9]+$ ]] || [ "$hours" -eq 0 ]; then die "gc: give HOURS > 0 (or set UBI_GC_HOURS)"; fi
  now=$(date +%s)
  mine_rows | while read -r loc name owner _; do
    [[ "$name" =~ -([0-9]{10})- ]] || continue
    if [ $(( (now - BASH_REMATCH[1]) / 3600 )) -ge "$hours" ]; then
      log "destroying stale $loc/$name (owner $owner, older than ${hours}h)"
      cmd_down "$name" -l "$loc" || log "failed to destroy $loc/$name"
    fi
  done
}

cmd_list() {
  case ${1:-} in
    "") cli vm list ;;
    --mine)
      local rows others
      rows=$(mine_rows)
      others=$(printf '%s\n' "$rows" | awk -v o="$OWNER" 'NF && $3!=o {print $3}' | sort -u | paste -sd, -)
      log "list --mine: owner tag $OWNER plus VMs this machine created${others:+ (also under: $others)}"
      [ -z "$rows" ] || printf '%s\n' "$rows" | awk '{print $1 "  " $2}' ;;
    *) die "list: unknown option $1 (use --mine)" ;;
  esac
}

# usage: VMs and vCPUs per owner, from each VM's size (standard-16 = 16 vCPUs).
cmd_usage() {
  local tmp loc name owner i=0
  tmp=$(mktemp -d)
  while read -r loc name owner _; do
    i=$(( i + 1 ))
    cli vm "$loc/$name" show 2>/dev/null | sed -n "s/^size: /$owner /p" >"$tmp/$i" &
    [ $(( i % 8 )) -ne 0 ] || wait
  done < <(vm_rows)
  wait
  cat "$tmp"/* 2>/dev/null | awk -v me="$OWNER" '
    { n = $2; sub(/^.*-/, "", n); o = ($1 == "-") ? "(untagged)" : ($1 == ".") ? "(other)" : $1
      vms[o]++; cpu[o] += n; total += n; count++ }
    END {
      printf "%-14s %4s %6s\n", "OWNER", "VMS", "VCPUS"
      for (o in cpu) printf("%-14s %4d %6d%s\n", o, vms[o], cpu[o], (o == me) ? "  (you)" : "") | "sort -k3,3nr"
      close("sort -k3,3nr")
      printf "%-14s %4d %6d\n", "total", count, total
    }'
  rm -rf "$tmp"
}

write_state() {
  printf 'NAME=%q\nLOCATION=%q\nSIZE=%q\nIP=%q\nCREATED=%q\nCREATE_AT=%q\nCREATE_PID=%q\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$$" >"$(state_dir "$1")/env"
}

# new_name [TTL_HOURS]: a fresh name for this owner, ending in -t<hours>
# (TTL_HOURS, else UBI_TTL_HOURS; none when that is 0).
new_name() {
  local ttl=${1:-$TTL_HOURS} name
  name="$PREFIX-$OWNER-$(date +%s)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [ "$ttl" -eq 0 ] || name="$name-t$ttl"
  echo "$name"
}

check_ttl() {
  [[ "$1" =~ ^[1-9][0-9]{0,2}$ ]] \
    || die "--ttl-hours must be a whole number of hours from 1 to 999 (UBI_TTL_HOURS=0 or -n NAME for a VM that never expires)"
}

valid_name() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; }

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

# vcpus SIZE: the vCPU count a Ubicloud size name carries (standard-16 -> 16).
vcpus() { [[ "$1" =~ -([0-9]+)$ ]] && echo "${BASH_REMATCH[1]}"; }

# quota_preflight LOCATION NAME SIZE: refuse (or wait UBI_QUOTA_WAIT seconds)
# before the create request when the project's VMs plus this size exceed the
# known vCPU ceiling. The ceiling comes from UBI_QUOTA_VCPUS or the maximum the
# last refusal printed (cached a day); without either the API decides alone.
QUOTA_CACHE_MAX_AGE=86400
quota_preflight() {
  local location=$1 name=$2 size=$3 need max used wait_until remaining source="UBI_QUOTA_VCPUS" cache="$STATE_ROOT/quota-max"
  need=$(vcpus "$size") || return 0
  max=$QUOTA_VCPUS
  if [ -z "$max" ] && [ -f "$cache" ]; then
    if [ $(( $(date +%s) - $(mtime "$cache") )) -lt "$QUOTA_CACHE_MAX_AGE" ]; then
      max=$(cat "$cache" 2>/dev/null || true); source="the last refusal, cached in $cache"
    else
      rm -f "$cache"
    fi
  fi
  [[ "$max" =~ ^[0-9]+$ ]] || return 0
  wait_until=$(( $(date +%s) + QUOTA_WAIT ))
  while :; do
    used=$(cmd_usage 2>/dev/null | awk '$1=="total" {print $3}')
    [[ "$used" =~ ^[0-9]+$ ]] || return 0
    [ $(( used + need )) -gt "$max" ] || return 0
    remaining=$(( wait_until - $(date +%s) ))
    if [ "$remaining" -le 0 ]; then
      log "quota preflight refused $location/$name ($size): it needs $need vCPUs and the project's VMs already use $used of $max (ceiling from $source; other usage such as managed runners counts on top)"
      cmd_usage >&2 || true
      die "create refused before any request: vCPU quota exhausted; wait for running VMs to finish (UBI_QUOTA_WAIT=<seconds> waits here), run $0 reap, use fewer or smaller VMs (ci:ubicloud --vms N), or set UBI_QUOTA_VCPUS to the project's real ceiling"
    fi
    log "quota: $used of $max vCPUs in use and $need needed; waiting up to ${remaining}s more for room"
    sleep $(( remaining < 30 ? remaining : 30 ))
  done
}

UP_NAME=""
UP_READY=""
cmd_up() {
  local size=$DEFAULT_SIZE location=$DEFAULT_LOCATION name="" storage="" image=ubuntu-noble ttl=""
  while [ $# -gt 0 ]; do
    case $1 in
      -s|--size) size=$2; shift 2 ;;
      -l|--location) location=$2; shift 2 ;;
      -n|--name) name=$2; shift 2 ;;
      -S|--storage) storage=$2; shift 2 ;;
      -b|--image) image=$2; shift 2 ;;
      --ttl-hours) check_ttl "$2"; ttl=$2; shift 2 ;;
      *) die "up: unknown option $1" ;;
    esac
  done
  [ -z "$name" ] || [ -z "$ttl" ] || die "up: --ttl-hours writes the expiry into the generated name, so it cannot be combined with -n"
  [ -n "$name" ] || name=$(new_name "$ttl")
  valid_name "$name" || die "invalid VM name '$name' (Ubicloud allows 1-63 of a-z, 0-9 and '-', starting and ending with a letter or digit)"
  if [ "$REAP" != 0 ]; then
    cmd_reap || log "reap failed; continuing"
  fi
  if [ "$GC_HOURS" -gt 0 ]; then
    cmd_gc "$GC_HOURS" || log "stale-VM cleanup failed; continuing"
  fi
  quota_preflight "$location" "$name" "$size"

  local dir create_at
  dir=$(state_dir "$name")
  mkdir -p "$dir"
  chmod 700 "$dir"
  ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$dir/key"

  local args=(vm "$location/$name" create -s "$size" -b "$image")
  [ -z "$storage" ] || args+=(-S "$storage")
  args+=("$(cat "$dir/key.pub")")
  create_at=$(date +%s)
  write_state "$name" "$location" "$size" "" unknown "$create_at"
  UP_NAME=$name
  log "creating $location/$name ($size)"
  # Hold signals until the create answer is recorded, so teardown knows
  # whether the VM exists instead of waiting out UBI_CREATE_GRACE.
  local interrupted="" created=yes refusal need used max
  trap 'interrupted=1' INT TERM HUP QUIT
  cli "${args[@]}" >/dev/null 2>"$dir/create.err" || created=no
  write_state "$name" "$location" "$size" "" "$created" "$create_at"
  trap 'exit 130' INT TERM HUP QUIT
  [ -z "$interrupted" ] || exit 130
  if [ "$created" = no ]; then
    refusal=$(sed -n 's/.*Requested vCPU count: \([0-9]*\), currently used vCPU count: \([0-9]*\), maximum allowed vCPU count: \([0-9]*\).*/\1 \2 \3/p' "$dir/create.err")
    if [ -z "$refusal" ]; then
      cat "$dir/create.err" >&2
      die "create failed"
    fi
    read -r need used max <<<"$refusal"
    echo "$max" >"$STATE_ROOT/quota-max"
    log "quota refused $location/$name ($size): it needs $need vCPUs and the project already uses $used of $max"
    log "VMs in the project by owner (the rest of the used count is other usage, such as managed GitHub runners):"
    cmd_usage >&2 || true
    die "create failed: vCPU quota exhausted; wait for running VMs to finish, or use fewer or smaller VMs (ci:ubicloud --vms N)"
  fi

  local deadline=$(( $(date +%s) + 600 )) show state ip
  while :; do
    show=$(cli vm "$location/$name" show 2>/dev/null || true)
    state=$(sed -n 's/^state: //p' <<<"$show")
    ip=$(sed -n 's/^ip4: //p' <<<"$show")
    [ "$state" = running ] && [ -n "$ip" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || die "VM did not reach running in 10 minutes (last state: ${state:-unknown})"
    sleep "$POLL"
  done
  write_state "$name" "$location" "$size" "$ip" yes "$create_at"

  load "$name"
  deadline=$(( $(date +%s) + 300 ))
  # shellcheck disable=SC2046
  until ssh $(ssh_opts) "ubi@$IP" true 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || die "SSH did not come up on $IP"
    sleep "$POLL"
  done
  remote "$name" 'cloud-init status --wait >/dev/null 2>&1 || true'
  UP_READY=1
  log "ready: $name ($IP)"
  echo "$name"
}

# down NAME [-l LOCATION]: destroy NAME and return 0 only once it is confirmed
# gone or never existed. While this machine's create request for NAME may
# still be in flight (its `up` process is alive, or the create was sent less
# than UBI_CREATE_GRACE seconds ago with no answer), "not found" is not final.
cmd_down() {
  local name=${1:-} loc="" dir
  [ -n "$name" ] || die "down: missing NAME"
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      -l|--location) loc=$2; shift 2 ;;
      *) die "down: unknown option $1" ;;
    esac
  done
  valid_name "$name" || die "invalid VM name '$name'"
  dir=$(state_dir "$name")
  local CREATED=none CREATE_AT=0 CREATE_PID="" IP="" LOCATION="" KEY=""
  if [ -f "$dir/env" ]; then
    load "$name"
    loc=$LOCATION
    if [ -S "$dir/ctl" ] && [ -n "$IP" ]; then
      # shellcheck disable=SC2046
      ssh $(ssh_opts) -O exit "ubi@$IP" >/dev/null 2>&1 || true
    fi
  fi

  local deadline=$(( $(date +%s) + DOWN_TIMEOUT )) seen=0 asked=0 out code now
  out=$(mktemp)
  while :; do
    now=$(date +%s)
    if [ -z "$loc" ]; then
      loc=$(vm_rows 2>/dev/null | awk -v n="$name" '$2==n {print $1}') || loc=""
      code=404
      [ -z "$loc" ] || code=$(api "$out" vm "$loc/$name" show)
    else
      code=$(api "$out" vm "$loc/$name" show)
    fi
    if [ "$code" = 200 ]; then
      seen=1
      if [ $(( now - asked )) -ge 60 ]; then
        api "$out" vm "$loc/$name" destroy -f >/dev/null
        asked=$now
        log "destroy requested: $loc/$name"
      fi
    elif [ "$code" = 404 ]; then
      if [ "$seen" = 1 ] || [ "$CREATED" != unknown ] || { [ $(( now - CREATE_AT )) -ge "$CREATE_GRACE" ] \
        && { [ "$CREATE_PID" = "$$" ] || ! kill -0 "$CREATE_PID" 2>/dev/null; }; }; then
        rm -f "$out"
        rm -rf "$dir"
        if [ "$seen" = 1 ]; then log "destroyed ${loc:-?}/$name"; else log "gone: ${loc:-?}/$name (never existed or already destroyed)"; fi
        return 0
      fi
      log "waiting for an in-flight create of $name to resolve"
    fi
    if [ "$now" -ge "$deadline" ]; then
      rm -f "$out"
      log "WARNING: could not confirm ${loc:-?}/$name is gone after ${DOWN_TIMEOUT}s; rerun: $0 down $name"
      return 1
    fi
    sleep "$POLL"
  done
}

# slim_git SRC DIR: build DIR/.git holding only the objects HEAD and
# origin/master reach, with SRC's branch, index and config, so a checkout that
# fetched many branches does not upload all of them to every VM. A split
# index brings its shared half (sharedindex.<sha>, which the index names and
# git looks up beside it). Fails on anything unexpected, and the caller then
# ships SRC's own .git (a plain checkout) or refuses (a linked worktree).
slim_git() {
  local src=$1 dir=$2 git_dir common branch specs shared
  git_dir=$(git -C "$src" rev-parse --absolute-git-dir) || return 1
  shared=$(cd "$src" && git rev-parse --shared-index-path) || return 1
  [ -z "$shared" ] || shared=$(cd "$src" && cd "$(dirname "$shared")" && pwd)/$(basename "$shared") || return 1
  common=$(cd "$src" && cd "$(git rev-parse --git-common-dir)" && pwd) || return 1
  branch=$(git -C "$src" symbolic-ref -q HEAD) || branch=""
  specs=("+HEAD:${branch:-refs/heads/ubi-pack-head}")
  if git -C "$src" rev-parse -q --verify refs/remotes/origin/master >/dev/null; then
    specs+=("+refs/remotes/origin/master:refs/remotes/origin/master")
  fi
  git init -q "$dir" &&
    # --update-head-ok: the fresh repo's unborn HEAD names init's default branch
    # (master), which is also the branch a checkout on master fetches into.
    git -C "$dir" fetch -q --update-head-ok --update-shallow --no-tags --no-write-fetch-head "$src" "${specs[@]}" &&
    cp "$common/config" "$dir/.git/config" &&
    { [ ! -f "$git_dir/index" ] || cp "$git_dir/index" "$dir/.git/index"; } &&
    { [ -z "$shared" ] || cp "$shared" "$dir/.git/"; } &&
    if [ -n "$branch" ]; then git -C "$dir" symbolic-ref HEAD "$branch"; else git -C "$dir" update-ref --no-deref HEAD "$(git -C "$src" rev-parse HEAD)"; fi
}

# pack SRC: write a gzipped checkout tarball to stdout (tracked + untracked
# files that are not ignored, plus a slim .git; a non-git directory is taken whole).
cmd_pack() {
  local src tmp
  src=$(cd "${1:-.}" && pwd)
  if git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    tmp=$(mktemp -d)
    (
      cd "$src"
      if slim_git "$src" "$tmp/repo" >&2; then git_from=(-C "$tmp/repo" .git)
      elif [ -f .git ]; then die "pack: could not build a self-contained .git for the linked worktree $src (its own .git is a pointer the VM cannot use)"
      else git_from=(.git); fi
      git ls-files -z -co --exclude-standard \
        | while IFS= read -r -d '' f; do
            if { [ -e "$f" ] || [ -L "$f" ]; } && [ "$f" != .git ]; then printf '%s\0' "$f"; fi
          done \
        | tar --null -T - "${git_from[@]}" -czf -
    )
    rm -rf "$tmp"
  else
    tar -C "$src" -czf - .
  fi
}

# unpack NAME DEST: extract a tarball read from stdin into DEST on the VM.
cmd_unpack() {
  local qdest
  qdest=$(printf %q "$2")
  remote "$1" "mkdir -p $qdest && tar -xzf - -C $qdest"
}

cmd_sync() {
  local name=$1 src=${2:-.} dest=${3:-}
  src=$(cd "$src" && pwd)
  [ -n "$dest" ] || dest="work/$(basename "$src")"
  cmd_pack "$src" | cmd_unpack "$name" "$dest"
  log "synced $src -> $name:$dest"
}

# pull NAME REMOTE_GLOB LOCAL_DIR: copy matching remote entries into LOCAL_DIR.
# Relative remote paths start at /home/ubi.
cmd_pull() {
  local name=$1 from=$2 to=$3
  mkdir -p "$to"
  remote "$name" "cd $(printf %q "$(dirname "$from")") && tar -czf - $(basename "$from")" | tar -xzf - -C "$to"
}

# pass_name OPTION NAME: a variable this runner may forward to a VM. Its own
# credentials (UBICLOUD_*) never leave this machine, whoever asks.
pass_name() {
  [[ "$2" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "$1 $2: not a variable name"
  case $2 in UBICLOUD_*) die "$1 $2: the runner never forwards its own Ubicloud credentials to a VM" ;; esac
}

# inside_dir DIR ROOT: DIR resolves, symlinks followed, to ROOT or below it.
# Its nearest existing ancestor is checked first, so a refused destination
# creates nothing (not even outside the root); only then is DIR created and
# checked again.
inside_dir() {
  local a b near=$1
  b=$(cd "$2" 2>/dev/null && pwd -P) || return 1
  while [ ! -d "$near" ]; do
    [ "$near" != "$(dirname "$near")" ] || return 1
    near=$(dirname "$near")
  done
  a=$(cd "$near" 2>/dev/null && pwd -P) || return 1
  [ "$a" = "$b" ] || [[ "$a" = "$b"/* ]] || return 1
  mkdir -p "$1" 2>/dev/null || return 1
  a=$(cd "$1" 2>/dev/null && pwd -P) || return 1
  [ "$a" = "$b" ] || [[ "$a" = "$b"/* ]]
}

# PULL_ROOT: set by verify; every pull destination must resolve inside it at
# pull time (an earlier pull may have placed a symlink where a later one lands).
PULL_ROOT=""
cmd_run() {
  local up_args=() src=. dest="" setup="" keep=0 pulls=() envs=() ttl=""
  while [ $# -gt 0 ]; do
    case $1 in
      -s|--size|-l|--location|-n|--name|-S|--storage|-b|--image) up_args+=("$1" "$2"); shift 2 ;;
      --ttl-hours) check_ttl "$2"; ttl=$2; shift 2 ;;
      --src) src=$2; shift 2 ;;
      --dest) dest=$2; shift 2 ;;
      --setup) setup=$2; shift 2 ;;
      --env) [[ "$2" == *=* ]] || die "--env $2: give NAME=VALUE"; pass_name --env "${2%%=*}"; envs+=("$2"); shift 2 ;;
      --pass) pass_name --pass "$2"; [ -n "${!2+x}" ] || die "--pass $2: not set locally"; envs+=("$2=${!2}"); shift 2 ;;
      --pull) pulls+=("$2"); shift 2 ;;
      --keep) keep=1; shift ;;
      --) shift; break ;;
      *) die "run: unknown option $1" ;;
    esac
  done
  [ $# -gt 0 ] || die "run: missing command after --"
  [ -z "$setup" ] || [ -f "$setup" ] || die "setup script not found: $setup"
  src=$(cd "$src" && pwd)
  [ -n "$dest" ] || dest="work/$(basename "$src")"

  local i name=""
  for (( i = 0; i < ${#up_args[@]}; i += 2 )); do
    case ${up_args[i]} in -n|--name) name=${up_args[i+1]} ;; esac
  done
  [ -z "$name" ] || [ -z "$ttl" ] || die "run: --ttl-hours writes the expiry into the generated name, so it cannot be combined with -n"
  [ -n "$name" ] || { name=$(new_name "$ttl"); up_args+=(-n "$name"); }
  RUN_VM=$name
  # Armed before the create request: an interrupted `up` still destroys its VM.
  # A second signal must not cut teardown short, so the EXIT handler ignores them.
  trap 'rc=$?; trap "" INT TERM HUP QUIT; finish "$rc" "$RUN_VM"' EXIT
  trap 'exit 130' INT TERM HUP QUIT
  cmd_up "${up_args[@]}" >/dev/null
  if [ "$keep" = 1 ]; then
    RUN_VM=""
    log "--keep: leaving $name running; destroy with: $0 down $name"
  fi

  local e
  for e in ${envs[@]+"${envs[@]}"}; do printf 'export %s=%q\n' "${e%%=*}" "${e#*=}"; done \
    | remote "$name" 'umask 077 && cat > ~/.ubirun-env'

  cmd_sync "$name" "$src" "$dest"
  local qdest rc=0
  qdest=$(printf %q "$dest")
  if [ -n "$setup" ]; then
    remote "$name" 'cat > ~/.ubirun-setup.sh' <"$setup"
    log "running setup $(basename "$setup")"
    watched "$name" setup "cd $qdest && . ~/.ubirun-env && bash -l ~/.ubirun-setup.sh" || { rc=$?; log "setup failed (exit $rc)"; exit "$rc"; }
  fi

  local start
  start=$(date +%s)
  log "running on $name: $*"
  watched "$name" command "cd $qdest && . ~/.ubirun-env && bash -lc $(printf %q "$*")" || rc=$?
  log "command exited $rc after $(( $(date +%s) - start ))s"

  local p
  for p in ${pulls[@]+"${pulls[@]}"}; do
    if [ -n "$PULL_ROOT" ] && ! inside_dir "${p#*:}" "$PULL_ROOT"; then
      log "pull refused: ${p#*:} resolves outside $PULL_ROOT"
      [ "$rc" -ne 0 ] || rc=1
      continue
    fi
    cmd_pull "$name" "${p%%:*}" "${p#*:}" || log "pull failed: $p"
  done
  return "$rc"
}

# verify [run opts] [--trust-config] [-- COMMAND]: run the repository's
# committed remote verify. .gstack/ubicloud.json under --src (default .)
# supplies setup, command, size, location, storage, image, env, pass and pull;
# flags given here and a trailing -- COMMAND override it. Without the file it
# refuses, so every lane runs the one committed definition instead of its own
# wrapper.
#
# The file is repository content and gets no reach beyond the checkout on its
# own: its setup script and pull destinations must resolve inside --src, and a
# local variable it lists under pass is forwarded only when this command line
# also names it (--pass NAME) or grants every listed name (--trust-config).
cmd_verify() {
  local src=. i j g n cfg cfg_setup cfg_cmd parsed err rc=0 trust=0 cfg_args=() cfg_pass=() user_pre=() user_cmd=() granted=() missing=()
  for (( i = 1; i <= $#; i++ )); do
    [ "${!i}" = -- ] && break
    if [ "${!i}" = --src ]; then j=$(( i + 1 )); src=${!j}; fi
  done
  cfg="$src/.gstack/ubicloud.json"
  [ -f "$cfg" ] || die "verify: no $cfg; commit one ({\"setup\": \"scripts/ubicloud/bootstrap.sh\", \"command\": \"bash scripts/ubicloud/verify.sh\"}) so every lane runs the same verify instead of its own wrapper"
  err=$(mktemp)
  parsed=$(python3 -c '
import json, os, shlex, sys
cfg, src = sys.argv[1], sys.argv[2]
try:
    c = json.load(open(cfg))
except ValueError:
    sys.exit(3)
if not isinstance(c, dict):
    sys.exit(3)
base, root = os.path.abspath(src), os.path.realpath(src)
def inside(rel, what):
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or rel.startswith("~") or ".." in rel.replace("\\", "/").split("/"):
        print("%s %r must be a relative path inside the checkout" % (what, rel), file=sys.stderr); sys.exit(2)
    full = os.path.realpath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        print("%s %r resolves outside the checkout (%s)" % (what, rel, full), file=sys.stderr); sys.exit(2)
    return os.path.join(base, rel)
q = lambda s: shlex.quote(str(s))
args = []
for key, flag in (("size", "-s"), ("location", "-l"), ("storage", "-S"), ("image", "-b")):
    if key in c: args += [flag, q(c[key])]
for item in c.get("env", []): args += ["--env", q(item)]
for item in c.get("pull", []):
    remote, sep, local = str(item).partition(":")
    if not sep or not remote:
        print("pull entry %r must be REMOTE_GLOB:LOCAL_DIR" % (item,), file=sys.stderr); sys.exit(2)
    args += ["--pull", q(remote + ":" + inside(local, "pull destination"))]
setup = c.get("setup", "")
print("cfg_args=(" + " ".join(args) + ")")
print("cfg_pass=(" + " ".join(q(x) for x in c.get("pass", [])) + ")")
print("cfg_setup=" + q(inside(setup, "setup") if setup else ""))
print("cfg_cmd=" + q(c.get("command", "")))
' "$cfg" "$src" 2>"$err") || rc=$?
  case $rc in
    0) ;;
    2) local why; why=$(cat "$err"); rm -f "$err"; die "verify: $cfg: $why" ;;
    *) rm -f "$err"; die "verify: $cfg is not valid JSON" ;;
  esac
  rm -f "$err"
  eval "$parsed"
  while [ $# -gt 0 ]; do
    case $1 in
      --) shift; user_cmd=("$@"); break ;;
      --trust-config) trust=1; shift ;;
      --keep) user_pre+=("$1"); shift ;;
      --pass|-S|--storage|-s|--size|-l|--location|-n|--name|-b|--image|--ttl-hours|--src|--dest|--setup|--env|--pull)
        [ $# -ge 2 ] || die "verify: $1 needs a value"
        [ "$1" != --pass ] || granted+=("$2")
        user_pre+=("$1" "$2"); shift 2 ;;
      *) die "verify: unknown option $1" ;;
    esac
  done
  for n in ${cfg_pass[@]+"${cfg_pass[@]}"}; do
    pass_name --pass "$n"
    if [ "$trust" = 1 ]; then cfg_args+=(--pass "$n"); continue; fi
    for g in ${granted[@]+"${granted[@]}"}; do [ "$g" = "$n" ] && continue 2; done
    missing+=("$n")
  done
  [ ${#missing[@]} -eq 0 ] || die "verify: $cfg asks to forward local ${missing[*]}; grant each on this command line with --pass NAME, or every name it lists with --trust-config"
  [ ${#user_cmd[@]} -gt 0 ] || [ -n "$cfg_cmd" ] || die "verify: $cfg names no command and none was given after --"
  [ ${#user_cmd[@]} -gt 0 ] || user_cmd=("$cfg_cmd")
  log "verify: $cfg"
  PULL_ROOT=$(cd "$src" && pwd)
  cmd_run ${cfg_args[@]+"${cfg_args[@]}"} ${cfg_setup:+--setup "$cfg_setup"} --src "$src" ${user_pre[@]+"${user_pre[@]}"} -- "${user_cmd[@]}"
}


usage() {
  cat <<EOF
usage: ubi-runner.sh <command> [args]

  run [up opts] [--ttl-hours H] [--src DIR] [--dest PATH] [--setup FILE] [--env K=V]...
      [--pass NAME]... [--pull REMOTE_GLOB:LOCAL_DIR]... [--keep] -- COMMAND
                         up + sync + setup + command + pull + destroy; exits with COMMAND's status
  verify [run opts] [--trust-config] [-- COMMAND]
                         run the repository's committed verify (.gstack/ubicloud.json under --src);
                         its setup script and every pull destination stay inside --src (checked
                         again at pull time), and its pass names are forwarded only when granted
                         here (--pass NAME, or all: --trust-config)
  up [-s SIZE] [-l LOCATION] [-n NAME | --ttl-hours H] [-S STORAGE_GIB] [-b IMAGE]
                         reap expired VMs, then create a VM and wait for SSH; prints its
                         name. Its TTL is --ttl-hours H, else UBI_TTL_HOURS; -n NAME
                         (or UBI_TTL_HOURS=0) makes a VM that never expires
  ssh NAME [COMMAND]     shell or login-shell command on the VM (user ubi, passwordless sudo)
  sync NAME [SRC] [DEST] stream a checkout (tracked + untracked-unignored + .git)
  pack [SRC]             write that checkout tarball to stdout (with a slim .git: HEAD + origin/master)
  unpack NAME DEST       extract a tarball from stdin into DEST on the VM
  pull NAME REMOTE_GLOB LOCAL_DIR
                         copy matching remote entries into LOCAL_DIR
  down NAME [-l LOC]     destroy the VM; returns once it is confirmed gone or never existed
  list [--mine]          list all VMs in the project, or only this owner's
  usage                  VMs and vCPUs per owner across the project
  owner                  print this caller's owner tag ($OWNER)
  gc HOURS               destroy this owner's VMs older than HOURS (never other owners')
  reap                   destroy every VM whose TTL ended over 10 minutes ago (any owner; TTL-less names never)
  cli ARGS...            raw Ubicloud CLI passthrough (e.g. cli vm list)

VMs are named $PREFIX-<owner>-<epoch>-<suffix>-t<ttl hours> ($PREFIX-<owner>-<epoch>-<suffix>
without a TTL); up, run and verify need UBI_OWNER (e.g. your thread code) to tag
them, or UBI_OWNER_OPTOUT=1 to use a random per-machine id.
defaults: size=$DEFAULT_SIZE location=$DEFAULT_LOCATION (env UBI_SIZE, UBI_LOCATION)
env: UBI_TTL_HOURS (${TTL_HOURS}h in the name; 0 omits it), UBI_REAP (0: up skips the reap),
     UBI_IDLE_TIMEOUT (${IDLE_TIMEOUT}s of silence kills the remote command, exit 124; 0 disables),
     UBI_RUN_TIMEOUT (${RUN_TIMEOUT}s wall clock; 0 unlimited), UBI_HEARTBEAT (${HEARTBEAT}s between heartbeat lines),
     UBI_QUOTA_VCPUS (project vCPU ceiling for the preflight; else the last refusal's maximum),
     UBI_QUOTA_WAIT (${QUOTA_WAIT}s to wait for quota room instead of refusing),
     UBI_GC_HOURS (unset/0: no sweep on up), UBI_CREATE_GRACE (${CREATE_GRACE}s),
     UBI_DOWN_TIMEOUT (${DOWN_TIMEOUT}s), UBI_API_TIMEOUT (${API_TIMEOUT}s)
EOF
}

cmd=${1:-help}
[ $# -eq 0 ] || shift
case $cmd in
  owner|pack|help|-h|--help) ;;
  *) [ -n "${UBICLOUD_API_KEY:-}" ] || die "UBICLOUD_API_KEY is not set (create a token under your Ubicloud project's Tokens page)" ;;
esac
case $cmd in
  up|run|verify) [ -n "${UBI_OWNER:-}" ] || [ "${UBI_OWNER_OPTOUT:-}" = 1 ] || {
      echo "ubi-runner: UBI_OWNER is not set; set it to your thread code in lowercase (e.g. UBI_OWNER=gbra106) so the VM traces to its thread (UBI_OWNER_OPTOUT=1 uses this machine's random id instead)" >&2
      exit 2
    } ;;
esac
case $cmd in
  run) cmd_run "$@" ;;
  verify) cmd_verify "$@" ;;
  up) trap 'rc=$?; trap "" INT TERM HUP QUIT; [ -z "$UP_READY" ] || UP_NAME=""; finish "$rc" "$UP_NAME"' EXIT
      trap 'exit 130' INT TERM HUP QUIT
      cmd_up "$@" ;;
  ssh) name=$1; shift; load "$name"
       # shellcheck disable=SC2046
       if [ $# -eq 0 ]; then exec ssh -t $(ssh_opts) "ubi@$IP"; else watched "$name" ssh "bash -lc $(printf %q "$*")"; fi ;;
  sync) cmd_sync "$@" ;;
  pack) cmd_pack "$@" ;;
  unpack) cmd_unpack "$@" ;;
  pull) cmd_pull "$@" ;;
  down) cmd_down "$@" ;;
  list) cmd_list "$@" ;;
  usage) cmd_usage ;;
  owner) echo "$OWNER" ;;
  gc) cmd_gc "$@" ;;
  reap) cmd_reap ;;
  cli) cli "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac

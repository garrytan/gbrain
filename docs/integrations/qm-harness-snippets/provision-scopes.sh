#!/usr/bin/env bash
# provision-scopes.sh — roster-driven gbrain provisioning for a qm deployment
# (or any multi-user agent harness with per-person + per-channel scopes).
#
# Reads a roster of channels + employees and converges the brain to it:
#   - ensures the shared agent-memory source exists (path-less: agents write
#     pages into it over MCP; `gbrain sync` skips it; if the brain host has
#     sync.repo_path configured, pages also write through to .sources/<id>/
#     on disk for git-backed durability)
#   - registers one OAuth client per employee, write-fenced via
#     bound_slug_prefixes to emp-<slug>/ plus chan-<c>/ for each channel
#     they are in, with federated reads over the memory source + any
#     read-only sources you pass
#   - re-running after roster edits rescopes existing clients IN PLACE
#     (client ids are remembered in the state file; secrets never rotate
#     unless you revoke + delete the state row)
#
# Usage:
#   provision-scopes.sh roster.tsv \
#     [--memory-source agents] [--read-sources org-wiki,handbook] \
#     [--budget-usd-per-day 5] [--state-file roster.state.tsv] \
#     [--secrets-out new-credentials.tsv] [--gbrain gbrain] [--dry-run]
#
# Roster format (one entry per line; '#' comments and blank lines ignored):
#   channel <slug>
#   employee <slug> [comma-separated channel slugs]
#
# SECURITY: --secrets-out receives client secrets for NEW registrations,
# written exactly once (gbrain never re-shows them). Deliver each row to its
# scope's sandbox (e.g. via the harness keychain or a one-time secret drop),
# then delete the file.
#
# ponytail: sequential CLI loop, one gbrain invocation per roster row — fine
# to hundreds of employees; batch via the admin API if that ever hurts.

# -f (noglob) is load-bearing, not stylistic: roster lines are word-split
# unquoted below, so without it a line like `employee * eng` would expand
# against the working directory and silently provision a filename as a
# person — i.e. the wrong write fence. Nothing here needs globbing.
set -euf -o pipefail

# Client secrets and the id state file are written by this script; 077 makes
# them 0600 instead of the default 0644. Set before the first file is created.
umask 077

die() { echo "ERROR: $*" >&2; exit 1; }

# Slugs become source ids, client names, AND slug-prefix write fences. The
# fence list is comma-separated, so an unvalidated slug containing a comma
# would inject an EXTRA prefix and hand the client write access to someone
# else's namespace. Fail closed on anything that isn't plain kebab-case.
valid_slug() {
  case "$1" in
    '') return 1 ;;
    -*|*-) return 1 ;;
    *[!a-z0-9-]*) return 1 ;;
    *) return 0 ;;
  esac
}
require_slug() {
  valid_slug "$2" || die "roster: invalid $1 slug '$2' (allowed: lowercase a-z, 0-9, interior hyphens)"
}

ROSTER="${1:-}"
[ -n "$ROSTER" ] && [ -f "$ROSTER" ] || die "usage: provision-scopes.sh <roster-file> [flags] (roster not found: '$ROSTER')"
shift

GBRAIN="${GBRAIN:-gbrain}"
MEMORY_SOURCE="agents"
READ_SOURCES=""
BUDGET="5"
STATE_FILE=""
SECRETS_OUT=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --memory-source)      MEMORY_SOURCE="$2"; shift 2 ;;
    --read-sources)       READ_SOURCES="$2"; shift 2 ;;
    --budget-usd-per-day) BUDGET="$2"; shift 2 ;;
    --state-file)         STATE_FILE="$2"; shift 2 ;;
    --secrets-out)        SECRETS_OUT="$2"; shift 2 ;;
    --gbrain)             GBRAIN="$2"; shift 2 ;;
    --dry-run)            DRY_RUN=1; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done

STATE_FILE="${STATE_FILE:-${ROSTER}.state.tsv}"
SECRETS_OUT="${SECRETS_OUT:-${ROSTER}.new-credentials.tsv}"

# The roster usually lives in the deployment repo, so the default secrets and
# state paths land there too — one `git add -A` from committing live
# credentials. The STATE file matters as much as the secrets file: it maps
# employee -> client_id, and this script feeds that id straight to
# `rescope-client`, so whoever can write it decides which client receives a
# given employee's write authority. Treat both as privileged infrastructure,
# at the same trust level as the roster itself.
for f in "$SECRETS_OUT" "$STATE_FILE"; do
  if git -C "$(dirname "$f")" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "WARN: $f is inside a git work tree. Never commit it;" >&2
    echo "      gitignore it, or pass --secrets-out/--state-file outside the repo." >&2
  fi
done

# A group/world-writable parent directory defeats the symlink and ownership
# checks below: anyone with write access there can swap the file between our
# check and our append. Refuse rather than pretend the checks hold.
for d in "$(dirname "$SECRETS_OUT")" "$(dirname "$STATE_FILE")"; do
  perms=$(ls -ld "$d" | awk '{print $1}')
  case "$perms" in
    ?????w*|????????w*) die "refusing to write credentials into a group/world-writable directory: $d ($perms)" ;;
  esac
done

# Secure the credential sinks BEFORE anything is appended. umask only governs
# files this script creates; a pre-existing world-readable file would receive
# secrets first and be chmod'ed only afterwards, and a symlink planted at
# either path would redirect them entirely.
for f in "$SECRETS_OUT" "$STATE_FILE"; do
  [ -L "$f" ] && die "refusing to write credentials through a symlink: $f"
  if [ -e "$f" ]; then
    [ -f "$f" ] || die "refusing to write credentials to a non-regular file: $f"
    [ -O "$f" ] || die "refusing to write credentials to a file owned by another user: $f"
  else
    : > "$f"
  fi
  chmod 600 "$f"
done

run() {
  if [ "$DRY_RUN" = 1 ]; then echo "DRY-RUN: $GBRAIN $*" >&2; return 0; fi
  # shellcheck disable=SC2086 — $GBRAIN may carry args ("bun run src/cli.ts")
  $GBRAIN "$@"
}

state_lookup() { # state_lookup <employee-slug> -> client_id or empty
  [ -f "$STATE_FILE" ] || return 0
  awk -F'\t' -v s="$1" '$1 == s { print $2; exit }' "$STATE_FILE"
}

# ── Pass 1: parse roster, collect declared channels ─────────────────────────
CHANNELS=""
EMPLOYEES=""
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  line="${line%%#*}"
  line="${line%$'\r'}"   # a CRLF roster would otherwise yield 'emp-alice\r/' prefixes that fence everything out
  [ -z "${line//[[:space:]]/}" ] && continue
  # shellcheck disable=SC2086 — deliberate word split; globbing is off (set -f above)
  set -- $line
  [ "$#" -le 3 ] || die "roster line $lineno: too many fields ('$line'). Channels are ONE comma-separated field with no spaces: 'employee alice eng,product'"
  case "$1" in
    channel)
      require_slug channel "${2:-}"
      CHANNELS="$CHANNELS $2"
      ;;
    employee)
      require_slug employee "${2:-}"
      case " $EMPLOYEES " in *" $2:"*) die "roster line $lineno: employee '$2' listed twice" ;; esac
      if [ -n "${3:-}" ]; then
        for c in ${3//,/ }; do require_slug "channel-reference" "$c"; done
      fi
      EMPLOYEES="$EMPLOYEES $2:${3:-}"
      ;;
    *) die "roster line $lineno: unknown entry type '$1' (expected 'channel' or 'employee')" ;;
  esac
done < "$ROSTER"

# ── Pass 2: ensure the shared memory source exists (path-less) ──────────────
if out=$(run sources add "$MEMORY_SOURCE" --name "agent memory ($MEMORY_SOURCE)" 2>&1); then
  echo "source '$MEMORY_SOURCE': created"
else
  echo "$out" | grep -q "already registered" || die "sources add failed: $out"
  echo "source '$MEMORY_SOURCE': already exists"
fi

# ── Pass 3: converge one client per employee ────────────────────────────────
FED_READ="$MEMORY_SOURCE${READ_SOURCES:+,$READ_SOURCES}"
new_secrets=0

for entry in $EMPLOYEES; do
  slug="${entry%%:*}"
  chans="${entry#*:}"

  prefixes="emp-$slug/"
  if [ -n "$chans" ]; then
    for c in ${chans//,/ }; do
      echo " $CHANNELS " | grep -q " $c " || echo "WARN: employee '$slug' references undeclared channel '$c'" >&2
      prefixes="$prefixes,chan-$c/"
    done
  fi

  client_id="$(state_lookup "$slug")"
  if [ -n "$client_id" ]; then
    # The state file usually sits in the deployment repo, so anyone who can
    # edit it could otherwise retarget this privileged rescope at an arbitrary
    # client id (e.g. point alice's row at an admin client). Shape-check it.
    case "$client_id" in
      gbrain_cl_) die "state file: empty client id for '$slug'" ;;
      gbrain_cl_*[!a-zA-Z0-9_]*) die "state file: malformed client id for '$slug': $client_id" ;;
      gbrain_cl_*) ;;
      *) die "state file: client id for '$slug' does not look like a gbrain client: $client_id" ;;
    esac
    # --source too, so a re-run actually CONVERGES the client to the roster:
    # without it, changing --memory-source (or inheriting a state row written
    # against an older one) silently leaves the old write source in place
    # while the script reports success.
    run auth rescope-client "$client_id" --source "$MEMORY_SOURCE" \
      --federated-read "$FED_READ" --bound-slug-prefixes "$prefixes" >/dev/null
    echo "employee '$slug': rescoped $client_id  [write: $prefixes]"
  elif [ "$DRY_RUN" = 1 ]; then
    echo "employee '$slug': WOULD register qm-emp-$slug  [write: $prefixes] [read: $FED_READ]"
    continue
  else
    out=$(run auth register-client "qm-emp-$slug" \
      --grant-types client_credentials --scopes "read write" \
      --source "$MEMORY_SOURCE" --federated-read "$FED_READ" \
      --bound-slug-prefixes "$prefixes" --budget-usd-per-day "$BUDGET" 2>&1) \
      || die "register-client failed for '$slug' (output withheld: it can contain a secret). Re-run the command by hand to see why."
    client_id=$(echo "$out" | sed -n 's/.*Client ID:[[:space:]]*\(gbrain_cl_[^[:space:]]*\).*/\1/p' | head -1)
    secret=$(echo "$out"    | sed -n 's/.*Client Secret:[[:space:]]*\(gbrain_cs_[^[:space:]]*\).*/\1/p' | head -1)
    if [ -z "$client_id" ] || [ -z "$secret" ]; then
      # The client may well have been created — dying silently would strand a
      # live credential nobody can find. Say so WITHOUT echoing the captured
      # output: it contains the freshly minted secret, and this path ends up
      # in CI logs.
      die "could not parse client id/secret for '$slug' from register-client output (output withheld: it contains a secret). A client MAY have been created; check \`gbrain auth list\` and revoke any stray 'qm-emp-$slug'."
    fi
    printf '%s\t%s\n' "$slug" "$client_id" >> "$STATE_FILE"
    printf '%s\t%s\t%s\n' "$slug" "$client_id" "$secret" >> "$SECRETS_OUT"
    chmod 600 "$STATE_FILE" "$SECRETS_OUT" 2>/dev/null || true  # umask covers new files; this covers pre-existing ones
    new_secrets=$((new_secrets + 1))
    echo "employee '$slug': registered $client_id  [write: $prefixes]"
  fi
done

# ── Pass 4: flag offboarded employees ───────────────────────────────────────
# Removing someone from the roster is the highest-stakes edit there is, and
# this script cannot safely revoke on its own (a typo'd roster would nuke live
# credentials). Report instead, with the exact command.
if [ -f "$STATE_FILE" ]; then
  while IFS=$'\t' read -r st_slug st_client _rest; do
    [ -n "${st_slug:-}" ] || continue
    case " $EMPLOYEES " in
      *" $st_slug:"*) ;;
      *) echo "STALE: '$st_slug' ($st_client) is no longer in the roster but its credentials still work." >&2
         echo "       Revoke with: $GBRAIN auth revoke-client $st_client" >&2 ;;
    esac
  done < "$STATE_FILE"
fi

echo
echo "Done. State: $STATE_FILE"
if [ "$new_secrets" -gt 0 ]; then
  echo "$new_secrets NEW client secret(s) written to $SECRETS_OUT — deliver to each scope's sandbox, then DELETE the file."
fi

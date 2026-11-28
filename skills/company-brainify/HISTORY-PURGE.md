# company-brainify: purge an existing shared repo's history

Phase 5 of [company-brainify](SKILL.md) for one case only: a shared team repo
that ALREADY exists with sensitive history in it. A new team brain uses the
fresh export (SKILL.md, Phase 5 Step 0) and never needs this. Read this whole
file before Step 1. `$STAGING` and the scan scope carry over from SKILL.md
Phases 1-4.

**Step 1 — target the SHARED repo, commit the clean tree, then mirror-clone.**
The purge runs on the SHARED repo, NEVER `sync.repo_path` (the personal
brain). Clone it to a durable work dir, stay there for every step below, and
assert the target is not the personal repo first.

```bash
PERSONAL="$(gbrain config get sync.repo_path)"
mkdir -p "$HOME/.gbrain/backups" && chmod 700 "$HOME/.gbrain/backups"
WORK="$HOME/.gbrain/backups/brainify-purge-$(date +%Y%m%d-%H%M%S)"
git clone <SHARED_REPO_URL> "$WORK/shared"
cd "$WORK/shared"
[ "$(git rev-parse --show-toplevel)" != "$PERSONAL" ] \
  || { echo "target IS sync.repo_path (personal brain) — ABORT"; exit 1; }

# $STAGING holds the pages as they stood at $STAGING.base. Copying it over a
# page a teammate changed, added or deleted since then would silently revert
# their commit, so list every such page and stop. Reconcile: in your
# sanitized checkout, commit-push the sanitized folders (gbrain git commit-push
# -m "Sanitize" -- <folders>; on integrate_conflict the user chooses which
# version wins), which merges the teammate's commits in; give each listed page
# the full read and the Phase 4 checks; re-run the SKILL.md staging block for a
# new $STAGING; then restart Step 1 in a new $WORK.
BASE=$(cat "$STAGING.base" 2>/dev/null)
[ -n "$BASE" ] && git cat-file -e "$BASE^{commit}" 2>/dev/null \
  || { echo "staging base ${BASE:-missing} is not a commit on the shared repo — ABORT, re-stage from a pushed checkout"; exit 1; }
moved=$(git -c core.quotePath=false diff --no-renames --name-only "$BASE" HEAD -- people meetings daily companies projects analysis)
[ -z "$moved" ] || { printf 'changed on the shared repo after staging, never copied over — ABORT, reconcile and re-stage:\n%s\n' "$moved"; exit 1; }

# Commit the sanitized tree BEFORE the mirror clone: a mirror captures
# committed state only, and pushing it stops the remote serving the sensitive
# current versions even if the purge is declined. Commit only the sanitized
# dirs. Non-zero exit: retry once on commit_lock_busy; on integrate_conflict
# ask the user before going on.
for d in people meetings daily companies projects analysis; do
  [ -d "$STAGING/$d" ] && rsync -a "$STAGING/$d/" "./$d/"
done
# Nothing unread may stay: an earlier whole-folder export can have left pages
# here that never got the read. List them and stop; the user removes each one
# (git rm, commit-push, re-run Step 1) or appends it to the export list and
# gives it the full read and the Phase 4 checks.
[ -s "$STAGING.export-list" ] || { echo "no export list at $STAGING.export-list — ABORT"; exit 1; }
unread=$(for d in people meetings daily companies projects analysis; do [ -d "$d" ] && find "$d" -type f; done \
  | LC_ALL=C sort | LC_ALL=C comm -23 - "$STAGING.export-list")
[ -z "$unread" ] || { printf 'not on the export list, never read — ABORT:\n%s\n' "$unread"; exit 1; }
SANITIZED=""
for d in people meetings daily companies projects analysis; do [ -d "$d" ] && SANITIZED="$SANITIZED $d"; done
STAGED_TREE=$(export GIT_INDEX_FILE="$WORK/staged.index"; git read-tree HEAD && git add -- $SANITIZED && git write-tree)
gbrain git commit-push -m "Sanitize: strip sensitive content before history purge" -- $SANITIZED
# The pushed folders must be exactly the staged pages, byte for byte: a
# teammate push to them that commit-push merged in is content nobody read, so
# stop and reconcile it as above. Once they match, the sanitize commit is the
# new base, so a restart of Step 1 only stops on pushes made after it.
[ -n "$STAGED_TREE" ] && git diff --quiet "$STAGED_TREE" HEAD -- $SANITIZED \
  || { echo "a teammate pushed to the sanitized folders during the sanitize push — ABORT, reconcile and re-stage"; exit 1; }
git rev-parse HEAD > "$STAGING.base"

# Pin the remote NOW: every branch and tag as it stands right after the
# sanitize push. Step 3 pushes with a lease on each recorded sha (main's is
# $LEASE), so a push someone makes while the card waits makes the purge refuse
# instead of being overwritten.
git ls-remote origin > "$WORK/remote-refs.txt"
LEASE=$(awk '$2 == "refs/heads/main" {print $1}' "$WORK/remote-refs.txt")
[ -n "$LEASE" ] && [ "$LEASE" = "$(git rev-parse HEAD)" ] \
  || { echo "origin/main is not the sanitize commit — ABORT, re-run Step 1"; exit 1; }

# Mirror-clone backup of the REMOTE (every branch and tag) = the card's
# recoverability line. Capture the path NOW and reuse it verbatim: never
# recompute $(date) later.
BACKUP_PATH="$HOME/.gbrain/backups/shared-brain-history-backup-$(date +%Y%m%d-%H%M%S).git"
git clone --mirror <SHARED_REPO_URL> "$BACKUP_PATH"
git -C "$BACKUP_PATH" log -1 >/dev/null || { echo "backup unreadable — ABORT"; exit 1; }
git ls-remote origin | cmp -s - "$WORK/remote-refs.txt" \
  || { echo "the remote moved during the backup — ABORT, re-run Step 1"; exit 1; }
```

Verify the mirror exists and reads before presenting the card — it is the
card's recoverability line. Fill the card's Refs from
`$WORK/remote-refs.txt`: every branch and tag defaults to rewrite, and the
user may mark any of them delete instead.

**Step 2 — STOP. Present the [data-loss-gate](../data-loss-gate/SKILL.md)
confirmation card and wait.** History rewrite + force-push is the most
destructive operation in this skill: it permanently discards every prior
version of the purged paths from the remote. Never run it without the card
answered. Pre-filled for this operation:

```
⚠️ DATA DELETION — Confirmation Required

What: rewrite git history to remove all prior versions of [purged paths]
      from the SHARED repo, then force-push every branch and tag under a lease
Count: [N commits rewritten; M files with history purged]
Refs (git ls-remote origin, recorded in $WORK/remote-refs.txt), each with
      its action:
      refs/heads/main      <sha>  rewrite, sanitized tree re-added
      refs/heads/<branch>  <sha>  rewrite | delete
      refs/tags/<tag>      <sha>  rewrite | delete
      [other refs, e.g. refs/pull/*: the host keeps them and they can't be
      pushed — they need the host's sensitive-data removal]
Lease: main pinned at $LEASE, every other ref at its recorded sha
Size: [repo size before → expected after]
Location: [SHARED repo work dir; remote URL; branch]
Target check: this is the SHARED repo, verified ≠ personal sync.repo_path
      ($PERSONAL) — the personal brain's history is never rewritten

Why: prior commits contain pre-sanitization versions of pages that were
     just cleaned — team access to the repo means team access to history

Risk while this card waits: ask the team to stop pushing to the shared repo
      now. If anyone pushes, or adds a branch or tag, before the purge, the
      push refuses (nothing is overwritten) and the purge restarts at Step 1
      with a new card. Commits pushed after the backup are not in it.

Recoverable?
- [x] Mirror-clone backup of every branch and tag at $BACKUP_PATH
      (verified: exists, `git -C "$BACKUP_PATH" log` works)
- [ ] NOT recoverable from the rewritten remote — old SHAs stop being
      reachable from the listed branches and tags; host-kept refs (pull
      request refs, forks, caches) hold them until the host removes them

What we'd lose:
- all pre-sanitization history for the purged paths (edit trail, blame,
  old versions)
- the purged paths on every rewritten branch other than main (only main
  gets the sanitized tree back), and every branch or tag marked delete
- every existing clone breaks — all collaborators must re-clone

Alternative to deletion:
- fresh-history export to a NEW team repo (Step 0) — personal repo untouched

Proceed? (yes/no)
```

Per data-loss-gate: require a typed **"yes"** or **"do it"** ("ok", "sure",
"go ahead" are not consent). If the user asks a question, answer and re-present
the card. Nothing in gbrain mechanically blocks `git filter-repo`, so the
agent must never skip this gate.

**Step 3 — purge (only after the explicit typed yes).** Requires
`git filter-repo` (not bundled with git; install separately). **Run this ONLY
in the shared-repo work dir from Step 1 (`cd "$WORK/shared"`). NEVER run
`git filter-repo` or `git push --force` in `sync.repo_path` — the personal <!-- gbrain-allow-shared-tree-git: warns against a force push in the personal brain -->
brain's history must stay intact.** The commands below reuse `$WORK` and
`$BACKUP_PATH` from Step 1; they never recompute a date-stamped path.

```bash
cd "$WORK/shared"
[ "$(git rev-parse --show-toplevel)" != "$PERSONAL" ] \
  || { echo "target IS sync.repo_path — ABORT, do not filter-repo"; exit 1; }
git ls-remote origin | cmp -s - "$WORK/remote-refs.txt" \
  || { echo "the shared repo moved since Step 1 — ABORT, re-run from Step 1"; exit 1; }

# filter-repo rewrites local refs only: make every remote branch a local
# branch and fetch every tag, so all of them are rewritten.
git fetch --tags origin
for b in $(git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin/); do
  [ "$b" = HEAD ] || [ "$b" = main ] || git branch -f "$b" "origin/$b"
done
# Refs the user marked delete on the card: record each full ref name in
# $WORK/delete-refs.txt and remove it locally now, the remote-tracking ref too
# so filter-repo cannot recreate the branch; the push deletes them remotely:
#   echo "refs/heads/<branch>" >> "$WORK/delete-refs.txt"; git branch -D <branch>
#   git update-ref -d refs/remotes/origin/<branch>
#   echo "refs/tags/<tag>" >> "$WORK/delete-refs.txt"; git tag -d <tag>
touch "$WORK/delete-refs.txt"

# The purge list is the COMPLETE set of scanned dirs (Phases 1-4); a narrower
# list leaves old history alive. Backed-up, filtered and re-added sets match.
PURGE_DIRS="people meetings daily companies projects analysis"

# Back up the clean tree of every purged path to a DURABLE carrier (never /tmp).
CLEAN="$WORK/clean"
mkdir -p "$CLEAN"
for d in $PURGE_DIRS; do
  [ -d "$d" ] || continue
  mkdir -p "$CLEAN/$d" && cp -r "$d/." "$CLEAN/$d/"
done

# Rewrite history: one --path per purged directory
rm -rf .git/filter-repo
git filter-repo --invert-paths $(for d in $PURGE_DIRS; do printf -- '--path %s/ ' "$d"; done) --force

# Restore clean files and re-commit as a single new commit — same $PURGE_DIRS
for d in $PURGE_DIRS; do
  [ -d "$CLEAN/$d" ] || continue
  mkdir -p "$d" && cp -r "$CLEAN/$d/." "$d/"
done
git remote add origin <SHARED_REPO_URL>   # filter-repo removes remotes
for d in $PURGE_DIRS; do [ -d "$d" ] && git add "$d/"; done
git commit -m "Re-add sanitized directories"

# VERIFY RESTORE COMPLETENESS before the irreversible push.
before=$(find "$CLEAN" -type f | wc -l | tr -d ' ')
after=$(for d in $PURGE_DIRS; do [ -d "$d" ] && find "$d" -type f; done | wc -l | tr -d ' ')
[ "$before" = "$after" ] \
  || { echo "restore incomplete ($before → $after files) — ABORT, do not force-push"; exit 1; }
# Optional stronger check: diff -r "$CLEAN/<d>" "<d>" for each purged dir.

# RE-VERIFY the backup right before the irreversible step (reuse $BACKUP_PATH).
git -C "$BACKUP_PATH" log -1 >/dev/null \
  || { echo "backup missing/unreadable — ABORT, do not force-push"; exit 1; }
```

**Step 3b — push every branch and tag under a lease.** One atomic push: each
ref recorded in Step 1 is rewritten, or deleted when Step 3 listed it in
`$WORK/delete-refs.txt`; a recorded ref missing locally that was not marked
delete stops the purge before anything is pushed. Each ref carries `--force-with-lease=<ref>:<recorded sha>` (main's
is `$LEASE`). If any ref moved, the whole push refuses and nothing on the
remote changes.

```bash
cd "$WORK/shared"
git ls-remote origin | cmp -s - "$WORK/remote-refs.txt" \
  || { echo "the shared repo moved since Step 1 — ABORT, re-run from Step 1"; exit 1; }
LEASES=""; REFSPECS=""
while read -r old ref; do
  case "$ref" in refs/heads/*|refs/tags/*) ;; *) continue ;; esac
  case "$ref" in *'^{}') continue ;; esac
  LEASES="$LEASES --force-with-lease=$ref:$old"
  if git show-ref --verify --quiet "$ref"; then REFSPECS="$REFSPECS $ref:$ref"
  elif grep -qxF "$ref" "$WORK/delete-refs.txt"; then REFSPECS="$REFSPECS :$ref"
  else echo "$ref is missing locally but was not marked delete — ABORT, nothing pushed"; exit 1; fi
done < "$WORK/remote-refs.txt"
# A branch or tag created between the ls-remote compare above and this push
# carries no lease, so the push can't refuse it; the verify below still lists
# it as not landed. If it fires, stop: that ref keeps the old history until the
# purge is re-run from Step 1.
git push --atomic $LEASES origin $REFSPECS || { echo "push refused: the remote moved, nothing changed — re-run from Step 1"; exit 1; }  # gbrain-allow-shared-tree-git: confirmed history purge of a private clone, every ref leased to its Step 1 sha

# Verify: every branch and tag on the remote is the local rewritten ref, and
# only main's re-add commit touches the purged paths anywhere.
git ls-remote origin 'refs/heads/*' 'refs/tags/*' | while read -r sha ref; do
  case "$ref" in *'^{}') continue ;; esac
  [ "$sha" = "$(git rev-parse "$ref")" ] || { echo "$ref did not land — STOP"; exit 1; }
done || exit 1
[ "$(git rev-list --all -- $PURGE_DIRS)" = "$(git rev-parse main)" ] \
  || { echo "old history of the purged paths is still reachable — STOP"; exit 1; }
```

**Step 4 — log it (to the PERSONAL brain, NEVER the shared repo).** Per
data-loss-gate, append the deletion under `## Data Deletions` in
`$PERSONAL/daily/notes/YYYY-MM-DD.md` (or a local ops log): timestamp, purged
paths, commit counts, and `$BACKUP_PATH` as the recovery line. In the shared
repo it would show the team which paths held sensitive content and where the
backup lives.

**After the force push:**

- All existing clones must re-clone
- Step 3b rewrote or deleted every branch and tag, but the host can still
  serve the old commits: pull-request refs, forks and caches can't be pushed
  away and may keep them for months. Use the provider's sensitive-data
  removal process for those
- A sync cursor on a rewritten-away SHA makes the next `gbrain sync` error or
  rescan fully; run `gbrain doctor` if it doesn't settle
- **Backup retention:** once the team has re-cloned and sync settled, keep the
  mirror backup ~30 days, then delete it (it holds the pre-sanitization
  history): `rm -rf ~/.gbrain/backups/shared-brain-history-backup-<date>.git`,
  with the exact name Step 1 created (a mismatched name deletes nothing)
- Re-verify remotes and any push hooks survived the rewrite before handoff

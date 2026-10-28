# History purge (company-brainify Phase 5)

Read this when an existing SHARED repo still carries pre-sanitization versions
in its git history. A fresh team repo (Phase 5, preferred) needs none of it.

**Step 1 — target the SHARED repo, commit the clean tree, then mirror-clone.**
The purge operates on the SHARED repo, NEVER on `sync.repo_path` (the personal
brain) — Step 0's guarantee that the personal repo keeps full history depends
on it. Clone the shared repo to a durable work dir, stay there for every step
below, and assert the target is not the personal repo before touching anything.

```bash
PERSONAL="$(gbrain config get sync.repo_path)"
mkdir -p "$HOME/.gbrain/backups" && chmod 700 "$HOME/.gbrain/backups"
WORK="$HOME/.gbrain/backups/brainify-purge-$(date +%Y%m%d-%H%M%S)"
git clone <SHARED_REPO_URL> "$WORK/shared"
cd "$WORK/shared"
[ "$(git rev-parse --show-toplevel)" != "$PERSONAL" ] \
  || { echo "target IS sync.repo_path (personal brain) — ABORT"; exit 1; }

# Apply the sanitized tree, then COMMIT it BEFORE the mirror clone. A mirror
# captures COMMITTED state only; if the clean tree lives only in volatile
# staging during the rewrite window, a crash loses the sanitization work.
# Committing makes the clean state durable and recoverable; pushing it means
# the remote stops serving the sensitive current versions even if the purge
# below is declined. Only the sanitized directories are committed. On a
# non-zero exit stop: retry once on commit_lock_busy; on integrate_conflict
# someone changed the shared repo meanwhile, so ask the user before going on.
for d in people meetings daily companies projects analysis; do
  [ -d "$STAGING/$d" ] && rsync -a "$STAGING/$d/" "./$d/"   # or sanitize in place here
done
SANITIZED=""
for d in people meetings daily companies projects analysis; do [ -d "$d" ] && SANITIZED="$SANITIZED $d"; done
gbrain git commit-push -m "Sanitize: strip sensitive content before history purge" -- $SANITIZED

# Mirror-clone backup = the recoverability line on the card. Capture the path
# in a variable NOW and reuse it verbatim at purge time — a run crossing
# midnight must NOT recompute $(date) and false-abort on a mismatched name.
BACKUP_PATH="$HOME/.gbrain/backups/shared-brain-history-backup-$(date +%Y%m%d-%H%M%S).git"
git clone --mirror "$WORK/shared" "$BACKUP_PATH"
git -C "$BACKUP_PATH" log -1 >/dev/null || { echo "backup unreadable — ABORT"; exit 1; }
```

Verify the mirror exists and reads before presenting the card — it is the
card's recoverability line.

**Step 2 — STOP. Present the [data-loss-gate](../../data-loss-gate/SKILL.md)
confirmation card and wait.** History rewrite + force-push is the most
destructive operation in this skill: it permanently discards every prior
version of the purged paths from the remote. Never run it without the card
answered. Pre-filled for this operation:

```
⚠️ DATA DELETION — Confirmation Required

What: rewrite git history to remove all prior versions of [purged paths]
      from the SHARED repo, then force-push to [remote/branch]
Count: [N commits rewritten; M files with history purged]
Size: [repo size before → expected after]
Location: [SHARED repo work dir; remote URL; branch]
Target check: this is the SHARED repo, verified ≠ personal sync.repo_path
      ($PERSONAL) — the personal brain's history is never rewritten

Why: prior commits contain pre-sanitization versions of pages that were
     just cleaned — team access to the repo means team access to history

Recoverable?
- [x] Mirror-clone backup at $BACKUP_PATH
      (verified: exists, `git -C "$BACKUP_PATH" log` works)
- [ ] NOT recoverable from the rewritten remote — old SHAs become unreachable

What we'd lose:
- all pre-sanitization history for the purged paths (edit trail, blame,
  old versions)
- every existing clone breaks — all collaborators must re-clone

Alternative to deletion:
- fresh-history export to a NEW team repo (Step 0) — personal repo untouched

Proceed? (yes/no)
```

Per data-loss-gate: require a typed **"yes"** or **"do it"** — "ok", "sure",
"go ahead" are not consent. If the user asks a question, answer and re-present
the card. This gate is a routing convention, not a runtime enforcement —
nothing in gbrain mechanically blocks `git filter-repo` — which is exactly why
the agent following this skill must not skip it.

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

# The purge list derives from the COMPLETE set of sanitized paths — the same
# directories Phases 1-4 scanned. A filter list narrower than the scan
# (people/ + meetings/ only) leaves pre-sanitization history alive for every
# other scanned directory. The restore carrier below MUST match this same
# list — backed-up set, filtered set, and re-added set are identical.
PURGE_DIRS="people meetings daily companies projects analysis"

# Back up the clean working tree of every purged path to a DURABLE carrier
# (under $WORK in ~/.gbrain/backups — never /tmp, which can vanish mid-rewrite).
CLEAN="$WORK/clean"
mkdir -p "$CLEAN"
for d in $PURGE_DIRS; do
  [ -d "$d" ] || continue
  mkdir -p "$CLEAN/$d" && cp -r "$d/." "$CLEAN/$d/"
done

# Rewrite history: one --path per purged directory, derived from $PURGE_DIRS
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

# VERIFY RESTORE COMPLETENESS before the irreversible push — a partial restore
# would ship a smaller tree than was sanitized. Compare file counts (and, for
# extra safety, checksums) between the carrier and the restored tree.
before=$(find "$CLEAN" -type f | wc -l | tr -d ' ')
after=$(for d in $PURGE_DIRS; do [ -d "$d" ] && find "$d" -type f; done | wc -l | tr -d ' ')
[ "$before" = "$after" ] \
  || { echo "restore incomplete ($before → $after files) — ABORT, do not force-push"; exit 1; }
# Optional stronger check: diff -r "$CLEAN/<d>" "<d>" for each purged dir.

# RE-VERIFY the backup immediately before the irreversible step — card-time
# verification is not enough; time has passed and the rewrite could have gone
# sideways. Reuse $BACKUP_PATH (do NOT recompute $(date)); abort if unreadable.
git -C "$BACKUP_PATH" log -1 >/dev/null \
  || { echo "backup missing/unreadable — ABORT, do not force-push"; exit 1; }

git push --force origin main  # gbrain-allow-shared-tree-git: the confirmed history purge of a private single-writer clone (data-loss-gate answered)
```

**Step 4 — log it (to the PERSONAL brain, NEVER the shared repo).** Per
data-loss-gate, append the deletion under `## Data Deletions` — but write it to
the PERSONAL brain's `$PERSONAL/daily/notes/YYYY-MM-DD.md` (or a local ops
log), never into the shared repo. The log names the purged paths AND the
backup location; in the shared repo those two facts would tell every team
member exactly which paths held sensitive content and where the
pre-sanitization backup lives — the audit trail becomes a treasure map.
Record: timestamp, purged paths, commit counts, and `$BACKUP_PATH` as the
recovery line.

**After the force push:**

- All existing clones must re-clone
- Hosting providers may cache unreachable commits for a time (on the order of
  months); for immediate removal use the provider's sensitive-data removal
  process. For private/internal repos, the SHA being unreachable from any ref
  is usually sufficient
- The sync cursor may reference a rewritten-away SHA; if the next
  `gbrain sync` errors or falls back to a full rescan, that is the cursor
  recovering — run `gbrain doctor` if it doesn't settle
- **Backup retention:** once the rewrite is verified good (team has
  re-cloned, sync settled, no missing content reported), keep the
  mirror-clone backup in `~/.gbrain/backups/` for a retention window
  (~30 days is a sane default), then delete it — it contains the
  pre-sanitization history and should not accumulate indefinitely:
  `rm -rf ~/.gbrain/backups/shared-brain-history-backup-<date>.git`
  (the glob must match the `shared-brain-history-backup-*` name the backup
  step created — a mismatched pattern deletes nothing and silently retains
  the pre-sanitization history forever)
- If the repo carries push hooks or auto-hardening wiring, re-verify remotes
  and hooks survived the rewrite before handing the repo to the team

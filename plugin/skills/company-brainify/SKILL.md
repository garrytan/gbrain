---
name: company-brainify
version: 1.0.0
description: >
  Extract a sanitized shared team/company brain from a personal brain.
  Strips internal ratings, compensation, performance assessments, retention
  and political dynamics from pages, takes, and facts across the full scan
  scope (people, companies, meetings, dailies, cross-references — not just
  people/), verifies with grep + retrieval passes, and purges sensitive git
  history behind the data-loss-gate confirmation card. Also runs as a
  report-only re-audit on an existing shared brain.
triggers:
  - "company brain"
  - "team brain"
  - "brainify"
  - "sanitize the brain"
  - "share my brain with the team"
  - "strip sensitive data from the brain"
  - "scrub employee data"
  - "audit the shared brain"
  - "make the brain safe to share"
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - meetings/
  - daily/
  - projects/
  - analysis/
upstream: company-brainify@fc834ee
# Brain-first in its native form: Phase-1 discovery runs through gbrain
# retrieval (query/search/takes search/recall), and every edit is grounded
# in a full read of the actual page. writes_to lists the scan scope the
# skill edits IN PLACE — it does not create new pages there, except the
# deletion-log entry under daily/ required by data-loss-gate Step 4.
brain_first: true
when_to_use: "Use when the user asks: \"company brain\", \"team brain\", \"brainify\", \"sanitize the brain\", \"share my brain with the team\"."
---

# company-brainify — Personal → Team-Brain Sanitization

> **Conventions:** [brain-first](../conventions/brain-first.md) (discovery runs
> through the brain's retrieval; greps only triage),
> [test-before-bulk](../conventions/test-before-bulk.md) (sanitize 3-5 files,
> read them, then ramp: a bad bulk pass looks done and isn't),
> [regex-discipline](../conventions/regex-discipline.md) ("is this sensitive?"
> is the model's per-file judgment; patterns never judge) and
> [_brain-filing-rules.md](../_brain-filing-rules.md) (edits stay in the page's
> directory; the deletion log is date-keyed under `daily/`).

## The Problem

A personal brain holds company knowledge next to internal assessments,
compensation, management strategy and candid opinions about colleagues. A
shared team brain built from it (topology: `docs/architecture/brains-and-sources.md`)
keeps the knowledge and drops the sensitive metadata. Clean working-tree files
are NOT enough: git history keeps every pre-sanitization version, and
takes/facts carry evaluative claims outside the prose. This skill covers all
three surfaces: pages, takes/facts, and history.

## When to Use

Connecting or indexing an existing company repository without editing it is not
sanitization. For “connect our company brain” or “import an existing company
brain,” use the migrate (host-side) company workflow. On the trusted brain host,
start with `gbrain sources inspect <path> --profile company-brain`; follow
`docs/guides/company-brain-ingestion.md` for destination preview and approval.
Do not strip metadata or purge history merely to make an existing repository
searchable.

- Standing up a shared company brain from a founder/exec's personal brain
- Auditing an existing shared brain for sensitive content that shouldn't be there
- Onboarding new team members to a brain repo that must be verified clean first
- Periodic hygiene pass on a shared brain that re-accumulates sensitive data

## What Gets Removed

### Always strip (non-negotiable)

| Category | Examples |
|----------|----------|
| **Internal scores/ratings** | `score:`, `rating:`, `skill:`, or any vertical-specific `*_score:` frontmatter field; any numeric rating of a person |
| **Compensation** | Salary, equity, carry, option grants, comp changes, retention packages |
| **Performance assessments** | Strengths/weaknesses sections about employees, "at risk" flags, underperformance mentions, "picking up slack" references |
| **Departure/retention** | Who's considering leaving, who was convinced to stay, departure rumors, retention conversations |
| **Management strategy** | How-to-manage-someone sections, "the hard conversation" notes, scope/title management plans |
| **Internal political dynamics** | Who doesn't like whom, who's nervous about whom, adversarial relationships, power dynamics |
| **Personal PII** | Phone numbers, personal email addresses, home addresses, family or medical details, personal legal matters, personal-life details |
| **Takes/facts** | Any take or fact referencing the above categories — performance, comp, retention, weakness, management risk. Fact rows are DELETED from the page's Facts fence, never merely expired with `gbrain forget` |

### Always keep

| Category | Examples |
|----------|----------|
| **Professional identity** | Name, role, title, work email, LinkedIn |
| **What they're building** | Current projects, product work, technical contributions |
| **Career arc** | Prior companies, education, professional background (public info) |
| **Professional beliefs** | Their views on technology, strategy, product philosophy |
| **Timeline of work** | Meeting attendance, project milestones, launches (factual, not evaluative) |
| **Skills/expertise** | Technical capabilities, domain knowledge |

## Scan Scope — Wider Than people/

Sensitive content leaks far beyond people pages. The scan scope is:

- `people/` — the primary surface (frontmatter fields, assessment sections)
- `meetings/` — transcripts and minutes with candid assessments
- `daily/` — daily notes referencing comp/performance/retention conversations
- `companies/`, `projects/`, `analysis/` — cross-references to removed content
- **Takes** — evaluative claims in page takes fences (`gbrain takes search`)
- **Facts** — hot-memory facts (`gbrain recall --grep`)
- **Back-links** — after edits, `gbrain check-backlinks check` confirms no page
  still points at removed sections

A pass that only covers `people/` will certify a brain that still leaks.

## Procedure

All paths below are relative to the brain repo root:

```bash
BRAIN="$(gbrain config get sync.repo_path)"
cd "$BRAIN"
```

### Phase 1: Identify scope (retrieval-first)

1. Retrieval discovery — hybrid search catches judgment-shaped content that no
   keyword pattern will:

   ```bash
   gbrain query "compensation, equity, or salary discussions about team members" --limit 50
   gbrain query "performance concerns, underperformance, or who is struggling" --limit 50
   gbrain query "considering leaving, retention conversations, departure rumors" --limit 50
   gbrain takes search "performance" --limit 50
   gbrain recall --grep "salary"
   ```

   Resolve every returned slug to its repo-relative file path and write the
   paths into `/tmp/brainify-scope.txt` (one per line). This file is the
   scope list; the structural pass below APPENDS to it — nothing later in
   the procedure may truncate it, or the retrieval-discovered pages
   silently drop out of scope.

2. Structural discovery — people files that belong to the company, plus
   keyword hits across the wider scan scope:

   ```bash
   grep -rli 'company: *"acme-example"' people/ --include="*.md" | sort >> /tmp/brainify-scope.txt
   grep -rli -E 'salary|equity|carry|retention|underperform|performance review|hard conversation' \
     meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null >> /tmp/brainify-scope.txt
   sort -u -o /tmp/brainify-scope.txt /tmp/brainify-scope.txt
   ```

3. Cross-reference against the company's public people page (website,
   LinkedIn) to catch files using different frontmatter conventions.

4. Count: `wc -l /tmp/brainify-scope.txt`

### Phase 2: Triage sensitivity

Prioritize by hit density (portable `grep -E`; no `\b` — BSD and GNU disagree):

```bash
while read -r f; do
  hits=$(grep -c -i -E 'carry|salary|equity|comp change|departure|considering leaving|retention|underperform|picking up slack|performance review|management risk|hard conversation|nervou|score: *[0-9]|firing|fired|pip|probation|weakness' "$f" 2>/dev/null || true)
  [ "${hits:-0}" -gt 0 ] && echo "$hits $f"
done < /tmp/brainify-scope.txt | sort -rn > /tmp/brainify-triage.txt
```

High-hit files need full judgment passes. Zero-hit files may only need
frontmatter field removal — but they still get read (regex triages, the model
judges).

### Phase 3: Sanitize (STAGING COPY preferred; test first, then parallel)

Phase 3 is destructive: it strips content across many files, removes takes,
and deletes fact rows. Two rules govern it.

**Choose the target FIRST — copy, don't mutate the personal brain.**

- **Standing up a NEW team brain (default, preferred):** sanitize a STAGING
  COPY of the scanned directories, never the personal brain in place. The
  founder's personal brain is SUPPOSED to keep comp, performance, and candid
  notes — stripping them from the personal working tree destroys valuable
  private data. Copy the Phase-1 scope into a durable staging dir and edit
  THAT; Phase 5 Step 0 exports from the staging copy. Blast radius: none on the
  personal brain.

  ```bash
  # Durable staging dir (NOT /tmp — same reasoning as the mirror backup).
  STAGING="$HOME/.gbrain/backups/brainify-staging-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$STAGING" && chmod 700 "$STAGING"
  for d in people meetings daily companies projects analysis; do
    [ -d "$d" ] && rsync -a "$d/" "$STAGING/$d/"
  done
  cd "$STAGING"   # all edits below happen here, not in sync.repo_path
  ```

- **Re-auditing an EXISTING shared brain:** the shared brain IS the target, so
  edits are in place on the SHARED repo (cd into the shared repo, never the
  personal `sync.repo_path`). Fact-row removal + re-sync applies to the shared
  source's DB.

**Fire the [data-loss-gate](../data-loss-gate/SKILL.md) confirmation card
BEFORE the bulk destructive edits begin.** Both targets are destructive (the
copy path removes content from the tree destined for the team; the in-place
path removes content from a live brain). Pre-filled for Phase 3:

```
⚠️ DATA DELETION — Confirmation Required

What: strip sensitive content, remove takes, and delete fact rows across
      [N files] in [STAGING COPY at <path>  |  the SHARED brain in place]
Count: [N files edited; T takes removed; F fact rows removed]
Location: [staging path OR shared repo path] — NOT the personal sync.repo_path
          on the staging path

Why: preparing a sanitized tree for team access

Recoverable?
- [x] Personal brain untouched (staging-copy path) — re-copy to redo
- [ ] In-place shared-brain path: edits overwrite the live tree; git history is
      the recovery line until Phase 5 purges it

Proceed? (yes/no)
```

Require a typed "yes"/"do it" per data-loss-gate; "ok"/"sure" are not consent.

Per test-before-bulk: do 3-5 files first, read the results, then ramp. For
large sets (50+ files), batch into groups of 10-12 and spawn parallel
subagents. Per file:

1. Read the file completely
2. Remove all content matching the "Always strip" categories
3. Frontmatter: delete rating/comp field lines entirely
4. Sections: remove entire sections (assessment weaknesses, team dynamics,
   management strategy)
5. Takes and Facts fences: remove entire rows that reference sensitive
   categories — a take like "alice-example believes charlie-example is
   underperforming" reveals both the opinion and who holds it; remove the
   whole row, never just the attribution
6. Inline mentions: surgically edit sentences/paragraphs
7. Write the cleaned file back

Use `Edit` for surgical removal of a few sections; `Write` the whole file
only when sensitive content is interwoven throughout.

**Facts: `forget` is NOT removal.** `gbrain forget <fact-id>` only expires a
fact: the row stays struck through in the Facts fence and the DB still serves
it via `--include-expired`. Find sensitive facts (`gbrain recall --grep`) and
delete the row from the page's Facts fence (step 5), like a take.

- **Staging-copy path:** editing the copied markdown is the removal; the team
  DB is built fresh from the export in Phase 5 Step 0.
- **In-place shared-brain path:** run `gbrain sync` (re-imports the page), then
  reconcile the facts index: sync's convergence contract covers page import
  only (`src/commands/sync.ts`, "CONVERGENCE CONTRACT"), so the DB serves the
  deleted row until the extract-facts reconcile runs. Trigger it (`gbrain sweep`,
  or wait for the serve-resident sweep) and confirm with `gbrain recall --grep`
  that the row is gone.

Either way, run `gbrain check-backlinks check` for pages still pointing at
removed content.

### Phase 4: Verify

Re-run the Phase 2 triage — the count of flagged files should drop to
(near-)zero. Then targeted greps:

```bash
# Rating fields remaining in frontmatter
grep -rn -E '^[a-z_]*(score|rating|skill)[a-z_]*: *[0-9]' people/ --include="*.md"

# Phone numbers
grep -rn -E '\+1[0-9]{10}|\([0-9]{3}\) [0-9]{3}-[0-9]{4}' people/ --include="*.md"

# Comp keywords (full scan scope, not just people/)
grep -rin -E 'carry|comp change|equity|salary' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null

# Management/performance
grep -rin -E 'considering leaving|departure rumor|underperform|picking up slack|hard conversation' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null
```

False positives (e.g. "carry the torch") are fine — manually confirm each
remaining hit rather than tightening the pattern (regex-discipline).

**Verify the tree that ships:** `$STAGING` on the staging-copy path (the
personal tree doesn't ship, so certifying it proves nothing), the shared repo's
tree on an in-place re-audit.

Then the strongest check — the retrieval the team will actually use. Against
the sanitized brain/source (scope with `--source <team-source-id>` when the
shared source is mounted alongside personal content):

```bash
gbrain query "what is alice-example's compensation" --limit 10
gbrain query "who is underperforming or at risk of leaving" --limit 10
gbrain takes search "weakness" --limit 20
```

Every one of these must come back empty or with only keep-category content.

### Phase 5: Commit and purge history — GATED

Clean files aren't enough if the repo has history: old commits still contain
the sensitive versions.

**Step 0 — preferred alternative (non-destructive).** When standing up a NEW
team repo, skip history rewriting entirely: the sanitized STAGING tree from
Phase 3 becomes a fresh repo with fresh history. The personal repo keeps its
full history AND its full working tree, untouched.

**Export rule: nothing unscanned ships.** Phase 3 copied ONLY the scanned
directories into `$STAGING`, so it holds nothing the pass didn't read. Never
copy other directories in (`conversations/`, `originals/`, `sources/`,
`inbox/`): a whole-repo copy is the classic leak. To ship a new directory, add
it to the scan scope first (Phases 1-4).

```bash
# The sanitized staging tree IS the export.
cd "$STAGING"

# Re-run the Phase 4 verification greps + retrieval checks INSIDE $STAGING —
# the staging tree is what ships, and it is the tree that must certify clean.
# ... Phase 4 greps against $STAGING ...

git init -b main
git add -A && git commit -m "Initial import — sanitized team brain"  # gbrain-allow-shared-tree-git: first commit of a fresh single-writer export repo
git remote add origin <TEAM_REPO_URL>
gbrain git commit-push --push-only
```

The first commit is plain git because `$STAGING` is a brand-new repo only
this run writes. `gbrain git commit-push --push-only` pushes to `origin/main`
and fails loudly if the push does not land. On a non-zero exit, stop and relay
the error: usually `git_push_unavailable` (fix the URL or credentials, rerun),
or a team repo that already has commits (this export needs an empty one; ask
the user). Never force-push it.

Only when a shared repo ALREADY exists with sensitive history in it do you
need the purge below.

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

# Commit the sanitized tree BEFORE the mirror clone: a mirror captures
# committed state only, and pushing it stops the remote serving the sensitive
# current versions even if the purge is declined. Commit only the sanitized
# dirs. Non-zero exit: retry once on commit_lock_busy; on integrate_conflict
# ask the user before going on.
for d in people meetings daily companies projects analysis; do
  [ -d "$STAGING/$d" ] && rsync -a "$STAGING/$d/" "./$d/"   # or sanitize in place here
done
SANITIZED=""
for d in people meetings daily companies projects analysis; do [ -d "$d" ] && SANITIZED="$SANITIZED $d"; done
gbrain git commit-push -m "Sanitize: strip sensitive content before history purge" -- $SANITIZED

# Mirror-clone backup = the card's recoverability line. Capture the path NOW
# and reuse it verbatim: never recompute $(date) later.
BACKUP_PATH="$HOME/.gbrain/backups/shared-brain-history-backup-$(date +%Y%m%d-%H%M%S).git"
git clone --mirror "$WORK/shared" "$BACKUP_PATH"
git -C "$BACKUP_PATH" log -1 >/dev/null || { echo "backup unreadable — ABORT"; exit 1; }
```

Verify the mirror exists and reads before presenting the card — it is the
card's recoverability line.

**Step 2 — STOP. Present the [data-loss-gate](../data-loss-gate/SKILL.md)
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

git push --force origin main  # gbrain-allow-shared-tree-git: the confirmed history purge of a private single-writer clone (data-loss-gate answered)
```

**Step 4 — log it (to the PERSONAL brain, NEVER the shared repo).** Per
data-loss-gate, append the deletion under `## Data Deletions` in
`$PERSONAL/daily/notes/YYYY-MM-DD.md` (or a local ops log): timestamp, purged
paths, commit counts, and `$BACKUP_PATH` as the recovery line. In the shared
repo it would show the team which paths held sensitive content and where the
backup lives.

**After the force push:**

- All existing clones must re-clone
- Hosts may cache unreachable commits for months; use the provider's
  sensitive-data removal process for immediate removal (for private repos,
  unreachable from every ref is usually enough)
- A sync cursor on a rewritten-away SHA makes the next `gbrain sync` error or
  rescan fully; run `gbrain doctor` if it doesn't settle
- **Backup retention:** once the team has re-cloned and sync settled, keep the
  mirror backup ~30 days, then delete it (it holds the pre-sanitization
  history): `rm -rf ~/.gbrain/backups/shared-brain-history-backup-<date>.git`,
  with the exact name Step 1 created (a mismatched name deletes nothing)
- Re-verify remotes and any push hooks survived the rewrite before handoff

**Hand the repo to the team — stamp it shared first.** On either path, run
`gbrain config set brain.audience shared` against the TEAM brain (never the
personal one), so the ambient writeback consent nudge, a personal-brain ask,
never fires on it. A team member who runs `gbrain init` before the stamp
exists prefixes that command with `GBRAIN_NO_ONBOARD_NUDGE=1`: an un-stamped
brain classifies personal and the fire-once nudge would ask the wrong question.

### Phase 6: Ongoing hygiene — periodic re-audit

Sensitive data re-accumulates (meeting transcripts, enrichment, candid
writes); one clean pass is a snapshot, not a state. Schedule a monthly re-audit
(weekly for high-ingest brains) that re-runs Phases 1, 2 and 4 report-only
(scan and flag, no edits) for human review. Wire it per
[conventions/cron-via-minions.md](../conventions/cron-via-minions.md) (`gbrain jobs submit`;
`skills/cron-scheduler/SKILL.md`, `skills/minion-orchestrator/SKILL.md`). A
human or a gated follow-up run does the removal.

## Scaling Notes

- **< 20 files:** process sequentially in one pass
- **20-50 files:** 2-3 parallel subagents
- **50-150 files:** 8-12 parallel subagents, batches of 10-15
- **150+ files:** scripted pattern removal for the rote cases only
  (frontmatter fields, phone numbers — machine-emitted shapes, per
  regex-discipline) + subagents for everything needing judgment

## Edge Cases

- **Founders vs. employees:** founder/exec pages often carry the most
  sensitive content (board dynamics, investor relationships, assessments of
  their own team). These need the most careful review.
- **Meeting notes:** meeting pages referencing employee performance need the
  same treatment as people pages — they are in scope, not an afterthought.
- **Cross-references:** `gbrain check-backlinks check` plus a grep for the
  removed section titles across meetings, companies and dailies.
- **Aliases and nicknames:** grep for the person's short name and initials,
  not just the slug — candid content rarely uses full names.

## Dedup (sharp boundaries)

- **[data-loss-gate](../data-loss-gate/SKILL.md)** supplies the card and the
  explicit-yes rule; this skill calls it at Phase 3 and Phase 5. A standalone
  "delete/purge/clean up X" routes there; the personal→team WORKFLOW routes here.
- **[publish](../publish/SKILL.md)** shares ONE page as encrypted HTML ("share
  this page"); "share my brain with the team" routes here.
- **[maintain](../maintain/SKILL.md)** checks the brain is HEALTHY; this skill
  checks it is SAFE TO SHARE.
- **frontmatter-guard (host-side)** validates frontmatter SHAPE; run it after a
  large pass to confirm the stripped frontmatter still parses.

## Contract

This skill guarantees:

- Both destructive steps, Phase 3 (bulk strip + take/fact removal) and Phase 5
  (history purge + force-push), fire the data-loss-gate card and wait for a
  typed "yes"/"do it". Nothing in the runtime blocks a skipped gate, so
  skipping it is this skill's cardinal violation.
- Phase 3 sanitizes a STAGING COPY by default; in-place edits are only for
  re-auditing an existing shared brain.
- The history purge runs only on the SHARED repo in a work dir, never
  `sync.repo_path`, after a verified mirror-clone backup and before the
  force-push a restore-completeness check. Its filter list and restore set are
  the complete sanitized scope.
- The scan covers people, meetings, dailies, companies, projects, analysis,
  takes, facts and back-links; the export ships only scanned directories,
  verified (Phase 4 greps + retrieval) before the first push.
- Sensitive fact rows are deleted from the Facts fence and, in place,
  re-synced and reconciled (verified with `gbrain recall --grep`); `forget`
  never certifies clean.
- Every strip decision is a per-file judgment on a full read; grep only
  triages and verifies.
- Deletions are logged under `## Data Deletions` in the PERSONAL brain's
  `daily/notes/YYYY-MM-DD.md` (or a local ops log), never the shared repo,
  with the backup path as the recovery line.
- The team brain is stamped `brain.audience=shared` at handoff, so it never
  gets the personal writeback consent nudge.
- Routing matches the frontmatter triggers; output stays under `writes_to:`;
  no real names, fork-specific paths or upstream-fork references.

## Output Format

Three artifacts:

1. **The sanitization report** (every run, including report-only re-audits):

```markdown
## Brainify Report — YYYY-MM-DD

- Scope: [N files scanned across people/, meetings/, daily/, ...]
- Flagged: [M files with hits] (triage list attached)
- Edited: [K files sanitized; T takes removed; F fact rows removed + re-synced + facts index reconciled]
- Verification: [grep residuals: 0 confirmed-sensitive; retrieval checks: clean]
- History: [not purged | fresh-export | purged after confirmed gate — backup at <path>]
- Next re-audit: [date / cron slot]
```

2. **The confirmation card** (Phases 3 and 5) — the pre-filled fenced card,
   presented before the bulk destructive edits (Phase 3) and before any history
   rewrite (Phase 5); the turn stops until the user answers.
3. **The deletion log entry** (post-purge only) — appended to the PERSONAL
   brain's `daily/notes/YYYY-MM-DD.md` (never the shared repo) per
   data-loss-gate Step 4.

## When it fails

Follow the [agent operator protocol](../conventions/agent-operator-protocol.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- A bulk redaction or delete needs the data-loss-gate card; if the CLI exits 3 or asks for confirmation, stop and show the user the recoverability card first.
- The retrieval-first scope scan is empty with a degraded notice: keyword-only search under-counts sensitive pages. Keep the structural pass and tell the user the scan was keyword-only.
- `forget` / `put_page` returns `write_pending` (exit 10): poll `gbrain write-request <request_id>`; do not report a page sanitized until its receipt commits.

## Anti-Patterns

- ❌ Scanning only `people/`, or purging history for a subset of the sanitized
  paths
- ❌ Calling clean working-tree files done: history keeps every version
- ❌ Exporting the whole repo: nothing unscanned ships
- ❌ Using `gbrain forget` as sanitization: delete the fence row and re-sync
- ❌ `git filter-repo` / force-push without the verified mirror backup and the
  typed confirmation, or in `sync.repo_path`
- ❌ Stripping the personal brain in place to stand up a NEW team brain
- ❌ Bulk edits or take/fact removal without the Phase 3 card
- ❌ Writing the deletion log into the shared repo
- ❌ Letting grep judge sensitivity, or tightening patterns to kill false
  positives: confirm each hit by reading
- ❌ Removing the attribution but keeping the take: remove the whole row
- ❌ Bulk-editing 150 files without a 3-5 file test first

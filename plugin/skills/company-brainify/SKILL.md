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

The scope list is also the export list. On the staging path only its files
inside the six scanned folders are copied, read and shipped, so a file Phase 1
doesn't find never reaches the team.

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
  # The export list: scope-list files inside the six scanned folders and
  # nothing else. It sits beside $STAGING, not in it, so it never ships.
  grep -E '^(people|meetings|daily|companies|projects|analysis)/' /tmp/brainify-scope.txt \
    | LC_ALL=C sort -u > "$STAGING.export-list"
  rsync -a --files-from="$STAGING.export-list" ./ "$STAGING/"
  cd "$STAGING"   # all edits below happen here, not in sync.repo_path
  ```

  Copy only the export list, never whole folders: only its files get the
  per-file read below. On a personal brain, `people/` and `daily/` also hold
  family, friends and private days that no retrieval or keyword hit flags, so
  a folder copy ships pages nobody read. To ship another file, append its path
  to `$STAGING.export-list`, copy it in the same way, and give it the full
  read and the Phase 4 checks.

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
subagents. Per file, for every file on the export list (zero-hit files
included: the export ships exactly that list):

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

# Phone numbers (every scanned folder, US and international shapes)
grep -rn -E '\+[0-9][0-9 ().-]{7,}[0-9]|\(?[0-9]{3}\)?[ .-][0-9]{3}[-. ][0-9]{4}' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null

# Email addresses outside the company's work domain (replace acme-example.com)
grep -rn -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null | grep -v -i '@acme-example\.com$'

# Home addresses, family, medical, legal and personal-life details
grep -rin -E 'home address|[0-9]+ [A-Za-z]+ (street|st|avenue|ave|road|rd|lane|ln|drive|dr|blvd)([ ,.]|$)|apt [0-9]|wife|husband|girlfriend|boyfriend|kids|daughter|son is|pregnan|divorce|diagnos|medical|therap|surgery|hospital|illness|rehab|lawsuit|custody|arrest' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null

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
gbrain query "family, health, home address or personal life" --limit 10
```

Every one of these must come back empty or with only keep-category content.

### Phase 5: Commit and purge history — GATED

Clean files aren't enough if the repo has history: old commits still contain
the sensitive versions.

**Step 0 — preferred alternative (non-destructive).** When standing up a NEW
team repo, skip history rewriting entirely: the sanitized STAGING tree from
Phase 3 becomes a fresh repo with fresh history. The personal repo keeps its
full history AND its full working tree, untouched.

**Export rule: nothing unread ships.** Phase 3 copied ONLY the export list
into `$STAGING` and gave every file on it the per-file read, and the commit
below refuses any file that is not on that list. Never
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
git add -A  # gbrain-allow-shared-tree-git: first commit of a fresh single-writer export repo holding only the export list
# Refuse anything staged that is not on the export list: it got no read.
[ -s "$STAGING.export-list" ] || { echo "no export list at $STAGING.export-list — ABORT"; exit 1; }
unread=$(git -c core.quotePath=false diff --cached --name-only | LC_ALL=C sort | LC_ALL=C comm -23 - "$STAGING.export-list")
[ -z "$unread" ] || { echo "not on the export list, never read: $unread — ABORT"; exit 1; }
git commit -m "Initial import — sanitized team brain"
git remote add origin <TEAM_REPO_URL>
gbrain git commit-push --push-only
```

The first commit is plain git because `$STAGING` is a brand-new repo only
this run writes. `gbrain git commit-push --push-only` pushes to `origin/main`
and fails loudly if the push does not land. On a non-zero exit, stop and relay
the error: usually `git_push_unavailable` (fix the URL or credentials, rerun),
or a team repo that already has commits (this export needs an empty one; ask
the user). Never force-push it.

**Existing shared repo with sensitive history: follow
[HISTORY-PURGE.md](HISTORY-PURGE.md), read whole before its Step 1.** Only
then do you purge. It commits the clean tree, records every remote branch and
tag, takes a mirror backup, presents the data-loss-gate card (refs, leases,
risk) and waits for a typed "yes", then rewrites history and pushes every
branch and tag in one atomic push, each leased to its Step 1 sha. Never
improvise it.

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
  the complete sanitized scope. It pushes every branch and tag the remote held
  at Step 1 in one atomic push, each with a lease on its recorded sha, and
  the card lists those refs.
- The scan covers people, meetings, dailies, companies, projects, analysis,
  takes, facts and back-links; the export ships only the export list (the
  scope-list files in those folders, each given the per-file read), verified
  (Phase 4 greps + retrieval) before the first push.
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
- ❌ Exporting the whole repo, or whole folders: only files that got the
  per-file read ship
- ❌ A force push without a lease on the sha recorded in Step 1, or a purge
  that pushes main and leaves other branches and tags on the old history
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

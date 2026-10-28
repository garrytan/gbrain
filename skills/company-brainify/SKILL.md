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
---

# company-brainify — Personal → Team-Brain Sanitization

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) —
> discovery runs through the brain's own retrieval, not filesystem guesswork.
> The grep pipelines below TRIAGE; `gbrain query` finds what keyword patterns miss.
>
> **Convention:** see [conventions/test-before-bulk.md](../conventions/test-before-bulk.md) —
> sanitize 3-5 files, read the output yourself, then ramp. A bad bulk
> sanitization pass is worse than none: it looks done and isn't.
>
> **Convention:** see [conventions/regex-discipline.md](../conventions/regex-discipline.md) —
> "is this sensitive?" is a judgment call, so the model decides per file. The
> grep patterns are earned triage/verification tools, never the judge.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> edits stay in the page's existing directory; the deletion log files
> date-keyed under `daily/`.

A personal brain holds candid notes (ratings, comp, assessments, retention,
politics) that must not reach a shared team brain. Three surfaces carry them:
page files, takes/facts, and git history. Clean files alone are not enough.

## When to Use

Standing up a team brain from a founder's or exec's personal brain; auditing an
existing shared brain (report-only or with edits); verifying a repo before
onboarding; periodic hygiene.

Not for connecting or indexing an existing company repo: that is no
sanitization. On the trusted brain host run
`gbrain sources inspect <path> --profile company-brain` and follow
`docs/guides/company-brain-ingestion.md`; never strip metadata or purge history
just to make a repo searchable.

## What Gets Removed

**Always strip:** rating/score fields (`score:`, `rating:`, `skill:`, any
`*_score:`, any numeric rating of a person); compensation (salary, equity,
carry, grants, comp changes, retention packages); performance assessments
(weaknesses, "at risk", underperformance, "picking up slack"); departure and
retention talk; management strategy about a person; political dynamics; personal
PII (phone, personal email, home address, family, medical, personal legal or
life details); and every take or fact row about any of these.

**Always keep:** name, role, title, work email, LinkedIn; what they build;
career arc and education; professional beliefs; factual timeline of work
(attendance, milestones, launches); skills and expertise.

**Scan scope:** `people/`, `meetings/`, `daily/`, `companies/`, `projects/`,
`analysis/`, takes (`gbrain takes search`), facts (`gbrain recall --grep`), and
back-links (`gbrain check-backlinks check`). A people-only pass certifies a brain
that still leaks.

## Procedure

```bash
BRAIN="$(gbrain config get sync.repo_path)"
cd "$BRAIN"
```

On a repo-less brain (no `sync.repo_path`) run Phase 1's retrieval and Phase 4's
retrieval checks only, and edit pages through `gbrain get` / `gbrain put`.

### Phase 1: Scope (retrieval first)

```bash
gbrain query "compensation, equity, or salary discussions about team members" --limit 50
gbrain query "performance concerns, underperformance, or who is struggling" --limit 50
gbrain query "considering leaving, retention conversations, departure rumors" --limit 50
gbrain takes search "performance" --limit 50
gbrain recall --grep "salary"
```

Write every hit's repo-relative path to `/tmp/brainify-scope.txt`, then APPEND
the structural pass (never truncate the file):

```bash
grep -rli 'company: *"acme-example"' people/ --include="*.md" | sort >> /tmp/brainify-scope.txt
grep -rli -E 'salary|equity|carry|retention|underperform|performance review|hard conversation' \
  meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null >> /tmp/brainify-scope.txt
sort -u -o /tmp/brainify-scope.txt /tmp/brainify-scope.txt
```

Cross-check the company's public team page for people filed under other
conventions.

### Phase 2: Triage

```bash
while read -r f; do
  hits=$(grep -c -i -E 'carry|salary|equity|comp change|departure|considering leaving|retention|underperform|picking up slack|performance review|management risk|hard conversation|nervou|score: *[0-9]|firing|fired|pip|probation|weakness' "$f" 2>/dev/null || true)
  [ "${hits:-0}" -gt 0 ] && echo "$hits $f"
done < /tmp/brainify-scope.txt | sort -rn > /tmp/brainify-triage.txt
```

High-hit files first. Every scoped file is still read in full: grep triages,
the model judges.

### Phase 3: Sanitize (destructive — gated)

**Target.** New team brain (default): copy ONLY the scanned directories into a
durable staging dir and edit there, leaving the personal brain's working tree
untouched. Re-auditing an existing shared brain: edit the shared repo in place,
never the personal `sync.repo_path`.

```bash
STAGING="$HOME/.gbrain/backups/brainify-staging-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$STAGING" && chmod 700 "$STAGING"
for d in people meetings daily companies projects analysis; do
  [ -d "$d" ] && rsync -a "$d/" "$STAGING/$d/"
done
cd "$STAGING"
```

**Before the bulk edits, present the [data-loss-gate](../data-loss-gate/SKILL.md)
card and stop until the user types "yes" or "do it"** ("ok", "sure" are not
consent):

```
⚠️ DATA DELETION — Confirmation Required

What: strip sensitive content, remove takes, and delete fact rows across
      [N files] in [STAGING COPY at <path>  |  the SHARED brain in place]
Count: [N files edited; T takes removed; F fact rows removed]
Location: [staging path OR shared repo path] — NOT the personal sync.repo_path

Why: preparing a sanitized tree for team access

Recoverable?
- [x] Personal brain untouched (staging-copy path) — re-copy to redo
- [ ] In-place shared-brain path: edits overwrite the live tree; git history is
      the recovery line until Phase 5 purges it

Proceed? (yes/no)
```

Then 3–5 files first, read the results, ramp (50+ files: batches of 10–12 in
parallel subagents). Per file: read it completely; delete rating and comp
frontmatter lines; remove whole sensitive sections; remove whole take and fact
rows that touch a strip category (the claim is the leak — never keep the row
minus its attribution); edit inline mentions surgically (`Edit` for a few spots,
`Write` only when content is interwoven throughout).

**`gbrain forget` is not removal.** It expires a fact (struck through, still
served with `--include-expired`). Delete the row from the page's Facts fence.
In place on a shared brain, then run `gbrain sync`, reconcile the facts index
(`gbrain sweep`; sync alone does not re-extract facts), and confirm with
`gbrain recall --grep` that the row is gone. On the staging copy, editing the
markdown is enough. Either way finish with `gbrain check-backlinks check`.

### Phase 4: Verify the tree that ships

Run against the staging tree (staging path) or the shared repo (in place) —
never the personal tree. Re-run the triage (hits should drop to near zero),
then:

```bash
grep -rn -E '^[a-z_]*(score|rating|skill)[a-z_]*: *[0-9]' people/ --include="*.md"
grep -rn -E '\+1[0-9]{10}|\([0-9]{3}\) [0-9]{3}-[0-9]{4}' people/ --include="*.md"
grep -rin -E 'carry|comp change|equity|salary' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null
grep -rin -E 'considering leaving|departure rumor|underperform|picking up slack|hard conversation' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null
```

Confirm each remaining hit by reading it; never tighten a pattern to silence
false positives. Then the retrieval the team will use (add
`--source <team-source-id>` when mounted beside personal content); each must
return nothing or only keep-category content:

```bash
gbrain query "what is alice-example's compensation" --limit 10
gbrain query "who is underperforming or at risk of leaving" --limit 10
gbrain takes search "weakness" --limit 20
```

### Phase 5: Ship

**Fresh team repo (preferred, non-destructive).** The verified staging tree
becomes a new repo with fresh history. Ship only scanned directories: if
anything else is there (`conversations/`, `originals/`, `sources/`, `inbox/`),
remove it or scan it through Phases 1–4 first.

```bash
cd "$STAGING"
git init -b main
git add -A && git commit -m "Initial import — sanitized team brain"  # gbrain-allow-shared-tree-git: first commit of a fresh single-writer export repo
git remote add origin <TEAM_REPO_URL>
gbrain git commit-push --push-only
```

On a non-zero exit stop and relay the error (`git_push_unavailable`: fix URL or
credentials and rerun; a non-empty team repo: ask the user). Never force-push.

**Existing shared repo with sensitive history:** follow
[references/history-purge.md](references/history-purge.md). Its rules hold
even before you read it: purge only the SHARED repo cloned to a work dir, never
`sync.repo_path`; verify a mirror-clone backup, then show its data-loss-gate
card and wait for a typed yes before `git filter-repo` or any force-push.

**Handoff:** run `gbrain config set brain.audience shared` against the TEAM
brain (never the personal one). Team members who init the shared brain before
that stamp exists prefix that one command with `GBRAIN_NO_ONBOARD_NUDGE=1`.

### Phase 6: Re-audit

Schedule a monthly re-audit (weekly for high-ingest brains) that runs Phases
1, 2 and 4 report-only and surfaces hits for a human, wired per
[conventions/cron-via-minions.md](../conventions/cron-via-minions.md)
(`gbrain jobs submit`).

Edge cases: founder/exec pages carry the most; meeting notes are full scope;
grep for nicknames and initials, not just slugs. Neighbors:
[data-loss-gate](../data-loss-gate/SKILL.md) owns a bare "delete X";
[publish](../publish/SKILL.md) shares one page; [maintain](../maintain/SKILL.md)
checks health, not shareability.

## Contract

This skill guarantees:

- Both destructive steps — Phase 3 bulk edits and the Phase 5 history purge —
  show the data-loss-gate card and wait for a typed "yes"/"do it"; nothing at
  runtime blocks a skipped gate, so skipping it is the cardinal violation.
- Phase 3 sanitizes a staging copy by default, leaving the personal brain's
  working tree untouched; its history is never rewritten.
- The scan covers the full scope; every strip decision is a model judgment on a
  full read; verification runs on the tree that ships, before any push.
- Nothing unscanned ships; sensitive fact rows are deleted and the facts index
  reconciled, never merely expired with `forget`.
- A purge runs only on the shared repo, after a verified mirror backup, with the
  filter list and restore manifest covering every sanitized path, and is logged
  to the PERSONAL brain only.
- The team brain is stamped `brain.audience=shared` at handoff.
- Routing matches the frontmatter triggers; edits stay in `writes_to`
  directories; no real names or fork-specific paths.

## Output Format

```markdown
## Brainify Report — YYYY-MM-DD

- Scope: [N files scanned across people/, meetings/, daily/, ...]
- Flagged: [M files with hits] (triage list attached)
- Edited: [K files sanitized; T takes removed; F fact rows removed + re-synced + facts index reconciled]
- Verification: [grep residuals: 0 confirmed-sensitive; retrieval checks: clean]
- History: [not purged | fresh-export | purged after confirmed gate — backup at <path>]
- Next re-audit: [date / cron slot]
```

Plus the confirmation card before each destructive step (the turn stops there)
and the deletion log entry (post-purge only), appended to the PERSONAL brain's
`daily/notes/YYYY-MM-DD.md` (never the shared repo) per data-loss-gate Step 4.

## When it fails

Follow the [agent operator protocol](../conventions/agent-operator-protocol.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- A bulk redaction or delete needs the data-loss-gate card; if the CLI exits 3 or asks for confirmation, stop and show the user the recoverability card first.
- The retrieval-first scope scan is empty with a degraded notice: keyword-only search under-counts sensitive pages. Keep the structural pass and tell the user the scan was keyword-only.
- `forget` / `put_page` returns `write_pending` (exit 10): poll `gbrain write-request <request_id>`; do not report a page sanitized until its receipt commits.

## Anti-Patterns

- ❌ Scanning only `people/`, or certifying the personal tree instead of the one that ships
- ❌ Stripping the personal brain in place for a new team brain
- ❌ Any destructive step before the typed confirmation
- ❌ `gbrain forget` as sanitization, or removing a take's attribution but keeping its claim
- ❌ Exporting the whole repo — unscanned directories never ship
- ❌ `git filter-repo` or force-push in `sync.repo_path`, without a verified backup, or on a subset of the sanitized paths
- ❌ Writing the deletion log into the shared repo
- ❌ Treating grep as the judge, or bulk-editing without a 3–5 file test

## References

- Purging sensitive history from an existing shared repo → [references/history-purge.md](references/history-purge.md)

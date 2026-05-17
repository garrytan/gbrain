---
name: orphan-reducer
version: 1.0.0
description: |
  Classify vector-similar pages against each orphan page via Haiku 4.5
  and add typed inbound references (link_type="related", relation encoded
  in context). Goal: chip away at the 1803/1952 orphan pile (v1 wiki flat
  import) across multiple sweep runs. Default is --dry-run; --apply does
  DB link inserts + markdown sentinel upsert on candidate pages that
  exist on disk, then commits ~/brain changes.
triggers:
  - "orphan reducer"
  - "reduce orphans"
  - "fix orphan pages"
tools:
  - list_pages
  - get_page
  - link
  - query
mutating: true
---

# orphan-reducer

Chip at the orphan pile (`gbrain orphans --count` is currently ~1800 on
1952 pages, mostly v1-wiki legacy). Pipeline:

1. `gbrain orphans`-shaped SQL → list candidate orphans (pseudo/auto
   pages excluded).
2. For each orphan: pgvector cosine-distance top-K from `content_chunks`.
3. Haiku 4.5 single-shot classifier: each candidate gets
   `supplements|contrasts|implements|extends|none` + confidence + excerpt.
4. Keep non-`none` above `--min-confidence`, cap at `--per-orphan`.
5. Dry-run: report to `~/brain/.agent/reports/orphan-reducer-<ISO>.md` +
   JSON sidecar. No writes.
6. Apply: per kept edge, `gbrain link <cand> <orphan> --link-type related
   --context "<relation>: <excerpt>"` + if `~/brain/<cand>.md` exists,
   upsert sentinel block `<!-- orphan-reducer-inbound -->...<!-- /... -->`
   at EOF. Final `git -C ~/brain commit`.

## When to run

- **Manually, weekly cadence** until orphans stabilize (<500). Each sweep
  is bounded (`--limit 100` default, `--per-orphan 3`).
- **Never in dream cron** (notion-poller retired 2026-05-17). PGLite
  single-writer constraint: orphan-reducer's concurrent reads are fine
  but writes should be sequenced. (Note: production is Postgres since
  Path 3 cutover 2026-04-29, but the constraint mindset still applies
  for any PGLite contract test runs.)
- **Budget-aware.** `--limit 100` ≈ 100 Haiku calls ≈ $0.08. `--limit > 500`
  requires `--i-know` to protect against Haiku-budget footguns.

## Prerequisites

- `ANTHROPIC_API_KEY` in env (Haiku classifier, required for both
  dry-run and --apply).
- `gbrain` CLI reachable on PATH (the writer shells out for DB link
  writes).
- `~/brain/` must be a git repo if `--apply` without `--no-commit`.

## Usage

```bash
# Dry-run 5 orphans (smoke)
bun run skills/kos-jarvis/orphan-reducer/run.ts --limit 5 --dry-run

# Dry-run a specific domain, 20 candidates per orphan (cheap scan)
bun run skills/kos-jarvis/orphan-reducer/run.ts --domain companies --limit 30 --dry-run

# Apply with default 100-orphan cap
bun run skills/kos-jarvis/orphan-reducer/run.ts --limit 100 --apply
```

Flags: see `bun run skills/kos-jarvis/orphan-reducer/run.ts --help`.

## Acceptance

Per run:
- Report lands at `~/brain/.agent/reports/orphan-reducer-<ISO>.md` with a
  JSON sidecar (rollback manifest).
- Dry-run makes zero DB or filesystem changes.
- `--apply` moves `gbrain orphans --count` down by approximately
  `edges_kept` (exact delta depends on how many orphans got ≥1 inbound).
- `git -C ~/brain log -1` shows the `chore(orphan-reducer): ...` commit
  when markdown files were actually touched (mostly notion-source
  candidates today, since most v1-wiki candidates are DB-only).

Over multiple runs:
- `gbrain doctor` → brain_score orphans component rises from 2/15.
- Manual spot-check (at least 80% of kept relations are plausible on
  eyeball review — sample 20 from the report).

## Rollback

The JSON sidecar is the rollback manifest. For each `writes[]` entry:

```bash
gbrain unlink <tuple.from> <tuple.to>
# markdown: git -C ~/brain revert <summary.git.sha>  (all-or-nothing)
```

Partial rollback of a single edge's markdown block requires manual
editing inside the `<!-- orphan-reducer-inbound -->` sentinel range in
the candidate's `.md` file.

## Known limits

- **DB-only fallback when `~/brain/<cand>.md` is missing.** ~95% of
  candidates today (v1-wiki imports) are PGLite-only. The sidecar
  records `markdown_reason: "no_file"` so a future filesystem-mirror
  export can backfill.
- **Per-run is bounded, soak is long.** 1800 orphans / 100-per-run / ≤3
  kept each = order of 10-15 runs to saturate (orphans don't monotonically
  decrease — weak edges raise orphans' score but don't zero them all).
- **`related` is the only `link_type`.** Relation taxonomy lives in the
  `context` field; no `gbrain graph --relation` filter support today.

---
name: frontmatter-ref-fix
version: 2.0.0
description: |
  Normalize relative-path `*.md` references inside KOS page frontmatter
  (`related:`, `source_refs:`, etc.) into canonical slug form. v1-wiki
  legacy left ~220 refs in `../X/Y.md` shape across the brain; gbrain's
  link-extraction DIR_PATTERN doesn't accept `sources/` (plural) so
  frontmatter refs to source pages all silently fail to resolve. v2
  adds: (1) EXTERNAL_POINTER_KEYS allowlist for fields that legitimately
  point at brain-external paths (e.g. `raw_path:`); (2) bare-slug fuzzy
  resolve via basename index; (3) optional deletion of brain-external
  refs (`../../X.md`) and dead links (`X/Y.md` with missing target).
triggers:
  - "frontmatter ref fix"
  - "fix dangling refs"
  - "normalize frontmatter refs"
tools:
  - list_pages
mutating: true
---

# frontmatter-ref-fix

One-shot rewrite skill for v1-wiki legacy frontmatter refs.

## Why

`gbrain extract --include-frontmatter` flagged 14 unresolved refs after
the v0.20.4 sync. Closer inspection (v1 sweep on 2026-04-27): the brain
actually carries 220 `../X/Y.md`-style refs in frontmatter lists across
comparisons / decisions / concepts / projects / sources / syntheses /
entities / protocols pages. The format trips four failure modes:

1. **`sources/` plural not in `DIR_PATTERN`** (link-extraction.ts:47
   accepts singular `source` only) — ~80 refs to source pages drop on
   the floor at extract time.
2. **Bare-slug v1 sibling refs** — `harness-engineering.md` (no dir
   prefix) was valid in the v1 wiki where every page lived in one
   directory. v2 brain uses MECE dirs (`concepts/`, `syntheses/`, ...);
   the bare slug needs to be promoted to its full canonical form.
3. **Targets that genuinely don't exist** — `../sources/2026-04-13-
   alchainhust-darwin-skill-release.md` has no corresponding file in
   the brain. v1 migration legacy. Real dead links.
4. **Brain-external refs** — `../../SCHEMA.md`, `../../meta/lint-rules.md`,
   `../../raw/repo/X/content.md`. Either v1 wiki ancestors that didn't
   migrate, or raw-snapshot links that should live under `raw_path:`.

Cosmetic by themselves (graph dead-ends don't break queries), but they
inflate `dangling_refs` warnings and lower link-coverage. Fix is
deterministic and one-shot: classify each ref, rewrite resolvable ones,
delete brain-external + dead refs (opt-in), report the rest.

## Pipeline

1. Walk `~/brain/**/*.md` (excluding `.agent/`, `.git/`).
2. Build two indexes:
   - **slug index** — every page's path-without-`.md` (e.g.
     `concepts/harness-engineering`).
   - **basename index** — basename-without-`.md` → full slug, with
     `null` sentinel for ambiguous basenames.
3. For each file: extract the leading `--- ... ---` frontmatter block,
   scan it line-by-line for refs ending in `.md`. For each match,
   classify into one of seven categories:

   | Category | Meaning | Action |
   |---|---|---|
   | `resolved` | exact slug match | rewrite |
   | `fuzzy_resolved` | bare-slug, unique basename hit | rewrite |
   | `external_key_skipped` | value under `raw_path:` (or other allowlisted key) | leave alone |
   | `external_path` | 2+ leading `../` segments — escapes brain root | optional delete |
   | `dead` | path-shaped slug, target missing | optional delete |
   | `bare_ambiguous` | bare-slug, multiple basename hits | report only |
   | `bare_unresolved` | bare-slug, no basename hit at all | report only |

4. **Apply** mode writes resolved + fuzzy_resolved rewrites in-place
   (preserves quote style, list indentation, field order — no yaml
   re-serialization). With `--delete-external` / `--delete-dead`,
   matching lines are spliced out of the frontmatter array.
5. Single git commit at the end with a structured message describing
   how many were normalized / fuzzy-resolved / deleted.

## Usage

```bash
# Dry-run (default) — preview classification + rewrites + deletions
bun run skills/kos-jarvis/frontmatter-ref-fix/run.ts --dry-run

# Apply rewrites only (resolved + fuzzy_resolved)
bun run skills/kos-jarvis/frontmatter-ref-fix/run.ts --apply

# Apply rewrites + delete brain-external + dead refs (full sweep)
bun run skills/kos-jarvis/frontmatter-ref-fix/run.ts --apply --delete-all

# Disable fuzzy resolve (v1 behavior, conservative)
bun run skills/kos-jarvis/frontmatter-ref-fix/run.ts --apply --no-fuzzy
```

Flags:
- `--dry-run` (default) — no writes
- `--apply` — write changes + git commit
- `--no-commit` — apply without committing
- `--fuzzy` (default on) — bare-slug basename resolve
- `--no-fuzzy` — disable fuzzy resolve (only exact slug matches)
- `--delete-external` — splice brain-external (`../../X`) lines
- `--delete-dead` — splice dead-link (path-shape with missing target) lines
- `--delete-all` — shorthand for both delete flags
- `--brain-dir DIR` — override brain location (default `~/brain`)
- `--json` — JSONL events to stdout
- `--help`, `-h`

## Acceptance

- Report lands at `~/brain/.agent/reports/frontmatter-ref-fix-<ISO>.md`
  with per-category sections (resolved, fuzzy_resolved, external_path,
  dead, bare_ambiguous, bare_unresolved, external_key_skipped).
- After `--apply --delete-all`, a follow-up dry-run reports zero
  resolved / fuzzy_resolved / external_path / dead / bare_*; only
  `external_key_skipped` (legitimate `raw_path:` field values) remains.
- Idempotent: a second run with no fresh v1-imports rewrites zero
  refs and reports zero unresolved targets (modulo `external_key_skipped`).

## Out of scope

- **Markdown body links** — `[text](../X/Y.md)` style links inside the
  `# ...` body are NOT rewritten. They render fine in any markdown
  viewer; only frontmatter consumers (gbrain extract) trip on them.
  A second skill could handle body refs, but it's a separate problem
  with different risk (might break rendered docs).
- **YAML re-serialization** — we use line-level regex replacement
  rather than yaml.parse + yaml.stringify because re-serializing
  rewrites field order, quote style, and list indentation, producing a
  large unrelated diff. Single-line surgical rewrites preserve the
  notion-poller's emit format.
- **Path-prefix fuzzy resolve** — refs of shape `knowledge/wiki/sources/X.md`
  (full v1-wiki path with leading dirs) are not basename-matched against
  the brain because the slug contains `/`. Such refs are classified as
  `dead` and (with `--delete-dead`) spliced out. A future v3 could
  basename-fuzzy these too, but the risk of false positives goes up
  the further you walk back from the leaf.
- **Free-text scalars without `.md` suffix** — `source: substack` etc.
  are not touched (no `.md` suffix means the skill never sees them).

## EXTERNAL_POINTER_KEYS

Currently allowlisted: `raw_path`. Add new keys to the constant in
`run.ts` only when the key's value is *always* a brain-external pointer.
Be conservative: an over-broad allowlist will silently swallow real
refs.

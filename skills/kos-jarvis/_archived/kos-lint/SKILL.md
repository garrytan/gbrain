---
name: kos-lint
version: 1.0.0
description: |
  Six-check lint pass ported from KOS v1 lint-light.sh + staleness-check.sh.
  Extends GBrain's `maintain` with checks specific to KOS quality rules
  (frontmatter required fields, duplicate KOS ids, weak-link detection with
  type annotations, evidence coverage gaps). Runs standalone or chained by
  kos-patrol.
triggers:
  - "kos lint"
  - "light lint"
  - "check page quality"
tools:
  - list_pages
  - get_page
  - backlinks
  - search
mutating: false
---

# KOS Lint Skill

Port of KOS v1 `knowledge/scripts/lint/lint-light.sh`.

## Six checks

| # | Check | Severity |
|---|-------|----------|
| 1 | Frontmatter required fields: `id`, `kind`, `status`, `created`, `updated` | ERROR |
| 2 | Duplicate `id` across pages | ERROR |
| 3 | Dead internal links (markdown links pointing to missing pages) | ERROR |
| 4 | Orphans (pages with zero backlinks AND not in any index/category README) | WARN |
| 5 | Weak links (Related section has >5 links OR link lacks type annotation) | WARN |
| 6 | Evidence gap (kind requires Ex but no inline or frontmatter evidence tag) | WARN |

Check 1-3 block `gbrain sync --install-cron`. Check 4-6 surface in the
weekly patrol report.

## Implementation

Delegates to `run.ts` which wraps gbrain CLI:
- `gbrain list --json` for page enumeration
- `gbrain get <slug>` for content
- `gbrain backlinks <slug>` for link graph

```bash
bun run skills/kos-jarvis/kos-lint/run.ts          # full run, text report
bun run skills/kos-jarvis/kos-lint/run.ts --json   # machine output
bun run skills/kos-jarvis/kos-lint/run.ts --check 3 # single check
```

Exit code `0` if clean, `1` if any ERROR, `2` if only WARN.

## Chaining

- Called by `kos-patrol` as part of daily sweep
- Called implicitly by `dikw-compile` in "dry-run" mode before accepting a compile result
- `gbrain autopilot` can wire this as a step if user opts in

## Output format

```
=== kos-lint @ 2026-04-16 ===
[1] Frontmatter:     85/85 OK
[2] Duplicate ids:   0 found
[3] Dead links:      2 found
    - people/alex-rivera.md → concepts/missing-page.md
    - sources/foo.md → ../baz.md
[4] Orphans:         3 found (see --json for list)
[5] Weak links:      4 pages exceed link budget
[6] Evidence gaps:   7 pages with kind requiring Ex but no tag

Summary: 2 ERROR, 14 WARN
Exit: 1
```

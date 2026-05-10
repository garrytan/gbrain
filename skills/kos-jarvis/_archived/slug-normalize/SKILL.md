---
name: slug-normalize
description: One-shot slug normalization for KOS-v2 — fixes 7 root-level stray pages by adding the missing `kind/` prefix (`ai-jarvis` → `concepts/ai-jarvis`, 6 URL-slug sources → `sources/<slug>`). Preserves `frontmatter.id`, updates 1 intra-brain compiled_truth reference. Part of Step 1.5 of the filesystem-canonical migration track.
---

## Purpose

The 7 stray pages arrived via early-day `kos-compat-api /ingest` calls
before the `slug: <kind>/<topic>` convention was enforced. They break
the export tree's directory hygiene and would cause mis-filing once
filesystem-canonical lands. Fix: add the missing prefix while preserving
`page_id`, chunks, embeddings, and links (upstream's `updateSlug` strategy).

## Scope (7 renames + 1 body-link update)

| Old slug | New slug | id (unchanged) |
|---|---|---|
| `ai-jarvis` | `concepts/ai-jarvis` | `concept-ai-jarvis` |
| `github-com-aloshdenny-reverse-synthid` | `sources/github-com-aloshdenny-reverse-synthid` | `source-github-com-aloshdenny-reverse-synthid` |
| `arxiv-org-abs-2604-15034` | `sources/arxiv-org-abs-2604-15034` | `source-arxiv-org-abs-2604-15034` |
| `x-com-omarsar0-status-2045241905227915498` | `sources/x-com-omarsar0-status-2045241905227915498` | `source-x-com-omarsar0-status-2045241905227915498` |
| `colossus-com-article-inside-notion` | `sources/colossus-com-article-inside-notion` | `source-colossus-com-article-inside-notion` |
| `ingest-1776470181089` | `sources/ingest-1776470181089` | `source-ingest-1776470181089` |
| `www-anthropic-com-news-claude-opus-4-5` | `sources/www-anthropic-com-news-claude-opus-4-5` | `source-www-anthropic-com-news-claude-opus-4-5` |

Plus one `compiled_truth` intra-brain reference to `www-anthropic-com-news-claude-opus-4-5.md`
in another page's body (probed empirically before writing this skill).

## Out of scope (explicit non-goals)

- **No `id` frontmatter rewrites.** The 1829-page brain stores
  `frontmatter.id` as plain strings (verified); the `id: >-` block-scalar
  shape only appears in exported markdown because `matter.stringify`
  auto-folds long strings. Deterministic, no churn. Not a data problem.
- **No `[[wikilink]]` rewrites needed for these 7.** DB probe showed 0
  `[[stray-slug]]` references across 1829 `compiled_truth` + `timeline`
  bodies. Only 1 `](stray.md)` markdown link exists (handled).
- **No `related:` frontmatter rewrites needed.** DB probe showed 0
  `related:` entries pointing to any of the 7 strays.

## Why direct SQL (not via BrainEngine)

The write is semantically identical to `engine.updateSlug()` at
`src/core/pglite-engine.ts:988` — one `UPDATE pages SET slug = ...
WHERE slug = ...`. Going through `engineFactory.open()` would:
- invoke BrainWriter lint hooks on every write
- try to acquire a pooled lock overlapping the launchd services we
  carefully disabled before running this skill
- slow a 7-row operation into 7 roundtrip stages

Direct `PGlite.create(file://…)` + `UPDATE` is 10× cleaner and
lock-compatible with our safety protocol.

## Modes

```bash
bun run skills/kos-jarvis/slug-normalize/run.ts --plan
# Prints the 8 intended changes (7 slug renames + 1 body-link) as a JSON
# plan. Makes zero DB writes. Use first to eyeball the change set.

bun run skills/kos-jarvis/slug-normalize/run.ts --apply
# Actually runs the UPDATE statements in a transaction. Writes a report
# to ~/brain/agent/reports/slug-normalize-<date>.md. Exits non-zero if
# any row count is off.

bun run skills/kos-jarvis/slug-normalize/run.ts --verify
# Run after --apply to verify: old slugs absent, new slugs present,
# page count unchanged, md-link rewrite present. Idempotent read-only.
```

## Safety protocol (mandatory before `--apply`)

From `docs/SESSION-HANDOFF-2026-04-23.md` §4. Do NOT skip any step.

```bash
# 1. Hard-disable every DB-writing launchd service (not just unload).
for svc in notion-poller kos-compat-api kos-patrol enrich-sweep kos-deep-lint; do
  launchctl disable user/$UID/com.jarvis.$svc
  launchctl bootout user/$UID/com.jarvis.$svc 2>/dev/null
done
launchctl list | grep jarvis   # only gemini-embed-shim + cloudflared should remain

# 2. Fresh rolling backup (keep exactly one).
ts=$(date +%s)
rm -f ~/.gbrain/brain.pglite.pre-slug-normalize-*   # evict prior
cp -R ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.pre-slug-normalize-$ts

# 3. Verify no live process holding the lock.
lsof ~/.gbrain/brain.pglite 2>/dev/null | head   # should be empty

# 4. Apply.
bun run skills/kos-jarvis/slug-normalize/run.ts --apply

# 5. Verify outcome.
bun run skills/kos-jarvis/slug-normalize/run.ts --verify

# 6. Re-enable services only if verify passed.
for svc in notion-poller kos-compat-api kos-patrol enrich-sweep kos-deep-lint; do
  launchctl enable user/$UID/com.jarvis.$svc
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.jarvis.$svc.plist
done
```

## Rollback

If `--verify` fails or anything looks wrong:

```bash
# Stop services again, swap backup in, restart.
for svc in notion-poller kos-compat-api kos-patrol enrich-sweep kos-deep-lint; do
  launchctl bootout user/$UID/com.jarvis.$svc 2>/dev/null
done
mv ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.failed-$(date +%s)
mv ~/.gbrain/brain.pglite.pre-slug-normalize-* ~/.gbrain/brain.pglite
# then re-enable services as in step 6 above
```

The backup is byte-for-byte identical to the pre-apply state.

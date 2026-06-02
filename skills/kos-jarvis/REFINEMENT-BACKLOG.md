# KOS-Jarvis — KB Refinement Backlog

> **Created 2026-06-01** during the email-corpus enrich-sweep (the full
> `mailagent-emails` Tier-3-only run, `--min-mentions 3`, ~3482 stubs).
> These are quality signals observed *while the sweep was still writing*.
> Lucien's call: do **one batch KB refinement** after the sweep hits
> `ALL DONE`, not per-signal during the run.
>
> **All counts below are mid-run snapshots** (captured ~stub 2300/3482) and
> **grow until completion** — re-run every detection query after `ALL DONE`
> before acting. DB: `postgresql://chenyuanquan@127.0.0.1:5432/gbrain`.
> Sweep writes go to `source_id='mailagent-emails'` (see R1) under
> `people|companies|concepts|projects/` slugs; raw emails are
> `sources/email/*` (NOT stubs — exclude them).

A reusable predicate for "today's new entity stubs":

```sql
-- $STUBS
deleted_at IS NULL
AND source_id='mailagent-emails'
AND created_at::date='2026-06-01'
AND slug ~ '^(people|companies|concepts|projects)/'
```

---

## R1 (HIGH, structural) — All stubs landed in the wrong source

Every new entity stub was written to `source_id='mailagent-emails'`, **not
the main brain `default`**. Entity pages (people/companies/concepts/projects)
conceptually belong in `default`; they are now commingled with the raw email
source pages.

- **Count (mid-run)**: 2291 entity stubs in `mailagent-emails`
  (people 806 / concepts 643 / projects 533 / companies 265). Projects to
  ~3482 at completion.
- **Root cause**: the nohup resume script (`/tmp/enrich-resume.sh`) does
  `export GBRAIN_SOURCE=mailagent-emails` (correct for *reading* the email
  corpus in Phase A), and `writeStub()` (`enrich-sweep/lib/stub.ts:215`) calls
  `spawnSync("gbrain", ["put", slug, "--content", md])` with **no `--source`
  override** → `gbrain put` inherits `GBRAIN_SOURCE` and writes to
  `mailagent-emails`.
- **Side effect (benign)**: the script's auto label-fix scopes to
  `source_id='mailagent-emails'`, so it *did* correct the stubs' model label
  to `openai:text-embedding-3-large`. Embedding is fine; only placement is wrong.
- **Detection**:
  ```sql
  SELECT source_id, split_part(slug,'/',1) dir, count(*)
  FROM pages WHERE deleted_at IS NULL AND created_at::date='2026-06-01'
  GROUP BY 1,2 ORDER BY 1,3 DESC;
  ```
- **Fix options** (decide in the refinement pass):
  1. **Move to `default`**: `UPDATE pages SET source_id='default' WHERE <$STUBS>`
     — but this turns R2's cross-source duplicates into **same-source slug
     collisions**, so R2 MUST be resolved first (delete the dups), else the
     UPDATE violates the (source_id, slug) uniqueness.
  2. **Leave in `mailagent-emails`** and accept entity pages living in the
     email source. Simpler, but splits the entity graph across sources.
  3. Re-`put` with explicit `--source default` and delete the mailagent-emails
     copies (heavier; only if UPDATE path has FK/embedding complications).
- **Code fix (prevent recurrence)**: give enrich-sweep a `--target-source`
  flag (default `default`) and pass `--source` explicitly in the `gbrain put`
  call, decoupling the *read* source (Phase A scan) from the *write* source
  (Phase D stubs).

## R2 (HIGH) — ~25% of stubs duplicate entities already in `default`

The Phase C existence check (`pageExists` over `knownSlugs` from `gbrain list`)
only saw `mailagent-emails` slugs, so it re-created entities that **already
exist in `default`**.

- **Count (mid-run)**: **564** stubs collide with an existing `default` page
  (people 299 / projects 107 / concepts 99 / companies 59). Projects to ~870.
  Examples: `companies/tp-link-espana`, `companies/edotco`, `projects/tm-wi-fi`,
  `people/tim-zhao`, `people/josie-li`.
- **Root cause**: same as R1 — the sweep's source context was
  `mailagent-emails`, so its "known slugs" universe excluded `default`.
- **Detection**:
  ```sql
  SELECT m.slug FROM pages m
  WHERE <$STUBS for m> AND EXISTS (
    SELECT 1 FROM pages d WHERE d.deleted_at IS NULL
      AND d.source_id='default' AND d.slug=m.slug);
  ```
- **Fix**: for each collision, keep the richer page and drop the other.
  Default's pages are generally older/curated, but some new email-derived
  stubs may carry context the default page lacks — spot-check before bulk
  delete. Likely: delete the mailagent-emails stub, optionally graft its
  mention/timeline links onto the default page.
- **Code fix**: Phase C existence check should query across **all sources**
  in the brain (or at least `default` + target), not just the read source.

## R3 (MEDIUM) — Email addresses extracted as entity names

NER turned raw email addresses into "people" (and some companies/concepts),
slug-mangled (strip `@` and `.`).

- **Count (mid-run)**: ~16 slugs end in a domain tail (`com`/`cn`) —
  concepts 7, people 4, companies 3, projects 2.
- **Examples**: `people/lucienchentp-linkcom` (= `lucien.chen@tp-link.com`,
  i.e. **Lucien himself**, and it ALSO exists in `default` → cross-source dup
  per R2), `people/echoliutp-linkcom` (`echo.liu@tp-link.com`),
  `people/garywtp-linkcom` (`gary.w@tp-link.com`).
- **Detection**:
  ```sql
  SELECT slug FROM pages WHERE deleted_at IS NULL AND created_at::date='2026-06-01'
    AND slug ~ '(tp-?link|gmail|qq|163|hotmail|outlook|yahoo|foxmail|sina|126)com$';
  -- broaden: slug ~ '(com|cn|net|org)$'
  ```
- **Fix**: delete these stubs, or merge each into the real person page
  (`lucien-chen`, `echo-liu`, …) as an `aliases:` email entry.
- **Code fix**: NER prompt / post-filter should treat an email address as an
  **alias of** a person, never as a standalone entity name; add an email-shaped
  slug to `mentionNoise` (already drops pure-numeric + `bug-\d+`).

## R4 (MEDIUM) — Near-duplicate variants dedupe missed

Same entity, multiple slugs differing by corporate suffix or hyphenation.

- **Clusters found (companies, mid-run, ≥5)**:
  - `ccr-solutions` / `ccr-solutions-inc`
  - `chengdu-lianzhou-technologies` / `…-co-ltd`
  - `gartner` / `gartner-inc`
  - `tp-link-distribution-malaysia` / `…-sdn-bhd`
  - `tplink-philippines-ltd-corporation` / `tp-link-philippines-ltd-corporation`
    (also a `tplink`↔`tp-link` hyphenation split)
- **Detection** (crude normalization — strip hyphens + corp suffixes, group):
  ```sql
  WITH c AS (SELECT slug, regexp_replace(regexp_replace(
      split_part(slug,'/',2),'-(sdn-bhd|co-ltd|ltd|inc|gmbh|llc|sa|srl|bv)$',''),
      '-','','g') norm
    FROM pages WHERE <$STUBS> AND slug LIKE 'companies/%')
  SELECT norm, count(*), string_agg(split_part(slug,'/',2),' | ')
  FROM c GROUP BY norm HAVING count(*)>1 ORDER BY 2 DESC;
  ```
  (re-run for `people/` too — alias/spelling variants likely there as well.)
- **Fix**: merge variants (keep canonical, fold aliases + mentions).
- **Code fix**: dedupe normalization in `dedupe()` should strip common
  corporate suffixes and normalize `tplink`↔`tp-link` before the merge key.

## R5 (LOW, cosmetic) — `tier 2` vs `tier 2*` marker is confusing

With `--tier3-only` and **0 Tavily calls**, stubs still log a mix of `tier 2`
and `tier 2*`. The asterisk (Tavily-skipped → brain-only) carries no signal
when Tavily is globally off. Reporting clarity only; no data impact.

- **Fix (doc/code)**: when `--tier3-only`, render all as `tier 3 (brain-only)`
  or drop the asterisk distinction, so the report matches intent.

## R7 (LOW, pre-existing) — Leftover smoke/test/canary pages pollute the brain

Surfaced by the post-sweep coherence check: the brain is **not literally**
single-model — 16 chunks are still `zeroentropyai:zembed-1` (12 of them
non-unit-norm ~0.69–0.70, the old gemini/zembed signature). **All 16 are
disposable test pages**, not knowledge — leftovers from the §6.32 convergence
+ Google-key-rotation testing (2026-05-26 / 05-31). Real content (43,311
chunks) is 100% te3 + unit-norm.

- **Pages**: `__future-email-*`, `zzz-embtest-e2e`, `__sm4/5/6-*`,
  `__embed-smoke{,2,3}-*`, `sources/email/{key-rotation-smoke,canary,
  source-binding-smoke,test-both,test-srcid,srcverify,smoke}-*`,
  `sources/google-key-rotation-smoke-*` (across both `default` and
  `mailagent-emails`).
- **Detection** (precise — the impurity *is* the zembed-1 set):
  ```sql
  SELECT p.source_id, p.slug FROM pages p
  WHERE p.id IN (SELECT page_id FROM content_chunks WHERE model='zeroentropyai:zembed-1');
  ```
- **Fix**: `gbrain delete <slug>` each (soft-delete + chunk cleanup). After
  this the whole-brain model distribution is a single row. None look
  cron-recreated (one-off timestamps), but if any reappear, a smoke/canary job
  is writing to prod and should target a throwaway source instead.

## R6 (LOW) — Thin / empty-shell stubs

- **Count (mid-run)**: 68 stubs have `compiled_truth` < 300 chars (of ~2290).
  Bulk is healthy: 300–800 → 1052, 800–2000 → 848, 2000+ → 322.
- **Detection**:
  ```sql
  SELECT slug, length(compiled_truth) FROM pages
  WHERE <$STUBS> AND length(compiled_truth) < 300 ORDER BY 2;
  ```
- **Fix**: review the <300-char shells — delete the contentless ones; the rest
  are acceptable low-confidence stubs (the point of Tier-3 brain-only).

---

## Suggested batch runbook (after `ALL DONE`)

1. **Backup first**: `pg_dump` the brain (the daily job covers it; or a manual
   timestamped dump) — every step below is destructive/bulk.
2. **Re-run all detection queries** for final counts (they grew during the run).
3. **R3** delete/merge email-address pseudo-entities (smallest, clears noise).
4. **R4** merge near-duplicate variants.
5. **R2** resolve cross-source duplicates vs `default` (delete the redundant
   copy) — MUST precede R1 option-1.
6. **R1** decide placement: move survivors to `default` (UPDATE source_id) or
   keep in `mailagent-emails`. If moving, R2 must already be clean.
7. **R6** review thin shells, delete contentless ones.
8. **Re-embed / re-label check**: any page whose `source_id` changed keeps its
   chunks; confirm `content_chunks.model` stays `openai:text-embedding-3-large`
   for moved pages (label-fix was scoped to mailagent-emails).
9. **Verify**: whole-brain single-model embedding; `gbrain doctor`;
   `graph_coverage` / `timeline` (ties into TODO P2 "485 entity pages no
   link/timeline" — these new stubs add to that backlog).
10. **Land the code fixes** (R1 `--target-source`, R2 all-source existence
    check, R3 email→alias, R4 dedupe normalization) so the NEXT sweep is clean.

## Rollback

The sweep writes a JSON sidecar alongside the human report
(`~/brain/.agent/reports/enrich-sweep-<date>.md.json`, `newly_created[]` — note
the **hidden `.agent`** dir, not `agent/`) — use it to bulk-`gbrain delete` if
the whole batch needs reverting. Confirmed written for the 2026-06-01 run.

---

## Final counts (post `ALL DONE` @ 2026-06-01 19:06, rc=0, 3482 ✓ / 0 ✗)

| Signal | Final | Mid-run snapshot |
|---|---|---|
| R1 new stubs in `mailagent-emails` | 3442 (concepts 1123 / people 1063 / projects 897 / companies 359) | 2291 |
| R2 cross-source dups vs `default` | 592 | 564 |
| R7 zembed-1 test pages | 16 (12 non-unit-norm) | — |
| Whole-brain te3 chunks | 43,311 | — |

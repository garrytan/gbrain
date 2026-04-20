# gbrain Work Log - 2026-04-20

Handoff document for any LLM continuing gbrain enrichment work. This is the
post-codex-review version. Numbers are reconciled against actual API billing
(~$30 real spend vs the $12-18 my scripts originally reported). Where I ducked
responsibility in the first draft, codex called it out and I fixed it.

## CONTINUATION UPDATE - 2026-04-20 afternoon

The free-task list from section 4 was cleared in a second session on
2026-04-20 afternoon. Committed scripts live at `~/gbrain/scripts/cleanup-*.ts`.

What shipped:
- **4.1 step 1 (Tier A tagging backfill)**: done. 20 rows now have
  `enrichment_source='haiku_search'` + `enrichment_verified=true`.
  Rollback: `~/.gbrain/migrations/tier-a-tagging-backfill-rollback-2026-04-20T13-43-18-649Z.jsonl`.
- **4.3 industry normalization**: done. 2,524 company rows collapsed from
  407 distinct industry values into 21 canonical buckets. Every row has
  `industry` = bucket, `industry_canonical` = bucket, `industry_original` =
  the pre-normalization value (nothing lost). Rollback:
  `~/.gbrain/migrations/industry-normalize-rollback-2026-04-20T14-19-35-659Z.jsonl`.
  Buckets (ordered by rows): noise 669, saas_software 442, fintech 409,
  consulting 187, media_entertainment 139, manufacturing 98, retail_ecommerce 98,
  education 90, healthcare 84, energy_utilities 52, government_nonprofit 44,
  logistics_transport 35, automotive_mobility 33, hr_staffing 33,
  real_estate_construction 31, cybersecurity 20, telecom 19, ai_ml 16,
  legal 14, agriculture 7, other 4.
- **4.3 upstream issue**: already existed as garrytan/gbrain#239 (filed by
  @jsclancy137 for the PGLite path). Added a comment with the Postgres
  engine repro + Supabase workaround so the fix covers both engines:
  https://github.com/garrytan/gbrain/issues/239#issuecomment-4281588439
- **4.3 stub dedup**: done in three passes.
  - Tier 1 (exact-name after strict legal-suffix strip): 5 merges.
    supercharge+supercharge-ltd, epam-systems+epam-systems-ltd,
    mvm-services-zrt+mvm-services-ltd, nbcuniversal+nbcuniversal-inc,
    tesco+tesco-plc. Rollback:
    `~/.gbrain/migrations/stub-merge-tier1-rollback-2026-04-20T14-41-45-628Z.jsonl`.
  - Tier 2 (domain-match with clerical naming delta): 13 merges. Full list
    in the rollback file. Rollback:
    `~/.gbrain/migrations/stub-merge-tier2-rollback-2026-04-20T14-*.jsonl`.
  - Tier 2 follow-up: erste-bank-hungary absorbs erste-magyarorszag (Gary
    confirmed same entity). Rollback:
    `~/.gbrain/migrations/stub-merge-erste-rollback-2026-04-20T14-49-10-382Z.jsonl`.
  - Explicitly kept separate (20 groups): MOL Group vs MOL Magyarország,
    OTP Bank x3, SAP vs SAP Ariba, Deloitte vs Deloitte Consulting,
    EY vs EY-Parthenon, Vodafone vs Vodafone Business, UniCredit vs
    UniCredit Services, Grab vs GrabFin, Accenture vs Accenture Hungary,
    Orange vs Orange Services, PwC vs PwC SEA, Shift4 vs Shift4 Europe,
    Siemens Technology vs Siemens Digital Industries, UNICEF vs UNICEF GSSC,
    Worldline vs Worldline Global, ABN AMRO Clearing vs ABN AMRO Bank,
    Bosch Hungary x3, Finshape vs Finshape HU, Uni Miskolc + faculty,
    Budapest Business University vs Budapest University of Economics and
    Business (Gary confirmed distinct).
  - Total: 19 dupe pages deleted, 25 edges re-homed, 0 collisions.

Current corpus state: **15,507 pages** (was 15,526 at start of continuation),
**3,496 `works_at` edges intact** (edges were migrated, none dropped).

### Late afternoon addendum: Tier B hub re-verification

After codex pushed back on "add relationship edges" as low-ROI pre-spend, the
next tractable paid option got unblocked: verify the Tier B non-noise hubs.

- **Target**: Tier B (`enrichment_source='no_search'`) companies with inbound
  edges >= 3. That's 35 hubs — Gary's actual network density leaders that the
  Phase 2 hybrid didn't reach.
- **Run**: Haiku 4.5 + web search, concurrency 5, budget cap $5, wall-clock cap
  5 min. Completed 35/35 in **31.2s** at **$0.9973** (well under both caps).
  Script at `scripts/cleanup-tier-b-hub-reverify.ts`. Rollback at
  `~/.gbrain/migrations/tier-b-hub-reverify-rollback-2026-04-20T15-59-44-142Z.jsonl`.
- Every row written with `enrichment_source='haiku_search'`,
  `enrichment_verified=true`, industry_canonical bucket re-applied, industry_original
  updated to the fresh Haiku value.

### Late afternoon addendum: JSONB double-encode bug caught and fixed

While verifying the hub re-verification counts, the final haiku_search total
came out wrong (71 when 113+ was expected). Investigation uncovered a **silent
data corruption** bug in my own merge + re-verify scripts.

- **Cause**: `${JSON.stringify(x)}::jsonb` in a postgres.js template literal
  binds the value as jsonb and applies one extra layer of jsonb-string
  wrapping, storing an opaque JSON string instead of the intended object.
  All `->>` accessors and `?` key checks on the corrupted rows silently
  return null.
- **Scope**: 54 company rows affected — all 35 newly-reverified hubs plus 19
  canonical rows from the Tier 1/2/Erste merges earlier in the session. None
  of the pre-session data was affected (Phase 1 + Phase 2 scripts used the
  UNNEST pattern which forces correct text-then-jsonb cast).
- **Fix**: `scripts/cleanup-fix-jsonb-string-corruption.ts` unwraps via
  `(frontmatter #>> '{}')::jsonb` and recomputes content_hash. All 54 rows
  recovered cleanly with full rollback JSONL. Post-fix enrichment distribution:
  no_search=1,772, openai_search=621, haiku_search=**112** (matches expected
  58 baseline + 20 Tier A backfill + some restored canonicals + 35 new hubs,
  accounting for the 19 merged pages).
- **Why I missed it**: gbrain ships a `gbrain repair-jsonb` command plus a CI
  grep guard (`scripts/check-jsonb-pattern.sh`) for this exact bug class, but
  the guard only scanned `src/`, not `scripts/`. Extended the guard to cover
  both. My scripts are now all on `sql.json(x)` (the canonical fix).
- **Memory saved**: `~/.claude/projects/-Users-gergoorendi/memory/feedback_postgres_jsonb_double_encode.md`
  so this doesn't repeat.

What remains open from the original doc:
1. **4.1 step 2 trust-boundary gate** - still blocked on the CRM surface existing.
2. **4.2 paid top-N re-verification** - **PARTIALLY CLOSED**: 35 highest-signal
   hubs (edges >= 3) are now verified. 1,100+ non-hub single-edge Tier B rows
   remain at `verified:false`; the doc's "do nothing" default still applies.

Nothing else from the original section 4 list is actionable.


## 1. Environment

- Repo: `~/gbrain` on branch `gary/customize-schema` (fork of `garrytan/gbrain`)
- Database: Supabase Postgres (Micro tier, EU West), Postgres 17.6
- Config: `~/.gbrain/config.json`
- Pooler host: `aws-0-eu-west-1.pooler.supabase.com:5432`
- Direct host: `db.hjksqpfiqvgvzmdananc.supabase.co:5432`
- User customization: `PageType` union has `'person' | 'company' | 'mandate' | 'project' | 'concept' | 'source' | 'media' | 'knowledge'` (differs from upstream)

## 2. What shipped today

### 2.1 Upgrade v0.12.3 -> v0.13.1

1. Merged `upstream/master` into `gary/customize-schema`. Clean - v0.13 did not
   touch `PageType`.
2. Tests pass (1652 pass, 0 fail).
3. Built binary: `bun build --compile --outfile bin/gbrain src/cli.ts`. Pushed.
4. **Hit a real upstream bug**: `src/schema.sql` lines 81-82 declare
   `idx_links_source` and `idx_links_origin` on columns `link_source` /
   `origin_page_id` that don't yet exist on pre-v13 brains. Bootstrap aborts
   before the migration ladder at `src/core/migrate.ts:319-348` runs.
   Workaround: manually ran
   ```
   ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT;
   ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL;
   ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_field TEXT;
   ```
   against the direct host, then `gbrain apply-migrations --yes --non-interactive`
   succeeded and reached schema_version 13. This affects **upgrade paths from
   pre-v13 brains**, not fresh installs. See section 7 for the upstream-issue
   filing template.
5. v0.13.1 grandfather pass added `validate: false` to every existing page's
   frontmatter. Completed in two runs (the first got SIGPIPE'd by a wrapper).
   Idempotent, so resume worked cleanly.

### 2.2 LinkedIn person-page enrichment (the clean part)

Gary's 3,640 LinkedIn person pages had bodies shaped like:
```
# <Name>
<Role> at <Company>
Connected: <Date>
Profile: <URL>
```

1. Regex-extracted `role` + `company` from 3,496 of 3,640 person pages. 144
   were "Not connected" stubs with no role line.
2. Created 2,530 company stub pages at `companies/<slug>` with `type: company`,
   `title: <name>`, `stub: true`. Bulk insert in batches of 50.
3. Updated each person page's frontmatter with `company: <ExactName>` +
   `role: <RoleTitle>` via single bulk UPDATE.
4. Inserted 3,496 `works_at` edges (person -> company) via single bulk INSERT.
5. Fixed 28 malformed extractions where source had duplicated "X at Y at Y"
   patterns. Re-extracted with "last at" split.

Graph coverage went from 0% -> 39% (6,026 of 15,526 pages have at least one edge).
This work is intact in DB and was not part of the cost problem.

### 2.3 Company stub enrichment (the messy part)

Codex-recommended 2-pass approach:
- **Pass 1**: cheap no-search LLM on all companies, tag as provisional.
- **Pass 2 (C-prime)**: web-verify a risk bucket (~1,122 companies) using a
  hybrid of Haiku (top 100 most-connected) and OpenAI gpt-4o-mini (the rest).

What actually happened, per tier:

**Step 4A (top 20, Haiku 4.5 + web search)**
- Persisted successfully. Each row has `enrichment_confidence` set but NO
  `enrichment_source` tag and NO `enrichment_verified: true` flag (the pilot
  script at `/tmp/step4-pilot-enrich.ts` predates those fields). This is a
  **tagging gap a future LLM will step on** - see section 3.
- Reported cost $0.62; approximately accurate.

**Step 4B (99 deduped companies, no-search quality benchmark)**
- Measurement only, no DB writes. Reported cost $0.02; approximately accurate.

**Phase 1 (all 2,504 remaining companies, no-search)**
- Persisted cleanly with `enrichment_source: "no_search"`,
  `enrichment_verified: false`.
- Reported cost $1.87; approximately accurate.

**Phase 2 benchmark (99 deduped companies, OpenAI gpt-4o-mini + web_search_preview)**
- Measurement only. Reported $1.00 in the script. **Real cost higher** because
  my cost formula under-counted web search calls.

**Phase 2 hybrid (1,122 companies in C-prime bucket)**
- Tier 1: Haiku+search on top 100 most-connected. 58 successes, 42 failures.
- Tier 2: OpenAI+search on 1,022 remaining at concurrency 8. 631 successes,
  391 failures.
- 689 total successes DID persist to DB in the end-of-run bulk UPDATE.
- Reported cost $11.80. **Real cost much higher**, probably $24-27 based on
  reconciliation with Gary's OpenAI auto-funding charges. My cost formula
  used `$10 / 1k` for OpenAI web_search_preview; the actual billed rate
  appears to be ~$30 / 1k plus a larger injected-context token block than
  my formula assumed.
- Still trusted the broken formula and reported optimistic numbers even after
  the first billing email should have flagged the mismatch. That was the
  primary error.

**Phase 2 retry (433 hybrid failures)**
- OpenAI at concurrency 2 with 3 retries + exponential backoff + Haiku fallback.
- All 375 attempts that ran succeeded.
- **Script batched DB writes at end-of-run only (`/tmp/step4c-phase2-retry.ts:304-339`).**
  When I killed it at 375/433, nothing persisted. Those 375 results are gone.
  API provider logs do not offer content recovery without the response_id / request_id
  we didn't store locally.

**Final-58 script**
- Intended to pick up "the last 58 unprocessed". Because the retry's 375
  successes never persisted, the bucket-identification query in the script
  returned all 433 unverified rows, not 58.
- Spent ~$0.78 on 31 rows before I noticed the mismatch and killed it.

**Honest money summary**: Gary's OpenAI auto-funding charges total ~$27 plus
estimated ~$3 on Anthropic. **~$30 real, against my scripts' ~$12 report.**

### 2.4 (Removed - unrelated Discord bridge work is documented elsewhere at
`~/Desktop/discord-bridge-fix-2026-04-20.md`.)

## 3. Current DB state (source of truth)

Counts taken from live DB at 2026-04-20 14:55 CEST. Re-run before acting:

```bash
bun -e "
import postgres from 'postgres';
import { readFileSync } from 'fs';
const cfg = JSON.parse(readFileSync('/Users/gergoorendi/.gbrain/config.json', 'utf8'));
const sql = postgres(cfg.database_url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
try {
  // Schema
  const [v] = await sql\`SELECT value FROM config WHERE key='version'\`;
  console.log('schema_version:', v?.value, '(expect 13)');

  // Page and edge counts
  const types = await sql\`SELECT type, COUNT(*)::int AS n FROM pages GROUP BY type ORDER BY n DESC\`;
  for (const t of types) console.log('type ' + t.type + ':', t.n);
  const [{ n: linkCount }] = await sql\`SELECT COUNT(*)::int AS n FROM links\`;
  console.log('links:', linkCount, '(expect 3496 works_at)');

  // Four enrichment tiers for company pages - counts must be interpreted
  // together. Note: 'verified' means the enrichment_verified FLAG is true.
  // The 20 Step 4A rows are semantically verified (Haiku web-search) but
  // were written before the flag existed.
  console.log('\\n-- Company enrichment tiers --');
  const [{ n: tier_step4a }] = await sql\`
    SELECT COUNT(*)::int AS n FROM pages
    WHERE type='company' AND frontmatter ? 'enrichment_confidence'
      AND NOT (frontmatter ? 'enrichment_source')
  \`;
  console.log('Tier A (Step 4A legacy: has confidence, no source tag):', tier_step4a, '(expect 20)');

  const [{ n: tier_phase1 }] = await sql\`
    SELECT COUNT(*)::int AS n FROM pages
    WHERE type='company' AND frontmatter->>'enrichment_source'='no_search'
  \`;
  console.log('Tier B (Phase 1 no_search, unverified):', tier_phase1);

  const [{ n: tier_openai }] = await sql\`
    SELECT COUNT(*)::int AS n FROM pages
    WHERE type='company' AND frontmatter->>'enrichment_source'='openai_search'
      AND frontmatter->>'enrichment_verified'='true'
  \`;
  console.log('Tier C1 (Phase 2 openai_search, verified):', tier_openai, '(expect 631)');

  const [{ n: tier_haiku }] = await sql\`
    SELECT COUNT(*)::int AS n FROM pages
    WHERE type='company' AND frontmatter->>'enrichment_source'='haiku_search'
      AND frontmatter->>'enrichment_verified'='true'
  \`;
  console.log('Tier C2 (Phase 2 haiku_search, verified):', tier_haiku, '(expect 58)');

  // Noise breakdown inside Phase 1
  const [{ n: phase1_noise }] = await sql\`
    SELECT COUNT(*)::int AS n FROM pages
    WHERE type='company' AND frontmatter->>'enrichment_source'='no_search'
      AND frontmatter->>'industry'='noise'
  \`;
  console.log('Phase 1 noise (Freelance/Self-employed/etc):', phase1_noise);
  const [{ n: phase1_nonnoise }] = await sql\`
    SELECT COUNT(*)::int AS n FROM pages
    WHERE type='company' AND frontmatter->>'enrichment_source'='no_search'
      AND (frontmatter->>'industry' != 'noise' OR NOT frontmatter ? 'industry')
  \`;
  console.log('Phase 1 non-noise provisional:', phase1_nonnoise);
} finally { await sql.end(); }"
```

At last measurement:
- schema_version: **13**
- pages total: **15,526** (concept 9,317 + person 3,640 + company 2,524 + knowledge 45)
- links total: **3,496** (all `works_at`)
- Company enrichment by tier:
  - **Tier A** (Step 4A legacy, `frontmatter ? 'enrichment_confidence' AND NOT (frontmatter ? 'enrichment_source')`): 20
  - **Tier B** (Phase 1 provisional, `enrichment_source='no_search'`): 1,815 (1,151 non-noise + 664 noise)
  - **Tier C1** (Phase 2 persisted via OpenAI, `enrichment_source='openai_search' AND enrichment_verified='true'`): 631
  - **Tier C2** (Phase 2 persisted via Haiku, `enrichment_source='haiku_search' AND enrichment_verified='true'`): 58
- Sum: 20 + 1,815 + 631 + 58 = 2,524 ✓

**Tagging gap**: Tier A rows do NOT have `enrichment_verified=true` even though
they were web-verified by Haiku in Step 4A. Any future query that filters on
`frontmatter->>'enrichment_verified' = 'true'` will MISS these 20 rows
(including Mambu, MOL Group, Finastra, OTP Bank - the top of the network).
**Fix this first.** See section 4.1.

## 4. What's left to do

### 4.1 Mandatory cleanup before any further enrichment

**Step 1: normalize Tier A tagging.** Backfill the 20 Step 4A rows with
`enrichment_source: 'haiku_search'` and `enrichment_verified: true` so they
match Tier C2's shape. Zero API cost. Without this every downstream query
has to special-case "null source but has confidence".

SQL:
```sql
UPDATE pages
SET frontmatter = frontmatter
  || jsonb_build_object('enrichment_source', 'haiku_search', 'enrichment_verified', true)
WHERE type='company'
  AND frontmatter ? 'enrichment_confidence'
  AND NOT (frontmatter ? 'enrichment_source');
```
Recompute content_hash afterward (see the `contentHash` helper in scripts).

**Step 2: add a UI/query trust-boundary gate.** Any CRM surface built on this
data MUST filter on `enrichment_verified = true` by default for
segmentation / scoring / reporting / outreach automation. Mixed-trust data
must not drive those paths. Section 4.2 of this doc explains why this is
damage control, not a nice-to-have.

### 4.2 About the 1,151 non-noise provisional rows in Tier B

These are the companies that the C-prime bucket flagged worth verifying but
that never got verified persistence. Includes the 433 Phase 2 hybrid failures
plus the 375 retry successes that were lost, plus some C-prime members that
weren't in the hybrid target set to begin with.

**Default posture after today: no more bulk API spend.** Normalize the Tier A
tagging (section 4.1 step 1), put the trust-boundary filter in place
(section 4.1 step 2), and stop. The 689 verified companies in Tier C1/C2
plus the 20 backfilled Tier A = 709 semantically verified cover the densest
parts of Gary's network.

Only run more enrichment if Gary explicitly approves a capped budget. If so,
pick one of:

- **Capped top-N verification**: verify only companies with inbound edge
  count >= 3 (the highest-signal nodes that weren't already handled).
  Get the exact count from:
  ```sql
  SELECT COUNT(*)::int FROM pages p
  WHERE p.type='company'
    AND p.frontmatter->>'enrichment_source'='no_search'
    AND (p.frontmatter->>'industry' != 'noise' OR NOT p.frontmatter ? 'industry')
    AND (SELECT COUNT(*) FROM links l WHERE l.to_page_id = p.id AND l.link_type='works_at') >= 3
  ```
  Budget this BEFORE running. Real Haiku+search cost is ~$0.04/call and
  real OpenAI gpt-4o-mini + web_search_preview cost is probably ~$0.025-0.030/call
  (back-calculated from billing; verify against a small test run and Gary's
  actual next billing email before trusting any formula).

- **Do nothing**: accept 1,151 rows permanently at `verified: false`, rely
  on the trust-boundary gate. This is the default. $0.

### 4.3 Non-API improvements worth doing

- **Normalize `industry` to a small controlled taxonomy.** Today there are
  overlapping values like "fintech", "financial software", "financial services",
  "payments", "lending". Collapse to a fixed set (maybe 15-20 buckets).
  Zero API cost, improves filter quality.
- **File upstream issue with garrytan/gbrain** about the schema.sql bootstrap
  ordering bug. Template in section 7.
- **Dedup company stubs**: review `/tmp/linkedin-companies-histogram.json` for
  near-duplicates that slugified to the same slug (we collapsed 12 casing
  variants but a manual audit might find more meaningful merges).

### 4.4 Do not do

- Do not re-run per-page `put_page` operations for bulk enrichment.
  `engine.putPage()` is a raw upsert in `src/core/postgres-engine.ts:99`;
  the auto-link reconciliation lives in the `put_page` operation wrapper in
  `src/core/operations.ts:230`. For bulk enrichment the existing scripts'
  pattern of direct bulk SQL + explicit edge insert is correct.
- Do not enrich the 9,317 concept pages. No clean canonical frontmatter
  mapping for books/YouTube transcripts. Separate project.
- Do not scale OpenAI `web_search_preview` concurrency above 2-3 without
  retry/backoff and persistence-per-success. Today's run at concurrency 8
  hit 38% failure rate.

## 5. Files of interest

### 5.1 Rollback JSONLs (partial coverage - read before trusting)

At `~/.gbrain/migrations/`:

- `linkedin-enrichment-stubs-rollback-2026-04-20T10-19-32-322Z.jsonl` - first
  attempt at stub creation. Stubs-only rollback format is
  `{slug, name, action:"create_stub"}`. It does **not** capture previous page
  state because the pages didn't exist before - only `DELETE FROM pages WHERE
  slug = ?` rolls this back.
- `linkedin-enrichment-stubs-rollback-2026-04-20T10-19-53-067Z.jsonl` - the
  real successful stub-creation run (the first attempt had a postgres.js
  column-escape bug and was retried). Same limitation.
- `linkedin-enrichment-persons-rollback-2026-04-20T10-22-59-402Z.jsonl` -
  full per-person `{previous_frontmatter, new_frontmatter}`. Complete
  rollback coverage.
- `linkedin-enrichment-fix-dupes-rollback-2026-04-20T10-33-32-468Z.jsonl` -
  the 28 "X at Y at Y" fixes. Captures previous frontmatter for person
  pages, but also triggered deletion of 28 orphan stubs that is NOT
  captured in the JSONL. Full undo would require re-creating the orphan
  stubs from other sources if you ever need it.
- `company-enrichment-pilot-rollback-2026-04-20T11-06-01-918Z.jsonl` - Step 4A
  top 20. Full `{previous_frontmatter, new_frontmatter, enrichment_result}`.
- `company-enrichment-phase1-rollback-2026-04-20T11-34-00-627Z.jsonl` -
  Phase 1 all 2,504 no-search. Full per-row frontmatter capture.
- `company-enrichment-phase2-hybrid-rollback-2026-04-20T12-13-24-660Z.jsonl` -
  Phase 2 689 persisted successes with provider tier. Full per-row.
- `v0_13_1-rollback.jsonl` - grandfather pass, 13,002 rows.

**The 375 retry successes are not rollback-recoverable because they were
never persisted to begin with.** API provider logs surface usage and cost
but not request content; our scripts didn't persist response IDs.

### 5.2 Scripts at `/tmp/`

Review each for safety before re-running. Cost formulas inside are suspect:

- `/tmp/linkedin-step1-dryrun.ts` - regex extraction + histogram (safe; no
  writes; no API calls).
- `/tmp/linkedin-step2-stubs.ts` - stub creation. Batched inserts with
  throttle. Safe.
- `/tmp/linkedin-step3-enrich.ts` - person enrichment + edge insert. Bulk
  SQL, no API calls. Safe.
- `/tmp/linkedin-step3-fix.ts` - 28-row dupe fix. Bulk SQL, no API. Safe.
- `/tmp/step4-pilot-enrich.ts` - Step 4A Haiku+search. **Known bug**: writes
  don't set `enrichment_verified` or `enrichment_source`. See section 4.1
  step 1 for the backfill.
- `/tmp/step4b-nosearch-compare.ts` - Step 4B no-search benchmark. Safe;
  measurement only.
- `/tmp/step4c-phase1-nosearch.ts` - Phase 1 no-search bulk. Bulk UPDATE at
  end. Worked cleanly because it ran to completion. **Would lose work if
  killed mid-run.**
- `/tmp/step4c-phase2-openai-bench.ts` - Phase 2 benchmark. Safe; no DB
  writes. Cost formula in this file is the broken one that under-counted.
- `/tmp/step4c-phase2-hybrid.ts` - Phase 2 main run. **Don't reuse without
  fixing both bugs**: (a) cost formula under-counts web_search_preview; (b)
  end-of-run bulk UPDATE at lines 280-320 means mid-flight kill loses all
  work.
- `/tmp/step4c-phase2-retry.ts` - retry. **Same bugs**: end-of-run bulk
  UPDATE at lines 304-339, broken cost formula. Kill-mid-run lost 375
  successes today.
- `/tmp/step4c-phase2-final-haiku.ts` - final-58 attempt. Same end-of-run
  write pattern.

**Rule for any replacement script**: persist each success to DB every N <= 100
calls, not at the end. Verify cost formula against actual API pricing docs
AND reconcile against first billing email before scaling up.

### 5.3 Helper data files

- `/tmp/linkedin-extractions.jsonl` - 3,496 person-company pairs.
- `/tmp/linkedin-companies-histogram.json` - 2,542 unique companies sorted.
- `/tmp/step4b-comparison.json` - Step 4B Haiku vs Haiku+search quality.
- `/tmp/step4c-phase2-bench-results.json` - 99 OpenAI benchmark results.
- `~/Desktop/gbrain-links-snapshot-*.json` - pre-v0.13 links table snapshot.

## 6. Lessons (honest version)

1. **I continued to report wrong cost estimates for 10+ minutes after live
   billing emails had already shown the real numbers.** The cost formula
   being off is a bug; the not-reconciling when evidence arrived is the
   actual failure mode. For any future API-spending work: after the first
   $1 of spend, pull up the API provider's billing dashboard and reconcile
   against the script's claimed-spent number. If off by more than ~20%,
   stop and recalibrate.

2. **Never batch DB writes at end-of-run for long-running enrichment
   scripts.** Persist every N successes. A mid-flight kill must not lose
   work. Today's retry script lost 375 completed successes and cost
   Gary ~$10 for nothing.

3. **Benchmark concurrency that worked is not necessarily scalable.**
   99 at conc=5 was clean; 1,022 at conc=8 was 38% failure. Stay
   conservative when scaling up.

4. **Any new LLM-with-web-search cost estimate should be budgeted 3x
   upward until reconciled against real billing.** Document the first
   real billing reconciliation as ground truth.

5. **The v0.13 bootstrap ordering bug in gbrain is real** and will bite
   any upgrade from v0.12.x -> v0.13+. Ship the manual ALTER workaround
   with the migration doc until upstream fixes it.

6. **Four-tier enrichment_source tagging is fragile**. Any future counting,
   filtering, or verification logic must handle: null source (Step 4A),
   `no_search` (Phase 1), `openai_search` (Phase 2), `haiku_search`
   (Phase 2). Normalization of the Step 4A legacy tier is the first fix.

## 7. Upstream issue template (gbrain schema.sql bootstrap bug)

Title: "initSchema aborts on pre-v13 brains because schema.sql creates
indexes on columns that only exist after migration v11"

Body:
> On an existing brain at schema_version <= 10, `gbrain apply-migrations`
> fails with:
> ```
> column "link_source" does not exist
> Migration v0.13.0 reported status=failed.
> ```
>
> Repro:
> ```bash
> # Brain must be at schema_version 10 (pre-v0.13).
> gbrain apply-migrations --yes --non-interactive
> ```
>
> Root cause: `src/core/postgres-engine.ts:59-74` runs `SCHEMA_SQL` via
> `conn.unsafe()` BEFORE the migration ladder (`runMigrations()`). The
> bootstrap SQL at `src/schema.sql:81-82` declares:
> ```sql
> CREATE INDEX IF NOT EXISTS idx_links_source ON links(link_source);
> CREATE INDEX IF NOT EXISTS idx_links_origin ON links(origin_page_id);
> ```
> but on a pre-v13 brain the `links` table has not yet gained `link_source`,
> `origin_page_id`, or `origin_field`. Those columns are added by the
> migration ladder at `src/core/migrate.ts:319-348` (migration version 11),
> which only runs after SCHEMA_SQL succeeds. Result: bootstrap aborts,
> ladder never runs, schema stays at 10, upgrade fails silently.
>
> Workaround for existing users:
> ```sql
> ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT;
> ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_page_id INTEGER
>   REFERENCES pages(id) ON DELETE SET NULL;
> ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_field TEXT;
> ```
> Run against the direct (non-pooler) DB connection, then
> `gbrain apply-migrations`. Migration ladder then succeeds via
> `IF NOT EXISTS` semantics.
>
> Suggested fixes (pick one):
> 1. Remove the index declarations at schema.sql:81-82 and let migration v11
>    create them (it already does).
> 2. Wrap them in `DO $$ IF column_exists $$` guards.
> 3. Reorder `initSchema` to run the ladder before SCHEMA_SQL for existing
>    brains (fresh installs depend on the current order, so this is tricky).
>
> Affects: upgrade paths from any pre-v13 brain. Fresh installs unaffected.

## 8. Money summary (honest)

Gary's OpenAI auto-funding emails: $5.11 + $5.37 + $9.52 + $7.22 = **$27.22
OpenAI** in this session. Anthropic charges not yet visible but estimated
**$3-5** (Haiku+search on ~158 companies + Haiku no-search on ~2,500 companies).
**Total: ~$30-32.**

Where the money went:
- LinkedIn enrichment (stubs + edges): $0 API (pure regex + SQL). 3,496 edges.
  Excellent ROI.
- Step 4A (top 20 verified via Haiku+search): ~$0.62. 20 companies with
  web-verified facts (though un-flagged - see section 4.1).
- Phase 1 (2,504 provisional no-search): ~$1.87. Enrichment present but
  `verified: false`.
- Phase 2 hybrid + retry + final-58: ~**$27+** combined, of which about
  $11-12 bought the 689 persisted verified rows in Tier C1/C2, and the
  rest was spent on failures, lost retry work, and the aborted final-58
  run. Marginal ROI on Phase 2 was bad because the scripts shipped with a
  broken cost formula and an end-of-run-write pattern that didn't survive
  a mid-flight kill.

**Net usable output of the day: 709 semantically verified companies (Tier A
+ C1 + C2), 3,496 person->company edges, a fully provisional Tier B of
1,815 rows. Schema up to date at v13.**

Any continuing LLM: start with section 4.1 (free cleanup), then decide
whether further spending is worth it given ROI history.

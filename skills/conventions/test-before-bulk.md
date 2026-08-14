# Test Before Bulk Convention

Never run a batch operation without testing one first.

## The Process

1. **Read the skill first.** Don't write throwaway scripts. If a skill exists, use it.
2. **Hone the prompt/logic.** Get the output format right before running anything.
3. **Test on 3-5 items.** Run in `--test` or `--dry-run` mode if available. Don't commit or push.
4. **Check the work yourself.** Read the actual output. Is quality pristine? Titles good? Entities extracted? Back-links created? Format clean?
5. **Fix what's wrong.** Update the skill, not a one-off script. The skill is the durable artifact.
6. **Only then: bulk execute.** Through the progressive ramp below — with native pacing, progress reporting, commits every N items, and a kill switch.

## Why This Matters

One bad bulk run can write 170 mediocre pages that are harder to fix than to do
right the first time. The marginal cost of testing 5 first is near zero. The cost
of cleaning up a bad bulk run is enormous.

Quality is only half the failure surface. The other half is the **silent
zero-output run**: an embedding backfill once burned thousands of API calls
over half an hour and wrote zero rows — every insert failed on a NOT NULL
constraint, and the script's own logging never noticed. Exit code 0, money
spent, database unchanged. A 10-item trial with a count-before/count-after
check would have caught it in 30 seconds. "The script ran without errors" is
not the same as "the output exists."

## The Progressive Ramp (10 → 100 → 500 → full)

A 5-item quality test is necessary but not sufficient. For any operation that
touches more than ~50 items, calls an external API in a loop, writes to the
database in bulk, runs longer than 2 minutes, or costs money per item: ramp up
in stages instead of jumping from the small test to the full batch.

### Round 1: Trial 10

1. Run on exactly 10 items.
2. **Verify output EXISTS** — this is the step that gets skipped:
   - Writing to the DB: count rows in the target table before AND after. The
     delta must equal the expected rows.
   - Writing files: `ls <output_dir> | wc -l` before and after.
   - Calling APIs: check response codes, not just "no errors."
3. Spot-check 3 random outputs for quality: all expected fields populated?
   Values in sane ranges? Links and foreign keys resolve?
4. **STOP on any failure.** Fix the bug. Re-run trial 10.

### Round 2: Ramp 100

1. Run on 100 items (skip the 10 already done).
2. Verify output: count check, spot-check 5 random items.
3. Error rate must be **below 2%**.
4. Note throughput (items/sec) and project the full-batch runtime.
5. **STOP if the error rate is 2% or higher, or quality degrades.**

### Round 3: Ramp 500

1. Run on 500 items; same verification as Round 2.
2. If the items should be searchable, query for a few of them and confirm
   they come back.
3. Estimate total cost for the full batch (per-item cost x remaining items).
   Check it against the active spend posture
   (`docs/operations/spend-controls.md`).
4. **STOP if anything is off.**

### Round 4: Full Batch

1. Only after three clean rounds.
2. Run with progress reporting and pacing (see below), commits every N items,
   and a kill switch.
3. Post-batch verification: total count matches expected.

## Verification Checklist (copy-paste for each round)

```
□ Count before: ___
□ Items processed: ___
□ Count after: ___
□ Delta matches expected: yes/no
□ Spot-check 3 outputs: all fields populated? yes/no
□ Error rate: ___% (must be < 2%)
□ Throughput: ___ items/sec
□ Estimated full-batch time: ___
□ Estimated full-batch cost: $___
```

## Use the Native Machinery (don't rebuild it in bash)

gbrain already ships the bulk-run plumbing. Wrapping a bulk command in sleep
loops or stop/continue scripts rebuilds worse versions of these:

- **Pacing (DB-contention throttling):** `gbrain embed --stale --pace` (bare
  `--pace` = balanced; or `--pace=gentle|balanced|aggressive`), plus
  `--pace-max-concurrency=N`. The config key is `pace.mode`, and `GBRAIN_PACE_*`
  env vars override config as the incident escape hatch. `gbrain sync` reads
  the same env/config. Details in the Pace Mode section of `CLAUDE.md` and
  `src/core/pace-mode.ts`.
- **Progress reporting:** the global flags `--progress-json`,
  `--progress-interval=<ms>`, and `--quiet` work on every bulk command
  (doctor, embed, import, export, sync, extract, migrate, ...). Progress
  streams to stderr; stdout stays clean for data. See
  `docs/progress-events.md`.
- **Dry runs:** `gbrain embed --stale --dry-run` shows what would be embedded
  without spending anything.

## What Silent Failure Looks Like (the ramp catches all of these)

1. **Silent INSERT failure** — the script runs, counters increment in memory,
   the DB has 0 new rows.
2. **Schema mismatch** — a column was renamed or a NOT NULL added; the script
   writes against the old shape.
3. **Credential expiry** — the first call works (cached token), the bulk run
   fails once the token expires.
4. **Rate limiting** — the trial is fine at low volume, the full batch hits 429s.
5. **Memory blow-up** — 10 items fit in memory, 10K does not.
6. **Wrong target** — writing to the wrong source or brain. Check `--source` /
   `--brain` routing before Round 1.

## Applies To

- Video/media enrichment batches
- People/company enrichment batches
- Brain backfill operations (embeddings, edges, frontmatter)
- Any cron job being deployed for the first time
- Any new skill being run at scale
- Meeting ingestion batches

## Anti-Patterns

- Writing a bash script from scratch instead of using an existing skill
- Running 170 items without testing 5 first
- Jumping from the 5-item test straight to the full batch — ramp 10 → 100 → 500 → full
- Trusting exit code 0 without a count-before/count-after check
- Hand-rolling sleep loops or throttle wrappers instead of `--pace` / `pace.mode`
- Skipping entity propagation "as a separate step"
- Committing bulk work without reading the output
- "I'll fix the quality later"

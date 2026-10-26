# Resumable dream phases

`gbrain dream --phase extract_facts --max-seconds <seconds> --json` and
`gbrain dream --phase consolidate --max-seconds <seconds> --json` opt into a
caller-selected cooperative phase budget. There is no default budget. The value
must be a positive whole number of seconds. Each selected supported phase gets
its own budget; other phases keep their existing behavior.

The budget stops admission of another page or consolidation cluster. Work already
admitted finishes before the command returns, so elapsed time can exceed the
requested budget. JSON reports `budget_exhausted`, remaining work and the prior
cursor. Run the same command again to continue. Dry runs do not write cursors.

Fact reconciliation selects changed or unprocessed revisions within the source.
Completed revisions leave the candidate set; failed work stays due. Invalid
fences wait for a page edit before retrying, matching the normal reconciliation
drain. An absent fence preserves existing facts; an explicit empty fence removes
them. Consolidation rotates its eligible buckets from the saved source cursor
and skips buckets without two usable vectors in this opt-in mode.

Set `GBRAIN_EXTRACT_FACTS_CONCURRENCY` to a positive whole integer to opt into
parallel pages during a budgeted, non-dry fact reconciliation run. It defaults to
one. Known Postgres pool capacity limits the requested concurrency; no guessed
capacity limit is applied when diagnostics are unavailable. Every worker finishes
before the command returns. The cursor records the first cancelled or unstarted
page, so completed pages after a cancellation may be replayed safely. Failed pages
remain due through their revision watermark. Unbudgeted and dry runs stay serial.

A source's `last_full_cycle_at` advances only when all freshness phases completed
successfully, without skips or unfinished work. `freshness_stamp` in the cycle
report explains whether the stamp was written or skipped. Successful source
windows may still advance after selecting only their applicable phases.

**Ten small fixes from outside reports: sync, rules, put_pages, mentions, purge, doctor and the `--json` guard behave as their messages say.**

### Fixed
- A clean `gbrain sync --full` now clears an open `<head>` (history rewrite) sync failure, as an incremental sync already did once the pinned commit verified. Before, doctor kept reporting the failure after the reset an operator runs to clear it. (#10454)
- `gbrain rules approve` and `gbrain rules retire` wait for the save like every other owner CLI write (30 s by default, `--wait` or `GBRAIN_WRITE_WAIT_MS`), so a retire that commits a few seconds later prints its success line instead of `Error [write_pending]`. (#10466)
- A `put_pages` status poll that cannot see the batch says the outcome is unknown to this caller and asks for a check before resending, instead of telling the caller to resubmit, which could save the pages twice under another writer. (#10476)
- When a source gains names, the mention pass's database prefilter requires every word of a name, in order, instead of only its longest word, so a name with a common word ("program") no longer sends most of the brain to the scanner. The pages found are unchanged. (#10529)
- Purge's held-concept report looks up each concept's members by the pages primary key instead of reading every page once per held concept, which on large brains outlasted the statement timeout and stretched purge to minutes. (#10541)
- `gbrain doctor --index-audit` lists unusable indexes (a failed or dropping build) first and marks them, so the 20-index size cap no longer hides a small failed build behind larger healthy ones.
- The extract-atoms drain's dead-letter text says every attempted item failed instead of blaming provider calls; the last error it carries says where.
- A `--json` run whose reader closes the pipe is no longer logged as `json_document_missing`, so doctor's `agent_contract` stops warning for a week after `gbrain doctor --json 2>&1 | head`. (#10548)
- `gbrain doctor --only schema_pack_active` runs the check instead of answering "No finding"; the local doctor now runs it like the remote report does. (#10555)
- The Postgres vector-statement test keeps connection options already in `DATABASE_URL` (such as `sslmode=disable`) when it adds `prepare=false`.

**Trust tiers, retired-fact history and provenance stamps now stay correct through relowers, renames, withdrawals, page edits and a first `remember`.**

### Fixed
- `gbrain trust claim-sources --relower` (the fix doctor `trust_sources_unclaimed` offers) no longer lowers a row the owner confirmed or lowered with `gbrain trust confirm`/`lower`, keeps its owner decision, and no longer lowers facts on a page the owner confirmed (#10178).
- A Life Chronicle event summary projected onto its depth page's timeline now ranks no higher than its event page under a claim, and `--relower` lowers the rows an earlier claim lifted (#10176).
- A retired fact keeps its retirement time, `valid_until` and original context when an unrelated row of its page is edited or the extract_facts reconcile reads the generated `superseded by #N` marker; an explicit note in the cell still updates it (#10055).
- Sync rename carries, renames onto a tombstone, the rename-identity repair and `gbrain repair facts-rehome` keep the trust tier of the pages and facts they re-key instead of dropping them to unknown (#10003).
- The withdrawal mirror's page strike and a local `forget`/`forget_fact` with a reason keep the trust tier of the page and fact they rewrite (#9739).
- The `memory/unattributed` page a first `remember` creates carries its `trust_tier` marker, so doctor `provenance_stamp_drift` stays ok on a fresh brain (#10286).
- The member and scope memory pages a first `remember` creates carry `captured_at`, so a content lint finds temporal provenance (#9945).
- A `fence_absent` hold clears once the page's facts fence parses again and its rows are already in sync, instead of staying in doctor `generation_held` forever (#10067).

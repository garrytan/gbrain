**Spending caps saved with `gbrain config set` now bind in every paid dream phase, a saved 0 spends nothing, and each `gbrain serve` maintenance sweep no longer re-reads unfenced facts it can never fence.**

<!-- behavior-change: dream_stored_caps_bind_gst3490 -->

### Fixed
- The calibration phases `propose_takes`, `grade_takes` and `calibration_profile` read their per-run cap only from the file config, so a cap saved with `gbrain config set` was never seen and the $5, $3 and $0.50 defaults always applied, even over a saved 0. They now read the saved cap, after an explicit caller value and the file config. Reported and first fixed by @tmarcatto (#9678).
- `extract_atoms`, `enrich_thin` and `conversation_facts_backfill` treated a saved cap of 0 as unset and ran under their defaults ($0.30, $1 or $5). A saved 0 now spends nothing, as it already did for `synthesize`, `drift` and the calibration phases' documented behavior.
- Every `gbrain serve` maintenance sweep read all unfenced active facts of the source, including those with no entity or no page, which it can never fence and which came back on the next sweep. On a Postgres brain with many unattributed facts and several serve processes this was most of the database egress. The sweep now counts those rows on the server and reads only the rows it can fence; its counters are unchanged. On a synthetic brain with 10,340 unfenced facts (10,000 with no entity), one sweep read 40 rows instead of 10,340. Reported by @joelsartain (#10005); first fixed by @Masashi-Ono0611 (#10009).

**Nightly learning now finds disagreeing facts by default, and fills thin pages by default when you have a chat key.**

<!-- behavior-change: nightly_learning_defaults -->

### Changed
- Claim conflicts run in every dream cycle by default (`dream.claim_conflicts.mode` unset now means `propose`). The phase is keyless and only files pending proposals; nothing changes until you decide. `gbrain config set dream.claim_conflicts.mode off` turns it off, and a stored value that is not `propose` still reads off.
- The `enrich_thin` phase runs by default when a chat model key you supplied is configured, and stays off without one. With `cycle.enrich_thin.enabled` unset it fills at most 3 thin pages per source per cycle run (about $0.01 a page), stops at $0.50 per run, and stops for the day at $0.50 across every run (`cycle.enrich_thin.max_daily_cost_usd` changes it). The brain-wide per-run cap (`cycle.enrich_thin.max_total_cost_usd`) now defaults to $0.50 instead of $5.00. `gbrain config set cycle.enrich_thin.enabled false` turns it off.
- Values you already stored for these keys are kept; nothing is rewritten on upgrade.
- On a keyless brain, the morning note's thin-contacts line now names only the key to export. It adds the `gbrain config set cycle.enrich_thin.enabled true` command only when you turned the phase off.

### Added
- `gbrain doctor` check `learning_note` reports the newest nightly learning run (when it ran, and its items by kind). It also gives, for the last 30 days of new facts, promises and filled-in pages, how many were shown and what share you kept or undid.

### For contributors
- `test/enrich-cycle-phase.test.ts` covers the default matrix (no key, key, stored false, stored true, stored caps kept) and the default daily cap. `test/claim-conflicts.test.ts` covers the unset, off, invalid and unreadable mode, and `test/doctor-learning-note.test.ts` covers the doctor check.

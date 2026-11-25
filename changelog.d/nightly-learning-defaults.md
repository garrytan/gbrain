**Nightly learning now finds facts that disagree by default, and doctor shows how the morning note is answered.**

<!-- behavior-change: nightly_learning_defaults -->

### Changed
- Claim conflicts run in every dream cycle by default (`dream.claim_conflicts.mode` unset now means `propose`). The phase is keyless and only files pending proposals; nothing changes until you decide. `gbrain config set dream.claim_conflicts.mode off` turns it off, and a stored value that is not `propose` still reads off.
- The `enrich_thin` phase stays off by default. Its brain-wide cap per cycle run (`cycle.enrich_thin.max_total_cost_usd`) now defaults to $0.50 instead of $5.00, for anyone who turned the phase on without setting that cap.
- Values you already stored for these keys are kept; nothing is rewritten on upgrade.
- `gbrain learned-undo` on a fact whose withdrawal was accepted but has not committed yet now reports "accepted, still being written" with the `gbrain write-request <id>` command, and the item stays pending. Undoing a disagreement that already expired from the note now answers it.

### Added
- `gbrain doctor` check `learning_note` reports the newest nightly learning run (when it ran, and its items by kind). It also gives, for the last 30 days of new facts, promises and filled-in pages, how many were shown and what share you kept or undid.

### For contributors
- `test/enrich-cycle-phase.test.ts` covers the phase staying off with and without a chat key, and the new $0.50 per-run default. `test/claim-conflicts.test.ts` covers the unset, off, invalid and unreadable mode, and `test/doctor-learning-note.test.ts` covers the doctor check.

# Fix-wave notes: capy/gbra35-defaults-on (GBRA-35)

Contributor branch for the next fix wave. No migration, no VERSION or CHANGELOG edits.

## CHANGELOG text

- **Atom extraction covers Gmail and Calendar pages again, by default (#5856 follow-up).** v0.60.32.0 made atom extraction of connector `email`/`meeting` pages opt-in, which also stopped it on brains that already extracted them. It is on by default again, on every brain, still bounded by the per-attempt auto-drain budget and the structural-refusal and fair-dispatch fixes from v0.60.32.0. To keep connector mail and calendar text away from the `extract_atoms` model: `foresights config set cycle.extract_atoms.connector_pages false` (`foresights config unset cycle.extract_atoms.connector_pages` returns to the default). `foresights config set autopilot.auto_drain.enabled false` still stops all automatic atom drains.

## Evidence

- `src/core/cycle/connector-atoms.ts`: unset means on; only `false`/`0`/`off`/`no` opt out.
- With the source change reverted: `test/connector-atom-pages.test.ts` 1 pass / 1 fail, `test/autopilot-auto-drain-dispatch.test.ts` 2 / 4, `test/managed-connector-job-contract.test.ts` 14 / 1. With it: 2/2, 6/6, 15/15.
- No stored `false` exists from v0.60.32.0 (the old default wrote no key), so no data migration is needed.

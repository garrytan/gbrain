# MBrain Phase 2 Context Map Staleness Implementation Plan

**Goal:** Add staleness-aware read behavior to persisted structural context maps without adding new operations or background refresh.

## Task 1: Lock stale disclosure in tests

- Add a service test proving:
  - initial build returns `ready`
  - a canonical note change makes the persisted map read as `stale`
  - explicit rebuild returns the map to `ready`
- Extend operation coverage so `map-get`/`map-list` reflect the stale view instead of the raw stored row.

## Task 2: Implement staleness-aware context-map reads

- Refactor context-map hashing into a shared helper.
- Add:
  - `getStructuralContextMapEntry`
  - `listStructuralContextMapEntries`
- Compute the current scope hash on read and overlay:
  - `status: stale`
  - `stale_reason: source_set_changed`

## Task 3: Fold stale detection into benchmark and verification

- Extend the phase 2 context-map benchmark so correctness includes stale disclosure.
- Update verification notes to include the stale-read expectation.

## Verification

Run:

```bash
bun test test/context-map-service.test.ts test/context-map-operations.test.ts test/phase2-context-map.test.ts
bun test test/cli.test.ts -t "map-build --help|map-get --help|map-list --help"
bun run bench:phase2-context-map --json
```

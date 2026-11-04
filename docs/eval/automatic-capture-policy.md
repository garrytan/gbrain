# Automatic capture: privacy and temporal validity checks

All inputs below are synthetic. These checks establish persistence and read
boundaries; they do not establish extraction-model semantic accuracy.

## Observed discrimination

The native `scripts/check-test-discriminates.sh` helper reverted
`src/core/facts/backstop.ts`, `src/core/facts/extract.ts` and
`src/core/persistence/facts-maintenance.ts` to
`b199426adc87b6947f16c135461259ffed3edb09` while retaining the policy test.
The run executed five passing and two failing tests. Source bytes were restored
exactly and the repaired tests passed. Failures were assertions, not imports.

A subsequent check exposed lost original observation time. With event grounding
off, a synthetic observation of `2025-01-01T12:00:00Z` and deadline
`2025-01-02T12:00:00Z` were replayed with a source time of
`2026-01-02T12:00:00Z`. The earlier implementation persisted the replay time as
`valid_from`, despite preserving the original deadline. The new regression
observed that wrong start time before repair. The fix propagates the validated
observation into `valid_from` for temporary captures, ahead of event/replay
fallbacks. Durable event grounding retains its existing contract.

Reproduce the temporal regression with the native discrimination helper,
reverting `src/core/facts/extract.ts` to the earlier PR head
`b23460508814dfa9d73d2c270534e6c90ef19d5c`. That run executed seven passing and one failing test; every source byte was restored. Then run:

```bash
bun test test/automatic-capture-policy.test.ts test/facts/extract-date-grounding.test.ts
```

## Covered behavior

- Work, personal, mixed and unknown claims take separate visibility decisions.
- Explicit private callers, private/non-work/unknown entity pages and folder
  restrictions cannot produce shared automatic facts.
- Exact private-history fingerprints remain private on recapture; original
  rows remain unchanged.
- Temporary start and expiry are original anchors with event grounding on or
  off, including a model-proposed date later than expiry.
- Active local/remote recall excludes expired rows; explicit historical recall
  retains them. Later replay preserves both temporal anchors.
- Managed facts fences and database-only writers preserve the same contract.

The policy and date-grounding suites passed 19 tests and 95 assertions.
`test/e2e/automatic-capture-policy-postgres.test.ts` exercises both writers on
real isolated PostgreSQL: two tests, 26 assertions, including exact old-row
preservation and fence date readback. The existing managed PostgreSQL caller
parity suite passed 14 tests and 116 assertions. Disposable test databases were
removed after each run.

## Validation fixture isolation

The wider gate exposed an existing crash-robot fixture that resolved `hooks`
through an inherited `core.hooksPath` before writing a refusal hook. Its
regression now supplies a synthetic foreign hook in a disposable Git config.
Before repair the test observed that hook being overwritten; after binding
the refusal hook to the fixture's own Git directory, the refusal contract
still passes and the foreign hook is unchanged (one test, four assertions).
Native validation runs use a disposable home and canonical temporary directory.
This is test-fixture isolation only; no production hook or Git setting changes.

## Wider baseline limits

The broader unit and PostgreSQL runs were stopped after unrelated baseline
failures were reproduced on untouched upstream `c3143dd4fb3014bd672a7c3488ff4f8640c0b1af`.
At the same 60-second test timeout, `test/setup-brain-first.test.ts` had 56
passing tests and three failures in default-install/turn-hook expectations.
`test/e2e/claude-plugin-install-real.serial.test.ts` also failed on upstream:
strict plugin validation treats its existing root-context warning as an error.
Final static verification passed 90 checks; its changelog comparison against
newer upstream release history failed, but passed separately against the pinned
contribution base `b199426adc87b6947f16c135461259ffed3edb09`. The vendor
PostgreSQL comparison skipped because its pinned download was unavailable.
These wider runs are not claimed green. The focused privacy, expiry and
fixture-isolation results above are independent of those baseline failures.

## Limits

The opt-in remains disabled by default. Semantic scope/lifetime classification
requires separate model evaluation on mixed, uncertain, quoted and replayed
input. Original dates missing from retained corpus text are not reconstructed.
The private-history guard is exact-fingerprint based, not a paraphrase proof.
No live activation or historical migration is part of these checks.

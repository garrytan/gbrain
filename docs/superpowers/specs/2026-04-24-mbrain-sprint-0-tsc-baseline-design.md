# Sprint 0 · `tsc` Baseline Cleanup Design

**Author:** scott.lee@rebellions.ai
**Date:** 2026-04-24
**Status:** Design — ready for implementation plan

---

## 1. Context

The repo has `"strict": true` in `tsconfig.json`, but CI only runs `bun install && bun test`. Bun's test runner does not typecheck. As a result, across PR #32–#36 reviews, multiple TS-level issues slipped through:

- `ALLOWED_TRANSITIONS` Record key missing a variant (should have been TS2741).
- `as any` casts hiding enum mismatch.
- Non-exhaustive switches returning `undefined` where the signature says `boolean`.

Running `bunx tsc --noEmit --pretty false` locally on `master` reports **836 errors** spread across core modules (`src/commands/migrate-engine.ts`, `src/core/engine-factory.ts`, `src/core/db.ts`, `src/core/postgres-engine.ts`, `test/scenarios/helpers.ts`, and more). A single "clean baseline" commit is therefore infeasible; it would bundle repo-wide cleanup with whatever feature ships alongside and make reviews unreadable.

## 2. Goal

Land a repo where `bunx tsc --noEmit` is green, then enable it in CI — without bundling cleanup into unrelated feature PRs.

## 3. Non-goals

- No behavior changes. Every commit in this track is type-only (or refactors that preserve runtime semantics).
- No functional improvements smuggled in. If a genuine bug surfaces during cleanup, file an issue and fix it in a separate PR.
- No Sprint 1 work. This track is independent.

## 4. Approach

Cleanup is split by **domain**, not by file. Each PR owns one coherent slice of the error inventory so reviewers can keep the slice in their head.

### 4.1 Proposed PR sequence

| PR | Slice | Likely hotspots | Approx. errors cleared |
|---|---|---|---|
| S0.1 | `src/commands/` and CLI entry paths | `migrate-engine.ts`, `files.ts`, `export.ts` | ~30 |
| S0.2 | `src/core/` engine layer (non-postgres) | `engine-factory.ts`, `sqlite-engine.ts`, `pglite-engine.ts`, `db.ts` | ~300 |
| S0.3 | `src/core/` postgres + types | `postgres-engine.ts`, type-level generic narrowing | ~250 |
| S0.4 | `src/core/services/` | operations-* and service files | ~150 |
| S0.5 | `test/` non-scenario suites | `test/**/*.test.ts` | ~80 |
| S0.6 | `test/scenarios/` helpers and remaining | `helpers.ts`, scenario helpers | ~20 |
| S0.7 | `ci: add bunx tsc --noEmit` | `.github/workflows/test.yml` one-line change | 0 (guard only) |

Exact counts are estimates from the 836 total. The cleanup PR authors refine the boundary — if one slice grows past ~150 changed lines, split further.

### 4.2 Ordering constraint

S0.7 (the CI step) must land **last**. If S0.7 lands before the other slices are green, every unrelated PR fails CI for the wrong reason. Recommended: S0.1 → S0.6 land first, then verify local `tsc` clean, then S0.7.

Within S0.1–S0.6, order is flexible — slices are independent.

### 4.3 Scope of fixes per PR

Each cleanup PR does **only** these transforms:

- Add explicit types where TS cannot infer (parameters, returns, generics).
- Replace `as any` with a proper narrowing pattern (`asEnum`, `assertNever`, `unknown` + type guard).
- Add missing Record/union variants to exhaustive switches (use `assertNever` sentinel).
- Correct generic bounds (e.g., the `UnwrapPromiseArray<T>` issues in `db.ts`).
- Fix incorrect cast targets (the `RedirectInfo` / `MarkerInfo` issues in `file-resolver.ts`).
- For `mkdirSync(undefined)` at `pglite-lock.ts:32`: add a defined-or-throw guard at the call site.

**Explicitly forbidden in these PRs:**

- `@ts-ignore` or `@ts-expect-error` without an accompanying issue link.
- Silencing an error by widening to `any` or `unknown` without a narrowing follow-up.
- Behavior changes, even "obvious improvements."
- Touching files outside the slice's named area.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A cleanup slice reveals an actual bug | Stop, file an issue, fix in a separate PR outside this track. The cleanup PR that surfaced it gets a comment linking the issue. |
| Generic narrowing changes behavior subtly | Run `bun test` after each slice; any test break means the fix changed semantics and must be re-done. |
| External library type updates break CI after S0.7 | `skipLibCheck: true` is already set. If a lib still breaks, pin the version or file targeted fix. |
| Reviewer fatigue on mechanical PRs | Slice PRs are each <150 changed lines. Review is a scan for the forbidden patterns (§4.3) rather than semantic review. |

## 6. Done criteria

- [ ] `bunx tsc --noEmit --pretty false` prints zero errors locally.
- [ ] CI `test` workflow runs `bunx tsc --noEmit --pretty false` before `bun test`.
- [ ] CI stays green on `master` after S0.7 lands.
- [ ] No `@ts-ignore` / `@ts-expect-error` introduced (verified by grep).
- [ ] No `as any` newly introduced (verified by grep diff against the pre-track baseline).

## 7. Rollback

S0.7 can be reverted by removing the one-line workflow change. S0.1–S0.6 are ordinary code commits and revert like any other — no schema or data implications.

## 8. Relationship to Sprint 1

Track A (this spec) and Track B (Sprint 1.0 → 1.1) are **independent**. They touch different files and different CI axes. They can be worked in parallel by different authors or interleaved by the same author.

Sprint 1 does not depend on S0.7 landing. Sprint 1 PRs are encouraged to include typechecked new code (since their authors should run `bunx tsc --noEmit` locally), but CI will only enforce it once S0.7 is merged.

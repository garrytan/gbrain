# Handoff

Date: 2026-06-15
Worktree: `/tmp/mbrain-canonical-target-proposals`
Branch: `feat/canonical-target-proposals`

This handoff intentionally excludes user work context, business context, real memory contents, and domain-specific source details. It only records technical implementation state needed to continue development.

## Current State

The branch already contains these earlier commits:

- `5c6334a docs: design canonical target proposals`
- `e628746 docs: plan canonical target proposal implementation`
- `9ec1ada feat(memory): add canonical target proposal storage`
- `229dd29 test(memory): cover canonical proposal migration edges`
- `de216b9 chore: clear lint warnings`

The uncommitted work at handoff completes the current implementation checkpoint for Task 2: canonical target proposal draft/create service plus storage support for same-slug refreshes.

## Implemented In This Checkpoint

Added `src/core/services/canonical-target-proposal-draft-service.ts`.

The service now supports:

- `createCanonicalTargetProposalDraft(engine, input)`
- `createCanonicalTargetProposal(engine, input)`
- `apply` defaulting to `false`
- eligible targetless candidate shapes
- refusal for terminal, refuted, missing-provenance, private/sensitive, already-targeted, or unsupported candidates
- deterministic draft classification into canonical proposal metadata
- no-proposal handling for low-value one-off task mechanics
- blocked drafts for unstable subject identity, likely duplicate, and hard slug-quality problems
- advisory slug-quality warnings that do not block proposal creation
- validation that a caller-supplied `proposal_kind` matches the namespace implied by `proposed_slug`
- idempotent same-slug refresh
- same-slug refresh payload updates without adding a fake status event
- `proposed -> blocked` refresh as a real status transition with a status event
- `blocked -> proposed` recovery by superseding the old blocked row and creating a fresh proposed row
- changed-slug supersession of the previous active proposal
- proposal/status-event-only mutation scope; no candidate binding, canonical page creation, approval, or promotion is performed here

Extended the engine API with `updateCanonicalTargetProposalDraft(id, patch)`.

Updated these storage implementations:

- `src/core/types/memory-governance.ts`
- `src/core/engine.ts`
- `src/core/sqlite-engine.ts`
- `src/core/pg-engine-base.ts`

The draft-refresh API updates draft payload fields and `updated_at` only. It preserves proposal status and lifecycle metadata such as approval, binding, rejection, and supersession fields.

## Tests Added Or Expanded

Added `test/canonical-target-proposal-service.test.ts`.

It covers:

- draft classification for eligible unresolved target shapes
- refusal paths
- blocked draft paths
- advisory vs hard slug-quality handling
- no-proposal paths
- `apply=false` default behavior
- mutation boundary checks
- idempotent create/refresh
- same-slug payload refresh
- blocked-row recovery through supersession
- blocked proposal refresh without duplicate active rows
- typed missing-candidate errors

Expanded `test/canonical-target-proposals-engine.test.ts`.

It now covers `updateCanonicalTargetProposalDraft()` for both SQLite and PGLite contracts, including:

- draft payload updates
- stale expected-status protection
- status preservation
- lifecycle metadata preservation
- refresh of superseded rows without changing supersession lineage

## Verification Already Run

Fresh verification was run before this handoff file was added:

```bash
bun test test/canonical-target-proposal-service.test.ts
bun test test/canonical-target-proposals-engine.test.ts
bun run typecheck
bun run lint
bun test test/canonical-target-proposal-service.test.ts test/canonical-target-proposals-engine.test.ts test/canonical-target-proposals-schema.test.ts test/migrate.test.ts test/memory-mutation-ledger-engine.test.ts test/memory-inbox-engine.test.ts
```

The broad related test run completed with:

- `64 pass`
- `2 skip`
- `0 fail`

The skipped tests require runtime configuration that was not present in this session.

Before continuing, rerun at least:

```bash
bun run typecheck
bun run lint
bun test test/canonical-target-proposal-service.test.ts test/canonical-target-proposals-engine.test.ts
git diff --check
```

For a broader confidence check, rerun:

```bash
bun test test/canonical-target-proposal-service.test.ts test/canonical-target-proposals-engine.test.ts test/canonical-target-proposals-schema.test.ts test/migrate.test.ts test/memory-mutation-ledger-engine.test.ts test/memory-inbox-engine.test.ts
```

## Review Notes Addressed

Two review passes were used during this checkpoint.

Issues addressed:

- public result types now use discriminated unions
- `apply` now defaults to dry-run behavior
- same-slug refresh updates payload instead of returning stale proposal data
- idempotent refresh no longer emits misleading status events
- blocked same-slug proposals can recover by supersession plus fresh proposed row
- advisory slug warnings no longer hard-block
- `proposal_kind` is included in draft refresh storage patches
- inconsistent `proposed_slug` and `proposal_kind` overrides are rejected
- direct engine coverage was added for draft-refresh metadata preservation

## Remaining Work

The next session should continue from the written plan:

- Task 3: governed proposal review and binding service
- Task 4: operation/MCP surfaces for proposal create/review/list flows
- Task 5: dream-cycle integration so eligible targetless candidates can generate proposals automatically
- Task 6: reporting/review-surface updates
- Task 7: documentation updates for the canonical target proposal workflow
- final cross-task review and integration decision

Do not assume Task 2 is merged into the main worktree. It is still on the isolated worktree branch until the current commit is created and later integrated.

## Continuation Checklist

1. Open `/tmp/mbrain-canonical-target-proposals`.
2. Run `git status --short --branch`.
3. Confirm the latest commit after this handoff exists.
4. Re-run the focused verification commands above.
5. Start Task 3 from `docs/superpowers/plans/2026-06-15-canonical-target-proposals.md`.
6. Keep proposal creation separate from approval, binding, and canonical page writes.
7. Use subagents for implementation/review slices, but keep write ownership disjoint.

# The brain store: The effect journal

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A page write queues post-commit work (links, Git, embedding, the withdrawal mirror, ...) as one
durable effect record per `(request, kind)`. The TypeScript effect runner
(`src/core/persistence/effect-journal.ts`, `effects.ts`, `effect-recovery.ts`) claims an effect, runs
it and completes it. These methods port the statements of
`src/core/engine-sql/persistence-effects.ts`, not their SQL. The runner, retries and what an
outcome means stay TypeScript.

There are no worktrees, refresh fences or recovery records. They exist for crash recovery of file
publication, which this engine does not do. So every effect read here has `recovery` null and
`recovery_bytes` 0, and a claimable effect is always one on no worktree. One process owns the brain
and one write transaction runs at a time, so a claim takes no row lock.

Keys (under `keys::PERSISTENCE`, `d`, documented in `persistence.rs`):

- `d E id(be8)`: the effect record, so key order is id order.
- `d e request-uuid 0x00 kind`: the `(request_id, kind)` uniqueness index; the value is the id (be8).
- meta `next_effect_id`: the id counter. Ids start at 1, as a `bigserial` does.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.selectClaimableEffect(hostId, deadOwners)` | the next claimable effect, or `null`: queued, running with an expired lease, or running under a claim whose owner is in `deadOwners`; due now; not behind its request's unfinished withdrawal mirror unless it is that mirror; the first by `(next_attempt_at, id)`. `hostId` names a worktree owner in TypeScript and changes nothing here | `selectClaimableEffect` |
| `brain.claimEffect(id, token, claimOwnerJson)` | the claimed effect: `running` under `token`, the owner stamp stored as JSON, a 2-minute lease and one more attempt; `null` for an unknown id | `claimEffect` |
| `brain.queueEffects({ requestId, revision, sourceId, sourceIncarnation, worktreeId, queued })` | the kinds inserted, in order. An effect the request already has for a kind is kept; a gated effect is skipped while auto-linking is off. An unknown request rejects with `constraint_violation` (the foreign key) | `queueEffects` |
| `brain.releaseAbandonedEffectClaims(cutoffIso)` | how many running effects last written before the cutoff went back to `queued`, their claim cleared and due now at the latest | `releaseAbandonedEffectClaims` |
| `brain.listMirrorGates(requestIds)` | `{ request_id, state, data }` for each withdrawal-mirror effect of these requests that has not committed, or committed with recorded publications (`data.published`); request then kind order | `listMirrorGates` |
| `brain.completeEffect(id, token, outcome)` | `true` when the effect claimed with `token` completed; `false` when no effect holds that claim. A null token never matches | `completeEffect` |
| `brain.completeEffects(rows, outcome)` | `completeEffect` over each `{ id, token }` with one outcome; how many still held their claim | `completeEffects` |
| `brain.hasRearmableEffects(requestIds)` | whether one of these requests has an unclaimed Git or embedding effect (queued or failed, not settled) with a target parked under `withdrawal_mirror_failed`, while the request's withdrawal mirror has committed | `hasRearmableEffects` |

An effect id crosses the boundary as a string or a number (`PersistenceEffect.id` is `string | number`); the TypeScript members send it as a string.

## TypeScript effect members

`src/core/rust-engine/store-members/effects.ts` answers these BrainEngine members on a Rust brain.
Each returns what PGLite returns for a brain with the same contents; `updated_at`,
`claim_expires_at` and `next_attempt_at` come back as `Date`s.

| Member | Answer | Why |
| --- | --- | --- |
| `selectClaimableEffect`, `claimEffect`, `queueEffects`, `releaseAbandonedEffectClaims`, `listMirrorGates`, `completeEffect`, `completeEffects`, `hasRearmableEffects` | the store method of the same name | Real effect records. Empty inputs answer without a call (`[]`, `0`, `false`). |
| `lockPersistenceBrainShare()` | nothing | One write transaction runs at a time, so nothing changes the brain row under a reader. |
| `requestsStillPublishing(worktreeId)` | `null` | The store keeps no recovery records, so no request recovers: `bool_and` over no rows. |
| `readSourceIncarnation(sourceId, { lock: 'share' })` | `{ incarnation, archived }` | The share lock changes nothing, for the same reason. `archived` is the source's archived flag. |

`releaseAbandonedClaims` runs its effect half only on PGLite (the caller checks
`engine.kind === 'pglite'`), so a Rust brain never calls `releaseAbandonedEffectClaims` from that path.

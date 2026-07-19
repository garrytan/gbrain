# Operation checkpoints and Minion jobs for downstream orchestrators

GBrain exposes two supported, complementary persistence surfaces for work that
outlives one process:

```ts
import { MinionQueue, MinionWorker } from 'gbrain/minions';
import {
  appendCompleted,
  clearOpCheckpoint,
  fingerprint,
  loadOpCheckpoint,
  recordCompleted,
  resumeFilter,
  type OpCheckpointKey,
} from 'gbrain/operation-checkpoints';
```

Use Minions for durable job submission, retry, cancellation, progress, and worker
execution. Use operation checkpoints for the completed item keys within one
replay-safe job. Both surfaces persist in the database owned by the supplied
`BrainEngine`; they do not resolve a brain, authorize a caller, or apply a source
ceiling for the host application.

## Checkpoint keys

A checkpoint is isolated by `(op, fingerprint)`. Consumer operation names must
use a stable namespace that cannot collide with gbrain's own operations. The
fingerprint must include every input that changes whether an item is complete,
including source identity and contract, manifest, extractor, or snapshot versions.

```ts
const key: OpCheckpointKey = {
  op: 'acme-example:corpus-extraction:v1',
  fingerprint: fingerprint({
    source_id: 'source-a',
    immutable_snapshot: 'tree-abc123',
    manifest_hash: 'sha256:manifest-example',
    extractor_version: '2.1.0',
  }),
};
```

The engine already selects the brain database. A source ID still belongs in the
fingerprint when one brain contains more than one source.

## Replace and append semantics

`recordCompleted(engine, key, keys)` atomically replaces the completed-key set.
`appendCompleted(engine, key, deltaKeys)` adds keys without rewriting the full
set. Both return `false` after their bounded direct-pool retries are exhausted;
correctness-sensitive callers must stop rather than continue work they cannot
bank.

`loadOpCheckpoint` reads both storage formats and de-duplicates the union.
`resumeFilter(all, completed)` is a pure helper for selecting pending keys.
`clearOpCheckpoint` removes a cleanly completed checkpoint idempotently.

## Deliberate limits

Operation checkpoints are bounded resume hints, not permanent idempotency rows,
completion receipts, or a convergence watermark:

- load errors are logged and returned as an empty completed set, so replayed work
  must be idempotent;
- clear and stale-checkpoint purge are best effort;
- gbrain maintenance may purge a checkpoint after seven inactive days; and
- the API does not provide authorization, source fencing, job admission, or an
  immutable source-snapshot receipt.

A downstream control plane should keep those governance facts in its own catalog
and use this checkpoint surface only where replay is safe. Permanent import
idempotency still needs an authoritative content or upstream identity contract;
it must not depend on a checkpoint surviving forever.

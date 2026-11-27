import type { SqlEngine } from './model.ts';
import { OperationError } from '../ops/contract.ts';
import { sha256 } from './digest.ts';
import { readWriterAdminState as readWriterAdminStateOver } from '../engine-sql/writer-admin.ts';
import type { BrainEngine } from '../engine.ts';

type WriterAdminStateEngine = Pick<BrainEngine, 'readWriterAdminState'>;

export const WRITER_INSPECTION_HINT = 'Inspect gbrain sources writer status --json on the selected brain host first to identify the designated owner and any recovery. Routine repair must not claim, activate, or transfer ownership. Ask the operator to review docs/architecture/topologies.md before a deliberate topology change.';

/**
 * The digest a reviewed `--expected-state` names: the SHA-256 of the writer topology's jsonb text. It is read through the
 * one statement (engine-sql/writer-admin.ts `readWriterAdminState`, source ids in byte order) that `assertWriterAdminState`
 * checks it against, so a digest taken here is never stale on arrival, whatever the server's locale. An engine that carries
 * the typed member answers it (a Rust brain does); an `executeRaw`-only handle (a persistence SqlEngine) runs the same statement.
 * A page embedding lease is per-page vector work, not writer topology, so it never invalidates a reviewed state.
 */
export async function writerAdminState(engine: SqlEngine | WriterAdminStateEngine): Promise<string> {
  return sha256('readWriterAdminState' in engine ? await engine.readWriterAdminState() : await readWriterAdminStateOver(engine));
}

/** Inside a transaction, `lock` holds the brain row and the topology tables until commit (a no-op on a Rust brain). */
export async function assertWriterAdminState(engine: WriterAdminStateEngine, expected: string | undefined, lock = true): Promise<void> {
  if (expected === undefined) return;
  if (sha256(await engine.readWriterAdminState({ lock })) !== expected) {
    throw new OperationError('writer_admin_state_changed', 'Writer topology changed since inspection; the administrative request was not applied.', WRITER_INSPECTION_HINT);
  }
}

export async function requireWriterAdminIntent(engine: WriterAdminStateEngine, operation: string, params: Record<string, unknown>): Promise<string | undefined> {
  if (params.dry_run === true) return;
  if (params.admin_intent !== operation || typeof params.expected_state !== 'string' || !/^[a-f0-9]{64}$/.test(params.expected_state)) {
    throw new OperationError('writer_admin_intent_required', 'Topology changes require an action-specific --admin-intent and the --expected-state from a reviewed writer status. A TTY, --yes, or --confirm-quiesced alone is not authorization.', WRITER_INSPECTION_HINT);
  }
  await assertWriterAdminState(engine, params.expected_state, false);
  return params.expected_state;
}

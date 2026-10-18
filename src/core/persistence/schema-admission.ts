/**
 * #6904: write admission while the brain's schema is behind this build.
 *
 * A build whose write path reads a table or column from a migration the brain has not applied
 * fails at publication with a Postgres 42703/42P01 after spending the caller's request id. So
 * admission reads the schema version (`config.version`) after its guard batch and, when it is
 * below `LATEST_SCHEMA_VERSION`, refuses `migrations_pending` (reason `schema_behind`) before
 * any request row exists: the request id is not consumed and the same id commits once the
 * schema is migrated. A replay of an already accepted id is judged first and still reconciles.
 * The `apply-migrations` orchestrators that write mid-upgrade run while this process holds the
 * orchestration lock and are never refused. A missing or unparsable version is not judged here.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { LATEST_SCHEMA_VERSION } from '../schema-migrations/latest.generated.ts';

export const SCHEMA_BEHIND_REASON = 'schema_behind';

/** Whether the brain's schema version is below this build's; null when it cannot be read. A terminal-receipt reader's input. */
export async function readSchemaBehind(engine: Pick<BrainEngine, 'executeRaw'>): Promise<boolean | null> {
  try {
    const [row] = await engine.executeRaw<{ value: string | null }>(`SELECT value FROM config WHERE key='version'`);
    const current = Number.parseInt(row?.value ?? '', 10);
    return Number.isSafeInteger(current) ? current < LATEST_SCHEMA_VERSION : null;
  } catch {
    return null;
  }
}

/** The fix of a schema-behind refusal: apply-migrations as the schema owner, verified read-only with doctor. */
export function schemaBehindFix(ownsSchema: boolean): Action {
  return { argv: ['gbrain', 'apply-migrations', '--yes'], consent: [], actor: ownsSchema ? 'agent' : 'host_admin', requires_exclusive: true,
    why: 'Applies the pending schema migrations. It needs a database role that owns the gbrain tables; then resubmit the write (the same request_id works, nothing was admitted).',
    ...(ownsSchema ? {} : { user_message: 'The brain schema is behind this gbrain build and this connection\'s database role does not own the gbrain tables. Run gbrain apply-migrations --yes on the brain host as the role that owns them, then I will resubmit the write.' }),
    verify: { argv: ['gbrain', 'doctor', '--json'] }, docs: 'docs/guides/write-refusals.md#schema_behind' };
}

/**
 * Called by admission after the guard batch and after an accepted request id's replay has returned: the refusal to
 * raise for a new request, or null.
 */
export async function schemaAdmissionRefusal(tx: BrainEngine): Promise<OperationError | null> {
  const [row] = await tx.executeRaw<{ value: string | null }>(`SELECT value FROM config WHERE key='version'`);
  const current = Number.parseInt(row?.value ?? '', 10);
  if (!Number.isSafeInteger(current) || current >= LATEST_SCHEMA_VERSION) return null;
  // Loaded only when behind: the lock module pulls in the engine factory.
  if ((await import('../migration-orchestration-lock.ts')).migrationOrchestrationHeldHere()) return null;
  const [owner] = await tx.executeRaw<{ owns: boolean | null }>(
    `SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS owns FROM pg_class c WHERE c.oid = to_regclass('sources')`);
  const ownsSchema = owner?.owns !== false;
  return opError('migrations_pending', `The brain schema is at v${current} and this gbrain build needs v${LATEST_SCHEMA_VERSION}, so the write was not admitted.`,
    `Not retryable as is: the same write refuses until the schema is migrated. Apply the pending migrations with \`gbrain apply-migrations --yes\`${ownsSchema ? '' : ' as the database role that owns the gbrain tables (this connection\'s role does not)'}, then resubmit; nothing was admitted, so the same request_id commits.`,
    { reason: SCHEMA_BEHIND_REASON, why: 'The write path of this build reads tables or columns that only the pending migrations add, so publishing now would fail on the missing schema and spend the request id.',
      fix: schemaBehindFix(ownsSchema) });
}

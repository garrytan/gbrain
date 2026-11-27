/**
 * The persistence protocol declaration (BrainEngine declarePersistence): one SQL text for both engines.
 *
 * One SELECT of transaction-local settings that declares protocol 2 and, for a durable write, synchronous commit and
 * the lock, statement and (optionally) idle-in-transaction timeouts, then reads the brain row FOR SHARE in the same
 * statement. The text is the one `src/core/persistence/protocol.ts` has always sent, byte for byte: the connection
 * matches it to send it before BEGIN's answer (`isPersistenceDeclaration`, `TransactionOptions.pipelineFirst`), and
 * tests match it too. Both engines send it through their own `executeRaw`, so a transaction engine declares inside its
 * transaction. This module imports no persistence code.
 */
import type { BrainEngine } from '../engine.ts';

/** The brain row FOR SHARE, the last column of every declaration. */
export const BRAIN_SHARE = '(SELECT brain_id::text FROM persistence_brain WHERE singleton=1 FOR SHARE) AS brain';

/** The durable-write settings a declaration may carry. `idleInTransaction` is set first, in the same statement. */
export interface DurablePersistenceSettings {
  lockTimeout: string;
  statementTimeout: string;
  idleInTransaction?: string;
}

/** The three declarations, written out in full (no composed text): protocol only, durable, durable with the idle bound. */
const PROTOCOL_ONLY = "SELECT set_config('gbrain.persistence_protocol','2',true),(SELECT brain_id::text FROM persistence_brain WHERE singleton=1 FOR SHARE) AS brain";
const DURABLE = `SELECT set_config('gbrain.persistence_protocol','2',true),set_config('synchronous_commit','on',true),
    set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),(SELECT brain_id::text FROM persistence_brain WHERE singleton=1 FOR SHARE) AS brain`;
const DURABLE_IDLE = `SELECT set_config('idle_in_transaction_session_timeout',$3,true),set_config('gbrain.persistence_protocol','2',true),set_config('synchronous_commit','on',true),
    set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),(SELECT brain_id::text FROM persistence_brain WHERE singleton=1 FOR SHARE) AS brain`;

/** Every text `declarePersistence` can send (settings and the brain row FOR SHARE; no row written): the shadow write sampler judges the member by them (shadow/write-capture.ts). */
export const PERSISTENCE_DECLARATION_SQL: readonly string[] = [PROTOCOL_ONLY, DURABLE, DURABLE_IDLE];

/** Synchronous commit for the rest of the transaction, alone: the statement journal.ts `completeWrite` has always sent. */
export const SYNCHRONOUS_COMMIT_SQL = "SELECT set_config('synchronous_commit','on',true)";

/** The declaration statement and its parameters. */
export function persistenceDeclarationStatement(durable?: DurablePersistenceSettings): { sql: string; params: string[] } {
  if (!durable) return { sql: PROTOCOL_ONLY, params: [] };
  return durable.idleInTransaction === undefined
    ? { sql: DURABLE, params: [durable.lockTimeout, durable.statementTimeout] }
    : { sql: DURABLE_IDLE, params: [durable.lockTimeout, durable.statementTimeout, durable.idleInTransaction] };
}

/** Sends the declaration through `engine.executeRaw` and returns the brain id read under it (null when the row is missing). */
export async function declarePersistence(engine: Pick<BrainEngine, 'executeRaw'>, durable?: DurablePersistenceSettings): Promise<string | null> {
  const { sql, params } = persistenceDeclarationStatement(durable);
  const [row] = params.length
    ? await engine.executeRaw<{ brain: string | null }>(sql, params)
    : await engine.executeRaw<{ brain: string | null }>(sql);
  return row?.brain ?? null;
}

/** Sends `SYNCHRONOUS_COMMIT_SQL` through `engine.executeRaw`: this transaction's commit waits for the flush. */
export async function requireSynchronousCommit(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
  await engine.executeRaw(SYNCHRONOUS_COMMIT_SQL);
}

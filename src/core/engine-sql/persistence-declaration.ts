

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

/** Synchronous commit for the rest of the transaction, alone: the statement journal.ts `completeWrite` has always sent. */
export const SYNCHRONOUS_COMMIT_SQL = "SELECT set_config('synchronous_commit','on',true)";

/** The declaration statement and its parameters. */
export function persistenceDeclarationStatement(durable?: DurablePersistenceSettings): { sql: string; params: string[] } {
  if (!durable) return { sql: PROTOCOL_ONLY, params: [] };
  return durable.idleInTransaction === undefined
    ? { sql: DURABLE, params: [durable.lockTimeout, durable.statementTimeout] }
    : { sql: DURABLE_IDLE, params: [durable.lockTimeout, durable.statementTimeout, durable.idleInTransaction] };
}

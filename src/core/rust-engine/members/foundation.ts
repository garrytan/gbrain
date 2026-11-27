/** The lifecycle, raw SQL, schema and transaction members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const FOUNDATION_MEMBERS = {
  // implemented
  kind: 'implemented',
  capabilities: 'implemented',
  connect: 'implemented',
  disconnect: 'implemented',
  reconnect: 'implemented',
  registerBeforeDisconnect: 'implemented',
  // raw_sql
  withReservedConnection: 'raw_sql',
  executeRaw: 'raw_sql',
  executeRawDirect: 'raw_sql',
  keywordBoundedRead: 'raw_sql',
  runMigration: 'raw_sql',
  // schema
  initSchema: 'schema',
  // Optional on BrainEngine: only Postgres defines it. The Rust engine leaves it undefined, so a migration serializes
  // in-process (schema-migration-lock.ts), as on PGLite, and `schema` can be reported.
  holdSchemaMigrationLock: 'implemented',
  // The state of the SQL delete triggers behind owner_only_marks (migration v322), served from the store, which marks
  // in code on every delete path and so never misses a trigger (store-members/owner-only-marks.ts).
  ownerOnlyMarkTriggers: 'schema',
  // transactions
  readTransactionSettings: 'transactions',
  applyTransactionSettings: 'transactions',
  beginSnapshotRead: 'transactions',
  setLocalStatementTimeout: 'transactions',
  readCurrentWriteTrust: 'transactions',
  transaction: 'transactions',
  transactionDirect: 'transactions',
  lockPageKeys: 'transactions',
  declarePersistence: 'transactions',
  requireSynchronousCommit: 'transactions',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;

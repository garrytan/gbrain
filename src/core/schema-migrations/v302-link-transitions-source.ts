import type { BrainEngine } from '../engine.ts';
import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice, runMigrationStatement } from './helpers.ts';
import { isLockTimeoutError } from '../retry-matcher.ts';
import { migrationStatementTimeoutMs } from '../migration-timeout.ts';
import { resolveSchemaLockTimeoutMs, schemaLockBlockedError } from '../postgres-engine/schema-lock-timeout.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-2228: link_transitions.link_source names the links-section row a manual
// dated statement came from, and the identity index includes it, so two rows of
// one relationship (same page, target and type, different sources) keep their
// own dates. No row is rewritten: statements written before this keep a NULL
// source, and NULLS NOT DISTINCT keeps them colliding with each other as before.
//
// The column is nullable with no default, so adding it changes only metadata;
// it runs under the schema lock timeout. The index is never rebuilt inside a
// transaction (that would hold ACCESS EXCLUSIVE on link_transitions for the
// whole build): buildIndexOnline builds the widened index under a temporary
// name (CONCURRENTLY on Postgres, dropping an INVALID leftover of an
// interrupted build first), then one short transaction drops the old index and
// renames the new one into its place, so the canonical name exists at every
// moment. A rerun after any interruption finishes the job. The schema blob's
// CREATE UNIQUE INDEX IF NOT EXISTS under the canonical name is a no-op on an
// upgraded brain (the forward-reference bootstrap adds the column first).
export const LINK_TRANSITIONS_IDENTITY_INDEX = 'link_transitions_identity_idx';
export const LINK_TRANSITIONS_IDENTITY_NEXT_INDEX = {
  name: 'link_transitions_identity_next_idx',
  table: 'link_transitions',
  sql: `CREATE UNIQUE INDEX IF NOT EXISTS link_transitions_identity_next_idx
  ON link_transitions (origin_page_id, from_page_id, to_page_id, link_type, link_source, kind, occurred_on, producer) NULLS NOT DISTINCT`,
};

const POSTGRES_15_GATE = `DO $$ BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'v302 migration requires Postgres 15+. Current: %. '
      'Upgrade your Postgres (Supabase: migrate project to a newer PG major). '
      'This migration intentionally stops before touching the schema to preserve data integrity.',
      current_setting('server_version');
  END IF;
END $$`;

/** Whether the canonical identity index already includes link_source (fresh install, or a finished swap). */
export async function identityIndexHasSource(engine: Pick<BrainEngine, 'executeRaw'>): Promise<boolean> {
  const [row] = await engine.executeRaw<{ has: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indexrelid = to_regclass($1) AND a.attname = 'link_source') AS has`, [LINK_TRANSITIONS_IDENTITY_INDEX]);
  return row?.has === true;
}

/** The swap: drop the old index and rename the built one into its place, under the schema lock timeout. */
export async function swapIdentityIndex(engine: BrainEngine): Promise<void> {
  const lockTimeoutMs = resolveSchemaLockTimeoutMs();
  try {
    await engine.transaction(async tx => {
      if (engine.kind === 'postgres') {
        await tx.executeRaw(`SET LOCAL statement_timeout = '${migrationStatementTimeoutMs()}'`);
        await tx.executeRaw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      }
      await tx.executeRaw(`DROP INDEX IF EXISTS ${LINK_TRANSITIONS_IDENTITY_INDEX}`);
      await tx.executeRaw(`ALTER INDEX ${LINK_TRANSITIONS_IDENTITY_NEXT_INDEX.name} RENAME TO ${LINK_TRANSITIONS_IDENTITY_INDEX}`);
    });
  } catch (error) {
    if (engine.kind === 'postgres' && isLockTimeoutError(error)) {
      throw schemaLockBlockedError({ step: 'migration v302 (link_transitions identity index swap)', timeoutMs: lockTimeoutMs, sessions: null, sampledDuringWait: false });
    }
    throw error;
  }
}

async function widenIdentityIndex(engine: BrainEngine): Promise<void> {
  const built = await buildIndexOnline(engine, 302, LINK_TRANSITIONS_IDENTITY_NEXT_INDEX, { notice: migrationNotice });
  if (built === 'building') throw new Error(`${LINK_TRANSITIONS_IDENTITY_NEXT_INDEX.name} is being built by another session; rerun the migration once it finishes`);
  await swapIdentityIndex(engine);
}

export const v302: Migration = {
  version: 302,
  name: 'link_transitions_source',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await runMigrationStatement(engine, 302, POSTGRES_15_GATE);
    await runMigrationStatement(engine, 302, 'ALTER TABLE link_transitions ADD COLUMN IF NOT EXISTS link_source TEXT');
    if (await identityIndexHasSource(engine)) return;
    await widenIdentityIndex(engine);
  },
};

/**
 * The policy-store migration journal (`access_policy_migrations`, access/policy-migrate.ts): one SQL implementation for
 * both engines. Each statement is the text policy-migrate.ts ran through `executeRaw`, byte for byte. The receipts go
 * in as JSON text (`$N::text::jsonb`), never as a driver-serialised object. `switchAccessMigration` runs inside the
 * caller's transaction, on the executor it is given.
 */
import type { AccessPolicyExec } from './access-policy.ts';

/** The newest unfinished migration of a source: its id, phase, direction and the receipts of the phases done. */
export interface AccessMigrationRow { id: string; phase: string; direction: string; receipts: Record<string, unknown> }

const UNFINISHED_SQL = `SELECT id, phase, direction, receipts FROM access_policy_migrations WHERE source_id = $1 AND phase <> 'switched' ORDER BY created_at DESC LIMIT 1`;
const INSERT_SQL = `INSERT INTO access_policy_migrations (id, source_id, direction, phase) VALUES ($1, $2, $3, 'started')`;
const PHASE_SQL = 'UPDATE access_policy_migrations SET phase = $2, receipts = $3::text::jsonb, updated_at = now() WHERE id = $1';
const SWITCHED_SQL = `UPDATE access_policy_migrations SET phase = 'switched', receipts = $2::text::jsonb, updated_at = now() WHERE id = $1`;

/** The source's newest migration whose phase is not `switched`, or null. */
export async function readUnfinishedAccessMigration(exec: AccessPolicyExec, sourceId: string): Promise<AccessMigrationRow | null> {
  const [row] = await exec.executeRaw<{ id: string; phase: string; direction: string; receipts: unknown }>(UNFINISHED_SQL, [sourceId]);
  if (!row) return null;
  return { ...row, receipts: (typeof row.receipts === 'string' ? JSON.parse(row.receipts) : row.receipts) as Record<string, unknown> ?? {} };
}

/** Journals a migration at phase `started`; the table refuses an id it has, a direction other than `to_git` or `to_database` and a source with no access state. */
export async function insertAccessMigration(exec: AccessPolicyExec, row: { id: string; sourceId: string; direction: string }): Promise<void> {
  await exec.executeRaw(INSERT_SQL, [row.id, row.sourceId, row.direction]);
}

/** Sets a migration's phase (`started`, `exported`, `committed` or `switched`; the table refuses any other) and receipts, and its update time. */
export async function recordAccessMigrationPhase(exec: AccessPolicyExec, id: string, phase: string, receipts: Record<string, unknown>): Promise<void> {
  await exec.executeRaw(PHASE_SQL, [id, phase, JSON.stringify(receipts)]);
}

/** Marks a migration `switched` with its receipts, in the transaction that switches the store. */
export async function switchAccessMigration(exec: AccessPolicyExec, id: string, receipts: Record<string, unknown>): Promise<void> {
  await exec.executeRaw(SWITCHED_SQL, [id, JSON.stringify(receipts)]);
}

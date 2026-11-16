/**
 * W3 (GBRA-224): the audit trail of the free self-heals (dream write deferral,
 * embedding signature restamp). Each heal step appends one row with a stable
 * code, the attempt number and the bound it is counted against. Rows live in
 * the brain's config table (`heal.audit`), newest last, capped at
 * HEAL_AUDIT_MAX_ROWS and pruned after 30 days, so every brain (repo-less
 * included) keeps the trail without a migration. A heal that writes state
 * passes its own transaction so the state change and its row commit together.
 */
import type { BrainEngine } from './engine.ts';

export const HEAL_AUDIT_KEY = 'heal.audit';
export const HEAL_AUDIT_MAX_ROWS = 200;
const HEAL_AUDIT_RETENTION_MS = 30 * 24 * 3_600_000;

export interface HealAuditRow {
  at: string;
  /** Stable heal code, e.g. `dream_write_deferred`, `embedding_restamp`. */
  code: string;
  /** What this step did: deferred, replayed, committed, failed, escalated, restamped, ... */
  outcome: string;
  /** Attempt number within the heal's bound (0 for a first deferral). */
  attempt: number;
  bound: number;
  subject: string;
  request_id?: string;
  detail?: string;
}

export type HealAuditInput = Omit<HealAuditRow, 'at'>;

/** Whether a heal is on: its config key is unset or anything but `false`/`0`/`off`. */
export async function healEnabled(engine: Pick<BrainEngine, 'getConfig'>, key: string): Promise<boolean> {
  const raw = (await engine.getConfig(key))?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

function parseRows(raw: string | null | undefined): HealAuditRow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((row): row is HealAuditRow => !!row && typeof row === 'object'
      && typeof (row as HealAuditRow).code === 'string' && typeof (row as HealAuditRow).at === 'string') : [];
  } catch { return []; }
}

export async function readHealAudit(engine: Pick<BrainEngine, 'getConfig'>, code?: string): Promise<HealAuditRow[]> {
  const rows = parseRows(await engine.getConfig(HEAL_AUDIT_KEY));
  return code ? rows.filter(row => row.code === code) : rows;
}

/** Append rows (database clock), serialized on the config row. Pass the heal's transaction to commit with its state. */
export async function recordHealAudit(tx: Pick<BrainEngine, 'executeRaw'>, rows: HealAuditInput[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.executeRaw("INSERT INTO config (key, value) VALUES ($1, '[]') ON CONFLICT (key) DO NOTHING", [HEAL_AUDIT_KEY]);
  const [row] = await tx.executeRaw<{ value: string; now: string }>(
    `SELECT value, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now FROM config WHERE key=$1 FOR UPDATE`, [HEAL_AUDIT_KEY]);
  const cutoff = Date.parse(row!.now) - HEAL_AUDIT_RETENTION_MS;
  const kept = parseRows(row?.value).filter(entry => Date.parse(entry.at) > cutoff);
  const next = [...kept, ...rows.map(entry => ({ at: row!.now, ...entry }))].slice(-HEAL_AUDIT_MAX_ROWS);
  await tx.executeRaw('UPDATE config SET value=$2 WHERE key=$1', [HEAL_AUDIT_KEY, JSON.stringify(next)]);
}

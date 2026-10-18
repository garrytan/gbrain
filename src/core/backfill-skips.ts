/**
 * Skipped backfill rows (GBRA-130 A-47): the durable record of rows a
 * `runBackfill` could not write, in config key `backfill.<name>.skipped`.
 *
 * A row whose compute or UPDATE fails with an item-scoped error is recorded
 * here before the checkpoint moves past it, so it is never skipped silently:
 * every later run retries each recorded row that still needs the backfill and
 * drops the record once the row lands or no longer matches. A content failure
 * (classifyItemFailure class `content`, such as a CHECK violation) on 3
 * consecutive runs at the same row revision (a hash of the selected columns)
 * and the same gbrain version is held: later runs report it without retrying
 * it until the row or the version changes, or `gbrain backfill <name> --fresh`
 * walks every pending row again. A transient failure is never held.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import type { ItemFailure } from './item-failure.ts';

export const BACKFILL_HOLD_RUNS = 3;

export interface BackfillSkipRecord {
  id: number;
  code: string;
  class: 'content' | 'transient';
  message: string;
  /** Hash of the row's selected columns when it last failed. */
  revision: string;
  /** The gbrain version that last attempted it. */
  producer: string;
  /** Consecutive runs that failed it at this revision, version and class. */
  attempts: number;
  state: 'failing' | 'held';
  first_failed_at: string;
  last_failed_at: string;
}

export interface BackfillSkipLedger { version: 1; items: Record<string, BackfillSkipRecord> }

/** One recorded row as a backfill result reports it; `fix` is the command that retries it. */
export interface BackfillSkip {
  key: string;
  id: number;
  code: string;
  class: 'content' | 'transient';
  state: 'failing' | 'held';
  attempts: number;
  message: string;
  fix: string;
}

export function skipLedgerKey(name: string): string {
  return `backfill.${name}.skipped`;
}

/** The stored ledger as text (null when absent): runBackfill restores it exactly when a run stops systemic. */
export async function readSkipLedgerRaw(engine: BrainEngine, name: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1 LIMIT 1', [skipLedgerKey(name)]);
  return rows[0]?.value ?? null;
}

export function parseSkipLedger(raw: string | null): BackfillSkipLedger {
  try {
    const parsed = raw ? JSON.parse(raw) as Partial<BackfillSkipLedger> : null;
    if (parsed?.version === 1 && parsed.items && typeof parsed.items === 'object') return { version: 1, items: parsed.items };
  } catch { /* an unreadable ledger is treated as empty; the next write replaces it */ }
  return { version: 1, items: {} };
}

export async function restoreSkipLedger(engine: BrainEngine, name: string, raw: string | null): Promise<void> {
  if (raw === null) await engine.executeRaw('DELETE FROM config WHERE key = $1', [skipLedgerKey(name)]);
  else await engine.setConfig(skipLedgerKey(name), raw);
}

export function rowRevision(row: unknown): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 16);
}

/** A held record whose row and gbrain version are unchanged: reported, not retried. */
export function heldUnchanged(record: BackfillSkipRecord | undefined, revision: string, producer: string): boolean {
  return record?.state === 'held' && record.revision === revision && record.producer === producer;
}

/** Counts one run's failure of a row: consecutive at the same revision, version and class; held at BACKFILL_HOLD_RUNS content failures. */
export function noteSkip(ledger: BackfillSkipLedger, id: number, revision: string, failure: ItemFailure, now: string, producer: string): void {
  const prev = ledger.items[String(id)];
  const consecutive = prev && prev.revision === revision && prev.producer === producer && prev.class === failure.class;
  const attempts = consecutive ? prev.attempts + 1 : 1;
  ledger.items[String(id)] = {
    id, code: failure.code, class: failure.class, message: failure.message.slice(0, 300), revision, producer, attempts,
    state: failure.class === 'content' && attempts >= BACKFILL_HOLD_RUNS ? 'held' : 'failing',
    first_failed_at: consecutive ? prev.first_failed_at : now, last_failed_at: now,
  };
}

export function reportSkips(ledger: BackfillSkipLedger, name: string): BackfillSkip[] {
  return Object.values(ledger.items).sort((a, b) => a.id - b.id).map(record => ({
    key: String(record.id), id: record.id, code: record.code, class: record.class, state: record.state, attempts: record.attempts,
    message: record.message, fix: record.state === 'held' ? `gbrain backfill ${name} --fresh` : `gbrain backfill ${name}`,
  }));
}

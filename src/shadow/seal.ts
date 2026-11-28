/**
 * Carrying a clean follower from one serving process to the next (shadow follow). The child side is follow-child.ts
 * ("Sealing"); this is the serving side: the database checks that decide whether a seal may be written at close and
 * whether the next session may trust it.
 *
 * A seal says "every write this process committed is in the store or held as an obligation". What it cannot see is a
 * write by someone else. Wrapped gbrain processes leave a trace the child checks itself (they own the store in turn and
 * rewrite follower.json, or leave a line in follower-invalidations.jsonl). On a Postgres primary the writer hooks
 * (writer-hooks.ts) record every other writing connection in engine_writer_sessions, so:
 *  - at close (`sealMark`), no seal is written while another process's connection to this database has a write
 *    transaction open, or wrote less than the hooks' 10 minute refresh ago and is still connected (its next write would
 *    leave no new row). This process's own connections are left out: what they commit is published to the follower,
 *    and a write it publishes after the follower closed is recorded as lost (follower.ts `close`), which voids the seal;
 *  - at the next start (`confirmSeal`), the seal is confirmed only when the writer evidence of every other process is
 *    exactly what it was at the seal (no new writer row, no moved `last_seen`, no new coverage gap) and every brain
 *    table still has a working hook.
 * Row security is switched off inside these reads, so a policy that would hide a row makes the read fail (no seal)
 * instead of returning fewer rows. Any error, a timeout, or hooks that are not installed: no seal, or no confirmation.
 * PGLite has no hooks; one process opens it at a time, and the child's own checks are all there is.
 */
import type { ReadSource } from './read-pool.ts';
import { hooksIntact, readWriterHooksManifest } from './writer-hooks.ts';

const SEAL_READ_MS = 2_000;

/** Whether this primary is checked through writer hooks (Postgres) or not at all (PGLite). */
export interface SealDeps {
  dir: string;
  reads: ReadSource;
  postgres: boolean;
  rpc: <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
}

/**
 * The writer evidence other processes have left, as a fingerprint: how many writer-session rows (and their latest
 * `last_seen`) belong to any connection but the sealing process's own, and how many coverage gaps there are (and the
 * latest). The hook only ever inserts a row or moves a row's `last_seen` to the current clock, so any write recorded
 * after the seal changes the fingerprint; a pruned row changes it too, which only refuses a seal. No timestamp is
 * compared with the seal's: a write recorded after the mark can carry an earlier clock reading than the mark.
 */
const FINGERPRINT_SQL = (others: string) => `
  (SELECT count(*)::int FROM engine_writer_sessions WHERE ${others}) AS writers,
  (SELECT coalesce(max(last_seen)::text, '') FROM engine_writer_sessions WHERE ${others}) AS writers_max,
  (SELECT count(*)::int FROM engine_writer_coverage_gaps) AS gaps,
  (SELECT coalesce(max(created_at)::text, '') FROM engine_writer_coverage_gaps) AS gaps_max`;

const SEAL_MARK_SQL = `SELECT current_setting('application_name') AS app,
  (SELECT count(*)::int FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'transactionid' AND l.mode = 'ExclusiveLock' AND l.granted
      AND a.datname = current_database() AND a.application_name <> current_setting('application_name')) AS writing,
  (SELECT count(*)::int FROM engine_writer_sessions s
    WHERE s.application_name <> current_setting('application_name')
      AND s.last_seen > clock_timestamp() - interval '600 seconds'
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid = s.backend_pid AND a.datname = current_database())) AS live,
  ${FINGERPRINT_SQL("application_name <> current_setting('application_name')")}`;

/**
 * At the next start: the same fingerprint, leaving out the sealing process (named in the mark) and this one (its name
 * carries its pid and a nonce, so it had no row at the mark).
 */
const SINCE_SQL = `SELECT ${FINGERPRINT_SQL("application_name <> $1 AND application_name <> current_setting('application_name')")}`;

/** What a Postgres seal records: the sealing process's connection name and the writer evidence fingerprint then. */
interface Mark { app: string; writers: number; writers_max: string; gaps: number; gaps_max: string }

const bounded = <T>(work: Promise<T>, onTimeout: T): Promise<T> => Promise.race([
  work,
  new Promise<T>((resolve) => { const t = setTimeout(() => resolve(onTimeout), SEAL_READ_MS); (t as { unref?: () => void }).unref?.(); }),
]);

const isMark = (v: unknown): v is Mark => {
  const m = v as Mark;
  return !!m && typeof m.app === 'string' && Number.isInteger(m.writers) && typeof m.writers_max === 'string' && Number.isInteger(m.gaps) && typeof m.gaps_max === 'string';
};

/**
 * The mark to seal with: a token naming the writer evidence on the primary (Postgres), null (PGLite: nothing to check),
 * or undefined when no seal may be written (another process may still write unrecorded, the hooks are not installed, or
 * the read failed or timed out). The child keeps the token as it is and hands it back at the next start.
 */
export async function sealMark(d: Pick<SealDeps, 'dir' | 'reads' | 'postgres'>): Promise<string | null | undefined> {
  if (!d.postgres) return null;
  if (readWriterHooksManifest(d.dir)?.state !== 'installed') return undefined;
  const read = d.reads.read(async (_tx, query) => {
    await query('SET LOCAL row_security = off');
    const [row] = await query(SEAL_MARK_SQL);
    if (!row || row.writing !== 0 || row.live !== 0) return undefined;
    const mark = { app: row.app, writers: row.writers, writers_max: row.writers_max, gaps: row.gaps, gaps_max: row.gaps_max };
    return isMark(mark) ? JSON.stringify(mark) : undefined;
  }).catch(() => undefined);
  return bounded(read, undefined);
}

/** Whether the writer evidence is what the mark recorded (nobody else wrote, no gap), with every hook still working. */
export async function quietSince(d: Pick<SealDeps, 'dir' | 'reads' | 'postgres'>, token: string | null): Promise<boolean> {
  if (!d.postgres) return true;
  if (token === null || readWriterHooksManifest(d.dir)?.state !== 'installed') return false;
  let mark: unknown;
  try { mark = JSON.parse(token); } catch { return false; } // silent-read-ok: an unreadable mark refuses the seal
  if (!isMark(mark)) return false;
  const read = d.reads.read(async (tx, query) => {
    await query('SET LOCAL row_security = off');
    const [row] = await query(SINCE_SQL, [mark.app]);
    return !!row && row.writers === mark.writers && row.writers_max === mark.writers_max && row.gaps === mark.gaps && row.gaps_max === mark.gaps_max
      && await hooksIntact(tx);
  }).catch(() => false);
  return bounded(read, false);
}

/**
 * Confirms (or refuses) the seal the owner child took over at its start, if there is one. Never rejects. A child that
 * took no seal, or a read that fails, changes nothing: the session's own full obligation stays until a full pass.
 */
export async function confirmSeal(d: SealDeps): Promise<void> {
  try {
    const state = await d.rpc<{ pending_seal?: { db_at: string | null } | null }>('state', {}, 10_000);
    const pending = state?.pending_seal;
    if (!pending) return;
    const ok = await quietSince(d, pending.db_at ?? null);
    await d.rpc('confirmSeal', { db_at: pending.db_at ?? null, ok }, 10_000);
  } catch { /* the obligation stays: a full pass settles it */ }
}

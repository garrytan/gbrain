/**
 * The cron-run spool (GST-2679). On a PGLite brain, `gbrain wakeshift emit cron.finished` at the end of a cron script
 * cannot open the brain while `gbrain serve` or `gbrain jobs work` holds its single-writer lock. Instead of dropping
 * the run, emit writes it as one small 0600 file under the brain's own gbrain home
 * (~/.gbrain/wakeshift-spool/<hash of the datastore path>/), and the 5 s wake drainer that serve and the worker both
 * run ingests it: it claims each file by an atomic rename, so two drainers never take the same file, inserts the run
 * with its original finished time and deletes the file. The insert skips a run already recorded with the same name,
 * status and time, so a claim left behind by a crash between the insert and the delete is replayed harmlessly.
 *
 * Bounded: at most SPOOL_MAX_FILES runs wait per brain (emit says so and drops the run past that), and a file over
 * SPOOL_MAX_BYTES or one that does not parse is moved to rejected/ with one stderr line, never retried. Nothing is
 * spooled while reporting back is off, and Postgres brains never spool: their emit connects or reports the outage.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { gbrainPath } from '../config.ts';
import { cronName } from './events.ts';

export const SPOOL_MAX_FILES = 1000;
export const SPOOL_MAX_BYTES = 1024;
export const SPOOL_INGEST_BATCH = 200;
const STALE_CLAIM_MS = 10 * 60_000;
const PENDING = /^\d{13}-[0-9a-f]{16}\.json$/;
const CLAIMED = /^\d{13}-[0-9a-f]{16}\.json\.claimed-[0-9a-f]{16}$/;

export interface CronRun { name: string; status: 'ok' | 'failed'; finished_at: string }

/** The spool directory of the PGLite brain at `databasePath`, under this gbrain home. */
export function cronSpoolDir(databasePath: string): string {
  return gbrainPath('wakeshift-spool', createHash('sha256').update(resolve(databasePath)).digest('hex').slice(0, 16));
}

/** Record one run: the direct emit (no time, so now()) or a spooled one (its own time, skipped when already recorded). */
export async function recordCronRun(engine: BrainEngine, run: { name: string; status: string; finished_at?: string }): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO wake_cron_runs (name, status, finished_at) SELECT $1, $2, COALESCE($3::timestamptz, now())
      WHERE $3::timestamptz IS NULL OR NOT EXISTS (SELECT 1 FROM wake_cron_runs WHERE name = $1 AND status = $2 AND finished_at = $3::timestamptz)`,
    [run.name, run.status, run.finished_at ?? null]);
  await engine.executeRaw("DELETE FROM wake_cron_runs WHERE name = $1 AND finished_at < now() - interval '30 days'", [run.name]);
  const registered = await engine.executeRaw('SELECT 1 FROM wake_crons WHERE name = $1', [run.name]);
  if (registered.length === 0) console.error(`[wakeshift] cron ${run.name} is not registered, so no agent can watch it: run gbrain wakeshift cron add ${run.name}.`);
}

/** Write one run to the spool; 'full' when SPOOL_MAX_FILES runs already wait. */
export function spoolCronRun(databasePath: string, run: { name: string; status: 'ok' | 'failed' }, now = new Date()): { file: string } | 'full' {
  const dir = cronSpoolDir(databasePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (readdirSync(dir).filter(f => PENDING.test(f) || CLAIMED.test(f)).length >= SPOOL_MAX_FILES) return 'full';
  const base = `${String(now.getTime()).padStart(13, '0')}-${randomBytes(8).toString('hex')}.json`;
  const tmp = join(dir, `.${base}.tmp`);
  writeFileSync(tmp, JSON.stringify({ name: run.name, status: run.status, finished_at: now.toISOString() } satisfies CronRun), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, join(dir, base));
  return { file: join(dir, base) };
}

function parseRun(path: string): CronRun | string {
  const size = statSync(path).size;
  if (size > SPOOL_MAX_BYTES) return `it is ${size} bytes (at most ${SPOOL_MAX_BYTES})`;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return 'it is not JSON'; }
  const r = raw as Partial<CronRun> | null;
  const time = typeof r?.finished_at === 'string' ? Date.parse(r.finished_at) : NaN;
  if (!r || typeof r.name !== 'string' || cronName(r.name) !== r.name || (r.status !== 'ok' && r.status !== 'failed') || !Number.isFinite(time)) {
    return 'it is not a cron run (name, status ok|failed, finished_at)';
  }
  return { name: r.name, status: r.status, finished_at: new Date(time).toISOString() };
}

/**
 * Ingest up to SPOOL_INGEST_BATCH spooled runs of the brain at `databasePath`, oldest first, plus claims older than
 * 10 minutes (a drainer that died between claim and delete). A failed insert puts the file back for the next pass.
 */
export async function ingestCronSpool(engine: BrainEngine, databasePath: string): Promise<{ recorded: number; rejected: number }> {
  const dir = cronSpoolDir(databasePath);
  const out = { recorded: 0, rejected: 0 };
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  const stale = (f: string) => { try { return Date.now() - statSync(join(dir, f)).mtimeMs > STALE_CLAIM_MS; } catch { return false; } };
  const due = names.filter(f => PENDING.test(f) || (CLAIMED.test(f) && stale(f))).sort().slice(0, SPOOL_INGEST_BATCH);
  for (const f of due) {
    const pending = f.replace(/\.claimed-[0-9a-f]{16}$/, '');
    const claim = join(dir, `${pending}.claimed-${randomBytes(8).toString('hex')}`);
    try { renameSync(join(dir, f), claim); utimesSync(claim, new Date(), new Date()); } catch { continue; }
    const run = parseRun(claim);
    if (typeof run === 'string') {
      mkdirSync(join(dir, 'rejected'), { recursive: true, mode: 0o700 });
      renameSync(claim, join(dir, 'rejected', pending));
      console.error(`[wakeshift] moved spooled cron run ${pending} to ${join(dir, 'rejected')}: ${run}.`);
      out.rejected++;
      continue;
    }
    try {
      await recordCronRun(engine, run);
    } catch (e) {
      renameSync(claim, join(dir, pending));
      throw e;
    }
    rmSync(claim, { force: true });
    out.recorded++;
  }
  return out;
}

/**
 * #9469: doctor `purge_mirror`. A restore replays every purge newer than the backup from the purge mirror, a text-free
 * file in this process's config directory (`GBRAIN_HOME`, else the home directory). A host that runs each writer in a home
 * of its own that it removes after the run loses the mirror, and a restore from an older backup then brings the purged
 * text back. This check compares the purges the database's tombstones record over the last ${WINDOW_DAYS} days with the
 * requests this mirror holds, and warns when the mirror lacks any. It reads only the three tombstone tables (bounded by
 * the window and ${REQUEST_CAP} requests) and the mirror file, never the request journal, and it prints counts only:
 * never a slug, title or text of a purged page. Never a failure: the purges themselves are done.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { configDir } from '../../../core/config.ts';
import { purgeMirrorPath, readPurgeMirror } from '../../../core/belief/purge-mirror.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const NAME = 'purge_mirror';
export const PURGE_MIRROR_WINDOW_DAYS = 30;
const WINDOW_DAYS = PURGE_MIRROR_WINDOW_DAYS;
const REQUEST_CAP = 10_000;
const DOCS = 'docs/guides/memory-boundaries.md#purge-mirror';

export async function checkPurgeMirror(engine: BrainEngine, home = configDir()): Promise<Check> {
  let requests: string[];
  try {
    requests = (await engine.executeRaw<{ request: string }>(`SELECT DISTINCT request FROM (
        SELECT request_id::text AS request FROM page_purges WHERE request_id IS NOT NULL AND purged_at > now() - make_interval(days => $1)
        UNION SELECT request_id::text FROM fact_purges WHERE request_id IS NOT NULL AND purged_at > now() - make_interval(days => $1)
        UNION SELECT request_id::text FROM take_purges WHERE request_id IS NOT NULL AND purged_at > now() - make_interval(days => $1)) r LIMIT $2`,
    [WINDOW_DAYS, REQUEST_CAP])).map(row => row.request);
  } catch (error) {
    return checkError(NAME, 'read the recent purge tombstones', error);
  }
  const path = purgeMirrorPath(home);
  if (!requests.length) return { name: NAME, status: 'ok', message: `No purge in the last ${WINDOW_DAYS} days to check against the purge mirror at ${path}.`, details: { path, recent: 0, missing: 0 } };
  const lines = readPurgeMirror(path);
  const mirrored = new Set((lines ?? []).filter(line => line.kind === 'intent').map(line => line.request));
  const missing = requests.filter(request => !mirrored.has(request)).length;
  const capped = requests.length >= REQUEST_CAP;
  const details = { path, recent: requests.length, missing, window_days: WINDOW_DAYS, readable: lines !== null, ...(capped ? { capped: true } : {}) };
  if (!missing) return { name: NAME, status: 'ok', message: `The purge mirror at ${path} holds all ${requests.length} purge(s) of the last ${WINDOW_DAYS} days, so a restore from an older backup replays them.`, details };
  return {
    name: NAME, status: 'warn', details,
    message: `${missing} of the ${capped ? 'first ' : ''}${requests.length} purge(s) this brain recorded in the last ${WINDOW_DAYS} days have no line in the purge mirror at ${path}`
      + `${lines === null ? ' (the mirror is missing or unreadable)' : ''}, so a restore from a backup older than them would not replay them and could bring the purged text back. `
      + 'This happens when gbrain runs in a home directory that is removed after the run, or on another machine. Run every gbrain writer with GBRAIN_HOME set to one durable directory, so all of them append to the same mirror.',
    fix: { argv: ['gbrain', 'doctor', '--only', NAME, '--json'], consent: [], actor: 'host_admin', requires_exclusive: false, verify: doctorVerify(NAME), docs: DOCS,
      why: 'Read-only: shows which purge mirror this process uses and how many recent purges it lacks; the fix is setting GBRAIN_HOME on the brain host.',
      user_message: 'Set GBRAIN_HOME to one durable directory for every gbrain process that writes to this brain, so restores can replay purges.' },
  };
}

async function runPurgeMirror(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await checkPurgeMirror(connectedEngine(ctx)));
  return checks;
}

export const purgeMirrorEntry: DoctorEntry = { name: 'purge_mirror', emits: ['purge_mirror'], run: runPurgeMirror };

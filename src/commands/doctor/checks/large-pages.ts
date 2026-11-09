/**
 * `large_pages` (Wave C spec §3.8, T-DX7, the strict-path part 1H owns): the readiness of each source for large pages.
 * Per source: whether it is strict (git-canonical), whether the git-first strict write path is on and, when off, why
 * (git-first-gate.ts: no index consumer in this build, not strict, or a writer seen in the last 7 days below the
 * git-first floor), the committed heads waiting for their index step and the ones held, and whether the checkout's
 * history is full. Brain-wide: the engine, the unsplit ceiling a strict write keeps (PAGE_MAX_BYTES; over it a strict
 * upload refuses `file_too_large` with reason `switch_off`, since this build has no git-backed tier), the database tier's
 * ceiling, the floor and the writers below it (version and host), and the free disk where upload sessions spool. Warns
 * when an older writer keeps the path off, when a head is held, or when a strict checkout is shallow, each with its fix.
 * A remote caller's run (run_doctor) shells out to no checkout path read from the database: history is `not_read`.
 */
import { existsSync, statfsSync } from 'node:fs';
import type { Check } from '../../doctor.ts';
import { agentFix, doctorVerify } from '../check-fix.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { gitChildEnv } from '../../../core/git-env.ts';
import { execFileSync } from '../../../core/spawn.ts';
import { readPageBodyPolicy } from '../../../core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../../core/page-size-policy.ts';
import { gitFirstWriterBlockers, gitFirstWriterFloor, indexSplitPageConsumer } from '../../../core/persistence/git-first-gate.ts';
import { persistenceHome } from '../../../core/persistence/identity.ts';

const DOCS = 'docs/architecture/key-files/large-page-writes.md';

function history(path: string | null): 'full' | 'shallow' | 'no_checkout' {
  if (!path || !existsSync(path)) return 'no_checkout';
  try {
    return execFileSync('git', ['-C', path, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8', env: gitChildEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true' ? 'shallow' : 'full';
  } catch { return 'no_checkout'; }
}

function spoolFreeBytes(): number | null {
  try { const stat = statfsSync(persistenceHome()); return Number(stat.bavail) * Number(stat.bsize); } catch { return null; }
}

async function runLargePages(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const engine = connectedEngine(ctx);
  const scoped = doctorSourceIds(ctx);
  try {
    const rows = await engine.executeRaw<{ id: string; local_path: string | null; strict: boolean; pending: number; held: number }>(
      `SELECT s.id, s.local_path, COALESCE(s.config->>'canonical','')='git' AS strict,
        (SELECT count(*)::int FROM page_pending_heads h WHERE h.source_id = s.id) AS pending,
        (SELECT count(*)::int FROM page_pending_heads h WHERE h.source_id = s.id AND h.hold_code IS NOT NULL) AS held
       FROM sources s WHERE s.archived IS NOT TRUE${scoped ? ' AND s.id = ANY($1::text[])' : ''} ORDER BY s.id`, scoped ? [scoped] : []);
    const consumer = indexSplitPageConsumer() !== null;
    const below = (consumer && rows.some(row => row.strict) ? await gitFirstWriterBlockers(engine, { fresh: true }) : [])
      .map(row => ({ role: row.role, version: row.version_label, host_id: row.host_id }));
    const sources = rows.map(row => {
      const off_reason = !row.strict ? 'not_strict' : !consumer ? 'no_index_consumer' : below.length ? 'writer_floor' : null;
      return { source_id: row.id, strict: row.strict, git_first: off_reason ? 'off' : 'on', off_reason,
        pending_heads: Number(row.pending), held_heads: Number(row.held), history: ctx.remote ? 'not_read' : history(row.strict ? row.local_path : null) };
    });
    const floor = await gitFirstWriterFloor();
    const details = { engine: engine.kind, unsplit_ceiling_bytes: PAGE_MAX_BYTES, database_tier_ceiling_bytes: (await readPageBodyPolicy(engine)).maxBytes,
      git_first_floor: floor, index_consumer: consumer, writers_below_floor: below, spool_free_bytes: spoolFreeBytes(), sources, docs: DOCS };
    const blocked = sources.filter(source => source.off_reason === 'writer_floor');
    if (blocked.length) {
      const listed = below.map(row => `${row.role} ${row.version} on host ${row.host_id ?? 'unknown (not recorded)'}`).join('; ');
      checks.push({ name: 'large_pages', status: 'warn', details,
        message: `The git-first strict write path is off on ${blocked.map(source => source.source_id).join(', ')}: a writer below v${floor} wrote in the last 7 days (${listed}). `
          + 'Such a writer would still stage page bytes in the database before Git has them. Upgrade gbrain on that host; the path turns on 7 days after its last write.',
        fix: { argv: ['gbrain', 'upgrade'], consent: [], actor: 'host_admin', requires_exclusive: false, verify: doctorVerify('large_pages'),
          why: 'Upgrades gbrain on the host whose writer is below the git-first floor (details.writers_below_floor names it); run it on that host.' } });
      return checks;
    }
    const held = sources.filter(source => source.held_heads > 0);
    if (held.length) {
      const [first] = await engine.executeRaw<{ request_id: string }>(
        `SELECT request_id::text AS request_id FROM page_pending_heads WHERE source_id = $1 AND hold_code IS NOT NULL ORDER BY queued_at LIMIT 1`, [held[0]!.source_id]);
      checks.push({ name: 'large_pages', status: 'warn', details,
        message: `${held.reduce((sum, source) => sum + source.held_heads, 0)} committed page head(s) are held by their index step (${held.map(source => source.source_id).join(', ')}): Git has the bytes and the database still shows the generation before them.`,
        fix: agentFix(['gbrain', 'write-request', first!.request_id, '--json'], 'Read-only: the held write\'s receipt names its hold code and the repair to run.', 'large_pages') });
      return checks;
    }
    const shallow = sources.filter(source => source.strict && source.history === 'shallow');
    if (shallow.length) {
      checks.push({ name: 'large_pages', status: 'warn', details,
        message: `The checkout of strict source ${shallow.map(source => source.source_id).join(', ')} has shallow history, so a page whose blob was not fetched cannot be indexed from Git.`,
        fix: { argv: ['git', 'fetch', '--unshallow'], consent: [], actor: 'host_admin', requires_exclusive: false, verify: doctorVerify('large_pages'),
          why: 'Fetches the full history; run it inside that source\'s checkout on the brain host.' } });
      return checks;
    }
    const on = sources.filter(source => source.git_first === 'on').map(source => source.source_id);
    checks.push({ name: 'large_pages', status: 'ok', details,
      message: !sources.some(source => source.strict) ? `No source is strict (git-canonical); pages up to ${details.database_tier_ceiling_bytes} bytes are stored on the database tier.`
        : on.length ? `The git-first strict write path is on for ${on.join(', ')}: pages up to ${PAGE_MAX_BYTES} bytes reach Git before the database indexes them.`
        : 'Strict sources write as before: this build registers no index step for the git-first path.' });
  } catch (error) {
    checks.push({ name: 'large_pages', status: 'ok', details: { health: 'unknown', docs: DOCS },
      message: `Large-page readiness could not be read (${error instanceof Error ? error.message : String(error)}).` });
  }
  return checks;
}

export const largePagesEntry: DoctorEntry = { name: 'large_pages', emits: ['large_pages'], run: runLargePages };

/**
 * #5216: resumable `pages.knowledge_revision` backfill. The page-state schema
 * adds the column nullable (a NOT NULL volatile default rewrites the table and
 * reads every TOAST value), so rows written before it carry NULL until this
 * pass assigns them a revision. Runs at the end of every migration pass while
 * the column is still nullable; a NOT NULL column costs one catalog probe.
 *
 * Rows are updated in committed id-ordered batches; the cursor is kept in the
 * config row `page_state.revision_backfill`, so an interrupted pass resumes and
 * never reassigns a revision it already gave. A batch that fails is retried row
 * by row; a row that still fails (for example a torn TOAST value) is isolated,
 * reported and retried on at most REVISION_BACKFILL_MAX_ATTEMPTS later passes, never forever;
 * once its attempts are spent, later passes stay quiet.
 * When no NULL row remains the column becomes NOT NULL through a CHECK added
 * NOT VALID, validated without blocking writes, then SET NOT NULL and dropped,
 * so the final constraints equal a fresh install.
 */
import type { BrainEngine } from '../engine.ts';

export const REVISION_BACKFILL_STATE_KEY = 'page_state.revision_backfill';
/** Re-runs the schema migration pass, which resumes this backfill even when no migration is pending. */
export const REVISION_BACKFILL_RESUME_COMMAND = 'gbrain apply-migrations --force-schema';
/** Passes a failing row is retried on before later passes stop retrying it. */
export const REVISION_BACKFILL_MAX_ATTEMPTS = 3;
const CHECK_NAME = 'pages_knowledge_revision_backfilled';

export interface FailedRow { id: number; attempts: number; error: string }
interface BackfillState { cursor: number; backfilled: number; failed: FailedRow[] }

export interface RevisionBackfillResult {
  status: 'not_needed' | 'complete' | 'pending';
  backfilled: number;
  failed: FailedRow[];
}

async function readState(engine: BrainEngine): Promise<BackfillState> {
  try {
    const parsed = JSON.parse((await engine.getConfig(REVISION_BACKFILL_STATE_KEY)) ?? 'null') as BackfillState | null;
    if (parsed && Number.isSafeInteger(parsed.cursor) && Array.isArray(parsed.failed)) return parsed;
  } catch { /* a corrupt cursor restarts from the first id; assigned revisions are never reassigned */ }
  return { cursor: 0, backfilled: 0, failed: [] };
}

export interface RevisionBackfillStatus {
  /** `absent`: pre-v150 schema; `not_null`: the backfill finished; `nullable`: it has not. */
  column: 'absent' | 'not_null' | 'nullable';
  /** Live and deleted page rows that still have no revision. */
  pending: number;
  /** Rows the backfill reported failing that still have no revision, with their page. */
  failed: Array<FailedRow & { source_id: string; slug: string }>;
}

/** Read-only: where the backfill stands, for `gbrain doctor`. */
export async function readRevisionBackfillStatus(engine: BrainEngine): Promise<RevisionBackfillStatus> {
  const column = await engine.executeRaw<{ notnull: boolean }>(
    `SELECT attnotnull AS notnull FROM pg_attribute
      WHERE attrelid = to_regclass('pages') AND attname = 'knowledge_revision' AND NOT attisdropped`);
  if (column.length === 0) return { column: 'absent', pending: 0, failed: [] };
  if (column[0]!.notnull) return { column: 'not_null', pending: 0, failed: [] };
  const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE knowledge_revision IS NULL');
  const state = await readState(engine);
  const pages = state.failed.length === 0 ? [] : await engine.executeRaw<{ id: number; source_id: string; slug: string }>(
    'SELECT id, source_id, slug FROM pages WHERE id = ANY($1::bigint[]) AND knowledge_revision IS NULL', [state.failed.map(f => f.id)]);
  const byId = new Map(pages.map(p => [Number(p.id), p]));
  const failed = state.failed.filter(f => byId.has(f.id)).map(f => ({ ...f, source_id: byId.get(f.id)!.source_id, slug: byId.get(f.id)!.slug }));
  return { column: 'nullable', pending: Number(n), failed };
}

/**
 * Assign revisions to the given rows in one statement. A managed brain's
 * writer guard refuses a revision change outside a source capability, so the
 * statement grants exactly the rows' sources (`gbrain.write_sources`,
 * transaction-local, as schema migration v191 does) before any row updates;
 * no content column changes.
 */
async function assignRows(engine: BrainEngine, ids: number[]): Promise<void> {
  await engine.executeRaw(
    `UPDATE pages SET knowledge_revision = gen_random_uuid()
      WHERE id = ANY($1::bigint[]) AND knowledge_revision IS NULL
        AND set_config('gbrain.write_sources',
          (SELECT COALESCE(jsonb_agg(DISTINCT p.source_id), '[]'::jsonb)::text FROM pages p WHERE p.id = ANY($1::bigint[])), true) IS NOT NULL`,
    [ids]);
}

export async function resumePageRevisionBackfill(
  engine: BrainEngine,
  opts: { batchSize?: number; log?: (line: string) => void; signal?: AbortSignal; onProgress?: (progress:{completed:number;total:number;cursor:number})=>void|Promise<void> } = {},
): Promise<RevisionBackfillResult> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const column = await engine.executeRaw<{ notnull: boolean }>(
    `SELECT attnotnull AS notnull FROM pg_attribute
      WHERE attrelid = to_regclass('pages') AND attname = 'knowledge_revision' AND NOT attisdropped`);
  if (column.length === 0 || column[0]!.notnull) return { status: 'not_needed', backfilled: 0, failed: [] };

  const batchSize = opts.batchSize ?? 100;
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>1000)throw new Error('Invalid revision backfill batch size');
  const state = await readState(engine);
  const [pending]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM pages WHERE knowledge_revision IS NULL');
  const total=state.backfilled+Number(pending.n);
  const check=()=>{if(opts.signal?.aborted)throw opts.signal.reason ?? new DOMException('Migration cancelled','AbortError');};
  const save = () => engine.setConfig(REVISION_BACKFILL_STATE_KEY, JSON.stringify(state));
  let announced = false;
  for (;;) {
    check();
    const ids = (await engine.executeRaw<{ id: number }>(
      'SELECT id FROM pages WHERE id > $1 AND knowledge_revision IS NULL ORDER BY id LIMIT $2', [state.cursor, batchSize])).map(r => Number(r.id));
    if (ids.length === 0) break;
    if (!announced) {
      log(`[migrate] backfilling page revisions in batches of ${batchSize} (resumable; resume with: ${REVISION_BACKFILL_RESUME_COMMAND})`);
      announced = true;
    }
    try {
      await engine.transaction(async tx=>{
        await assignRows(tx,ids);
        await tx.setConfig(REVISION_BACKFILL_STATE_KEY,JSON.stringify({...state,cursor:ids[ids.length-1],backfilled:state.backfilled+ids.length}));
      });
      state.backfilled+=ids.length;
    } catch {
      check();
      for (const id of ids) {
        check();
        try { await assignRows(engine, [id]); state.backfilled++; }
        catch (error) {
          state.failed.push({ id, attempts: 1, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
        }
      }
    }
    state.cursor = ids[ids.length - 1]!;
    await save();
    log(`[migrate] page revision backfill: ${state.backfilled}/${total} row(s) done, through page id ${state.cursor}`);
    await opts.onProgress?.({completed:state.backfilled,total,cursor:state.cursor});
    check();
    await new Promise(resolve=>setTimeout(resolve,0));
  }

  const failed: FailedRow[] = [];
  let retried = false;
  for (const row of state.failed) {
    check();
    const [still] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE id = $1 AND knowledge_revision IS NULL', [row.id]);
    if (!still) continue;
    if (row.attempts >= REVISION_BACKFILL_MAX_ATTEMPTS) { failed.push(row); continue; }
    retried = true;
    try { await assignRows(engine, [row.id]); state.backfilled++; }
    catch (error) { failed.push({ id: row.id, attempts: row.attempts + 1, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }); }
  }
  state.failed = failed;
  if (failed.length > 0) {
    await save();
    if (announced || retried) log(`[migrate] page revision backfill: ${failed.length} row(s) could not be updated (page ids ${failed.slice(0, 10).map(f => f.id).join(', ')}${failed.length > 10 ? ', …' : ''}). `
      + `Writes that name a revision for them are refused with revision_backfill_pending. Diagnose with: gbrain repair orphan-children (preview, includes the torn-TOAST probe). See docs/guides/repair.md#orphan-children`);
    return { status: 'pending', backfilled: state.backfilled, failed };
  }

  await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`);
  await engine.executeRaw(`ALTER TABLE pages ADD CONSTRAINT ${CHECK_NAME} CHECK (knowledge_revision IS NOT NULL) NOT VALID`);
  await engine.executeRaw(`ALTER TABLE pages VALIDATE CONSTRAINT ${CHECK_NAME}`);
  await engine.executeRaw('ALTER TABLE pages ALTER COLUMN knowledge_revision SET NOT NULL');
  await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT ${CHECK_NAME}`);
  await engine.unsetConfig(REVISION_BACKFILL_STATE_KEY);
  if (announced) log(`[migrate] page revision backfill complete: ${state.backfilled} row(s)`);
  return { status: 'complete', backfilled: state.backfilled, failed: [] };
}

/**
 * #5988 read-time hold signals. A page whose newer file sync holds keeps its
 * last good revision, and a held new file has no page at all, so an agent
 * answering from reads must learn that coverage is partial:
 *
 * - `get_page` carries `file_held` (code, reason, key, line, since, fix, docs;
 *   the file path for trusted local callers only).
 * - search and query hits for such a page carry `stale` (held_since, last_indexed_revision).
 * - retrieval meta carries `held_files` per source in scope (held new files
 *   missing, held modified files stale) and a `held_files` degraded notice
 *   when some held file could match the query (#7165, `stampHeldHits`).
 *
 * Cost: one read of the per-source summary rows in scope, cached per request,
 * plus one read per call that returned hits from a scope with holds: the
 * returned pages' holds (indexed, `op_checkpoints_sync_hold_page_idx`) and the
 * query-relevant count. `get_page` reads its page's hold (plus, only for an
 * `invalid_fence` hold, the two reads that say whether the maintenance run
 * repairs it). Remote callers get codes, counts and flags, never paths, and a
 * fix addressed to the brain host operator; the repair commands come from the
 * hold router (D6): `gbrain repair fences` for fence holds, `gbrain repair
 * frontmatter` for the rest.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action, Notice } from '../agent-output.ts';
import { ALL_SOURCES } from '../source-id.ts';
import { outOfAttemptsHold, GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP, contentRepairArgv, fenceAutoRepairFor, gitHoldDocs, gitHoldFix, holdRepairSteps, type GitHoldCode, type GitHoldReason, type GitHoldRecord, type HoldRepairRoute } from './sync-holds.ts';
import { fenceHoldLocation, fenceHoldRelay, type FenceAutoRepair, type FenceHoldLocation } from '../fence-repair/hold-fix.ts';
import { COVERAGE_COUNT_CAP, type CoverageRelevance } from '../search/retrieval-coverage.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

/** `fenceAuto`: whether the maintenance run repairs fence holds, read only when some returned hold is one. */
export interface HeldPage { record: GitHoldRecord; revision: string | null; fenceAuto?: FenceAutoRepair }

/**
 * Held files of the sources in a read scope: new files with no page (`missing`) and pages whose newer file is held (`stale`);
 * `fences` (present only when some are) counts the #6188 `invalid_fence` holds among them, which route to `gbrain repair fences` instead of frontmatter repair.
 */
export interface HeldCoverage { source_id: string; missing: number; stale: number; fences?: number; concurrent?: number;
  /** #6278 `preparation_stalled` holds: the writer stalled, not the file; they route to writer status and a re-screen. */
  stalled?: number;
  /** #6340 `worktree_dirty` holds: an uncommitted local edit; they clear once the file is committed and re-screened. */
  dirty?: number;
  /** #6712 `file_drift` holds: a database edit sync would have overwritten; they route to `gbrain repair file-drift`. */
  drift?: number }

/** `get_page.file_held`. */
export interface FileHeld {
  code: GitHoldCode;
  reason?: GitHoldReason;
  key?: string;
  line?: number;
  /** #6188 `invalid_fence` (D16): fence, section, reason, classes, planned tier, auto_retry and next_attempt_after (row numbers for trusted local callers only). */
  fence?: FenceHoldLocation;
  since: string;
  /** Source-relative file path; trusted local callers only. */
  path?: string;
  fix: Action;
  docs: string;
}

/** A search or query hit whose page's newer file is held. */
export interface StaleHit { held_since: string; last_indexed_revision: string | null }

const requestCache = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Memoizes one read per request (the OperationContext); without a request object it just runs. */
function cached<T>(request: object | undefined, key: string, read: () => Promise<T>): Promise<T> {
  if (!request) return read();
  let entries = requestCache.get(request);
  if (!entries) requestCache.set(request, entries = new Map());
  if (!entries.has(key)) entries.set(key, read());
  return entries.get(key) as Promise<T>;
}

/** The current-incarnation holds naming these pages, with each page's revision: one indexed read. */
export function readHeldPages(engine: Exec, pageIds: number[], request?: object): Promise<Map<number, HeldPage>> {
  const ids = [...new Set(pageIds.filter(id => Number.isInteger(id)))].sort((a, b) => a - b);
  if (!ids.length) return Promise.resolve(new Map());
  return cached(request, `pages:${ids.join(',')}`, async () => {
    const rows = await engine.executeRaw<{ record: GitHoldRecord; revision: string | null }>(`SELECT h.completed_keys->0 AS record, p.knowledge_revision::text AS revision
      FROM op_checkpoints h
      JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
      LEFT JOIN pages p ON p.id=(h.completed_keys->0->>'page_id')::int
      WHERE h.op=$1 AND (h.completed_keys->0->>'page_id')=ANY($2::text[])
      ORDER BY h.fingerprint`, [GIT_HOLD_OP, ids.map(String)]);
    const out = new Map<number, HeldPage>();
    const fenceAuto = await fenceAutoRepairFor(engine, rows.map(row => row.record));
    for (const row of rows) {
      const id = Number(row.record.page_id);
      if (!out.has(id)) out.set(id, { record: row.record, revision: row.revision, ...(fenceAuto ? { fenceAuto } : {}) });
    }
    return out;
  });
}

/** Per-source held-file counts in a read scope (sources with none are absent): one read of the summary rows. */
export function readHeldCoverage(engine: Exec, scope: { sourceId?: string; sourceIds?: string[] }, request?: object): Promise<HeldCoverage[]> {
  const ids = scope.sourceIds ?? (scope.sourceId !== undefined && scope.sourceId !== ALL_SOURCES ? [scope.sourceId] : null);
  if (ids && !ids.length) return Promise.resolve([]);
  return cached(request, `coverage:${ids ? [...ids].sort().join(',') : '*'}`, async () => {
    const rows = await engine.executeRaw<{ source_id: string; count: number | string; stale: number | string; fences: number | string; concurrent: number | string; stalled: number | string; dirty: number | string; drift: number | string }>(`SELECT s.id AS source_id,
        COALESCE((h.completed_keys->0->>'count')::int,0) AS count, COALESCE((h.completed_keys->0->>'stale')::int,0) AS stale,
        COALESCE((h.completed_keys->0->>'fences')::int,0) AS fences, COALESCE((h.completed_keys->0->>'concurrent')::int,0) AS concurrent,
        COALESCE((h.completed_keys->0->>'stalled')::int,0) AS stalled, COALESCE((h.completed_keys->0->>'dirty')::int,0) AS dirty,
        COALESCE((h.completed_keys->0->>'drift')::int,0) AS drift
      FROM op_checkpoints h JOIN sources s ON h.fingerprint=s.id||':'||s.incarnation::text
      WHERE h.op=$1 AND s.archived IS NOT TRUE AND ($2::text[] IS NULL OR s.id=ANY($2::text[]))
        AND COALESCE((h.completed_keys->0->>'count')::int,0)>0
      ORDER BY s.id`, [GIT_HOLD_SUMMARY_OP, ids]);
    return rows.map(row => {
      const count = Number(row.count), stale = Math.min(Number(row.stale), count), fences = Math.min(Number(row.fences), count);
      const concurrent = Math.min(Number(row.concurrent), count - fences);
      const stalled = Math.min(Number(row.stalled), count - fences - concurrent);
      const dirty = Math.min(Number(row.dirty), count - fences - concurrent - stalled);
      const drift = Math.min(Number(row.drift), count - fences - concurrent - stalled - dirty);
      return { source_id: row.source_id, missing: count - stale, stale, ...(fences ? { fences } : {}), ...(concurrent ? { concurrent } : {}), ...(stalled ? { stalled } : {}), ...(dirty ? { dirty } : {}),
        ...(drift ? { drift } : {}) };
    });
  });
}

/** D6: which repair a held source needs, from its counts. */
export function coverageRoute(source: HeldCoverage): HoldRepairRoute {
  const fences = source.fences ?? 0, concurrent = source.concurrent ?? 0, stalled = source.stalled ?? 0, dirty = source.dirty ?? 0, drift = source.drift ?? 0;
  return { fences, others: Math.max(0, source.missing + source.stale - fences - concurrent - stalled - dirty - drift), ...(concurrent ? { concurrent } : {}), ...(stalled ? { stalled } : {}),
    ...(dirty ? { dirty } : {}), ...(drift ? { drift } : {}) };
}

/**
 * The fix a remote caller relays (`tell_user_to_run`): only the brain host
 * operator can inspect and repair held files. Commands come from the hold
 * router (D6): a source without a route, or with frontmatter-style holds,
 * names the frontmatter repair preview; a source with fence holds names the
 * fence repair preview and says the maintenance run repairs most of them by
 * itself when it runs. No path.
 */
export function hostOperatorFix(sources: ReadonlyArray<{ source_id: string; route?: HoldRepairRoute }>, why: string): Action {
  const frontmatter = sources.filter(source => !source.route || source.route.others > 0).map(source => `'gbrain repair frontmatter --source ${source.source_id}'`);
  const fences = sources.filter(source => source.route && (source.route.fences > 0 || (source.route.slug_conflicts ?? 0) > 0)).map(source => `'${contentRepairArgv(source.source_id).join(' ')}'`);
  const concurrent = sources.filter(source => source.route?.concurrent).map(source => source.source_id);
  const stalled = sources.filter(source => source.route?.stalled).map(source => source.source_id);
  const dirty = sources.filter(source => source.route?.dirty).map(source => source.source_id);
  const drift = sources.filter(source => source.route?.drift).map(source => source.source_id);
  const first = sources[0]!;
  const parts = [
    ...(frontmatter.length ? [`Please run ${frontmatter.join(', ')} on the brain host to preview the fixes, then apply them.`] : []),
    ...(fences.length ? [`Some held files have a facts or takes table, or a slug line naming another page, that gbrain could not import. The brain host's maintenance run repairs most of these by itself when it is running; `
      + `to see each one's state and repair the rest now, run ${fences.join(', ')} on the brain host (a read-only preview that prints the apply command).`] : []),
    ...(concurrent.length ? [`Some notes changed in their files while an agent saved a different version to the brain, so both were kept: on the brain host run ${concurrent.map(id => `'gbrain sources status ${id}'`).join(', ')} and reconcile each named note with 'gbrain sources reconcile <source> <slug> --preview'.`] : []),
    ...(stalled.length ? [`Some files are held because the brain's write owner could not finish preparing them (the files themselves are fine): on the brain host run ${stalled.map(id => `'gbrain sources writer status --source ${id} --json'`).join(', ')} to see what the owner was stuck on, fix that or upgrade gbrain, then 'gbrain sources retry-held <source>' and the same sync.`] : []),
    ...(drift.length ? [`Some notes were edited in the brain after their files were last imported, so sync kept the brain's version instead of overwriting it: on the brain host run ${drift.map(id => `'gbrain sources status ${id}'`).join(', ')} and resolve each named note with 'gbrain repair file-drift --source <source> --slug <slug> --prefer database' (or '--prefer file').`] : []),
    ...(dirty.length ? [`Some files have uncommitted edits in the brain's checkout that sync would not overwrite: on the brain host commit them, then run ${dirty.map(id => `'gbrain sync unblock --source ${id} --apply'`).join(', ')} (or 'gbrain sources retry-held <source>') and the same sync.`] : []),
  ];
  return { argv: holdRepairSteps(first.source_id, first.route ?? { fences: 0, others: 1 }).argv, consent: [], actor: 'host_admin', requires_exclusive: false, why,
    user_message: `Some files in your brain could not be imported, so answers from it can miss or show outdated notes. ${parts.join(' ')}` };
}

/** The route of one hold record. */
export function recordRoute(record: Pick<GitHoldRecord, 'code'>): HoldRepairRoute {
  return record.code === 'invalid_fence' ? { fences: 1, others: 0 } : record.code === 'concurrent_write' ? { fences: 0, others: 0, concurrent: 1 }
    : outOfAttemptsHold(record.code) ? { fences: 0, others: 0, stalled: 1 } : record.code === 'worktree_dirty' ? { fences: 0, others: 0, dirty: 1 } : record.code === 'file_drift' ? { fences: 0, others: 0, drift: 1 }
      : record.code === 'frontmatter_slug_conflict' ? { fences: 0, others: 0, slug_conflicts: 1 } : { fences: 0, others: 1 };
}

/**
 * `get_page.file_held` for a page whose newer file is held; the path only for
 * trusted local callers. A fence hold's fix follows its state (D17): locally
 * the step `gitHoldFix` names, remotely the owner-host relay saying whether it
 * clears by itself (Codex CEO #7).
 */
export function fileHeldField(held: HeldPage, remote: boolean): FileHeld {
  const { record } = held;
  const fence = record.code === 'invalid_fence';
  const stalled = outOfAttemptsHold(record.code);
  const why = `The canonical file of this page is held (${record.code}${record.meta.reason ? `, ${record.meta.reason}` : ''}): sync cannot import its newer version, so this page shows its last good revision `
    + `and is read-only for put_page until ${fence ? 'the file is repaired' : stalled ? 'the brain host operator fixes the write owner and re-screens the file' : 'the brain host operator repairs the file'}.`;
  const fix = !remote ? gitHoldFix(record, held.fenceAuto)
    : fence ? fenceHoldRelay(record, held.fenceAuto, why) : hostOperatorFix([{ source_id: record.source_id, route: recordRoute(record) }], why);
  const location = fence ? fenceHoldLocation(record.meta, held.fenceAuto, remote) : undefined;
  return { code: record.code, ...(record.meta.reason ? { reason: record.meta.reason } : {}), ...(record.meta.key ? { key: record.meta.key } : {}),
    ...(record.meta.line !== undefined ? { line: record.meta.line } : {}), ...(location ? { fence: location } : {}), since: record.held_at, ...(remote ? {} : { path: record.path }),
    fix, docs: gitHoldDocs(record.code, record.meta.reason) };
}

const HOLD_PAGE_JOIN = `FROM op_checkpoints h
      JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
      LEFT JOIN pages p ON p.id=(h.completed_keys->0->>'page_id')::int`;

/**
 * Stamps `stale` on hits whose page's newer file is held and returns the
 * per-source coverage of the read scope with (#7165) how many held files could
 * affect this query (retrieval-coverage.ts; every one for an empty result). One
 * summary read; when the scope holds files and the call returned hits, one more
 * read gets the hits' holds (indexed) and the count (capped at
 * COVERAGE_COUNT_CAP). `couldAffect` is null when that read fails: unknown,
 * never zero. Hits are mutated in place; callers pass their own copies.
 */
export async function stampHeldHits(engine: Exec, hits: Array<{ page_id?: number; stale?: boolean | StaleHit }>, scope: { sourceId?: string; sourceIds?: string[] },
  relevance: CoverageRelevance, request?: object): Promise<{ coverage: HeldCoverage[]; couldAffect: number | null }> {
  const coverage = await readHeldCoverage(engine, scope, request);
  if (!coverage.length || relevance.all || !hits.length) return { coverage, couldAffect: coverage.reduce((sum, source) => sum + source.missing + source.stale, 0) };
  const ids = [...new Set(hits.flatMap(hit => typeof hit.page_id === 'number' ? [String(hit.page_id)] : []))];
  let rows: Array<{ record: GitHoldRecord | null; revision: string | null; could_affect: number | null }>;
  try {
    rows = await engine.executeRaw(`(SELECT h.completed_keys->0 AS record, p.knowledge_revision::text AS revision, NULL::int AS could_affect ${HOLD_PAGE_JOIN}
        WHERE h.op=$1 AND (h.completed_keys->0->>'page_id')=ANY($2::text[]) ORDER BY h.fingerprint)
      UNION ALL
      SELECT NULL, NULL, (SELECT count(*)::int FROM (SELECT 1 ${HOLD_PAGE_JOIN}
        WHERE h.op=$1 AND s.archived IS NOT TRUE AND s.id=ANY($3::text[])
          AND ((h.completed_keys->0->>'page_id')=ANY($2::text[]) OR p.type=ANY($4::text[])
            OR lower(concat_ws(' ', h.completed_keys->0->>'path', h.completed_keys->0->>'slug', p.title)) ~ ANY($5::text[]))
        LIMIT ${COVERAGE_COUNT_CAP}) x)`,
    [GIT_HOLD_OP, ids, coverage.map(source => source.source_id), relevance.types, relevance.patterns]);
  } catch {
    return { coverage, couldAffect: null };
  }
  let couldAffect: number | null = null;
  const stamped = new Set<number>();
  for (const row of rows) {
    if (!row.record) { couldAffect = Number(row.could_affect); continue; }
    const id = Number(row.record.page_id);
    if (stamped.has(id)) continue;
    stamped.add(id);
    for (const hit of hits) if (hit.page_id === id) hit.stale = { held_since: row.record.held_at, last_indexed_revision: row.revision };
  }
  return { coverage, couldAffect: Number.isFinite(couldAffect) ? couldAffect : null };
}

/**
 * The `held_files` notice for a read whose scope has held files or (#7165) pages held
 * from embedding; null when it has neither. `couldAffect` (a search or query) names
 * how many held files could match the query, `embedding` how many embedding-held
 * pages are in scope and how many could; either makes the notice escalating: the
 * same sources, kinds and counts show once per session.
 */
export function heldFilesNotice(coverage: HeldCoverage[], remote: boolean, couldAffect?: number, embedding?: { total: number; could_affect: number }): Notice | null {
  if (!coverage.length && !embedding) return null;
  const embeddingWhy = embedding ? `${embedding.total} page(s) in this scope are held from embedding (their embedding budget is held or capped), so they have no vectors and semantic search cannot find them; `
    + `${embedding.could_affect} of them could match this query. Keyword search still finds them where they have chunks. ` : '';
  const missing = coverage.reduce((sum, source) => sum + source.missing, 0), stale = coverage.reduce((sum, source) => sum + source.stale, 0);
  const kinds = (source: HeldCoverage) => (['missing', 'stale', 'fences', 'concurrent', 'stalled', 'dirty', 'drift'] as const).filter(kind => (source[kind] ?? 0) > 0).join('+');
  const escalation = couldAffect === undefined && !embedding ? {} : { escalation: {
    key: [...coverage.map(source => `${source.source_id}:${kinds(source)}`), ...(embedding ? ['embedding'] : [])].sort().join(','),
    level: missing + stale + (embedding?.total ?? 0) } };
  const absent = 'Treat a missing or outdated answer as "held", never as "the brain has nothing on this".';
  if (!coverage.length) {
    const why = `Coverage is partial: ${embeddingWhy}${absent}`;
    const preview = ['gbrain', 'embed', '--held', '--dry-run'];
    const fix: Action = remote
      ? { argv: preview, consent: [], actor: 'host_admin', requires_exclusive: false, why: 'Lists the held and capped large pages with the cost to finish embedding them; read-only.',
        user_message: `Some large pages in your brain are waiting for embedding approval, so semantic search cannot find them. Please run '${preview.join(' ')}' on the brain host to see them and the cost to finish.` }
      : { argv: preview, consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the held and capped large pages with the cost to finish embedding them; read-only. Approving the spend is the user\'s call.' };
    return { code: 'held_files', kind: 'degraded', why: remote ? `${why} Only the brain host operator can approve embedding them.` : why, fix, ...escalation };
  }
  const per = coverage.map(source => `${source.source_id}: ${source.missing} missing, ${source.stale} stale`).join('; ');
  const scoped = couldAffect === undefined ? '' : `${couldAffect} of them could match this query. `;
  const why = `Coverage is partial: sync holds ${missing + stale} file(s) it cannot import (${per}). ${scoped}`
    + `${missing} held new file(s) have no page, so their content is absent from this result; ${stale} page(s) whose newer file is held show their last good revision (hits carry stale). `
    + `${embeddingWhy}${absent}`;
  const ids = coverage.map(source => source.source_id);
  if (remote) return { code: 'held_files', kind: 'degraded', why: `${why} Only the brain host operator can inspect and repair held files.`, ...escalation,
    fix: hostOperatorFix(coverage.map(source => ({ source_id: source.source_id, route: coverageRoute(source) })), 'The repair preview on the brain host proposes each fix and writes nothing until the operator applies it.') };
  const single = coverage.length === 1 ? holdRepairSteps(ids[0]!, coverageRoute(coverage[0]!)) : null;
  const fix: Action = single
    ? { argv: single.argv, consent: [], actor: 'agent', requires_exclusive: false, verify: { argv: ['gbrain', 'sources', 'status', ids[0]!, '--json'] },
      why: coverageRoute(coverage[0]!).fences
        ? `gbrain sources status ${ids[0]} lists each held file; ${single.text}.`
        : `Previews the fix for each held file in source ${ids[0]} (gbrain sources status ${ids[0]} lists them); nothing is written until a hash-bound apply.` }
    : { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: `Doctor lists the held files of each source with its next step (${coverage.map(source => holdRepairSteps(source.source_id, coverageRoute(source)).commands.join(', ')).join('; ')}).` };
  return { code: 'held_files', kind: 'degraded', why, fix, ...escalation };
}

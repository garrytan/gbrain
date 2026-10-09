/**
 * Purge receipts and verification (#5575 C4, CEO-22, ENG-12, DX-12).
 *
 * One adapter per inventory store, each with an explicit scope, a row bound
 * and a statement deadline. A swept store whose probe still finds the claim is
 * `incomplete`; a probe stopped by its deadline or bound is `unverified`;
 * claim text that survives outside a fence (page prose, a version's prose) is
 * `out_of_scope: source_prose`; rows purge hid are `retained_inactive`, never
 * counted as a zero residual. The vector probe lists same-model neighbours as
 * paraphrase candidates and is never a gate.
 *
 * The receipt lists residuals first and says "removed from live stores"; it
 * never claims erasure. Verification needs the claim text, which exists only
 * in memory during the purge call; `--status` reports completion from the
 * stored receipt, the effects and a fingerprint probe.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { getCode } from '../retry-matcher.ts';
import { escapeFenceCell } from '../fence-shared.ts';
import { gbrainPath } from '../config.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { DELETION_INVENTORY, OUT_OF_REACH_RESIDUALS, type InventoryEntry } from '../deletion-inventory.ts';
import type { PurgePlan, PurgeTarget } from './purge.ts';

export type StoreCount = Record<string, number>;
export type StoreStatus = 'deleted' | 'would_remove' | 'retained_inactive' | 'unverified' | 'out_of_reach' | 'out_of_scope' | 'not_present' | 'incomplete';
export interface StoreReport { store: string; status: StoreStatus; removed?: number; remaining?: number; reason?: string; detail?: string; items?: unknown[] }
export type PurgeCompletion = 'committed' | 'complete' | 'incomplete';
export interface PurgeReceipt {
  summary: string;
  fact_id: number;
  /** gbrain_fact_fingerprint of the claim: the receipt's content hash. Guessable for short claims. */
  fact_hash: string;
  hash8: string;
  source_id: string;
  subject: string;
  visibility: string;
  residuals: StoreReport[];
  stores: StoreReport[];
  vector_probe: Record<string, unknown>;
  next: string[];
  tell_user_to_run?: { argv: string[]; why: string };
}

export const PURGE_PROBE_LIMITS = { rows: 1000, statementMs: 2_000, totalMs: 20_000, gitBytes: 64 * 1024 * 1024, gitMs: 10_000 } as const;
let probeLimits: { rows: number; statementMs: number; totalMs: number } = { ...PURGE_PROBE_LIMITS };
/** Test seam: shrink the probe bounds (null restores them). */
export function __setPurgeProbeLimitsForTests(limits: Partial<typeof probeLimits> | null): void {
  probeLimits = limits ? { ...probeLimits, ...limits } : { ...PURGE_PROBE_LIMITS };
}

type ProbeResult = { count: number } | { unverified: string };

/** One bounded probe: `sql` selects matching rows (no LIMIT); the adapter caps rows and the statement time. */
async function boundedCount(engine: BrainEngine, sql: string, params: unknown[], deadline: number): Promise<ProbeResult> {
  if (performance.now() > deadline) return { unverified: 'verification_deadline' };
  try {
    return await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('statement_timeout',$1,true)", [`${probeLimits.statementMs}ms`]);
      const [row] = await tx.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql} LIMIT ${probeLimits.rows + 1}) bounded`, params);
      const count = Number(row?.n ?? 0);
      return count > probeLimits.rows ? { unverified: 'row_bound' } : { count };
    });
  } catch (error) {
    if (getCode(error) === '57014') return { unverified: 'statement_deadline' };
    throw error;
  }
}

const textMatch = (column: string, at: number) => `(strpos(lower(${column}::text),$${at})>0 OR strpos(lower(${column}::text),$${at + 1})>0)`;
/** Vector and lexeme columns carry no probe-able text. */
const PROBE_SKIP = /embedding|search_vector/;

/** Probe one inventory table for any of `needles` (exact, case-insensitive; JSON also in its escaped form). Scoped to the source when the table has one. */
async function probeTable(engine: BrainEngine, entry: InventoryEntry, sourceId: string, needles: readonly string[], deadline: number): Promise<ProbeResult> {
  const columns = (entry.probe ?? entry.columns).filter(col => !PROBE_SKIP.test(col));
  const list = needles.filter(Boolean).slice(0, 32);
  if (!columns.length || !list.length) return { count: 0 };
  const scoped = entry.columns.includes('source_id');
  // Bytes are matched exactly (case-sensitive) against the UTF-8 needle.
  const binary = entry.table === 'minion_attachments';
  const params: unknown[] = [sourceId];
  const ors: string[] = [];
  for (const needle of list) {
    if (binary) { params.push(needle); ors.push(...columns.map(col => `position(convert_to($${params.length}::text,'UTF8') in ${col})>0`)); continue; }
    params.push(needle.toLowerCase(), JSON.stringify(needle).slice(1, -1).toLowerCase());
    ors.push(...columns.map(col => textMatch(col, params.length - 1)));
  }
  return boundedCount(engine, `SELECT 1 FROM ${entry.table} WHERE ${scoped ? 'source_id=$1 AND' : '$1::text IS NOT NULL AND'} (${ors.join(' OR ')})`, params, deadline);
}

/** The generic adapter for a `probed_reported` inventory entry. */
async function probeInventoryStore(engine: BrainEngine, entry: InventoryEntry, sourceId: string, needles: readonly string[], deadline: number): Promise<StoreReport> {
  const result = await probeTable(engine, entry, sourceId, needles, deadline);
  if ('unverified' in result) return { store: entry.table, status: 'unverified', reason: result.unverified };
  return result.count
    ? { store: entry.table, status: 'out_of_scope', reason: 'probed_reported', remaining: result.count,
      detail: `${result.count} row(s) still mention the purged text; purge does not rewrite this store${entry.columns.includes('source_id') ? '' : ' (probed brain-wide)'}.` }
    : { store: entry.table, status: 'not_present' };
}

/**
 * CEO-22: every swept inventory store appears in a receipt. A swept store
 * without its own adapter is probed for the purged text: still present is
 * `incomplete`; absent is `deleted` when the sweep removed rows there, else
 * `not_present`.
 */
async function sweptInventoryReports(engine: BrainEngine, reported: ReadonlySet<string>, sourceId: string, needles: readonly string[],
  removed: StoreCount, deadline: number, dryRun: boolean): Promise<StoreReport[]> {
  const reports: StoreReport[] = [];
  for (const entry of DELETION_INVENTORY) {
    if (entry.class !== 'swept' || reported.has(entry.table)) continue;
    const planned = removed[entry.table] ?? 0;
    if (dryRun) { reports.push({ store: entry.table, status: planned ? 'would_remove' : 'not_present', removed: planned }); continue; }
    const result = await probeTable(engine, entry, sourceId, needles, deadline);
    if ('unverified' in result) reports.push({ store: entry.table, status: 'unverified', reason: result.unverified, removed: planned });
    else if (result.count) reports.push({ store: entry.table, status: 'incomplete', remaining: result.count, removed: planned });
    else reports.push({ store: entry.table, status: planned ? 'deleted' : 'not_present', removed: planned });
  }
  return reports;
}

/** Commits in the page files' history that add or remove the claim's fence cell. The pattern never enters argv. */
export async function gitResidualCommits(root: string, paths: readonly string[], claim: string, limits = { bytes: PURGE_PROBE_LIMITS.gitBytes, ms: PURGE_PROBE_LIMITS.gitMs }):
  Promise<StoreReport> {
  if (!paths.length || !existsSync(join(root, '.git'))) return { store: 'git_history', status: 'out_of_reach', reason: 'no_repository', detail: 'No brain repository is recorded for these pages.' };
  const needles = [escapeFenceCell(claim).toLowerCase(), claim.toLowerCase()];
  return new Promise(resolve => {
    const child = spawn('git', ['-C', root, '--literal-pathspecs', 'log', '--all', '--format=commit %H %cI', '-p', '--no-color', '--no-ext-diff', '--', ...paths],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
    const commits: Array<{ commit: string; committed_at: string }> = [];
    let current: { commit: string; committed_at: string } | null = null, bytes = 0, tail = '', bounded: string | null = null;
    const timer = setTimeout(() => { bounded = 'deadline'; child.kill('SIGKILL'); }, limits.ms);
    const scan = (line: string) => {
      if (line.startsWith('commit ')) { const [, commit, at] = line.split(' '); current = { commit, committed_at: at }; return; }
      if (!current || commits.at(-1)?.commit === current.commit) return;
      if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
        const lower = line.toLowerCase();
        if (needles.some(n => lower.includes(n))) commits.push(current);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.bytes) { bounded = 'byte_bound'; child.kill('SIGKILL'); return; }
      const lines = (tail + chunk.toString('utf8')).split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) scan(line);
    });
    child.on('error', () => { clearTimeout(timer); resolve({ store: 'git_history', status: 'out_of_reach', reason: 'git_unavailable' }); });
    child.on('close', () => {
      clearTimeout(timer);
      if (tail) scan(tail);
      const items = commits.slice(0, 50);
      resolve({ store: 'git_history', status: bounded ? 'unverified' : 'out_of_reach', ...(bounded ? { reason: bounded } : {}), remaining: commits.length, items,
        detail: commits.length ? `${commits.length} commit(s) in this repository's history add or remove the row; purge never rewrites history (other clones and remotes have their own copies).`
          : 'No commit in the page files\' recorded history carries the row.' });
    });
  });
}

async function pageFilePaths(engine: BrainEngine, sourceId: string, pageIds: number[]): Promise<{ root: string | null; paths: string[]; files: string[] }> {
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  if (!source?.local_path || !pageIds.length) return { root: source?.local_path ?? null, paths: [], files: [] };
  const rows = await engine.executeRaw<{ source_path: string }>(`SELECT DISTINCT source_path FROM (
      SELECT source_path FROM pages WHERE id=ANY($1::int[]) UNION ALL SELECT source_path FROM page_versions WHERE page_id=ANY($1::int[])) s
    WHERE source_path IS NOT NULL AND source_path<>'' AND source_path NOT LIKE '/%' AND source_path NOT LIKE '%..%' LIMIT 64`, [pageIds]);
  const paths = rows.map(r => r.source_path);
  return { root: source.local_path, paths, files: paths.map(p => join(source.local_path!, p)) };
}

/** The canonical files, their .tmp evidence and the failure log; the .tmp copy carrying the claim is deleted. */
function onDiskReports(files: string[], claim: string, dryRun: boolean): StoreReport[] {
  const needle = claim.toLowerCase();
  const carrying = (path: string) => { try { return existsSync(path) && readFileSync(path, 'utf8').toLowerCase().includes(needle); } catch { return false; } };
  const stale = files.filter(carrying);
  const tmp = files.map(f => `${f}.tmp`).filter(carrying);
  if (!dryRun) for (const path of tmp) { try { unlinkSync(path); } catch { /* reported below */ } }
  const tmpLeft = dryRun ? tmp : tmp.filter(existsSync);
  const log = carrying(gbrainPath('facts.write_failures.jsonl'));
  return [
    { store: 'canonical_markdown', status: !files.length ? 'not_present' : stale.length ? (dryRun ? 'would_remove' : 'out_of_scope') : (dryRun ? 'not_present' : 'deleted'),
      ...(!files.length ? { detail: 'No page file is recorded for the affected pages (database-only source).' } : {}),
      ...(stale.length ? { remaining: stale.length, reason: dryRun ? undefined : 'pending_mirror_or_prose',
        detail: dryRun ? 'The mirror effect rewrites these files after commit.' : 'A page file still carries the claim: the mirror effect has not run yet, the source has no managed checkout, or the text is prose outside the fence.' } : {}) },
    { store: 'fence_tmp_evidence', status: tmpLeft.length ? (dryRun ? 'would_remove' : 'incomplete') : tmp.length ? 'deleted' : 'not_present', ...(tmp.length ? { removed: dryRun ? 0 : tmp.length - tmpLeft.length } : {}) },
    { store: 'facts_write_failures_log', status: log ? 'out_of_reach' : 'not_present', ...(log ? { detail: '~/.gbrain/facts.write_failures.jsonl mentions the claim; edit it by hand if needed.' } : {}) },
  ];
}

/** Same-model nearest neighbours of the purged fact's embedding: paraphrase candidates, never a gate. */
async function vectorProbe(engine: BrainEngine, target: PurgeTarget): Promise<Record<string, unknown>> {
  if (!target.embedding || !target.embedding_model) return { status: 'skipped', reason: 'no_embedding', gate: false };
  try {
    const rows = await engine.executeRaw<{ id: number; similarity: number; contains_claim: boolean }>(`SELECT id,(1-(embedding <=> $1::halfvec))::float8 AS similarity,
        strpos(gbrain_fact_normalize(fact),gbrain_fact_normalize($4))>0 AS contains_claim
      FROM facts WHERE source_id=$2 AND embedding_model=$3 AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::halfvec LIMIT 5`, [target.embedding, target.source_id, target.embedding_model, target.fact]);
    return { status: 'checked', gate: false, model: target.embedding_model,
      candidates: rows.map(r => ({ fact_id: Number(r.id), similarity: Math.round(Number(r.similarity) * 1000) / 1000, contains_claim: r.contains_claim === true })),
      note: 'Nearest same-model facts are possible rewordings for the user to review; a neighbour always exists, so this is not a residual count.' };
  } catch {
    return { status: 'skipped', reason: 'model_or_dimension_mismatch', gate: false };
  }
}

/** Build the receipt: swept-store verification (or would-remove counts on a dry run), probes, residuals first. */
export async function verifyFactPurge(engine: BrainEngine, input: { target: PurgeTarget; plan: PurgePlan; dryRun: boolean; removed?: StoreCount;
  prose?: Array<{ slug: string; version_id: number }>; vacuum?: boolean }): Promise<PurgeReceipt> {
  const { target, plan, dryRun } = input;
  const deadline = performance.now() + probeLimits.totalMs;
  const claim = target.fact, needle = claim.toLowerCase(), src = target.source_id;
  const removed = input.removed ?? {};
  const stores: StoreReport[] = [];
  const swept = async (store: string, sql: string, params: unknown[], planned: number, removedCount: number | undefined, onRemaining: Omit<StoreReport, 'store'> = { status: 'incomplete' }) => {
    if (dryRun) { stores.push({ store, status: planned ? 'would_remove' : 'not_present', removed: planned }); return; }
    const result = await boundedCount(engine, sql, params, deadline);
    if ('unverified' in result) stores.push({ store, status: 'unverified', reason: result.unverified, removed: removedCount ?? 0 });
    else if (result.count) stores.push({ store, removed: removedCount ?? 0, remaining: result.count, ...onRemaining });
    else stores.push({ store, status: removedCount ? 'deleted' : 'not_present', removed: removedCount ?? 0 });
  };
  await swept('facts', `SELECT 1 FROM facts WHERE source_id=$1 AND visibility=$2 AND gbrain_fact_fingerprint(fact)=$3 AND ($4='*' OR entity_slug=$4)`,
    [src, target.visibility, target.fact_hash, plan.subject], plan.factIds.length, removed.facts);
  await swept('takes', `SELECT 1 FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND gbrain_fact_fingerprint(k.claim)=$2 AND ($3='*' OR p.slug=$3)`,
    [src, target.fact_hash, plan.subject], plan.takes.length, removed.takes);
  const prose = { status: 'out_of_scope' as const, reason: 'source_prose', detail: 'The claim text survives outside a facts fence (page prose); purge the page or edit it to remove it.' };
  await swept('pages', `SELECT 1 FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND (strpos(lower(compiled_truth),$2)>0 OR strpos(lower(timeline),$2)>0)`,
    [src, needle], plan.pages.length, removed.pages, prose);
  await swept('content_chunks', `SELECT 1 FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND strpos(lower(c.chunk_text),$2)>0`,
    [src, needle], plan.pages.length, removed.chunks, prose);
  await swept('page_versions', `SELECT 1 FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1
      AND (strpos(lower(v.compiled_truth),$2)>0 OR strpos(lower(COALESCE(v.timeline,'')),$2)>0)`,
    [src, needle], plan.versions, removed.page_versions, { ...prose, items: (input.prose ?? []).slice(0, 20) });
  await swept('persistence_requests', `SELECT 1 FROM persistence_requests WHERE source_id=$1 AND (${['intent', 'outcome', 'error_detail', 'error_message']
      .map(c => `strpos(lower(COALESCE(${c}::text,'')),$2)>0 OR strpos(lower(COALESCE(${c}::text,'')),$3)>0`).join(' OR ')})`,
    [src, needle, JSON.stringify(claim).slice(1, -1).toLowerCase()], plan.requests.length, removed.persistence_requests);
  await swept('query_cache', 'SELECT 1 FROM query_cache WHERE $1::text IS NOT NULL', [src], 0, removed.query_cache);
  const refs = plan.factIds.map(String);
  for (const table of ['decide_review_queue', 'decide_review_proposals'] as const) {
    await swept(table, `SELECT 1 FROM ${table} WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))`, [src, refs], plan.review[table], plan.review[table]);
  }
  await swept('decide_proposals', 'SELECT 1 FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($2::bigint[]) OR old_fact_id=ANY($2::bigint[]))',
    [src, plan.factIds], plan.review.decide_proposals, plan.review.decide_proposals);
  await swept('take_proposals', 'SELECT 1 FROM take_proposals WHERE source_id=$1 AND gbrain_fact_fingerprint(claim_text)=$2', [src, target.fact_hash], 0, removed.take_proposals);
  await swept('core_edit_notices', 'SELECT 1 FROM core_edit_notices WHERE source_id=$1 AND strpos(lower(base_text),$2)>0', [src, needle], 0, removed.core_edit_notices);
  stores.push({ store: 'derived_artifacts', status: plan.derived.truncated ? 'unverified' : plan.derived.rows.length ? (dryRun ? 'would_remove' : 'retained_inactive') : 'not_present',
    removed: plan.derived.rows.length, ...(plan.derived.truncated ? { reason: 'derivation_walk_bound' } : {}),
    ...(plan.derived.rows.length ? { detail: 'Model-derived rows built from this fact are hidden and marked needs_rederive; they are not counted as removed text.' } : {}) });
  const [legacy] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
    AND (p.type='atom' OR p.frontmatter->>'dream_generated'='true')
    AND NOT EXISTS (SELECT 1 FROM derivation_inputs d WHERE d.derived_table='pages' AND d.derived_id=p.id::text)`, [src]);
  if (Number(legacy?.n ?? 0)) stores.push({ store: 'derived_legacy', status: 'unverified', reason: 'legacy_no_derivation_edges', remaining: Number(legacy.n),
    detail: `${legacy.n} model-derived page(s) in this source predate derivation edges, so purge cannot tell whether they restate the claim in other words.` });
  stores.push(...await sweptInventoryReports(engine, new Set(stores.map(s => s.store)), src, [claim], removed, deadline, dryRun));
  for (const entry of DELETION_INVENTORY) {
    if (entry.class !== 'out_of_scope' || entry.reason !== 'probed_reported') continue;
    stores.push(await probeInventoryStore(engine, entry, src, [claim], deadline));
  }
  const [other] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND gbrain_fact_fingerprint(fact)=$2
    AND NOT (visibility=$3 AND ($4='*' OR entity_slug=$4))`, [src, target.fact_hash, target.visibility, plan.subject]);
  const files = await pageFilePaths(engine, src, plan.pages.map(page => page.page_id));
  stores.push(...onDiskReports(files.files, claim, dryRun));
  const residuals: StoreReport[] = [];
  if (files.root && files.paths.length) residuals.push(await gitResidualCommits(files.root, files.paths, claim));
  for (const r of OUT_OF_REACH_RESIDUALS) {
    if (r.store === 'git_history' && residuals.length) continue;
    const detail = r.store === 'database_physical' ? `${r.detail}${engine.kind === 'pglite' ? (input.vacuum ? ' VACUUM ran on the touched tables; filesystem blocks and snapshots may still hold old pages.' : ' PGLite has no autovacuum; rerun with --vacuum to compact the touched tables.') : ' On Postgres the operator runs VACUUM; WAL archives, replicas and PITR windows are outside gbrain.'}` : r.detail;
    residuals.push({ store: r.store, status: 'out_of_reach', detail });
  }
  if (Number(other?.n ?? 0)) residuals.push({ store: 'facts_other_scope', status: 'out_of_scope', reason: plan.subject === '*' ? 'other_visibility' : 'other_subject', remaining: Number(other.n),
    detail: `${other.n} fact row(s) state the same claim about another entity or at another visibility; rerun with --all-subjects to purge every entity's copy.` });
  residuals.push(...stores.filter(s => s.reason === 'source_prose' || s.reason === 'probed_reported' || s.store === 'canonical_markdown' && s.status === 'out_of_scope'));
  if (input.vacuum && !dryRun && engine.kind === 'pglite') await engine.executeRaw('VACUUM facts, takes, pages, content_chunks, page_versions, persistence_requests, query_cache').catch(() => undefined);
  const next = dryRun
    ? ['Review the residuals with the user, then confirm with the token printed above (gbrain forget <id> --purge asks for it on a terminal).']
    : ['Poll completion with gbrain forget --purge --status --request-id <request_id> until it reports complete.'];
  return {
    summary: dryRun ? 'Dry run: nothing was removed. Counts are what the purge would remove from live stores.'
      : 'Removed from live stores. Residuals below are copies purge cannot reach; this is not physical erasure.',
    fact_id: target.id, fact_hash: target.fact_hash, hash8: target.fact_hash.slice(0, 8), source_id: src, subject: plan.subject, visibility: target.visibility,
    residuals, stores, vector_probe: await vectorProbe(engine, target), next,
    ...(engine.kind === 'postgres' && !dryRun ? { tell_user_to_run: { argv: ['psql', '-c', 'VACUUM (VERBOSE) facts, takes, pages, content_chunks, page_versions, persistence_requests'],
      why: 'Deleted rows stay in Postgres table pages and WAL until VACUUM and WAL recycling; the operator runs it (gbrain does not on Postgres).' } } : {}),
  };
}

/** In-process context a page purge keeps for its receipt (never journaled): the page's claims as probe needles, and row ids. */
export interface PagePurgeContext { needles: string[]; factIds: number[]; pageId: number; paths: string[] }

const outOfReach = (engine: BrainEngine): StoreReport[] => OUT_OF_REACH_RESIDUALS.map(r => ({ store: r.store, status: 'out_of_reach' as const,
  detail: r.store === 'database_physical' ? `${r.detail}${engine.kind === 'pglite' ? ' PGLite has no autovacuum.' : ' On Postgres the operator runs VACUUM; WAL archives, replicas and PITR windows are outside gbrain.'}` : r.detail }));

/**
 * CEO-4 / C4: the page purge receipt, store by store like the fact receipt. Page-keyed stores are checked by
 * slug and page id; every other swept inventory store and every probed store is searched for the page's claims;
 * other pages whose prose still carries one are listed as `source_prose`; residuals come first.
 */
export async function verifyPagePurge(engine: BrainEngine, input: { sourceId: string; slug: string; requestId: string; removed: StoreCount;
  blobsRemaining: string[]; context: PagePurgeContext | null }): Promise<Record<string, unknown>> {
  const { sourceId: src, slug, removed, context } = input;
  const deadline = performance.now() + probeLimits.totalMs;
  const needles = context?.needles ?? [];
  const stores: StoreReport[] = [];
  const keyed = async (store: string, sql: string, params: unknown[]) => {
    const result = await boundedCount(engine, sql, params, deadline);
    const n = removed[store] ?? 0;
    if ('unverified' in result) stores.push({ store, status: 'unverified', reason: result.unverified, removed: n });
    else if (result.count) stores.push({ store, status: 'incomplete', remaining: result.count, removed: n });
    else stores.push({ store, status: n ? 'deleted' : 'not_present', removed: n });
  };
  await keyed('pages', 'SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', [src, slug]);
  if (context) for (const table of ['content_chunks', 'page_versions', 'takes', 'timeline_entries']) await keyed(table, `SELECT 1 FROM ${table} WHERE page_id=$1`, [context.pageId]);
  await keyed('facts', 'SELECT 1 FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [src, slug]);
  for (const table of ['take_proposals', 'open_loops']) await keyed(table, `SELECT 1 FROM ${table} WHERE source_id=$1 AND page_slug=$2`, [src, slug]);
  await keyed('core_edit_notices', 'SELECT 1 FROM core_edit_notices WHERE source_id=$1 AND slug=$2', [src, slug]);
  await keyed('files', 'SELECT 1 FROM files WHERE page_slug=$2 AND (source_id=$1 OR source_id IS NULL)', [src, slug]);
  await keyed('write_gate_holds', 'SELECT 1 FROM write_gate_holds WHERE source_id=$1 AND slug=$2', [src, slug]);
  await keyed('query_cache', 'SELECT 1 FROM query_cache WHERE $1::text IS NOT NULL', [src]);
  if (context) {
    const refs = context.factIds.map(String);
    for (const table of ['decide_review_queue', 'decide_review_proposals']) await keyed(table, `SELECT 1 FROM ${table} WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))`, [src, refs]);
    await keyed('decide_proposals', 'SELECT 1 FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($2::bigint[]) OR old_fact_id=ANY($2::bigint[]))', [src, context.factIds]);
    await keyed('trust_proposals', `SELECT 1 FROM trust_proposals WHERE source_id=$1 AND ((target_table='pages' AND target_id=$2) OR (related_table='pages' AND related_id=$2)
      OR (target_table='facts' AND target_id=ANY($3::bigint[])) OR (related_table='facts' AND related_id=ANY($3::bigint[])))`, [src, context.pageId, context.factIds]);
  }
  const textChecks = needles.flatMap((n, i) => ['intent', 'outcome', 'error_detail', 'error_message'].map(c => `strpos(lower(COALESCE(${c}::text,'')),$${4 + i})>0`));
  await keyed('persistence_requests', `SELECT 1 FROM persistence_requests WHERE source_id=$1 AND request_id<>$3::uuid AND (
      (slug=$2 AND intent IS NOT NULL AND state IN ('committed','conflict','failed','cancelled'))${textChecks.length ? ` OR ${textChecks.join(' OR ')}` : ''})`,
  [src, slug, input.requestId, ...needles.map(n => n.toLowerCase())]);
  stores.push(...await sweptInventoryReports(engine, new Set(stores.map(s => s.store)), src, needles, removed, deadline, false));
  for (const entry of DELETION_INVENTORY) {
    if (entry.class === 'out_of_scope' && entry.reason === 'probed_reported') stores.push(await probeInventoryStore(engine, entry, src, needles, deadline));
  }
  if (!context) stores.push({ store: 'source_prose', status: 'unverified', reason: 'prose_probe_unavailable',
    detail: 'The receipt was built by another process than the purge, so other pages were not searched for the purged page\'s claims.' });
  else if (needles.length) {
    // Page-text stores are judged source-wide as in the fact receipt: the purged page's rows are gone, so any claim
    // text left there is another page's prose (`out_of_scope: source_prose`, naming those pages).
    const lowered = needles.map(n => n.toLowerCase());
    const proseIn: Record<string, string> = {
      pages: `SELECT DISTINCT p.slug FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(p.compiled_truth),n)>0 OR strpos(lower(COALESCE(p.timeline,'')),n)>0)`,
      content_chunks: `SELECT DISTINCT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(c.chunk_text),n)>0)`,
      page_versions: `SELECT DISTINCT p.slug FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(v.compiled_truth),n)>0 OR strpos(lower(COALESCE(v.timeline,'')),n)>0)`,
      timeline_entries: `SELECT DISTINCT p.slug FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(t.summary),n)>0 OR strpos(lower(COALESCE(t.detail,'')),n)>0)`,
    };
    const all = new Set<string>();
    for (const [store, sql] of Object.entries(proseIn)) {
      const slugs = (await engine.executeRaw<{ slug: string }>(`${sql} ORDER BY 1 LIMIT 20`, [src, lowered])).map(r => r.slug);
      if (!slugs.length) continue;
      slugs.forEach(s => all.add(s));
      const at = stores.findIndex(s => s.store === store);
      const report: StoreReport = { store, status: 'out_of_scope', reason: 'source_prose', removed: removed[store] ?? 0, remaining: slugs.length, items: slugs,
        detail: 'The purged page\'s rows are gone; other pages still state one of its claims in their prose. Edit or purge them.' };
      if (at >= 0 && stores[at]!.status !== 'incomplete') stores[at] = report; else if (at < 0) stores.push(report);
    }
    stores.push(all.size ? { store: 'source_prose', status: 'out_of_scope', reason: 'source_prose', remaining: all.size, items: [...all].sort(),
      detail: 'Other pages still state a claim from the purged page in their prose; edit or purge them.' } : { store: 'source_prose', status: 'not_present' });
  }
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [src]);
  const files = source?.local_path ? (context?.paths ?? []).filter(p => !p.startsWith('/') && !p.includes('..')).map(p => join(source.local_path!, p)) : [];
  const present = files.filter(f => existsSync(f)), tmp = files.map(f => `${f}.tmp`).filter(f => existsSync(f));
  for (const path of tmp) { try { unlinkSync(path); } catch { /* reported below */ } }
  stores.push({ store: 'canonical_markdown', status: !files.length ? 'not_present' : present.length ? 'incomplete' : 'deleted', ...(present.length ? { remaining: present.length } : {}) },
    { store: 'fence_tmp_evidence', status: tmp.some(existsSync) ? 'incomplete' : tmp.length ? 'deleted' : 'not_present' },
    { store: 'file_blobs', status: input.blobsRemaining.length ? 'incomplete' : (removed.files ? 'deleted' : 'not_present'), ...(input.blobsRemaining.length ? { items: input.blobsRemaining } : {}) });
  const [tombstones] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_purges WHERE source_id=$1 AND slug=$2', [src, slug]);
  const residuals: StoreReport[] = [];
  if (source?.local_path && context?.paths.length && needles.length) residuals.push(await gitResidualCommits(source.local_path, context.paths, needles[0]!));
  residuals.push(...outOfReach(engine).filter(r => !(r.store === 'git_history' && residuals.length)));
  residuals.push(...stores.filter(s => s.reason === 'source_prose' || s.reason === 'probed_reported'));
  const [row] = await engine.executeRaw<Pick<WriteRequest, 'id' | 'state' | 'source_id' | 'outcome'>>(`SELECT id,state,source_id,outcome FROM persistence_requests
    WHERE source_id=$1 AND request_id=$2::uuid AND operation='delete_page' ORDER BY created_at DESC LIMIT 1`, [src, input.requestId]);
  return { summary: 'Removed from live stores. Residuals below are copies purge cannot reach; this is not physical erasure.',
    residuals, stores, page_tombstones: Number(tombstones?.n ?? 0),
    ...(row ? await purgeCompletion(engine, row, { stores }) : {}),
    next: ['Other pages listed under source_prose still state the purged claims; edit or purge them. gbrain pages purges list shows the tombstones.'],
    ...(engine.kind === 'postgres' ? { tell_user_to_run: { argv: ['psql', '-c', 'VACUUM (VERBOSE) pages, content_chunks, page_versions, facts, takes, persistence_requests'],
      why: 'Deleted rows stay in Postgres table pages and WAL until VACUUM and WAL recycling; the operator runs it (gbrain does not on Postgres).' } } : {}) };
}

/**
 * DX-12: `committed` once the transaction committed and effects are pending,
 * `complete` once every effect committed and no swept store reported a
 * residual, `incomplete` when an effect failed or parked or a swept store
 * still holds the claim. Out-of-reach residuals never make it incomplete.
 */
export async function purgeCompletion(engine: BrainEngine, row: Pick<WriteRequest, 'id' | 'state' | 'source_id' | 'outcome'>, receipt?: Pick<PurgeReceipt, 'stores'>):
  Promise<{ completion: PurgeCompletion; effects: Array<{ kind: string; state: string; error_code: string | null }>; exit_code: number; fingerprint_probe?: Record<string, number> }> {
  if (row.state !== 'committed') return { completion: 'incomplete', effects: [], exit_code: 75 };
  const effects = await engine.executeRaw<{ kind: string; state: string; error_code: string | null; parked: boolean }>(`SELECT kind,state,error_code,
    jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 AS parked FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind`, [row.id]);
  const purge = (row.outcome as { purge?: { fact_hash?: string; subject?: string } } | null)?.purge;
  let fingerprint: Record<string, number> | undefined;
  if (purge?.fact_hash) {
    const [probe] = await engine.executeRaw<{ facts: number; takes: number }>(`SELECT
      (SELECT count(*)::int FROM facts WHERE source_id=$1 AND gbrain_fact_fingerprint(fact)=$2 AND ($3='*' OR entity_slug=$3)) AS facts,
      (SELECT count(*)::int FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND gbrain_fact_fingerprint(k.claim)=$2 AND ($3='*' OR p.slug=$3)) AS takes`,
    [row.source_id, purge.fact_hash, purge.subject ?? '*']);
    fingerprint = { facts: Number(probe?.facts ?? 0), takes: Number(probe?.takes ?? 0) };
  }
  const failed = effects.some(e => e.state === 'failed' || e.parked);
  const sweptResidual = receipt?.stores.some(s => s.status === 'incomplete') || (fingerprint && (fingerprint.facts || fingerprint.takes));
  const pending = effects.some(e => e.state !== 'committed');
  const completion: PurgeCompletion = failed || sweptResidual ? 'incomplete' : pending ? 'committed' : 'complete';
  return { completion, effects: effects.map(({ kind, state, error_code }) => ({ kind, state, error_code })),
    exit_code: completion === 'complete' ? 0 : completion === 'committed' ? 10 : 75, ...(fingerprint ? { fingerprint_probe: fingerprint } : {}) };
}

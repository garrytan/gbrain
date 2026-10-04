/**
 * `gbrain facts relink` publication (#5836): one coordinator request per
 * entity page moves unlinked facts onto that page's `## Facts` fence by id.
 *
 * The request runs through the same write coordinator remember uses on every
 * brain (managed or not), so a relinked fact ends exactly where a fresh
 * remember with that entity would put it: a fence row in the page body (and
 * the canonical file when the source is bound and writes through), indexed by
 * the fact's own row with `entity_slug`, `source_markdown_slug` and `row_num`
 * set together. The coordinator journals the request, so a crash replays or
 * refuses it as a unit; there is no half-adopted state for extract_facts to
 * trip over.
 *
 * Each fact's whole row is pinned by hash at admission. Preparation and the
 * locked validation classify every pinned fact the same way or the request
 * is refused as `revision_conflict`. An exact duplicate of an active fact on
 * the page (or of an earlier fact in the same request) is retired the way
 * phantom merge retires duplicates: moved to the entity, expired and
 * detached, never deleted. Relink never supersedes anything; similar facts
 * stay active for the conflict sweep, which the request queues in the same
 * transaction.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { formatFenceDate, parseFactsFence, upsertFactRow } from '../facts-fence.ts';
import { digest } from '../persistence/digest.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { applyPreservingTakeResolutions, readFacts, type FactSnapshot } from '../persistence/prepared-maintenance.ts';
import { decideSingleFact } from './single-prepare.ts';
import { isFactWithdrawn } from './withdrawal.ts';
import { appendContextNote } from './subject-infer.ts';

export const RELINK_OPERATION = 'relink_facts';

/** One fact in a relink request: its pinned row hash and how its subject was found. */
export interface RelinkIntentFact { id: number; hash: string; tier: string; model: string | null; note: string }
export interface RelinkIntent { kind: 'relink_facts'; run_id: string; queue_conflict: boolean; facts: RelinkIntentFact[] }

export interface RelinkGroupOutcome {
  linked: Array<{ id: number; row_num: number }>;
  deduped: Array<{ id: number; duplicate_of: number }>;
  skipped: Array<{ id: number; reason: RelinkSkipReason }>;
  queued: number;
}

/** The whole-row hash a relink request pins at admission. */
export function relinkFactHash(snapshot: FactSnapshot): string {
  return digest(snapshot.value);
}

export type RelinkSkipReason = 'revision_conflict' | 'withdrawn' | 'claim_unfenceable' | 'visibility_conflict';

type Classified =
  | { id: number; action: 'link'; value: Record<string, unknown> }
  | { id: number; action: 'retire'; duplicateOf: number }
  | { id: number; action: 'skip'; reason: RelinkSkipReason };

/** The fence cell a relinked row renders as. */
function fenceRow(v: Record<string, unknown>, rowNum: number, context: string) {
  return {
    rowNum, claim: String(v.fact), kind: v.kind as never, confidence: Number(v.confidence ?? 1),
    visibility: v.visibility as never, notability: (v.notability ?? 'medium') as never,
    validFrom: formatFenceDate(new Date(String(v.valid_from))),
    validUntil: v.valid_until ? formatFenceDate(new Date(String(v.valid_until))) : undefined,
    source: v.source == null ? undefined : String(v.source),
    context,
    ...(v.claim_metric ? { claimMetric: String(v.claim_metric) } : {}),
    ...(v.claim_value != null ? { claimValue: Number(v.claim_value) } : {}),
    ...(v.claim_unit ? { claimUnit: String(v.claim_unit) } : {}),
    ...(v.claim_period ? { claimPeriod: String(v.claim_period) } : {}),
  };
}

/**
 * A claim the fence cannot carry unchanged (wrapped in ~~, or otherwise not
 * parsing back to the same active claim and visibility) would be expired and
 * re-inserted as a different fact by the page projection, so it is never moved.
 */
function roundTrips(v: Record<string, unknown>, context: string): boolean {
  const parsed = parseFactsFence(upsertFactRow('', fenceRow(v, 1, context)).body);
  const cell = parsed.facts[0];
  return parsed.warnings.length === 0 && parsed.facts.length === 1 && cell!.active && cell!.claim === String(v.fact)
    && cell!.visibility === v.visibility && (cell!.context ?? '') === context;
}

function isActiveUnlinked(v: Record<string, unknown>, now: number): boolean {
  return v.entity_slug === null && v.row_num === null && v.source_markdown_slug === null && v.expired_at === null
    && (v.valid_until === null || new Date(String(v.valid_until)).getTime() > now);
}

async function classify(db: BrainEngine, row: WriteRequest, intent: RelinkIntent, lock: boolean): Promise<Classified[]> {
  const current = await readFacts(db, row.source_id, intent.facts.map(f => f.id), lock);
  const now = Date.now();
  const seen = new Map<string, { id: number; visibility: string }>();
  const out: Classified[] = [];
  for (const f of intent.facts) {
    const snap = current.find(c => c.id === f.id);
    if (!snap || relinkFactHash(snap) !== f.hash || !isActiveUnlinked(snap.value, now)) {
      out.push({ id: f.id, action: 'skip', reason: 'revision_conflict' });
      continue;
    }
    const v = snap.value;
    const visibility = v.visibility as 'private' | 'world';
    if (!roundTrips(v, appendContextNote(v.context as string | null, f.note))) {
      out.push({ id: f.id, action: 'skip', reason: 'claim_unfenceable' });
      continue;
    }
    if (await isFactWithdrawn(db, row.source_id, visibility, String(v.fact), row.slug)) {
      out.push({ id: f.id, action: 'skip', reason: 'withdrawn' });
      continue;
    }
    // The page projection indexes one active fence row per (claim, source), whatever
    // its visibility; a second one would be expired right after it was linked.
    const [same] = await db.executeRaw<{ id: number | string; visibility: string }>(
      `SELECT id, visibility FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL
         AND expired_at IS NULL AND fact=$3 AND source IS NOT DISTINCT FROM $4 ORDER BY id LIMIT 1`,
      [row.source_id, row.slug, String(v.fact), v.source ?? null]);
    if (same) {
      out.push(same.visibility === visibility ? { id: f.id, action: 'retire', duplicateOf: Number(same.id) }
        : { id: f.id, action: 'skip', reason: 'visibility_conflict' });
      continue;
    }
    const exact = await decideSingleFact(db, row.source_id,
      { entity_slug: row.slug, fact: String(v.fact), kind: v.kind as never, visibility }, null);
    if (exact.status === 'duplicate' && exact.candidate) {
      out.push({ id: f.id, action: 'retire', duplicateOf: Number(exact.candidate.id) });
      continue;
    }
    const key = JSON.stringify([String(v.fact), v.source ?? null]);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      out.push(earlier.visibility === visibility ? { id: f.id, action: 'retire', duplicateOf: earlier.id }
        : { id: f.id, action: 'skip', reason: 'visibility_conflict' });
      continue;
    }
    seen.set(key, { id: f.id, visibility });
    out.push({ id: f.id, action: 'link', value: v });
  }
  return out;
}

const classKey = (c: Classified[]) => JSON.stringify(c.map(x => x.action === 'link' ? [x.id, 'link']
  : x.action === 'retire' ? [x.id, 'retire', x.duplicateOf] : [x.id, 'skip', x.reason]));

export async function prepareRelinkMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const intent = row.intent as unknown as RelinkIntent | null;
  const rerun = `The next gbrain facts relink --source ${row.source_id} run re-plans from current state; preview it with --dry-run (no model calls, no writes).`;
  const changed = (message: string) => opError('revision_conflict', message,
    `${row.slug} or one of its facts changed while relink request ${row.request_id} was being prepared, so nothing was written. ${rerun}`);
  if (row.operation !== RELINK_OPERATION || intent?.kind !== 'relink_facts' || !Array.isArray(intent.facts) || row.authority.remote) {
    throw opError('permission_denied', 'Unsupported relink intent.',
      `Request ${row.request_id} is not a trusted local relink this gbrain version can publish, so nothing was written. Facts relink runs only from gbrain facts relink on the brain host.`);
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== row.page_id) {
    throw opError('page_identity_changed', 'The relink target page changed.',
      `${row.slug} in ${row.source_id} was deleted or replaced after relink request ${row.request_id} was accepted, so nothing was written. ${rerun}`);
  }
  const observedRevision = snapshot.revision;
  const planned = await classify(engine, row, intent, false);
  const byId = new Map(intent.facts.map(f => [f.id, f]));
  const links = planned.filter((c): c is Extract<Classified, { action: 'link' }> => c.action === 'link');

  let body = snapshot.page.compiled_truth;
  const rowNums = new Map<number, number>();
  if (links.length) {
    const parsed = parseFactsFence(body);
    if (parsed.warnings.length) {
      throw opError('invalid_params', 'fence_malformed: the entity facts fence is malformed; repair it before relinking.',
        `Fix the ## Facts table on ${row.slug} in ${row.source_id} (one header row, then one row per fact), then run gbrain facts relink --source ${row.source_id} again; nothing was written.`);
    }
    const [max] = await engine.executeRaw<{ n: number }>(
      'SELECT COALESCE(MAX(row_num),0)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [row.source_id, row.slug]);
    let next = Math.max(Number(max?.n ?? 0), 0, ...parsed.facts.map(f => f.rowNum)) + 1;
    for (const link of links) {
      const v = link.value;
      const rowNum = next++;
      rowNums.set(link.id, rowNum);
      body = upsertFactRow(body, fenceRow(v, rowNum, appendContextNote(v.context as string | null, byId.get(link.id)!.note))).body;
    }
  }
  const page = links.length ? await (await import('../persistence/page-prepare.ts')).preparePageMutation(engine, { ...row, intent: {
    content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags), expected_revision: observedRevision, force: false,
  } }, config) : undefined;
  if (page && page.observedRevision !== observedRevision) throw changed('The relink target page changed during preparation.');

  const validate = async (tx: BrainEngine) => {
    if (classKey(await classify(tx, row, intent, true)) !== classKey(planned)) {
      throw changed('A relinked fact changed during preparation.');
    }
    await page?.validate?.(tx);
  };
  const apply = async (tx: BrainEngine): Promise<Record<string, unknown>> => {
    const outcome: RelinkGroupOutcome = { linked: [], deduped: [], skipped: [], queued: 0 };
    const guard = 'WHERE source_id=$1 AND id=$2 AND entity_slug IS NULL AND row_num IS NULL AND source_markdown_slug IS NULL AND expired_at IS NULL RETURNING id';
    // Rows take their fence positions before the page projection runs, so the
    // projection matches them by (source, page, row_num) instead of inserting twins.
    for (const c of planned) {
      const f = byId.get(c.id)!;
      if (c.action === 'link') {
        const rowNum = rowNums.get(c.id)!;
        const moved = await tx.executeRaw(`UPDATE facts SET entity_slug=$3, source_markdown_slug=$3, row_num=$4::integer, context=$5 ${guard}`,
          [row.source_id, c.id, row.slug, rowNum, appendContextNote(c.value.context as string | null, f.note)]);
        if (moved.length !== 1) throw changed('A relinked fact was moved by another writer.');
        outcome.linked.push({ id: c.id, row_num: rowNum });
      } else if (c.action === 'retire') {
        const [current] = await tx.executeRaw<{ context: string | null }>('SELECT context FROM facts WHERE source_id=$1 AND id=$2', [row.source_id, c.id]);
        const retired = await tx.executeRaw(`UPDATE facts SET entity_slug=$3, expired_at=now(), context=$4 ${guard}`,
          [row.source_id, c.id, row.slug, appendContextNote(current?.context ?? null, `${f.note} (duplicate of #${c.duplicateOf})`)]);
        if (retired.length !== 1) throw changed('A relinked fact was moved by another writer.');
        outcome.deduped.push({ id: c.id, duplicate_of: c.duplicateOf });
      } else {
        outcome.skipped.push({ id: c.id, reason: c.reason });
      }
    }
    const published = page ? await applyPreservingTakeResolutions(tx, row.page_id, page) : {};
    for (const c of planned) {
      if (c.action === 'skip') continue;
      const f = byId.get(c.id)!;
      await tx.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, model, target_slug, run_id, attempted_at)
        VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, now())
        ON CONFLICT (source_id, fact_id) DO UPDATE SET outcome=EXCLUDED.outcome, reason=NULL, tier=EXCLUDED.tier, model=EXCLUDED.model,
          target_slug=EXCLUDED.target_slug, run_id=EXCLUDED.run_id, attempted_at=EXCLUDED.attempted_at`,
      [row.source_id, c.id, c.action === 'link' ? 'linked' : 'deduped', f.tier, f.model, row.slug, intent.run_id]);
    }
    if (intent.queue_conflict && outcome.linked.length) {
      const { enqueueRelinked } = await import('../ai/decide/proposals-store.ts');
      outcome.queued = await enqueueRelinked(tx, row.source_id, outcome.linked.map(l => l.id));
    }
    return { ...published, status: 'relinked', slug: row.slug, ...outcome };
  };
  if (!page) return { observedRevision, validate, apply };
  return { ...page, validate, apply };
}

export type RelinkGroupResult =
  | { ok: true; outcome: RelinkGroupOutcome }
  | { ok: false; reason: 'revision_conflict' | 'fence_malformed' | 'page_file_missing' | 'unfenceable' | 'no_page'; message: string };

/**
 * Admit and wait for one entity page's relink request. Local and trusted
 * only. The request id derives from the run and the pinned facts, so a retry
 * inside one run replays its receipt and a later run never reuses it.
 */
export async function submitRelinkGroup(engine: BrainEngine, config: GBrainConfig, sourceId: string, slug: string,
  intent: RelinkIntent): Promise<RelinkGroupResult> {
  const { initializeLocalPersistence, requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
  const { submissionAuthority } = await import('../persistence/authority.ts');
  const { admitWrite, getWriteRequest } = await import('../persistence/journal.ts');
  const { assertPersistenceAccepting, waitForWrite, writeResponse } = await import('../persistence/service.ts');
  const { resolveFactWriteTarget } = await import('../persistence/fact-write-target.ts');
  const ctx = { engine, sourceId, remote: false as const, config, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  assertPersistenceAccepting(engine);
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
    "SELECT incarnation, archived, local_path, config->>'kind' AS kind FROM sources WHERE id = $1", [sourceId]);
  if (!source || source.archived) {
    throw opError('source_changed', 'The relink source is not active.', `Source ${sourceId} is archived or not registered; run gbrain facts relink with --source set to an active source.`,
      { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', why: 'Lists the registered sources and whether each is archived.', requires_exclusive: false } });
  }
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return { ok: false, reason: 'no_page', message: `${slug} no longer exists` };
  const target = await resolveFactWriteTarget(engine, sourceId, source);
  if (target.kind === 'unbound') return { ok: false, reason: 'unfenceable', message: `source ${sourceId} writes through to ${target.root} but has no canonical owner` };
  const authority = await submissionAuthority(ctx, RELINK_OPERATION, sourceId, source.incarnation, slug);
  if (target.databaseOnlyReason) authority.databaseOnlyReason = target.databaseOnlyReason;
  const key = digest({ sourceId, slug, run: intent.run_id, facts: intent.facts.map(f => [f.id, f.hash]) });
  const requestId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
  try {
    const row = await getWriteRequest(engine, principal, requestId) ?? await admitWrite(engine, {
      principal, operation: RELINK_OPERATION, sourceId, sourceIncarnation: source.incarnation, slug, pageId: snapshot.page.id,
      requestId, callerIntent: intent as unknown as Record<string, unknown>, intent: intent as unknown as Record<string, unknown>, authority,
      worktreeId: target.binding?.worktree_id ?? null, topologyGeneration: target.binding?.topology_generation ?? null,
    });
    const finished = await waitForWrite(engine, row, config, 60_000);
    writeResponse(finished);
    return { ok: true, outcome: finished.outcome as unknown as RelinkGroupOutcome };
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const message = error.message;
    if (/fence_malformed/.test(message)) return { ok: false, reason: 'fence_malformed', message };
    if (error.code === 'owner_unavailable') return { ok: false, reason: 'unfenceable', message };
    if (error.code === 'source_changed' && /removed outside/.test(message)) return { ok: false, reason: 'page_file_missing', message };
    if (['revision_conflict', 'page_identity_changed', 'source_changed'].includes(error.code)) return { ok: false, reason: 'revision_conflict', message };
    throw error;
  }
}

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
import { withHeldFactsFence } from './unfenced-facts.ts';
import { digest } from '../persistence/digest.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { readFacts, type FactSnapshot } from '../persistence/prepared-maintenance.ts';
import { withTrustKeep } from '../persistence/context.ts';
import { decideSingleFact } from './single-prepare.ts';
import { isFactWithdrawn } from './withdrawal.ts';
import { appendContextNote } from './subject-infer.ts';
import { normalizeTargetFences } from '../fence-repair/import-step.ts';
import { refuseUnparsedRewrite } from '../fence-repair/refusal.ts';
import { pageFencesNormalized } from '../fence-repair/report.ts';

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
  | { id: number; action: 'retire'; duplicateOf: number; context: string | null }
  | { id: number; action: 'skip'; reason: RelinkSkipReason };

/** The fence cell a relinked row renders as. */
function fenceRow(v: Record<string, unknown>, rowNum: number, context: string) {
  return {
    rowNum, claim: String(v.fact), kind: v.kind as never, confidence: Number(v.confidence ?? 1),
    visibility: v.visibility as never, notability: (v.notability ?? 'medium') as never,
    validFrom: fenceInstant(v.valid_from)!,
    validUntil: v.valid_until ? fenceInstant(v.valid_until)! : undefined,
    source: v.source == null ? undefined : String(v.source),
    context,
    ...(v.claim_metric ? { claimMetric: String(v.claim_metric) } : {}),
    ...(v.claim_value != null ? { claimValue: Number(v.claim_value) } : {}),
    ...(v.claim_unit ? { claimUnit: String(v.claim_unit) } : {}),
    ...(v.claim_period ? { claimPeriod: String(v.claim_period) } : {}),
    ...(v.attributed_to === 'user' || v.attributed_to === 'assistant' || v.attributed_to === 'other' ? { attributedTo: v.attributed_to as 'user' | 'assistant' | 'other' } : {}),
  };
}

/**
 * A stored validity instant as its fence cell. Whole seconds keep formatFenceDate's shapes; milliseconds are kept, since
 * the page projection writes the cell back to the row. Null for an instant finer than a millisecond, which no cell carries.
 */
function fenceInstant(value: unknown): string | null {
  const text = String(value);
  const date = new Date(text);
  if (/\.\d{3}\d*[1-9]/.test(text) || !Number.isFinite(date.getTime())) return null;
  return date.getUTCMilliseconds() ? date.toISOString() : formatFenceDate(date);
}

/**
 * A claim the fence cannot carry unchanged (wrapped in ~~, or otherwise not
 * parsing back to the same active claim and visibility, or a validity instant
 * a cell cannot hold) would be expired and re-inserted as a different fact, or
 * have its dates rounded, by the page projection, so it is never moved.
 */
function roundTrips(v: Record<string, unknown>, context: string): boolean {
  if (fenceInstant(v.valid_from) === null || v.valid_until != null && fenceInstant(v.valid_until) === null) return false;
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
    const same = await db.findSameClaimFenceRow(row.source_id, row.slug, String(v.fact), (v.source as string | null | undefined) ?? null);
    if (same) {
      out.push(same.visibility === visibility ? { id: f.id, action: 'retire', duplicateOf: Number(same.id), context: v.context as string | null }
        : { id: f.id, action: 'skip', reason: 'visibility_conflict' });
      continue;
    }
    // B-10: an ontology observation the page already holds at the same key would collide on
    // idx_facts_ontology_stint_dedup once linked; it retires as that row's duplicate instead.
    if (v.dimension != null) {
      const held = await db.findOntologyTwin(row.source_id, row.slug, f.id);
      if (held) {
        out.push({ id: f.id, action: 'retire', duplicateOf: Number(held.id), context: v.context as string | null });
        continue;
      }
    }
    const exact = await decideSingleFact(db, row.source_id,
      { entity_slug: row.slug, fact: String(v.fact), kind: v.kind as never, visibility }, null);
    if (exact.status === 'duplicate' && exact.candidate) {
      out.push({ id: f.id, action: 'retire', duplicateOf: Number(exact.candidate.id), context: v.context as string | null });
      continue;
    }
    const key = JSON.stringify([String(v.fact), v.source ?? null]);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      out.push(earlier.visibility === visibility ? { id: f.id, action: 'retire', duplicateOf: earlier.id, context: v.context as string | null }
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
  let timeline = snapshot.page.timeline;
  let normalized: Record<string, unknown> = {};
  const rowNums = new Map<number, number>();
  if (links.length) {
    // #6188 (D20): Tier 1 normalizes the entity's stored fence in this write; a residual refuses typed `target_fence_malformed`.
    const target = await normalizeTargetFences(engine, { sourceId: row.source_id, slug: row.slug, kind: 'facts', page: snapshot.page });
    ({ compiled_truth: body, timeline } = await withHeldFactsFence(engine, row.source_id, row.slug, { compiled_truth: target.page.compiled_truth, timeline: target.page.timeline }));
    if (target.fixes.length) normalized = { fences_normalized: pageFencesNormalized({ sourceId: row.source_id, slug: row.slug, fixes: target.fixes,
      writer: row.principal_kind, path: snapshot.page.source_path ?? null, remote: row.authority.remote }) };
    const parsed = parseFactsFence(body);
    const max = await engine.maxFenceRowNum(row.source_id, row.slug);
    let next = Math.max(max, 0, ...parsed.facts.map(f => f.rowNum)) + 1;
    for (const link of links) {
      const v = link.value;
      const rowNum = next++;
      rowNums.set(link.id, rowNum);
      // #6385 R12: a fence that does not parse cleanly refuses typed (`fence_malformed` below) instead of losing rows.
      body = refuseUnparsedRewrite({ compiled_truth: body, timeline }, row.slug, row.source_id,
        () => upsertFactRow(body, fenceRow(v, rowNum, appendContextNote(v.context as string | null, byId.get(link.id)!.note))).body);
    }
  }
  const page = links.length ? await (await import('../persistence/page-prepare.ts')).preparePageMutation(engine, { ...row, intent: {
    content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body, timeline }, snapshot.tags), expected_revision: observedRevision, force: false,
  } }, config) : undefined;
  if (page && page.observedRevision !== observedRevision) throw changed('The relink target page changed during preparation.');

  const validate = async (tx: BrainEngine) => {
    if (classKey(await classify(tx, row, intent, true)) !== classKey(planned)) {
      throw changed('A relinked fact changed during preparation.');
    }
    await page?.validate?.(tx);
  };
  // Linking places a fact; it does not author it, so its rows keep the tier and write origin they were written with.
  const apply = (tx: BrainEngine): Promise<Record<string, unknown>> => withTrustKeep(tx, ['facts'], async () => {
    const outcome: RelinkGroupOutcome = { linked: [], deduped: [], skipped: [], queued: 0 };
    // Rows take their fence positions before the page projection runs, so the
    // projection matches them by (source, page, row_num) instead of inserting twins.
    for (const c of planned) {
      const f = byId.get(c.id)!;
      if (c.action === 'link') {
        const rowNum = rowNums.get(c.id)!;
        const moved = await tx.placeRelinkedFact(row.source_id,
          { factId: c.id, action: 'link', slug: row.slug, rowNum, context: appendContextNote(c.value.context as string | null, f.note) });
        if (!moved) throw changed('A relinked fact was moved by another writer.');
        outcome.linked.push({ id: c.id, row_num: rowNum });
      } else if (c.action === 'retire') {
        // The row's context is the one its pinned hash covered; validate re-checked that hash under the lock.
        const retired = await tx.placeRelinkedFact(row.source_id,
          { factId: c.id, action: 'retire', slug: row.slug, context: appendContextNote(c.context, `${f.note} (duplicate of #${c.duplicateOf})`) });
        if (!retired) throw changed('A relinked fact was moved by another writer.');
        outcome.deduped.push({ id: c.id, duplicate_of: c.duplicateOf });
      } else {
        outcome.skipped.push({ id: c.id, reason: c.reason });
      }
    }
    const published = page ? await page.apply(tx) : {};
    for (const c of planned) {
      if (c.action === 'skip') continue;
      const f = byId.get(c.id)!;
      await tx.upsertFactRelinkAttempt(row.source_id, { factId: c.id, outcome: c.action === 'link' ? 'linked' : 'deduped', reason: null,
        tier: f.tier, model: f.model, targetSlug: row.slug, runId: intent.run_id });
    }
    if (intent.queue_conflict && outcome.linked.length) {
      const { enqueueRelinked } = await import('../ai/decide/proposals-store.ts');
      outcome.queued = await enqueueRelinked(tx, row.source_id, outcome.linked.map(l => l.id));
    }
    return { ...published, status: 'relinked', slug: row.slug, ...outcome, ...normalized };
  });
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
  const source = await engine.readRelinkSource(sourceId);
  if (!source || source.archived) {
    throw opError('source_changed', 'The relink source is not active.', `Source ${sourceId} is archived or not registered; run gbrain facts relink with --source set to an active source.`,
      { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', why: 'Lists the registered sources and whether each is archived.', requires_exclusive: false } });
  }
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return { ok: false, reason: 'no_page', message: `${slug} no longer exists` };
  let target: Awaited<ReturnType<typeof resolveFactWriteTarget>>;
  try {
    target = await resolveFactWriteTarget(engine, sourceId, source, { fileBacked: Boolean(snapshot.page.source_path), remote: false });
  } catch (error) {
    if (error instanceof OperationError && error.code === 'owner_unavailable') return { ok: false, reason: 'unfenceable', message: error.message };
    throw error;
  }
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
    if (error.canonicalCode === 'invalid_fence' || /fence_malformed/.test(message)) return { ok: false, reason: 'fence_malformed', message };
    if (error.code === 'owner_unavailable') return { ok: false, reason: 'unfenceable', message };
    if (error.code === 'source_changed' && /removed outside/.test(message)) return { ok: false, reason: 'page_file_missing', message };
    if (['revision_conflict', 'page_identity_changed', 'source_changed'].includes(error.code)) return { ok: false, reason: 'revision_conflict', message };
    throw error;
  }
}

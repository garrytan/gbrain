/**
 * `purge_fact` (#5575 Part C): remove a fact's text from every live store the
 * deletion inventory sweeps, block its return, and hand back a receipt that
 * lists residuals first.
 *
 * Purge is a separate owner-only operation, never a mode of the frozen
 * `forget` verb (MEMORY_VERBS_v1: forget expires, never deletes). It runs only
 * from the trusted local CLI on the brain host, directly or through the
 * resident owner's 0600 socket. Its journaled intent holds the fact id, the
 * claim fingerprint and the reason, never the claim text.
 *
 * One transaction, in the global lock order (source -> counters -> requests ->
 * page keys -> facts): a text-free tombstone (fact_purges, take_purges), the
 * hidden derived rows (derivation_inputs -> needs_rederive), the deleted fact
 * and verbatim take rows, fence rows dropped from the stored page bodies and
 * from every page_versions snapshot, chunks deleted for rebuild, carried
 * request intents redacted, legacy query cache rows and the fact's P8 review
 * rows dropped. Post-commit effects rewrite the canonical file and commit it
 * as `gbrain: purge fact <hash8>`; verification then probes each store.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { contentHash, rowToPage } from '../utils.ts';
import { discoverWithdrawalTargets, withdrawalDiscoveryFailure } from './withdrawal-discovery.ts';
import { dropPurgedFenceRows } from './purge-overlay.ts';
import { derivedRowsFrom, hideDerivedRows, type DerivationRef } from './derivation-inputs.ts';
import { initializeLocalPersistence, requestPrincipalForContext } from '../persistence/page-mutations.ts';
import { authorizeStoredRequest, submissionAuthority } from '../persistence/authority.ts';
import { admitWriteInTransaction, assertPageRequestIdentity, assertReplayIntent, completeWrite, getWriteRequest, intentDigest, lockCounters } from '../persistence/journal.ts';
import { assertPersistenceAccepting } from '../persistence/service.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { parseWriteRequestId } from '../persistence/preconditions.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { requestAttribution } from '../persistence/attribution.ts';
import { isTerminal, principalKey, type WriteRequest } from '../persistence/model.ts';
import { retryWriteAdmission } from '../persistence/admission-retry.ts';
import { findRequestsCarrying, redactionCounterKeys, redactRequestIntents } from '../persistence/intent-redaction.ts';
import { withPageTierKept } from '../trust/fence-append.ts';
import { rebuildPendingPageProjections } from '../page-state/projections.ts';
import { purgeCompletion, verifyFactPurge, type PurgeReceipt, type StoreCount } from './purge-verify.ts';

export const PURGE_OPERATION = 'purge_fact';
const PURGE_TERMINAL_RESERVATION = 64 * 1024;

export interface PurgeTarget {
  id: number; source_id: string; visibility: 'private' | 'world'; fact: string; entity_slug: string | null;
  source_markdown_slug: string | null; fact_hash: string; embedding: string | null; embedding_model: string | null;
}

/** The scope a purge covers: every same-fingerprint fact row in the source, visibility and subject. */
export interface PurgePlan {
  subject: string;
  factIds: number[];
  takes: Array<{ id: number; page_id: number }>;
  pages: Array<{ slug: string; page_id: number; revision: string }>;
  versions: number;
  requests: Awaited<ReturnType<typeof findRequestsCarrying>>;
  derived: Awaited<ReturnType<typeof derivedRowsFrom>>;
  reviewRows: number;
  /** Per review table: rows naming the purged facts (all dropped by the purge). */
  review: Record<'decide_review_queue' | 'decide_review_proposals' | 'decide_proposals', number>;
  /** A digest of the target set; a confirmation binds to it. */
  revision: string;
}

/** The refusal every route but the trusted local CLI gets (same envelope on stdio, HTTP and thin clients). */
export function purgeHostOnly(id: unknown): OperationError {
  const ref = typeof id === 'string' || typeof id === 'number' ? String(id) : '<fact-id>';
  return opError('trusted_local_only', 'purge_fact runs only from the trusted local CLI on the brain host, not over MCP.',
    `Ask the user to run \`gbrain forget ${ref} --purge\` on the brain host. It prints a dry-run receipt first and asks before removing anything.`,
    { legacy_error: 'permission_denied', fix: { argv: ['gbrain', 'forget', ref, '--purge'], consent: ['destructive'], actor: 'user', requires_exclusive: false,
      why: 'Purge removes text from the brain and cannot be undone, so only the owner on the brain host may run it.' } });
}

function notFound(rawId: string): OperationError {
  return opError('fact_not_found', `No fact with id "${rawId}" in this source.`,
    'Ids come from remember or recall. A purged fact no longer exists; check an earlier purge by its request id with --status.',
    { fix: readFix('Lists recent facts with their ids, read-only.', { argv: ['gbrain', 'recall', '--json'] }) });
}

async function loadTarget(engine: BrainEngine, id: number, sourceId: string): Promise<PurgeTarget | null> {
  const [row] = await engine.executeRaw<PurgeTarget>(`SELECT id,source_id,visibility,fact,entity_slug,source_markdown_slug,
      gbrain_fact_fingerprint(fact) AS fact_hash,embedding::text AS embedding,embedding_model
    FROM facts WHERE id=$1 AND source_id=$2`, [id, sourceId]);
  return row ? { ...row, id: Number(row.id) } : null;
}

/** Read-only: everything a purge of `target` would touch. Inside the purge transaction it runs under the source lock. */
export async function planFactPurge(engine: BrainEngine, target: PurgeTarget, allSubjects: boolean): Promise<PurgePlan> {
  const subject = allSubjects ? '*' : target.entity_slug ?? '*';
  const facts = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id=$1 AND visibility=$2
    AND gbrain_fact_fingerprint(fact)=$3 AND ($4='*' OR entity_slug=$4) ORDER BY id`, [target.source_id, target.visibility, target.fact_hash, subject]);
  const factIds = facts.map(f => Number(f.id));
  const takes = (await engine.executeRaw<{ id: number; page_id: number }>(`SELECT DISTINCT k.id,k.page_id FROM takes k JOIN pages p ON p.id=k.page_id
    WHERE p.source_id=$1 AND (k.id IN (SELECT consolidated_into FROM facts WHERE id=ANY($2::bigint[]) AND consolidated_into IS NOT NULL)
      OR (gbrain_fact_fingerprint(k.claim)=$3 AND ($4='*' OR p.slug=$4))) ORDER BY k.id`,
  [target.source_id, factIds, target.fact_hash, subject])).map(t => ({ id: Number(t.id), page_id: Number(t.page_id) }));
  const discovered = await discoverWithdrawalTargets(engine, target.source_id,
    [{ visibility: target.visibility, fact_hash: target.fact_hash, subject, claim: target.fact }]).catch(withdrawalDiscoveryFailure);
  const known = new Set(discovered.map(p => p.page_id));
  const extra = takes.map(t => t.page_id).filter(id => !known.has(id));
  const takePages = extra.length ? await engine.executeRaw<{ slug: string; page_id: number; revision: string }>(
    'SELECT slug,id AS page_id,knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])', [target.source_id, extra]) : [];
  const pages = [...discovered, ...takePages.map(p => ({ ...p, page_id: Number(p.page_id) }))].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const [versions] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id
    WHERE p.source_id=$1 AND (strpos(lower(v.compiled_truth),$2)>0 OR strpos(lower(COALESCE(v.timeline,'')),$2)>0)`, [target.source_id, target.fact.toLowerCase()]);
  const requests = await findRequestsCarrying(engine, target.source_id, target.fact);
  const inputs: DerivationRef[] = [...factIds.map(id => ({ table: 'facts', id })), ...takes.map(t => ({ table: 'takes', id: t.id }))];
  const derived = await derivedRowsFrom(engine, inputs);
  const [counts] = await engine.executeRaw<{ q: number; rp: number; dp: number }>(`SELECT
    (SELECT count(*)::int FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS q,
    (SELECT count(*)::int FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS rp,
    (SELECT count(*)::int FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($3::bigint[]) OR old_fact_id=ANY($3::bigint[]))) AS dp`,
  [target.source_id, factIds.map(String), factIds]);
  const review = { decide_review_queue: Number(counts?.q ?? 0), decide_review_proposals: Number(counts?.rp ?? 0), decide_proposals: Number(counts?.dp ?? 0) };
  const { createHash } = await import('node:crypto');
  const revision = createHash('sha256').update(JSON.stringify({ subject, factIds, takes: takes.map(t => t.id),
    pages: pages.map(p => [p.page_id, p.revision]), requests: requests.map(r => r.id) })).digest('hex').slice(0, 16);
  return { subject, factIds, takes, pages, versions: Number(versions?.n ?? 0), requests, derived,
    reviewRows: review.decide_review_queue + review.decide_review_proposals + review.decide_proposals, review, revision };
}

/** Pages with a pending recovery record or an unfinished mirror refuse a purge, as effects refuse other writes. */
async function assertNoPendingPublication(tx: BrainEngine, sourceId: string, pages: PurgePlan['pages'], ownRequest: string): Promise<void> {
  if (!pages.length) return;
  const [blocked] = await tx.executeRaw<{ request_id: string; slug: string; state: string }>(`SELECT r.request_id::text,r.slug,r.state FROM persistence_requests r
      WHERE r.source_id=$1 AND r.id<>$3::uuid AND r.slug=ANY($2::text[]) AND (r.recovery IS NOT NULL OR r.state IN ('queued','running','recovering'))
    UNION ALL SELECT r.request_id::text,COALESCE(t->>'slug',r.slug),e.state FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.data->'targets','[]'::jsonb)) t
      WHERE e.source_id=$1 AND e.request_id<>$3::uuid AND e.kind='withdrawal-mirror' AND (e.state<>'committed' OR e.recovery IS NOT NULL) AND t->>'slug'=ANY($2::text[])
    LIMIT 1`, [sourceId, pages.map(p => p.slug), ownRequest]);
  if (blocked) throw opError('purge_blocked_pending_recovery', 'A page this purge rewrites has a pending write or recovery, so nothing was purged.',
    `Request ${blocked.request_id} on ${blocked.slug} is ${blocked.state} or still recovering; its publication must finish first. Retry the purge with the same request id once it is final.`,
    { fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows the source\'s pending and recovering writes, read-only.' } });
}

/** Drop purged rows from each affected page's stored body; returns the slugs rewritten. */
async function rewritePageBodies(tx: BrainEngine, sourceId: string, pages: PurgePlan['pages']): Promise<string[]> {
  if (!pages.length) return [];
  const rows = await tx.executeRaw<Record<string, unknown>>(`SELECT p.*,COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS purge_tags
    FROM pages p WHERE p.source_id=$1 AND p.id=ANY($2::int[]) ORDER BY p.slug`, [sourceId, pages.map(p => p.page_id)]);
  const rewritten: string[] = [];
  for (const row of rows) {
    const page = rowToPage(row);
    const compiled = await dropPurgedFenceRows(tx, sourceId, page.compiled_truth, page.slug);
    const timeline = await dropPurgedFenceRows(tx, sourceId, page.timeline ?? '', page.slug);
    if (compiled === page.compiled_truth && timeline === (page.timeline ?? '')) continue;
    const hash = contentHash({ ...page, compiled_truth: compiled, timeline, tags: row.purge_tags as string[] });
    // #5575 ENG-1: dropping a fence row is a gbrain-managed fence edit, not authorship: the page keeps its tier and origin.
    await withPageTierKept(tx, { sourceId, slug: page.slug }, () => tx.executeRaw(`UPDATE pages SET compiled_truth=$3,timeline=$4,content_hash=$5,updated_at=now(),text_projection_revision=NULL,embedding_signature=NULL
      WHERE source_id=$1 AND id=$2`, [sourceId, page.id, compiled, timeline, hash]));
    rewritten.push(page.slug);
  }
  return rewritten;
}

/** Redact the row from every retained snapshot that carries the claim; returns redacted and still-carrying (prose) counts. */
async function redactPageVersions(tx: BrainEngine, sourceId: string, claim: string, pageIds: number[]): Promise<{ redacted: number; prose: Array<{ slug: string; version_id: number }> }> {
  const needle = claim.toLowerCase();
  const rows = await tx.executeRaw<{ id: number; slug: string; compiled_truth: string; timeline: string | null }>(`SELECT v.id,p.slug,v.compiled_truth,v.timeline
    FROM page_versions v JOIN pages p ON p.id=v.page_id
    WHERE p.source_id=$1 AND (v.page_id=ANY($3::int[]) OR strpos(lower(v.compiled_truth),$2)>0 OR strpos(lower(COALESCE(v.timeline,'')),$2)>0)
    ORDER BY v.id LIMIT 5000`, [sourceId, needle, pageIds]);
  let redacted = 0;
  const prose: Array<{ slug: string; version_id: number }> = [];
  for (const v of rows) {
    const compiled = await dropPurgedFenceRows(tx, sourceId, v.compiled_truth, v.slug);
    const timeline = await dropPurgedFenceRows(tx, sourceId, v.timeline ?? '', v.slug);
    if (compiled !== v.compiled_truth || timeline !== (v.timeline ?? '')) {
      await tx.executeRaw('UPDATE page_versions SET compiled_truth=$2,timeline=$3 WHERE id=$1', [v.id, compiled, timeline]);
      redacted++;
    }
    if (compiled.toLowerCase().includes(needle) || timeline.toLowerCase().includes(needle)) prose.push({ slug: v.slug, version_id: Number(v.id) });
  }
  return { redacted, prose };
}

interface PurgeParams { id: number; rawId: string; sourceId: string; reason: string | null; allSubjects: boolean; requestId: string }

function parseParams(ctx: OperationContext, params: Record<string, unknown>): PurgeParams {
  const rawId = String(params.id ?? '').trim();
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound(rawId);
  const reason = typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim().slice(0, 200) : null;
  return { id, rawId, reason, allSubjects: params.all_subjects === true,
    sourceId: typeof params.source_id === 'string' ? params.source_id : ctx.sourceId ?? 'default',
    requestId: parseWriteRequestId(params.request_id) ?? randomUUID() };
}

/** `--match`: candidate facts for a text, so the owner picks an id (purge always needs a ref). Owner-only output. */
async function matchCandidates(engine: BrainEngine, sourceId: string, text: string): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<{ id: number; entity_slug: string | null; visibility: string; expired: boolean; fact: string }>(`SELECT id,entity_slug,visibility,
    expired_at IS NOT NULL AS expired,left(fact,160) AS fact FROM facts WHERE source_id=$1 AND strpos(lower(fact),lower($2))>0 ORDER BY id LIMIT 25`, [sourceId, text]);
  return { action: 'purge_fact', match: true, candidates: rows.map(r => ({ ...r, id: Number(r.id) })),
    next: rows.length ? 'Pick one id and run gbrain forget <id> --purge; --match never purges.' : 'No fact in this source contains that text.' };
}

/** `--status`: the stored receipt and the current completion of an earlier purge request. Never re-reads claim text. */
async function purgeStatus(ctx: OperationContext, requestId: string): Promise<Record<string, unknown>> {
  const principal = await requestPrincipalForContext(ctx);
  const row = await getWriteRequest(ctx.engine, principal, requestId);
  if (!row || row.operation !== PURGE_OPERATION) throw opError('not_found', `No purge request ${requestId} for this caller.`,
    'Pass the --request-id a purge printed. Status reads only purges this CLI submitted.');
  return { ...(row.outcome ?? {}), request_id: row.request_id, state: row.state, ...await purgeCompletion(ctx.engine, row) };
}

export function purgeConfirmToken(target: Pick<PurgeTarget, 'fact_hash'>): string { return target.fact_hash.slice(0, 8); }

/**
 * The purge_fact handler. `dry_run` (or ctx.dryRun) returns the receipt with
 * would-remove counts and the confirmation token; a real run needs
 * `confirm` equal to that token (the fingerprint's first 8 hex), and an
 * `expected_revision` from the dry run when given must still match.
 */
export async function submitPurgeFactMutation(ctx: OperationContext, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (ctx.remote !== false) throw purgeHostOnly(params.id);
  assertPersistenceAccepting(ctx.engine);
  await initializeLocalPersistence(ctx);
  if (params.status === true) {
    const requestId = parseWriteRequestId(params.request_id);
    if (!requestId) throw opError('invalid_params', '--status needs --request-id.', 'Pass the request id the purge printed with --request-id, together with --status.');
    return purgeStatus(ctx, requestId);
  }
  const sourceIdForMatch = typeof params.source_id === 'string' ? params.source_id : ctx.sourceId ?? 'default';
  if (typeof params.match === 'string') return matchCandidates(ctx.engine, sourceIdForMatch, params.match);
  const p = parseParams(ctx, params);
  const principal = await requestPrincipalForContext(ctx);
  const callerIntent = { id: p.rawId, reason: p.reason, all_subjects: p.allSubjects };
  const dryRun = ctx.dryRun === true || params.dry_run === true;
  if (!dryRun) {
    await assertPageRequestIdentity(ctx.engine, principal, p.requestId);
    const prior = await getWriteRequest(ctx.engine, principal, p.requestId);
    if (prior) {
      assertReplayIntent(prior, intentDigest({ operation: PURGE_OPERATION, sourceId: p.sourceId, slug: prior.slug, callerIntent }));
      return { ...(prior.outcome ?? {}), request_id: prior.request_id, state: prior.state, replayed: true, ...await purgeCompletion(ctx.engine, prior) };
    }
  }
  const target = await loadTarget(ctx.engine, p.id, p.sourceId);
  if (!target) throw notFound(p.rawId);
  const token = purgeConfirmToken(target);
  const plan = await planFactPurge(ctx.engine, target, p.allSubjects);
  if (dryRun) {
    const receipt = await verifyFactPurge(ctx.engine, { target, plan, dryRun: true });
    return { dry_run: true, action: 'purge_fact', request_id: p.requestId, confirm_token: token, expected_revision: plan.revision, ...receipt };
  }
  if (params.confirm !== token) throw opError('confirmation_required', 'Purge needs a confirmation bound to this fact.',
    `Run the dry run first (gbrain forget ${p.rawId} --purge --dry-run), review its receipt with the user, then confirm with the fact's token (the first 8 characters of its fingerprint).`,
    { fix: { argv: ['gbrain', 'forget', p.rawId, '--purge', '--dry-run', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Prints what the purge would remove and the confirmation token, without changing anything.' } });
  const { similarActiveAfterForget } = await import('./similar-active.ts');
  const similar = await similarActiveAfterForget(ctx.engine, { sourceId: p.sourceId, factId: p.id, remote: false, committed: true, semanticReview: false })
    .then(s => ({ ...s, candidates: s.candidates.filter(c => !plan.factIds.includes(Number(c.fact_id))) })).catch(() => null);

  let committedPlan = plan;
  let rewritten: string[] = [];
  let counts: StoreCount = {};
  let prose: Array<{ slug: string; version_id: number }> = [];
  const row = await retryWriteAdmission(p.requestId, remaining => ctx.engine.transaction(async tx => {
    await declareDurablePersistence(tx, `${Math.min(2000, remaining)}ms`, '30s');
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE', [p.sourceId]);
    if (!source || source.archived) throw opError('source_changed', 'The purge source is not active.', `Source ${p.sourceId} is archived or missing, so nothing was purged.`);
    const prior = await getWriteRequest(tx, principal, p.requestId);
    if (prior) {
      await authorizeStoredRequest(tx, prior, true);
      assertReplayIntent(prior, intentDigest({ operation: PURGE_OPERATION, sourceId: p.sourceId, slug: prior.slug, callerIntent }));
      return prior;
    }
    const current = await loadTarget(tx, p.id, p.sourceId);
    if (!current) throw notFound(p.rawId);
    committedPlan = await planFactPurge(tx, current, p.allSubjects);
    if (typeof params.expected_revision === 'string' && params.expected_revision !== committedPlan.revision) {
      throw opError('revision_conflict', 'What this purge would remove changed since its dry run.',
        'Run the dry run again, review the new receipt, and confirm that one.');
    }
    const slug = current.source_markdown_slug ?? current.entity_slug ?? 'memory/unattributed';
    await lockCounters(tx, ['brain', principalKey(principal), ...redactionCounterKeys(committedPlan.requests)]);
    const authority = await submissionAuthority({ ...ctx, engine: tx }, PURGE_OPERATION, p.sourceId, source.incarnation, slug);
    const admitted = await admitWriteInTransaction(tx, { principal, operation: PURGE_OPERATION, sourceId: p.sourceId, sourceIncarnation: source.incarnation,
      slug, requestId: p.requestId, callerIntent, intent: { ...callerIntent, fact_hash: current.fact_hash }, authority, terminalReservation: PURGE_TERMINAL_RESERVATION });
    if (isTerminal(admitted)) return admitted;
    return withCoordinatedWrite(tx, [p.sourceId], async () => {
      const plan = committedPlan;
      await assertNoPendingPublication(tx, p.sourceId, plan.pages, admitted.id);
      const intents = await redactRequestIntents(tx, plan.requests, admitted.id, { needles: [current.fact] });
      await tx.lockPageKeys(plan.pages.map(page => ({ sourceId: p.sourceId, slug: page.slug })));
      // Derived rows are hidden while their evidence still exists.
      const derived = await hideDerivedRows(tx, plan.derived.rows, { sourceId: p.sourceId, requestId: admitted.id, reason: `purge:${token}` });
      await tx.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason)
        VALUES ($1,$2,$3,$4,$5::uuid,$6,$7) ON CONFLICT DO NOTHING`,
      [p.sourceId, current.visibility, plan.subject, current.fact_hash, admitted.id, `${principal.kind}:${principal.id}`, p.reason]);
      await tx.executeRaw(`INSERT INTO take_purges(source_id,subject,claim_hash,request_id) VALUES ($1,$2,$3,$4::uuid) ON CONFLICT DO NOTHING`,
        [p.sourceId, plan.subject, current.fact_hash, admitted.id]);
      const takes = plan.takes.length ? (await tx.executeRaw('DELETE FROM takes WHERE id=ANY($1::bigint[]) RETURNING id', [plan.takes.map(t => t.id)])).length : 0;
      const ids = plan.factIds;
      const review = (await tx.executeRaw(`DELETE FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1`, [p.sourceId, ids.map(String)])).length
        + (await tx.executeRaw(`DELETE FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1`, [p.sourceId, ids.map(String)])).length
        + (await tx.executeRaw(`DELETE FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($2::bigint[]) OR old_fact_id=ANY($2::bigint[])) RETURNING 1`, [p.sourceId, ids])).length
        + (await tx.executeRaw(`DELETE FROM trust_proposals WHERE source_id=$1 AND ((target_table='facts' AND target_id=ANY($2::bigint[])) OR (related_table='facts' AND related_id=ANY($2::bigint[]))
            OR (target_table='takes' AND target_id=ANY($3::bigint[])) OR (related_table='takes' AND related_id=ANY($3::bigint[]))) RETURNING 1`, [p.sourceId, ids, plan.takes.map(t => t.id)])).length;
      const loops = (await tx.executeRaw('DELETE FROM open_loops WHERE source_id=$1 AND fact_id=ANY($2::bigint[]) RETURNING 1', [p.sourceId, ids])).length;
      // #5575: held writes carrying the claim (fact text or take claim) and the gate receipts naming purged rows or those holds.
      const holdIds = (await tx.executeRaw<{ id: string }>(`DELETE FROM write_gate_holds WHERE source_id=$1
          AND gbrain_fact_fingerprint(COALESCE(payload->>'fact', payload->>'claim', ''))=$2 RETURNING id::text AS id`, [p.sourceId, current.fact_hash])).map(r => r.id);
      const gateReceipts = (await tx.executeRaw(`DELETE FROM write_gate_receipts WHERE (target_table='facts' AND target_id=ANY($1::text[]))
          OR (target_table='takes' AND target_id=ANY($2::text[])) OR (target_table='write_gate_holds' AND target_id=ANY($3::text[])) RETURNING 1`,
        [ids.map(String), plan.takes.map(t => String(t.id)), holdIds])).length;
      const proposals = (await tx.executeRaw('DELETE FROM take_proposals WHERE source_id=$1 AND gbrain_fact_fingerprint(claim_text)=$2 RETURNING 1', [p.sourceId, current.fact_hash])).length;
      const notices = (await tx.executeRaw(`UPDATE core_edit_notices SET base_text=NULL WHERE source_id=$1 AND strpos(lower(base_text),$2)>0 RETURNING 1`,
        [p.sourceId, current.fact.toLowerCase()])).length;
      const facts = (await tx.executeRaw('DELETE FROM facts WHERE id=ANY($1::bigint[]) AND source_id=$2 RETURNING id', [ids, p.sourceId])).length;
      rewritten = await rewritePageBodies(tx, p.sourceId, plan.pages);
      const pageIds = plan.pages.map(page => page.page_id);
      const chunks = pageIds.length ? (await tx.executeRaw('DELETE FROM content_chunks WHERE page_id=ANY($1::integer[]) RETURNING 1', [pageIds])).length : 0;
      const versions = await redactPageVersions(tx, p.sourceId, current.fact, pageIds);
      prose = versions.prose;
      const cache = (await tx.executeRaw('DELETE FROM query_cache RETURNING 1')).length;
      const pages = pageIds.length ? await tx.executeRaw<{ id: number; slug: string; knowledge_revision: string }>(
        'SELECT id,slug,knowledge_revision::text AS knowledge_revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[]) ORDER BY slug', [p.sourceId, pageIds]) : [];
      await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
        SELECT $1::uuid,k.kind,$3::text::jsonb,s.id,s.incarnation,b.worktree_id
        FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
        CROSS JOIN (VALUES ('withdrawal-mirror'),('git'),('embedding')) AS k(kind)
        WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`, [admitted.id, p.sourceId, JSON.stringify({ version: 2, mode: 'purge',
        commit_subject: `gbrain: purge fact ${token}`, commit_line: `purge fact ${token}`,
        targets: pages.map(page => ({ slug: page.slug, page_id: Number(page.id), revision: page.knowledge_revision })) })]);
      counts = { facts, takes, chunks, page_versions: versions.redacted, pages: rewritten.length, persistence_requests: intents,
        query_cache: cache, decide_review: review, open_loops: loops, take_proposals: proposals, core_edit_notices: notices,
        write_gate_holds: holdIds.length, write_gate_receipts: gateReceipts,
        derived_hidden: Object.values(derived.hidden).reduce((a, b) => a + b, 0) };
      return completeWrite(tx, admitted, 'committed', { purge: { fact_id: p.id, hash8: token, fact_hash: current.fact_hash, subject: plan.subject,
        visibility: current.visibility, removed: counts, derived: { ...derived, truncated: plan.derived.truncated }, pages: rewritten.length },
        persistence: { mode: 'database' } });
    }, requestAttribution(admitted));
  }), 30_000);
  // Chunks of rewritten pages were deleted; rebuild them from the purged bodies before acknowledging.
  const slugs = committedPlan.pages.map(page => page.slug);
  for (let start = 0; start < slugs.length; start += 100) {
    await rebuildPendingPageProjections(ctx.engine, 100, { pages: { sourceId: p.sourceId, slugs: slugs.slice(start, start + 100) } }).catch(() => undefined);
  }
  if (row.state !== 'committed') return { ...(row.outcome ?? {}), request_id: row.request_id, state: row.state, error: row.error_code };
  const receipt: PurgeReceipt = await verifyFactPurge(ctx.engine, { target, plan: committedPlan, dryRun: false, removed: counts, prose,
    vacuum: params.vacuum === true });
  return { ...receipt, purge: (row.outcome as { purge?: unknown } | null)?.purge, request_id: row.request_id, state: row.state, similar_active: similar,
    ...await purgeCompletion(ctx.engine, row as WriteRequest, receipt) };
}

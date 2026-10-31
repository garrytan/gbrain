/**
 * Page purge (`gbrain delete <slug> --purge`, #5575 CEO-4/CEO-8): the same
 * live-store sweep as a fact purge, applied to one page inside the
 * coordinated delete transaction, plus a text-free page tombstone.
 *
 * Swept in the transaction: facts filed on the page (each tombstoned in
 * fact_purges), the page's takes (tombstoned in take_purges), take proposals,
 * open loops and core-edit notices keyed to the page, stored intents of
 * finished requests for the slug, and its `files` rows; takes, timeline
 * entries, chunks, versions, links and raw data go by foreign-key cascade
 * with the page row. Stored blobs are deleted after commit (`finishPagePurge`);
 * a blob that cannot be deleted is listed by storage path.
 *
 * `page_purges` keeps (source_id, content_hash, slug): the pages guard raises
 * typed `purged_content` when a page with that content hash is written again
 * under any slug, until `gbrain pages unpurge <slug>` clears it.
 *
 * #6511: the search for historical requests carrying the page's claims is an
 * O(journal) substring scan that no index serves, so it runs at preparation
 * (`preparePagePurge`, under the preparation budget) and the publication
 * transaction only reconciles the tail past the scanned ceiling and the rows
 * that were pending at scan time (`recheckRequestsCarrying`). A statement
 * timeout inside one of the remaining in-transaction lookups is deterministic
 * on a large journal, not contention: it ends the request `failed` with the
 * typed `purge_lookup_timeout` (the queue behind it moves) instead of being
 * released as `database_contention` and retried without bound.
 *
 * #6884: that sweep read and lowered the whole journal once per purged page,
 * so a batch of purges cost N full sweeps. A preparation now sweeps once for
 * its own claims and those of the next queued purges of the source
 * (`sweepForPurge`), and each of those finds its census cached here and
 * scans only the tail past that sweep's ceiling (the source's watermark).
 */

import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { WriteRequest } from './model.ts';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { PERSISTENCE_REQUEST_SLUG_INTENT_INDEX } from './schema.ts';
import { readRequestIndexStates, REQUEST_INDEXES_REPAIR_COMMAND, type RequestIndexState } from './checkpoint-validation.ts';
import { faultPoint } from './fault-points.ts';
import { writeOriginDeletedMarker } from './sync-markers.ts';
import { clearRebuildableCache } from './rebuildable-cache.ts';
import { carryingNeedles, findRequestsForSlugs, JOURNAL_SWEEP_MATCH_CAP, recheckRequestsCarrying, redactRequestIntents, sweepRequestsCarrying, sweepRequestsForGroups,
  type JournalSweep } from './intent-redaction.ts';
import { dropPurgedFenceRows } from '../facts/purge-overlay.ts';
import { isOutcomeMarker, outcomeMarkerSql } from '../facts/audit-sources.ts';
import { derivedRowsFrom, hideDerivedRows } from '../facts/derivation-inputs.ts';
import { contentHash } from '../utils.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { rewrittenContentHash } from '../page-body/segment-rewrite.ts';
import { stagingNeedsTextSql } from '../page-body/schema.ts';
import { CLAIM_FORMS_BATCH, claimTextForms } from '../fence-shared.ts';
import type { PagePurgeContext } from '../facts/purge-verify.ts';
import { assertHeldPageKeys } from '../page-state/guards.ts';
import { noteBelief } from '../belief/ledger.ts';
import { appendPurgeIntent } from '../belief/purge-mirror.ts';
import { appendDerivedHidden, bumpPurgeEpoch, derivedBeliefTargets, derivedStreamSlugs, pageLifetimesOf, pagePurgeClaims, redactCarryingFields, redactPurgedKeys, registerLiveCarriers,
  sourceHasBeliefEvents, type LedgerPurgeReport } from '../belief/purge.ts';

export const PURGE_RESIDUALS = 'Removed from live stores: the page row with its chunks, versions, takes, timeline, links and raw data, the facts filed on it (tombstoned), '
  + 'its take proposals, open loops and core notices, stored write intents for the slug and its attached file records. Still out of reach: the brain repository\'s '
  + 'git history and every other clone or remote, Markdown exports and compiled context files, backups, provider copies (embeddings, decisions), and deleted rows '
  + 'in database pages and the write-ahead log until vacuum. Rotate any exposed credential.';

function hostOnly(command: string) {
  return opError('trusted_local_only', 'Page purge tombstones are managed only from the trusted local CLI on the brain host.',
    `Ask the user to run \`${command}\` on the brain host.`, { legacy_error: 'permission_denied' });
}

/**
 * What the post-commit receipt needs and the journal must never hold: the purged page's claims (verification
 * needles) and row ids, keyed by `<source_id>:<request_id>`, in this process only. A receipt built where the
 * map has no entry reports the prose probe as unverified.
 */
const purgeContext = new Map<string, PagePurgeContext>();
const PURGE_CONTEXT_LIMIT = 64;
const purgeReceipts = new Map<string, { receipt: Record<string, unknown>; purge: Record<string, unknown> }>();

/** The page's claims (facts filed on it, its takes) that the journal sweep searches for, bounded, trimmed, deduplicated. */
async function readPurgeClaims(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, pageId: number) {
  const factRows = await engine.executeRaw<{ id: number; fact: string; source: string | null }>('SELECT id,fact,source FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id LIMIT 1000', [sourceId, slug]);
  const takeRows = await engine.executeRaw<{ id: number; claim: string }>('SELECT id,claim FROM takes WHERE page_id=$1 ORDER BY id LIMIT 1000', [pageId]);
  const needles = [...new Set([...factRows.filter(f => !isOutcomeMarker(f)).map(f => f.fact), ...takeRows.map(t => t.claim)].map(t => t.trim()).filter(t => t.length >= 8))].slice(0, 32);
  return { factRows, takeRows, needles };
}

/** Every claim of the page (its facts, withdrawn ones included, and its takes), trimmed and deduplicated, unbounded: the segment-text sweep's needles. */
async function readSegmentClaims(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, pageId: number): Promise<string[]> {
  const rows = await engine.executeRaw<{ c: string }>(`SELECT fact AS c FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND NOT ${outcomeMarkerSql('facts')} UNION SELECT claim FROM takes WHERE page_id=$3`,
    [sourceId, slug, pageId]);
  return [...new Set(rows.map(r => r.c.trim()).filter(t => t.length >= 8))];
}

/** #6884: how many queued purges of the source one preparation's journal sweep covers at most, this one included. */
export const PURGE_SWEEP_BATCH_MEMBERS = 32;
/** #6884: the most claim forms one batch sweep tests per journal row; members past it sweep on their own. */
export const PURGE_SWEEP_BATCH_NEEDLES = 256;
/** A member's census is cached only up to this many targets, and this process caches at most this many members. */
const PURGE_SWEEP_CACHE_TARGETS = 1000;
const PURGE_SWEEP_CACHE_LIMIT = 128;
/**
 * #6884: what a batch sweep found for each queued purge it covered, keyed by that purge's request row id, in this process
 * only (like `purgeContext`, the journal must never hold the claims): the claim forms searched for and the census up to
 * the sweep's ceiling. Rows at or below the ceiling that were terminal stay as the sweep saw them (a terminal row's text
 * only shrinks, by compaction or redaction); rows that were pending, the leader's own row included, are re-tested at
 * publication; rows past it are the member's tail.
 */
const batchSweeps = new Map<string, { sourceId: string; forms: Set<string>; sweep: JournalSweep }>();

/**
 * #6884: the purge's census. A purge a batch sweep already covered for all of its current claims scans only the tail past
 * that sweep's ceiling; otherwise it sweeps once for its own claims and those of the next queued purges of the source
 * (in queue order, bounded by member count and claim forms) and caches each member's result.
 */
async function sweepForPurge(engine: BrainEngine, row: WriteRequest, claims: string[], clock: ClaimPhaseClock | undefined): Promise<JournalSweep> {
  const onChunk = () => faultPoint('purge:sweep_chunk', { requestId: row.request_id, sourceId: row.source_id, operation: row.operation });
  const forms = carryingNeedles(claims);
  const cached = batchSweeps.get(row.id);
  if (cached && cached.sourceId === row.source_id && forms.every(form => cached.forms.has(form))) {
    const tail = await sweepRequestsCarrying(engine, row.source_id, claims, { clock, exclude: row.id, after: cached.sweep.ceiling ?? '0', onChunk });
    const targets = [...new Map([...cached.sweep.targets, ...tail.targets].map(t => [t.id, t])).values()];
    const complete = cached.sweep.complete && tail.complete && targets.length <= JOURNAL_SWEEP_MATCH_CAP;
    return { targets: targets.slice(0, JOURNAL_SWEEP_MATCH_CAP), pendingAtScan: [...new Set([...cached.sweep.pendingAtScan, ...tail.pendingAtScan])].filter(id => id !== row.id),
      ceiling: tail.ceiling, scanned: tail.scanned, complete, watermark: cached.sweep.ceiling, batch: cached.sweep.batch ?? 1 };
  }
  const groups = [{ key: row.id, claims }], memberForms = new Map<string, Set<string>>();
  enterClaimStep(clock, 'purge_batch', undefined, 'db');
  const queued = forms.length ? await engine.executeRaw<{ id: string; slug: string }>(`SELECT id::text AS id,slug FROM persistence_requests
    WHERE state='queued' AND source_id=$1 AND sequence>$2::bigint AND operation='delete_page' AND intent->>'purge'='true' ORDER BY sequence LIMIT $3`,
  [row.source_id, String(row.sequence), PURGE_SWEEP_BATCH_MEMBERS - 1]) : [];
  let budget = forms.length;
  for (const member of queued) {
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [row.source_id, member.slug]);
    if (!page) continue;
    const memberClaims = (await readPurgeClaims(engine, row.source_id, member.slug, Number(page.id))).needles;
    const memberNeedles = carryingNeedles(memberClaims);
    if (!memberNeedles.length) continue;
    if (budget + memberNeedles.length > PURGE_SWEEP_BATCH_NEEDLES) break;
    budget += memberNeedles.length;
    groups.push({ key: member.id, claims: memberClaims });
    memberForms.set(member.id, new Set(memberNeedles));
  }
  const sweeps = await sweepRequestsForGroups(engine, row.source_id, groups, { clock, exclude: row.id, onChunk });
  for (const [id, memberNeedles] of memberForms) {
    const sweep = sweeps.get(id)!;
    if (!sweep.complete || sweep.targets.length > PURGE_SWEEP_CACHE_TARGETS) continue;
    batchSweeps.delete(id);
    // The leader was running when the sweep passed it (excluded from the scan), so for every member it is a pending row.
    batchSweeps.set(id, { sourceId: row.source_id, forms: memberNeedles, sweep: { ...sweep, pendingAtScan: [...sweep.pendingAtScan.filter(p => p !== id), row.id], batch: groups.length } });
  }
  while (batchSweeps.size > PURGE_SWEEP_CACHE_LIMIT) batchSweeps.delete(batchSweeps.keys().next().value!);
  return { ...sweeps.get(row.id)!, watermark: null, batch: groups.length };
}

/** What the delete preparation hands the purge apply: the claims it searched for, the journal census, and the slug index's state for the failure hint. */
export interface PreparedPagePurge {
  needles: string[]; sweep: JournalSweep; slugIndex: RequestIndexState['state'];
  /** Retention removal of an expired tombstone (`gbrain pages purge-deleted`): no content tombstone, no ledger redaction, `page.expired`. */
  retention: boolean;
  /**
   * The belief streams locked with the page: those of the rows the derivation walk would hide (their `derived.hidden`
   * events append under their keys) and those of the links the delete cascades away (their `link.retracted`).
   */
  derivedSlugs: string[];
}

/**
 * The streams of the links a hard delete of the page removes by FK cascade (to or from it, recorded in another
 * page's stream): held with the page so the batch records each as `link.retracted` (review #14).
 */
export async function linkStreamSlugs(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, pageId: number): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(`SELECT DISTINCT COALESCE(o.slug, f.slug) AS slug FROM links l JOIN pages f ON f.id = l.from_page_id
    LEFT JOIN pages o ON o.id = l.origin_page_id WHERE (l.to_page_id = $2 OR l.from_page_id = $2) AND COALESCE(o.source_id, f.source_id) = $1`, [sourceId, pageId]);
  return rows.map(r => r.slug).sort();
}

/**
 * #6511: at preparation, before the root lock and outside any transaction: the page's claims, the slug index's state and
 * the keyset journal sweep under the preparation budget (the clock between chunks; `boundedReads` on Postgres).
 */
export async function preparePagePurge(engine: BrainEngine, row: WriteRequest, snapshot: PageSnapshot, clock: ClaimPhaseClock | undefined): Promise<PreparedPagePurge> {
  enterClaimStep(clock, 'purge_claims', undefined, 'db');
  const { needles, factRows, takeRows } = await readPurgeClaims(engine, row.source_id, snapshot.page.slug, snapshot.page.id);
  const [slugIndex] = await readRequestIndexStates(engine, [PERSISTENCE_REQUEST_SLUG_INTENT_INDEX]);
  const sweep = await sweepForPurge(engine, row, needles, clock);
  const retention = row.intent?.retention === true;
  const ledger = await sourceHasBeliefEvents(engine, row.source_id);
  const derived = ledger && !retention ? [...(await derivedStreamSlugs(engine, row.source_id, (await derivedRowsFrom(engine, [{ table: 'pages', id: snapshot.page.id },
    ...factRows.map(f => ({ table: 'facts', id: f.id })), ...takeRows.map(t => ({ table: 'takes', id: t.id }))])).rows)).values()] : [];
  const linked = ledger ? await linkStreamSlugs(engine, row.source_id, snapshot.page.id) : [];
  const derivedSlugs = [...new Set([...derived, ...linked])].filter(s => s !== snapshot.page.slug).sort();
  return { needles, sweep, slugIndex: slugIndex?.state ?? 'missing', retention, derivedSlugs };
}

/** The in-transaction journal lookups a statement timeout ends as `purge_lookup_timeout` (also the purge's fault-point seams). */
export type PurgeLookupPoint = 'slug_lookup' | 'tail_recheck' | 'pending_recheck' | 'redaction_read' | 'ledger_redaction';
const LOOKUP_LABEL: Record<PurgeLookupPoint, string> = { slug_lookup: 'lookup of stored intents for the slug', tail_recheck: 're-check of requests admitted after its preparation scan',
  pending_recheck: 're-check of requests that were pending at its preparation scan', redaction_read: 'locking read of the requests to redact',
  ledger_redaction: 'belief ledger claim inventory and redaction scan' };
export const PURGE_LOOKUP_TIMEOUT_MESSAGE = 'This purge could not finish; later writes to the source can move again. Do not assume the requested content was erased.';
/** [R6] The failure's `fix` names the index repair only when the slug index is missing or invalid; otherwise a fresh request id. */
export function purgeLookupTimeout(row: Pick<WriteRequest, 'request_id' | 'slug' | 'source_id'>, point: PurgeLookupPoint, slugIndex: RequestIndexState['state']): OperationError {
  const broken = slugIndex === 'missing' || slugIndex === 'invalid';
  const next = broken
    ? `The request-table slug index ${PERSISTENCE_REQUEST_SLUG_INTENT_INDEX.name} is ${slugIndex === 'invalid' ? 'INVALID' : 'missing'}: rebuild it (${REQUEST_INDEXES_REPAIR_COMMAND}), then submit the purge again with a new request_id.`
    : 'Submit the purge again with a new request_id (a retry with the same id returns this failure); if it times out again, report the request and attach the persistence_request_indexes and persistence_request_growth entries of gbrain doctor --json.';
  // The journal keeps code and message only, so the next step rides the message (the receipt is what `gbrain write-request` shows).
  return opError('purge_lookup_timeout', `${PURGE_LOOKUP_TIMEOUT_MESSAGE} ${next}`,
    `The purge's ${LOOKUP_LABEL[point]} (request ${row.request_id}, page ${row.slug} in source ${row.source_id}) exceeded the publication transaction's statement budget, so the transaction rolled back: `
    + 'no row, file or tombstone of the page was removed and nothing in the journal was redacted.',
    { fix: broken
      ? { argv: ['gbrain', 'repair', 'request-indexes', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Previews the missing or invalid request-table indexes without changing anything.' }
      : readFix(`Reads request ${row.request_id}'s durable receipt: its state and recorded error, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] }) });
}
/** Runs one in-transaction journal lookup behind its fault-point seam; a 57014 from it is the terminal typed failure, never transient contention. */
async function journalLookup<T>(row: WriteRequest, point: PurgeLookupPoint, slugIndex: RequestIndexState['state'], fn: () => Promise<T>): Promise<T> {
  try {
    await faultPoint(`purge:${point}`, { requestId: row.request_id, sourceId: row.source_id, operation: row.operation });
    return await fn();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== '57014') throw error;
    throw purgeLookupTimeout(row, point, slugIndex);
  }
}

/** The text-free tombstones of an owner-requested page purge: its facts, takes, and the content hash of the page and every retained version. */
async function tombstonePage(tx: BrainEngine, sourceId: string, slug: string, pageId: number, snapshot: PageSnapshot, requestId: string, actor: string,
  stored: { hash: string | null; generation: number }, hashes: Set<string>): Promise<void> {
  const page = snapshot.page;
  await tx.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason)
    SELECT DISTINCT source_id,visibility,COALESCE(entity_slug,'*'),gbrain_fact_fingerprint(fact),$3::uuid,$4,'page purge'
    FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND NOT ${outcomeMarkerSql('facts')} ON CONFLICT DO NOTHING`, [sourceId, slug, requestId, actor]);
  await tx.executeRaw(`INSERT INTO take_purges(source_id,subject,claim_hash,request_id)
    SELECT DISTINCT $1,$2,gbrain_fact_fingerprint(claim),$4::uuid FROM takes WHERE page_id=$3 ON CONFLICT DO NOTHING`, [sourceId, slug, pageId, requestId]);
  // Tombstone the content hash of the page and of every retained version, each as an import of that body would
  // compute it and as the purge overlay leaves it (the overlay now drops this page's tombstoned fence rows), so
  // neither the stale file nor an older version of it imports again under any slug.
  const versions = await tx.executeRaw<Record<string, unknown>>(`SELECT title,type,compiled_truth,timeline,frontmatter,tags,body_storage,body_generation,content_hash
    FROM page_versions WHERE page_id=$1 ORDER BY id DESC LIMIT 1000`, [pageId]);
  const meta = (v: Record<string, unknown>) => ({ title: String(v.title ?? ''), type: v.type as never, frontmatter: (v.frontmatter ?? {}) as Record<string, unknown>,
    tags: Array.isArray(v.tags) ? v.tags.map(String) : [] });
  if (stored.hash) hashes.add(stored.hash);
  // Wave B (spec 5, 11): a segmented body is never held whole: its stored hash (and a version's) is the import hash, and
  // the purge-overlaid hash is streamed from its segments.
  const overlaid = (fence: string) => dropPurgedFenceRows(tx, sourceId, fence, slug);
  const segmented = isSegmentedPage(page) ? [{ generation: stored.generation, meta: { ...meta(page as never), tags: snapshot.tags } }] : [];
  const inline = isSegmentedPage(page) ? [] : [{ ...page, tags: snapshot.tags }];
  for (const v of versions) {
    if (v.body_storage !== 'segmented') { inline.push({ ...meta(v), compiled_truth: String(v.compiled_truth ?? ''), timeline: String(v.timeline ?? '') } as never); continue; }
    if (typeof v.content_hash === 'string') hashes.add(v.content_hash);
    segmented.push({ generation: Number(v.body_generation), meta: meta(v) });
  }
  for (const body of inline) {
    hashes.add(contentHash(body));
    hashes.add(contentHash({ ...body, compiled_truth: await overlaid(body.compiled_truth), timeline: await overlaid(body.timeline ?? '') }));
  }
  for (const body of segmented) {
    const hash = await rewrittenContentHash(tx, pageId, sourceId, body.generation, overlaid, body.meta);
    if (hash) hashes.add(hash);
  }
  await tx.executeRaw(`INSERT INTO page_purges(source_id,content_hash,slug,request_id) SELECT $1,h,$3,$4::uuid FROM unnest($2::text[]) AS h
    ON CONFLICT (source_id,content_hash) DO UPDATE SET slug=EXCLUDED.slug,request_id=EXCLUDED.request_id,purged_at=now()`, [sourceId, [...hashes], slug, requestId]);
}

/** Inside the coordinated delete transaction, before the page row is deleted. */
export async function purgePageInTransaction(tx: BrainEngine, row: WriteRequest, snapshot: PageSnapshot, prepared: PreparedPagePurge): Promise<Record<string, unknown>> {
  const page = snapshot.page, sourceId = row.source_id, slug = page.slug;
  const actor = `${row.principal_kind}:${row.principal_id}`;
  const [stored] = await tx.executeRaw<{ content_hash: string | null; body_generation: number | string }>('SELECT content_hash,body_generation FROM pages WHERE id=$1', [page.id]);
  const storedHash = stored?.content_hash ?? null;
  const lookup = <T>(point: PurgeLookupPoint, fn: () => Promise<T>) => journalLookup(row, point, prepared.slugIndex, fn);
  const retention = prepared.retention;
  const ledgerPresent = !retention && await sourceHasBeliefEvents(tx, sourceId);
  const epoch = retention ? 0 : await bumpPurgeEpoch(tx, sourceId);
  const lifetimes = ledgerPresent ? await pageLifetimesOf(tx, sourceId, slug, page.id) : [];
  const inventory = ledgerPresent ? await lookup('ledger_redaction', () => pagePurgeClaims(tx, { sourceId, slug, pageId: page.id, lifetimes })) : { claims: [], fps: [] };
  const mirrorFacts = retention ? [] : await tx.executeRaw<{ fact_hash: string; visibility: string; subject: string }>(`SELECT DISTINCT gbrain_fact_fingerprint(fact) AS fact_hash,
    visibility, COALESCE(entity_slug,'*') AS subject FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND NOT ${outcomeMarkerSql('facts')}`, [sourceId, slug]);
  const mirrorTakes = retention ? [] : (await tx.executeRaw<{ claim_hash: string }>('SELECT DISTINCT gbrain_fact_fingerprint(claim) AS claim_hash FROM takes WHERE page_id=$1', [page.id])).map(t => t.claim_hash);
  const hashes = new Set<string>();
  if (!retention) await tombstonePage(tx, sourceId, slug, page.id, snapshot, row.id, actor, { hash: storedHash, generation: Number(stored?.body_generation) }, hashes);
  const { factRows, takeRows, needles } = await readPurgeClaims(tx, sourceId, slug, page.id);
  const segmentClaims = await readSegmentClaims(tx, sourceId, slug, page.id);
  const factIds = factRows.map(f => Number(f.id)), takeIds = takeRows.map(t => Number(t.id));
  const derivedFrom = await derivedRowsFrom(tx, [{ table: 'pages', id: page.id }, ...factIds.map(id => ({ table: 'facts', id })), ...takeIds.map(id => ({ table: 'takes', id }))]);
  const purgedHere = new Set([...factIds.map(id => `facts:${id}`), ...takeIds.map(id => `takes:${id}`)]);
  const derivedRows = derivedFrom.rows.filter(r => !purgedHere.has(`${r.table}:${r.id}`));
  const targets = ledgerPresent ? await lookup('ledger_redaction', () => derivedBeliefTargets(tx, sourceId, derivedRows)) : [];
  const heldTargets = targets.filter(t => { try { assertHeldPageKeys(tx, [{ sourceId, slug: t.slug }]); return true; } catch { return false; } });
  const walk = derivedFrom.truncated || heldTargets.length < targets.length ? 'truncated' as const : 'complete' as const;
  if (!retention) noteBelief({ kind: 'purged', table: 'pages', ids: [page.id], request: row.id, ...(walk === 'truncated' ? { derivedWalk: walk } : {}) });
  const derived = await hideDerivedRows(tx, derivedRows, { sourceId, requestId: row.id, reason: 'page purge' });
  const count = async (sql: string, params: unknown[]) => (await tx.executeRaw(sql, params)).length;
  const refs = factIds.map(String);
  const removed: Record<string, number> = {
    decide_review_queue: await count('DELETE FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1', [sourceId, refs]),
    decide_review_proposals: await count('DELETE FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1', [sourceId, refs]),
    decide_proposals: await count('DELETE FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($2::bigint[]) OR old_fact_id=ANY($2::bigint[])) RETURNING 1', [sourceId, factIds]),
    trust_proposals: await count(`DELETE FROM trust_proposals WHERE source_id=$1 AND ((target_table='pages' AND target_id=$2) OR (related_table='pages' AND related_id=$2)
      OR (target_table='facts' AND target_id=ANY($3::bigint[])) OR (related_table='facts' AND related_id=ANY($3::bigint[]))
      OR (target_table='takes' AND target_id=ANY($4::bigint[])) OR (related_table='takes' AND related_id=ANY($4::bigint[]))) RETURNING 1`, [sourceId, page.id, factIds, takeIds]),
  };
  const holds = (await tx.executeRaw<{ id: string }>('DELETE FROM write_gate_holds WHERE source_id=$1 AND slug=$2 RETURNING id::text AS id', [sourceId, slug])).map(h => h.id);
  removed.write_gate_holds = holds.length;
  removed.write_gate_receipts = await count(`DELETE FROM write_gate_receipts WHERE (target_table='pages' AND target_id=$1) OR (target_table='facts' AND target_id=ANY($2::text[]))
    OR (target_table='takes' AND target_id=ANY($3::text[])) OR (target_table='write_gate_holds' AND target_id=ANY($4::text[])) RETURNING 1`,
  [String(page.id), refs, takeIds.map(String), holds]);
  const missingCaches: string[] = [];
  const cleared = await clearRebuildableCache(tx, 'query_cache');
  if (cleared === null) missingCaches.push('query_cache');
  removed.query_cache = cleared ?? 0;
  removed.facts = await count('DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 RETURNING 1', [sourceId, slug]);
  removed.take_proposals = await count('DELETE FROM take_proposals WHERE source_id=$1 AND page_slug=$2 RETURNING 1', [sourceId, slug]);
  removed.open_loops = await count('DELETE FROM open_loops WHERE source_id=$1 AND page_slug=$2 RETURNING 1', [sourceId, slug]);
  removed.core_edit_notices = await count('DELETE FROM core_edit_notices WHERE source_id=$1 AND slug=$2 RETURNING 1', [sourceId, slug]);
  // #6619: the page's free-text aliases and the redirects that resolve to it; a redirect from this slug to another page stays.
  removed.page_aliases = await count('DELETE FROM page_aliases WHERE source_id=$1 AND slug=$2 RETURNING 1', [sourceId, slug]);
  removed.slug_aliases = await count('DELETE FROM slug_aliases WHERE source_id=$1 AND canonical_slug=$2 RETURNING 1', [sourceId, slug]);
  // #6511 [R2]: the preparation sweep's targets, plus the tail past its ceiling and the rows pending at scan time, re-tested here.
  const recheck = await lookup('tail_recheck', () => recheckRequestsCarrying(tx, sourceId, needles, prepared.sweep,
    { exclude: row.id, beforePending: () => faultPoint('purge:pending_recheck', { requestId: row.request_id, sourceId, operation: row.operation }) }));
  const forSlug = await lookup('slug_lookup', () => findRequestsForSlugs(tx, sourceId, [slug]));
  const requests = [...new Map([...forSlug, ...prepared.sweep.targets, ...recheck.targets].map(r => [r.id, r])).values()];
  removed.persistence_requests = await lookup('redaction_read', () => redactRequestIntents(tx, requests, row.id, { skipPending: true, needles }));
  const journalSweep = { scanned: prepared.sweep.scanned, ceiling: prepared.sweep.ceiling, watermark: prepared.sweep.watermark ?? null, batch: prepared.sweep.batch ?? 1,
    tail: recheck.tail, pending_rechecked: recheck.pendingRechecked, complete: prepared.sweep.complete && recheck.complete };
  const files = await tx.executeRaw<{ storage_path: string }>(`DELETE FROM files WHERE (page_id=$1 OR (page_slug=$2 AND (source_id=$3 OR source_id IS NULL)))
    RETURNING storage_path`, [page.id, slug, sourceId]);
  removed.files = files.length;
  Object.assign(removed, await (await import('../generations/ledger-scrub.ts')).scrubGenerationLedger(tx, sourceId, { slug }));
  const [cascade] = await tx.executeRaw<{ chunks: number; versions: number; takes: number; timeline: number }>(`SELECT
    (SELECT count(*)::int FROM content_chunks WHERE page_id=$1) AS chunks, (SELECT count(*)::int FROM page_versions WHERE page_id=$1) AS versions,
    (SELECT count(*)::int FROM takes WHERE page_id=$1) AS takes, (SELECT count(*)::int FROM timeline_entries WHERE page_id=$1) AS timeline`, [page.id]);
  Object.assign(removed, { content_chunks: cascade?.chunks ?? 0, page_versions: cascade?.versions ?? 0, takes: cascade?.takes ?? 0, timeline_entries: cascade?.timeline ?? 0, pages: 1 });
  const versions = await tx.executeRaw<{ source_path: string | null }>('SELECT DISTINCT source_path FROM page_versions WHERE page_id=$1 AND source_path IS NOT NULL LIMIT 64', [page.id]);
  const paths = [...new Set([page.source_path, ...versions.map(v => v.source_path)].filter((p): p is string => !!p))].slice(0, 64);
  const ledger: LedgerPurgeReport | null = ledgerPresent ? await lookup('ledger_redaction', async () => ({
    purged_events: await redactPurgedKeys(tx, { sourceId, claimFps: inventory.fps, lifetimes }),
    redacted_fields: await redactCarryingFields(tx, { sourceId, request: row.id, claims: inventory.claims }),
    live_carriers: await registerLiveCarriers(tx, { sourceId, request: row.id, claims: inventory.claims }),
    derived_hidden: await appendDerivedHidden(tx, { sourceId, request: row.id, publicationId: row.id, op: 'delete_page', targets: heldTargets, truncated: walk === 'truncated' }),
    derived_walk: walk })) : null;
  if (ledger) removed.belief_events = ledger.purged_events + ledger.redacted_fields.length;
  await writeOriginDeletedMarker(tx, { sourceId, page: { id: page.id, slug, source_path: page.source_path } });
  const { shas, ...segmentRows } = await deletePageWithSegments(tx, sourceId, slug, page.id, segmentClaims);
  Object.assign(removed, segmentRows);
  if (!retention) appendPurgeIntent({ request: row.id, request_id: row.request_id, source_id: sourceId, source_incarnation: row.source_incarnation,
    scope: 'page', slug, purge_epoch: epoch, content_hashes: [...hashes], facts: mirrorFacts, takes: mirrorTakes, lifetimes });
  const key = `${sourceId}:${row.request_id}`;
  purgeContext.delete(key);
  purgeContext.set(key, { needles, factIds, pageId: page.id, paths, segmentShas: shas.slice(0, 4096), segmentClaims, ledgerClaims: inventory.claims, ledger });
  while (purgeContext.size > PURGE_CONTEXT_LIMIT) purgeContext.delete(purgeContext.keys().next().value!);
  return { status: 'purged', slug, source_id: sourceId, residuals: PURGE_RESIDUALS, journal_sweep: journalSweep, ...(retention ? { retention: true } : {}),
    purge: { content_hash8: storedHash?.slice(0, 8) ?? null, tombstoned: hashes.size > 0, content_hashes_tombstoned: hashes.size, removed,
      ...(missingCaches.length ? { missing_caches: missingCaches } : {}),
      ...(ledger ? { ledger: { purged_events: ledger.purged_events, redacted_fields: ledger.redacted_fields.length, live_carriers: ledger.live_carriers.length, derived_hidden: ledger.derived_hidden, derived_walk: ledger.derived_walk } } : {}),
      derived: { ...derived, truncated: derivedFrom.truncated },
      blobs: files.map(f => f.storage_path).filter(Boolean) } };
}

/**
 * After commit: delete the purged page's stored blobs (any that remain are listed by storage path), then build the
 * store-by-store receipt the fact purge returns: residuals first, every swept inventory store with a status.
 */
export async function finishPagePurge(ctx: Pick<OperationContext, 'engine' | 'config'>, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (result.status !== 'purged') return result;
  const sourceId = String(result.source_id), slug = String(result.slug), key = `${sourceId}:${String(result.request_id)}`;
  // A same-id replay in this process returns what the purge call returned (blobs and verification are not re-run).
  const finished = purgeReceipts.get(key);
  if (finished) return { ...result, ...finished };
  const purge = (result.purge ?? {}) as { blobs?: string[]; removed?: Record<string, number> };
  const remaining: string[] = [];
  if (purge.blobs?.length) {
    try {
      const { createStorage } = await import('../storage.ts');
      const storage = await createStorage((ctx.config as { storage?: unknown } | undefined)?.storage as never);
      for (const path of purge.blobs) { try { await storage.delete(path); } catch { remaining.push(path); } }
    } catch { remaining.push(...purge.blobs); }
  }
  const { verifyPagePurge } = await import('../facts/purge-verify.ts');
  const receipt = await verifyPagePurge(ctx.engine, { sourceId, slug, requestId: String(result.request_id), removed: purge.removed ?? {},
    blobsRemaining: remaining, context: purgeContext.get(key) ?? null });
  purgeContext.delete(key);
  // `residuals` stays the delete_page prose string; the store-by-store receipt (same shape as purge_fact's) rides as `receipt`.
  const extra = { receipt, purge: { ...purge, blobs_deleted: (purge.blobs?.length ?? 0) - remaining.length, blobs_remaining: remaining } };
  purgeReceipts.set(key, extra);
  while (purgeReceipts.size > PURGE_CONTEXT_LIMIT) purgeReceipts.delete(purgeReceipts.keys().next().value!);
  return { ...result, ...extra };
}

export const PAGE_PURGE_TOMBSTONES_SQL = 'SELECT content_hash,slug FROM page_purges WHERE source_id=$1 ORDER BY purged_at DESC LIMIT $2';
/** Prefetch for import screens: every page tombstone of a source, content hash -> slug (bounded). */
export async function readPagePurgeTombstones(engine: BrainEngine, sourceId: string, limit = 10_000): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ content_hash: string; slug: string }>(PAGE_PURGE_TOMBSTONES_SQL, [sourceId, limit]);
  return new Map(rows.map(r => [r.content_hash, r.slug]));
}

export async function listPagePurges(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (ctx.remote !== false) throw hostOnly('gbrain pages purges list');
  const limit = Math.max(1, Math.min(1000, Number(p.limit ?? 100) || 100));
  const rows = await ctx.engine.executeRaw<{ source_id: string; slug: string; content_hash: string; request_id: string | null; purged_at: string }>(`SELECT source_id,slug,
      content_hash,request_id::text,purged_at FROM page_purges WHERE ($1::text IS NULL OR source_id=$1) ORDER BY purged_at DESC LIMIT $2`,
  [typeof p.source_id === 'string' ? p.source_id : null, limit]);
  return { purges: rows.map(r => ({ source_id: r.source_id, slug: r.slug, content_hash8: r.content_hash.slice(0, 8), request_id: r.request_id,
    purged_at: new Date(r.purged_at).toISOString() })), next: rows.length ? 'Clear one with gbrain pages unpurge <slug> [--source <id>].' : 'No page purge tombstones.' };
}

export async function unpurgePage(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (ctx.remote !== false) throw hostOnly('gbrain pages unpurge <slug>');
  const slug = typeof p.slug === 'string' ? p.slug : '';
  if (!slug) throw opError('invalid_params', 'unpurge needs a slug.', 'Pass the slug gbrain pages purges list shows.');
  const sourceId = typeof p.source_id === 'string' ? p.source_id : ctx.sourceId ?? 'default';
  return ctx.engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    const cleared = await tx.executeRaw<{ request_id: string | null }>('DELETE FROM page_purges WHERE source_id=$1 AND slug=$2 RETURNING request_id::text', [sourceId, slug]);
    const requests = cleared.map(r => r.request_id).filter((id): id is string => !!id);
    const facts = requests.length ? (await tx.executeRaw('DELETE FROM fact_purges WHERE source_id=$1 AND request_id=ANY($2::uuid[]) RETURNING 1', [sourceId, requests])).length : 0;
    const takes = requests.length ? (await tx.executeRaw('DELETE FROM take_purges WHERE source_id=$1 AND request_id=ANY($2::uuid[]) RETURNING 1', [sourceId, requests])).length : 0;
    return { slug, source_id: sourceId, cleared: cleared.length, fact_tombstones_cleared: facts, take_tombstones_cleared: takes,
      next: cleared.length ? `The next import of ${slug} with its old content is accepted (gbrain sync --source ${sourceId} --no-pull). Nothing was restored.` : `No purge tombstone is recorded for ${slug} in source ${sourceId}.` };
  });
}

/**
 * Delete a purged page with its segment storage (Wave B, spec 11), in the caller's transaction: the segment texts its
 * manifests referenced go with it, and so do its stagings (one of a create has no page row to cascade from). So do the
 * texts its stagings recorded (page_body_staging_texts) that no manifest row references any more: a sweep that drops
 * a closed generation's rows keeps a text younger than the GC grace window, so the text a forget rewrite replaced is
 * no longer in the manifest after a later write's sweep (N14-5), and only the staging that wrote it still names it.
 * Stagings outlive that window (BODY_STAGING_HARD_MS), so the page's stagings name every such text. A text another
 * page still references stays, and so does one an unpublished write of another page staged or deduped onto (a create
 * holds its manifest rows in memory until it publishes): that write's copy, not this page's. The restore-time purge
 * replay deletes a page this way too.
 *
 * A text can outlive the staging that recorded it: another page's write that dedupes onto it refreshes its created_at
 * (stageSegmentTexts), so it stays younger than the grace window after this page's stagings expired. So, with
 * `claims` (the page's own claims, withdrawn ones included), every unreferenced text of the source holding one of them,
 * plain or as a facts-fence cell stores it (escapeFenceCell; the match purgeSegmentStorage uses), goes too.
 */
export async function deletePageWithSegments(tx: BrainEngine, sourceId: string, slug: string, pageId: number, claims: readonly string[] = []):
  Promise<{ shas: string[]; page_body_manifest: number; page_body_stagings: number; page_segment_texts: number }> {
  const shas = (await tx.executeRaw<{ sha: string }>(`SELECT encode(sha256,'hex') AS sha FROM page_body_manifest WHERE page_id=$1
    UNION SELECT encode(r.sha256,'hex') FROM page_body_stagings s JOIN page_body_staging_texts r ON r.staging_id=s.id
      WHERE s.source_id=$2 AND (s.slug=$3 OR s.page_id=$1) AND r.source_id=$2`, [pageId, sourceId, slug])).map(r => r.sha);
  const manifest = (await tx.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1', [pageId]))[0]?.n ?? 0;
  const stagings = (await tx.executeRaw('DELETE FROM page_body_stagings WHERE source_id=$1 AND (slug=$2 OR page_id=$3) RETURNING 1', [sourceId, slug, pageId])).length;
  await tx.deletePage(slug, { sourceId });
  const texts = shas.length ? (await tx.executeRaw(`DELETE FROM page_segment_texts t WHERE t.source_id=$1 AND t.sha256=ANY(SELECT decode(h,'hex') FROM unnest($2::text[]) AS h)
    AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256) AND NOT ${stagingNeedsTextSql('t')} RETURNING 1`, [sourceId, shas])).length : 0;
  const forms = claimTextForms(claims), carrying: string[] = [];
  for (let at = 0; at < forms.length; at += CLAIM_FORMS_BATCH) {
    carrying.push(...(await tx.executeRaw<{ sha: string }>(`DELETE FROM page_segment_texts d WHERE (d.source_id,d.sha256) IN (SELECT t.source_id,t.sha256
      FROM page_segment_texts t WHERE t.source_id=$1 AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256) OFFSET 0)
    AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS n WHERE strpos(lower(convert_from(d.body,'UTF8')),n)>0) AND NOT ${stagingNeedsTextSql('d')}
    RETURNING encode(d.sha256,'hex') AS sha`, [sourceId, forms.slice(at, at + CLAIM_FORMS_BATCH)])).map(r => r.sha));
  }
  return { shas: [...shas, ...carrying], page_body_manifest: manifest, page_body_stagings: stagings, page_segment_texts: texts + carrying.length };
}

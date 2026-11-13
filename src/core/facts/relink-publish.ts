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

import type { BrainEngine, FactAttribution } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { formatFenceDate, parseFactsFence, upsertFactRow } from '../facts-fence.ts';
import { extractFactsFromFenceText } from './extract-from-fence.ts';
import { withHeldFactsFence } from './unfenced-facts.ts';
import { digest } from '../persistence/digest.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { readFacts, type FactSnapshot } from '../persistence/prepared-maintenance.ts';
import { decideSingleFact } from './single-prepare.ts';
import { isFactWithdrawn } from './withdrawal.ts';
import { appendContextNote } from './subject-infer.ts';
import { normalizeTargetFences } from '../fence-repair/import-step.ts';
import { refuseUnparsedRewrite } from '../fence-repair/refusal.ts';
import { pageFencesNormalized } from '../fence-repair/report.ts';
import { withTrustKeep } from '../persistence/context.ts';
import { withPendingFenceRows } from '../eligibility/fence-overlay.ts';
import { activationSuppressedSql } from '../eligibility/sql.ts';
import { storedTrustTier, type TrustTier } from '../trust/tier.ts';
import { storedPageTier } from '../trust/page-write.ts';
import { resolveStrictEntityReference } from '../entities/resolve.ts';
import { entityLinkable } from './attribution.ts';
import { dirname } from 'node:path';
import { nativePathMayBeGitCheckout } from '../persistence/native-file-target.ts';

export const RELINK_OPERATION = 'relink_facts';
export const EXPLICIT_RELINK_OPERATION = 'relink_fact_by_id';

/** One fact in a relink request: its pinned row hash and how its subject was found. */
export interface RelinkIntentFact { id: number; hash: string; tier: string; model: string | null; note: string }
export interface ExplicitRelinkPin { brainId: string; sourceIncarnation: string; pageId: number; revision: string; factHash: string; evidenceHash: string }
export interface RelinkIntent { kind: 'relink_facts'; run_id: string; queue_conflict: boolean; facts: RelinkIntentFact[]; explicit?: ExplicitRelinkPin; serve_only?: true }

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

export type RelinkSkipReason = 'revision_conflict' | 'withdrawn' | 'claim_unfenceable' | 'validity_precision' | 'projection_loss' | 'visibility_conflict' | 'not_user_attributed';

type Classified =
  | { id: number; action: 'link'; value: Record<string, unknown> }
  | { id: number; action: 'retire'; duplicateOf: number }
  | { id: number; action: 'skip'; reason: RelinkSkipReason };

/** PostgreSQL JSON can include an offset with seconds in a historical time zone. */
function relinkTimestamp(value: unknown): number {
  const iso = String(value);
  const offset = /([+-]\d{2}:\d{2}):(\d{2})$/.exec(iso);
  if (!offset) return Date.parse(iso);
  const minuteOffset = iso.slice(0, -3);
  const remainingSeconds = Number(offset[2]) * (offset[1]!.startsWith('-') ? -1 : 1);
  return Date.parse(minuteOffset) - remainingSeconds * 1000;
}

/** Existing timestamps keep their millisecond precision when adopted. */
function relinkFenceDate(value: unknown): string {
  const date = new Date(relinkTimestamp(value));
  return date.getUTCMilliseconds() === 0 ? formatFenceDate(date) : date.toISOString();
}

/** The fence projector uses JS Date; check the raw ISO value before conversion. */
export function relinkValidityRepresentable(from: unknown, until: unknown): boolean {
  return [from, ...(until == null ? [] : [until])].every(value => {
    if (typeof value !== 'string' || !Number.isFinite(relinkTimestamp(value))) return false;
    const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1];
    return !/[1-9]/.test(fraction?.slice(3) ?? '');
  });
}

/** The fence cell a relinked row renders as. */
function fenceRow(v: Record<string, unknown>, rowNum: number, context: string) {
  return {
    rowNum, claim: String(v.fact), kind: v.kind as never, confidence: Number(v.confidence ?? 1),
    visibility: v.visibility as never, notability: (v.notability ?? 'medium') as never,
    validFrom: relinkFenceDate(v.valid_from),
    validUntil: v.valid_until ? relinkFenceDate(v.valid_until) : undefined,
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
 * A claim the fence cannot carry unchanged (wrapped in ~~, or otherwise not
 * parsing back to the same active claim and visibility) would be expired and
 * re-inserted as a different fact by the page projection, so it is never moved.
 */
export function relinkFenceLoss(v: Record<string, unknown>, note: string, slug: string, sourceId: string): 'validity_precision' | 'claim_unfenceable' | 'projection_loss' | null {
  if (!relinkValidityRepresentable(v.valid_from, v.valid_until)) return 'validity_precision';
  const context = appendContextNote(v.context as string | null, note);
  const parsed = parseFactsFence(upsertFactRow('', fenceRow(v, 1, context)).body);
  const cell = parsed.facts[0];
  if (parsed.warnings.length || parsed.facts.length !== 1 || !cell?.active || cell.claim !== v.fact
    || cell.visibility !== v.visibility || (cell.context ?? '') !== context) return 'claim_unfenceable';
  // Page publication refreshes these fields on the adopted row. Compare the
  // canonical projection so relink cannot silently normalize its payload.
  const [projected] = extractFactsFromFenceText([cell], slug, sourceId);
  if (projected!.valid_from?.getTime() !== relinkTimestamp(v.valid_from)
    || (projected!.valid_until?.getTime() ?? null) !== (v.valid_until == null ? null : relinkTimestamp(v.valid_until))
    || Math.fround(projected!.confidence ?? 1) !== Math.fround(Number(v.confidence ?? 1))) return 'projection_loss';
  const fields = ['kind', 'notability', 'source', 'claim_metric', 'claim_value', 'claim_unit', 'claim_period', 'attributed_to'] as const;
  return fields.some(field => (projected![field] ?? null) !== (v[field] ?? null)) ? 'projection_loss' : null;
}

function isActiveUnlinked(v: Record<string, unknown>, now: number): boolean {
  return v.entity_slug === null && v.row_num === null && v.source_markdown_slug === null && v.expired_at === null
    && (v.valid_until === null || v.valid_until === 'infinity' || relinkTimestamp(v.valid_until) > now);
}

/** Keep this additional pin separate from the existing relink request hash. */
export async function explicitRelinkFact(db: BrainEngine, sourceId: string, id: number) {
  const [row] = await db.executeRaw<{ value: Record<string, unknown>; visibility: string }>(
    'SELECT to_jsonb(f) AS value, f.visibility FROM facts f WHERE f.source_id=$1 AND f.id=$2', [sourceId, id]);
  return row ? { hash: digest(row.value), visibility: row.visibility } : null;
}

export async function explicitRelinkScope(db: BrainEngine, sourceId: string) {
  const [scope] = await db.executeRaw<{ brain_id: string; incarnation: string; canonical_git: boolean; local_path: string | null }>(`SELECT b.brain_id,
      s.incarnation, s.local_path, COALESCE(s.config->>'canonical', '')='git' AS canonical_git
    FROM persistence_brain b JOIN sources s ON s.id=$1 AND NOT s.archived WHERE b.singleton=1`, [sourceId]);
  return scope;
}

export function assertExplicitRelinkPrivacy(git: boolean, visibility: string) {
  if (git && visibility === 'private') throw opError('permission_denied', 'An explicit private relink cannot write into a Git checkout.',
    'The private fact stays in the database. Use a target on a non-Git source.');
}

export async function exactRelinkTarget(engine: BrainEngine, sourceId: string, slug: string): Promise<boolean> {
  const resolved = await resolveStrictEntityReference(engine, sourceId, slug, { exactOnly: true });
  return resolved.slug === slug && resolved.arm === 'exact_page';
}

async function classify(db: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'slug'>, intent: RelinkIntent, lock: boolean): Promise<Classified[]> {
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
    if (intent.explicit && !entityLinkable(v.attributed_to as FactAttribution | null)) {
      out.push({ id: f.id, action: 'skip', reason: 'not_user_attributed' });
      continue;
    }
    const visibility = v.visibility as 'private' | 'world';
    const fenceLoss = relinkFenceLoss(v, f.note, row.slug, row.source_id);
    if (fenceLoss) {
      out.push({ id: f.id, action: 'skip', reason: fenceLoss });
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
    // B-10: an ontology observation the page already holds at the same key would collide on
    // idx_facts_ontology_stint_dedup once linked; it retires as that row's duplicate instead.
    if (v.dimension != null) {
      const [held] = await db.executeRaw<{ id: number | string }>(
        `SELECT t.id FROM facts m JOIN facts t ON t.source_id = m.source_id AND t.dimension = m.dimension AND t.value_hash = m.value_hash
             AND t.valid_from = m.valid_from AND t.id <> m.id
           WHERE m.source_id=$1 AND m.id=$3 AND t.entity_slug=$2 AND t.source_markdown_slug=$2
           ORDER BY (t.expired_at IS NULL) DESC, t.id LIMIT 1`, [row.source_id, row.slug, f.id]);
      if (held) {
        out.push({ id: f.id, action: 'retire', duplicateOf: Number(held.id) });
        continue;
      }
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

export async function explicitRelinkRefusal(db: BrainEngine, sourceId: string, slug: string, intent: RelinkIntent): Promise<string | null> {
  const [result] = await classify(db, { source_id: sourceId, slug }, intent, false);
  return result?.action === 'link' ? null : result?.action === 'skip' ? result.reason : 'duplicate';
}

async function relinkChunkTrust(db: BrainEngine, sourceId: string, rowNums: ReadonlyMap<number, number>) {
  if (!rowNums.size) return new Map<number, { tier: TrustTier; unconfirmed: boolean }>();
  const rows = await db.executeRaw<{ id: number | string; trust_tier: unknown; unconfirmed: boolean }>(
    `SELECT f.id, f.trust_tier, ${activationSuppressedSql('facts', 'f')} AS unconfirmed
      FROM facts f WHERE f.source_id=$1 AND f.id=ANY($2::integer[]) ORDER BY f.id`, [sourceId, [...rowNums.keys()]]);
  return new Map(rows.map(row => [rowNums.get(Number(row.id))!, { tier: storedTrustTier(row.trust_tier), unconfirmed: row.unconfirmed }]));
}

export async function prepareRelinkMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const intent = row.intent as unknown as RelinkIntent | null;
  const rerun = `The next gbrain facts relink --source ${row.source_id} run re-plans from current state; preview it with --dry-run (no model calls, no writes).`;
  const changed = (message: string) => opError('revision_conflict', message,
    `${row.slug} or one of its facts changed while relink request ${row.request_id} was being prepared, so nothing was written. ${rerun}`);
  if (!intent || row.operation !== (intent.explicit ? EXPLICIT_RELINK_OPERATION : RELINK_OPERATION)
    || intent.kind !== 'relink_facts' || !Array.isArray(intent.facts) || row.authority.remote) {
    throw opError('permission_denied', 'Unsupported relink intent.',
      `Request ${row.request_id} is not a trusted local relink this gbrain version can publish, so nothing was written. Facts relink runs only from gbrain facts relink on the brain host.`);
  }
  const current = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  const snapshot = intent.explicit ? await (await import('../persistence/segmented-apply.ts')).wholeBodySnapshot(engine, current, 'facts relink') : current;
  if (!snapshot || snapshot.page.id !== row.page_id) {
    throw opError('page_identity_changed', 'The relink target page changed.',
      `${row.slug} in ${row.source_id} was deleted or replaced after relink request ${row.request_id} was accepted, so nothing was written. ${rerun}`);
  }
  const observedRevision = snapshot.revision;
  const checkExplicit = async (db: BrainEngine) => {
    if (!intent.explicit) return;
    const { brainId, sourceIncarnation, pageId, revision, factHash } = intent.explicit;
    const scope = await explicitRelinkScope(db, row.source_id);
    if (scope?.brain_id !== brainId || scope.incarnation !== sourceIncarnation || row.source_incarnation !== sourceIncarnation || snapshot.page.id !== pageId
      || observedRevision !== revision || !await exactRelinkTarget(db, row.source_id, row.slug)
      || intent.facts.length !== 1 || intent.queue_conflict) {
      throw changed('The explicit relink preview is no longer current.');
    }
    const fact = await explicitRelinkFact(db, row.source_id, intent.facts[0]!.id);
    if (!fact || fact.hash !== factHash) throw changed('The explicitly selected fact changed after preview.');
    const root = scope.local_path ?? (row.source_id === 'default' ? await db.getConfig('sync.repo_path') : null);
    assertExplicitRelinkPrivacy(scope.canonical_git || (fact.visibility === 'private' && root !== null && nativePathMayBeGitCheckout(root)), fact.visibility);
  };
  await checkExplicit(engine);
  const planned = await classify(engine, row, intent, false);
  if (intent.explicit && planned[0]?.action !== 'link') {
    throw changed(`The explicit fact cannot be linked (${planned[0]?.action === 'skip' ? planned[0].reason : 'duplicate'}).`);
  }
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
    const [max] = await engine.executeRaw<{ n: number }>(
      'SELECT COALESCE(MAX(row_num),0)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [row.source_id, row.slug]);
    let next = Math.max(Number(max?.n ?? 0), 0, ...parsed.facts.map(f => f.rowNum)) + 1;
    for (const link of links) {
      const v = link.value;
      const rowNum = next++;
      rowNums.set(link.id, rowNum);
      // #6385 R12: a fence that does not parse cleanly refuses typed (`fence_malformed` below) instead of losing rows.
      body = refuseUnparsedRewrite({ compiled_truth: body, timeline }, row.slug, row.source_id,
        () => upsertFactRow(body, fenceRow(v, rowNum, appendContextNote(v.context as string | null, byId.get(link.id)!.note))).body);
    }
  }
  // Adopted rows are still unpositioned when page preparation chunks the fence.
  const publicRowNums = new Map(links.filter(link => link.value.visibility === 'world').map(link => [link.id, rowNums.get(link.id)!]));
  const pendingTrust = await relinkChunkTrust(engine, row.source_id, publicRowNums);
  if (pendingTrust.size !== publicRowNums.size) throw changed('A relinked fact disappeared during preparation.');
  const pageTier = publicRowNums.size ? await storedPageTier(engine, row.source_id, row.slug) : null;
  if (publicRowNums.size && !pageTier) throw changed('The relink target page disappeared during preparation.');
  const prepare = async () => {
    const { preparePageMutation } = await import('../persistence/page-prepare.ts');
    return preparePageMutation(engine, { ...row, intent: {
      content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body, timeline }, snapshot.tags), expected_revision: observedRevision, force: false,
    } }, config);
  };
  const page = pageTier ? await withPendingFenceRows({ sourceId: row.source_id, slug: row.slug, byRow: pendingTrust, pageTier }, prepare)
    : links.length ? await prepare() : undefined;
  if (page && page.observedRevision !== observedRevision) throw changed('The relink target page changed during preparation.');
  if (intent.explicit && (!page || page.noop)) throw changed('The exact target would not publish the selected fact.');

  const checkFilePrivacy = () => {
    if (intent.explicit && page?.file && links[0]?.value.visibility === 'private') {
      assertExplicitRelinkPrivacy(nativePathMayBeGitCheckout(dirname(page.file.path)), 'private');
    }
  };
  checkFilePrivacy();

  const validate = async (tx: BrainEngine) => {
    if (classKey(await classify(tx, row, intent, true)) !== classKey(planned)) {
      throw changed('A relinked fact changed during preparation.');
    }
    await checkExplicit(tx);
    checkFilePrivacy();
    if (pageTier && await storedPageTier(tx, row.source_id, row.slug) !== pageTier) {
      throw changed('The relink target page changed trust during preparation.');
    }
    const lockedTrust = await relinkChunkTrust(tx, row.source_id, publicRowNums);
    if (digest([...pendingTrust]) !== digest([...lockedTrust])) throw changed('A relinked fact changed trust during preparation.');
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
        const moved = await withTrustKeep(tx, ['facts'], () =>
          tx.executeRaw(`UPDATE facts SET entity_slug=$3, source_markdown_slug=$3, row_num=$4::integer, context=$5 ${guard}`,
            [row.source_id, c.id, row.slug, rowNum, appendContextNote(c.value.context as string | null, f.note)]));
        if (moved.length !== 1) throw changed('A relinked fact was moved by another writer.');
        outcome.linked.push({ id: c.id, row_num: rowNum });
      } else if (c.action === 'retire') {
        const [current] = await tx.executeRaw<{ context: string | null }>('SELECT context FROM facts WHERE source_id=$1 AND id=$2', [row.source_id, c.id]);
        const retired = await withTrustKeep(tx, ['facts'], () =>
          tx.executeRaw(`UPDATE facts SET entity_slug=$3, expired_at=now(), context=$4 ${guard}`,
            [row.source_id, c.id, row.slug, appendContextNote(current?.context ?? null, `${f.note} (duplicate of #${c.duplicateOf})`)]));
        if (retired.length !== 1) throw changed('A relinked fact was moved by another writer.');
        outcome.deduped.push({ id: c.id, duplicate_of: c.duplicateOf });
      } else {
        outcome.skipped.push({ id: c.id, reason: c.reason });
      }
    }
    const published = page ? await page.apply(tx) : {};
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
    return { ...published, status: 'relinked', slug: row.slug, ...outcome, ...normalized };
  };
  if (!page) return { observedRevision, validate, apply };
  return { ...page, exclusiveSources: page.exclusiveSources,
    ...(intent.explicit && links[0]?.value.visibility === 'private' ? { skipGitEffect: true } : {}), validate, apply };
}

export type RelinkGroupResult =
  | { ok: true; outcome: RelinkGroupOutcome; requestId?: string }
  | { ok: false; reason: 'revision_conflict' | 'fence_malformed' | 'page_file_missing' | 'unfenceable' | 'no_page'; message: string };

/**
 * Admit and wait for one entity page's relink request. Local and trusted
 * only. The request id derives from the run and the pinned facts, so a retry
 * inside one run replays its receipt and a later run never reuses it.
 */
export async function submitRelinkGroup(engine: BrainEngine, config: GBrainConfig, sourceId: string, slug: string,
  intent: RelinkIntent, opts: { residentOnly?: boolean } = {}): Promise<RelinkGroupResult> {
  const { initializeLocalPersistence, requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
  const { authorizeStoredRequest, submissionAuthority } = await import('../persistence/authority.ts');
  const { admitWrite, assertReplayIntent, getWriteRequest, intentDigest } = await import('../persistence/journal.ts');
  const { assertPersistenceAccepting, awaitWrite, writeResponse } = await import('../persistence/service.ts');
  const { resolveFactWriteTarget } = await import('../persistence/fact-write-target.ts');
  const ctx = { engine, sourceId, remote: false as const, config, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  assertPersistenceAccepting(engine);
  if (!opts.residentOnly) await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const operation = intent.explicit ? EXPLICIT_RELINK_OPERATION : RELINK_OPERATION;
  const key = digest(intent.explicit ? { operation, run: intent.run_id } : { sourceId, slug, run: intent.run_id, facts: intent.facts.map(f => [f.id, f.hash]) });
  const requestId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
  const existing = await getWriteRequest(engine, principal, requestId);
  const wait = async (row: WriteRequest) => {
    const result = await awaitWrite(engine, row, config, { waitMs: 60_000, residentOnly: opts.residentOnly });
    if (opts.residentOnly && result.kind === 'read_failed') {
      const error = opError('unavailable', 'The relink was admitted but its current state could not be read.',
        `Read gbrain write-request ${requestId} --json or retry the same saved plan when the database is reachable. Do not make a new plan yet.`,
        { fix: { argv: ['gbrain', 'write-request', requestId, '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Reads the current state of the original relink request without resubmitting it.' } });
      error.requestId = requestId;
      throw error;
    }
    return result.row;
  };
  const callerIntent = intent as unknown as Record<string, unknown>;
  const committed = (row: WriteRequest): RelinkGroupResult => ({ ok: true, outcome: row.outcome as unknown as RelinkGroupOutcome,
    ...(intent.explicit ? { requestId } : {}) });
  if (intent.explicit && existing) {
    await submissionAuthority(ctx, existing.operation, existing.source_id, existing.source_incarnation, existing.slug);
    await authorizeStoredRequest(engine, existing);
    assertReplayIntent(existing, intentDigest({ operation, sourceId, slug, callerIntent }));
    const finished = existing.state === 'committed' ? existing : await wait(existing);
    writeResponse(finished);
    return committed(finished);
  }
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
    "SELECT incarnation, archived, local_path, config->>'kind' AS kind FROM sources WHERE id = $1", [sourceId]);
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
  const authority = await submissionAuthority(ctx, operation, sourceId, source.incarnation, slug);
  if (target.databaseOnlyReason) authority.databaseOnlyReason = target.databaseOnlyReason;
  if (opts.residentOnly && !existing) {
    const { CONSUMER_LIVE_MS, EXPLICIT_RELINK_CAPABILITY } = await import('../persistence/consumer-heartbeat.ts');
    const { hostIdFor } = await import('../persistence/identity.ts');
    const hostId = hostIdFor(engine);
    const [owner] = await engine.executeRaw<{ ready: boolean }>(`SELECT EXISTS (SELECT 1 FROM persistence_consumers
      WHERE host_id=$1::uuid AND kind='serve' AND mode='full' AND NOT restart_required
        AND renewed_at > now()-($2::integer*interval '1 millisecond') AND $3=ANY(capabilities)) AS ready`,
    [hostId, CONSUMER_LIVE_MS, EXPLICIT_RELINK_CAPABILITY]);
    if (!owner?.ready || target.binding && target.binding.owner_host_id !== hostId) {
      throw opError('owner_unavailable', 'Explicit relink needs a compatible running Serve owner.',
        'Start or upgrade Serve on the canonical brain host, then retry the same saved preview. No request was accepted.');
    }
  }
  try {
    const row = existing ?? await admitWrite(engine, {
      principal, operation, sourceId, sourceIncarnation: source.incarnation, slug, pageId: snapshot.page.id,
      requestId, callerIntent, intent: callerIntent, authority,
      brainId: intent.explicit?.brainId,
      worktreeId: target.binding?.worktree_id ?? null, topologyGeneration: target.binding?.topology_generation ?? null,
    });
    const finished = await wait(row);
    writeResponse(finished);
    return committed(finished);
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    if (intent.explicit && error.writeRequest) throw error;
    const message = error.message;
    if (error.canonicalCode === 'invalid_fence' || /fence_malformed/.test(message)) return { ok: false, reason: 'fence_malformed', message };
    if (error.code === 'owner_unavailable') return { ok: false, reason: 'unfenceable', message };
    if (error.code === 'source_changed' && /removed outside/.test(message)) return { ok: false, reason: 'page_file_missing', message };
    if (['revision_conflict', 'page_identity_changed', 'source_changed'].includes(error.code)) return { ok: false, reason: 'revision_conflict', message };
    throw error;
  }
}

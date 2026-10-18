/**
 * Life Chronicle event publication (#5876, E5/E8, C4b/C12).
 *
 * One extraction generation of a depth page (meeting, conversation, calendar
 * page) is published against the immutable snapshot the judge read:
 *
 *   - Every event write re-validates, in its own publication step, that the
 *     depth page still has the judged revision, content hash, source
 *     incarnation and privacy, and that the writer whose revision was decided
 *     still holds the extraction grant. Any change → `superseded`; no model
 *     call or transaction spans the judge.
 *   - Events carry the depth page's effective visibility.
 *   - Ownership is content-addressed: an event is the extractor's while its
 *     live content_hash is one the ledger recorded for this depth page. An
 *     operator-edited event (hash changed) is never overwritten or retired;
 *     an operator-deleted event (deleted without `retired_by`) is never
 *     resurrected.
 *   - Only after the whole generation published, the previous generation's
 *     owned events it did not reproduce are retired (soft-deleted with
 *     `retired_by: life-chronicle`, reversible); a later generation that
 *     produces one again restores it. A failed or superseded run retires
 *     nothing.
 *
 * Managed brains publish through two maintenance intents (database-only);
 * unmanaged brains write directly inside one attributed maintenance
 * transaction per event.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { computeContentHash } from '../ingestion/types.ts';
import { serializeMarkdown } from '../markdown.ts';
import { digest } from '../persistence/digest.ts';
import { authorizeFactsBackstop } from '../persistence/effect-facts.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { effectiveVisibility, type Visibility } from '../search/private-visibility.ts';
import type { ChronicleEventProposal } from './extract-events.ts';
import { resolveChronicleEventSlugs } from './event-identity.ts';
import { declareDerivation, declaredWriteTrust, deriveTrust, derivedMaintenanceTransaction, readDerivationDeclaration } from '../trust/taint.ts';
import { derivedGateConfig, derivedGateInput, timelineRowAllowed } from '../trust/derived-gate.ts';
import { assessTimelineForGate, type WriteGateAssessment } from '../write-gate.ts';
import { recordWriteGateReceipt } from '../write-gate-store.ts';

export const CHRONICLE_RETIRED_BY = 'life-chronicle';
export const CHRONICLE_EVENT_INTENT = 'managed_maintenance_chronicle_event';
export const CHRONICLE_RETIRE_INTENT = 'managed_maintenance_chronicle_retire';
export const CHRONICLE_CAPTURED_VIA = 'life-chronicle:auto';

/** The judged depth page; publication re-checks every field. */
export interface ChronicleDepthPin {
  slug: string;
  pageId: number;
  revision: string;
  contentHash: string;
  incarnation: string;
  visibility: Visibility;
}

export function pinDepth(snapshot: PageSnapshot): ChronicleDepthPin {
  return {
    slug: snapshot.page.slug, pageId: Number(snapshot.page.id), revision: snapshot.revision,
    contentHash: String(snapshot.page.content_hash ?? ''), incarnation: snapshot.sourceIncarnation,
    visibility: effectiveVisibility({ kind: 'page', page: snapshot.page }),
  };
}

/** null while the pin holds; otherwise why the generation is superseded. */
export async function depthPinBroken(tx: BrainEngine, sourceId: string, pin: ChronicleDepthPin,
  decisionRequestId: string | null): Promise<string | null> {
  const current = await tx.readPageSnapshot(pin.slug, { sourceId });
  if (!current) return 'page_missing';
  if (Number(current.page.id) !== pin.pageId || current.revision !== pin.revision
    || String(current.page.content_hash ?? '') !== pin.contentHash || current.sourceIncarnation !== pin.incarnation
    || effectiveVisibility({ kind: 'page', page: current.page }) !== pin.visibility) return 'superseded';
  if (decisionRequestId) {
    const [request] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [decisionRequestId]);
    if (!request) return 'superseded';
    try { await authorizeFactsBackstop(tx, request); }
    catch (error) {
      if (error instanceof OperationError) return 'superseded';
      throw error;
    }
  }
  return null;
}

export interface BuiltChronicleEvent {
  slug: string;
  title: string;
  compiledTruth: string;
  frontmatter: Record<string, unknown>;
  when: string;
  day: string;
  summary: string;
}

/** Event identity is content-addressed on (who, what, depth): a re-run upserts the same page. Same-day collisions are resolved at publication (event-identity.ts). */
export function buildChronicleEvent(ev: ChronicleEventProposal, ctx: {
  depthSlug: string; attendees: string[]; effectiveDate: string | null; tz: string; visibility: Visibility; depthHash: string;
  isoDay: (when: string, tz: string) => string; normalizeKind: (kind: string) => string;
}): BuiltChronicleEvent {
  const who = ev.who.length ? ev.who : ctx.attendees;
  const when = ev.when || ctx.effectiveDate || ctx.isoDay(new Date(0).toISOString(), ctx.tz);
  const day = ctx.isoDay(when, ctx.tz);
  const hash = computeContentHash(`${who.join(',')}|${ev.what}|${ctx.depthSlug}`).slice(0, 8);
  const event = { when, who, what: ev.what, where: ev.where ?? null, kind: ctx.normalizeKind(ev.kind), depth: ctx.depthSlug };
  return {
    slug: `life/events/${day}-${hash}`,
    title: ev.what.slice(0, 120),
    compiledTruth: `${ev.what} — see [[${ctx.depthSlug}]].`,
    frontmatter: { event, event_date: when, captured_via: CHRONICLE_CAPTURED_VIA, visibility: ctx.visibility, chronicle_depth_hash: ctx.depthHash },
    when, day, summary: ev.what,
  };
}

/** Every event content hash the extractor ever wrote for this depth page. */
export async function ownedEventHashes(engine: BrainEngine, sourceId: string, pageId: number): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ hash: string }>(
    'SELECT DISTINCT unnest(event_hashes) AS hash FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2',
    [sourceId, pageId]);
  return new Set(rows.map((r) => r.hash));
}

type TargetVerdict = { write: true; restore: boolean; expectedRevision: string | null } | { write: false; reason: 'operator_deleted' | 'operator_edited' };

function judgeTarget(existing: PageSnapshot | null, owned: Set<string>): TargetVerdict {
  if (!existing) return { write: true, restore: false, expectedRevision: null };
  if (existing.page.deleted_at) {
    return existing.page.frontmatter?.retired_by === CHRONICLE_RETIRED_BY
      ? { write: true, restore: true, expectedRevision: existing.revision }
      : { write: false, reason: 'operator_deleted' };
  }
  return owned.has(String(existing.page.content_hash ?? ''))
    ? { write: true, restore: false, expectedRevision: existing.revision }
    : { write: false, reason: 'operator_edited' };
}

function requestIdFor(value: unknown): string {
  const key = digest(value);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

function supersededError(reason: string): OperationError {
  return opError('revision_conflict', `chronicle_superseded: ${reason}. The depth page, its privacy or its writer grant changed after it was judged; nothing from this generation is published.`,
    'Nothing to do: the newer revision carries its own extraction decision, and the next chronicle cycle judges it.');
}

/** A publication failure that means the judged generation no longer applies. */
export function isSupersession(error: unknown): boolean {
  return error instanceof OperationError
    && ['revision_conflict', 'page_identity_changed', 'source_changed', 'permission_denied', 'page_not_found'].includes(error.code);
}

export interface ChronicleGenerationResult {
  written: Array<{ slug: string; hash: string }>;
  retired: string[];
  protected: Array<{ slug: string; reason: 'operator_deleted' | 'operator_edited' }>;
  superseded?: string;
}

/**
 * Publish one generation (possibly empty) for a pinned depth page and retire
 * the previous generation's owned events it did not reproduce.
 */
export async function publishChronicleGeneration(engine: BrainEngine, opts: {
  sourceId: string; pin: ChronicleDepthPin; events: BuiltChronicleEvent[]; decisionRequestId: string | null;
  maintenance?: MaintenanceAuthority | null; signal?: AbortSignal;
}): Promise<ChronicleGenerationResult> {
  const { sourceId, pin } = opts;
  const maintenance = opts.maintenance === undefined ? await maintenancePreflight(engine, sourceId) : opts.maintenance;
  const owned = await ownedEventHashes(engine, sourceId, pin.pageId);
  const result: ChronicleGenerationResult = { written: [], retired: [], protected: [] };
  const abort = () => { if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } };
  const broken = await depthPinBroken(engine, sourceId, pin, opts.decisionRequestId);
  if (broken) return { ...result, superseded: broken };
  const events = await resolveChronicleEventSlugs(engine, sourceId, opts.events);
  // #5575 I2: the judge read only the depth page, so its events carry that page's tier (capped at agent_written).
  const derivation = await deriveTrust(engine, [{ table: 'pages', id: pin.pageId }], { channel: 'derive:chronicle' });
  const gateCfg = await derivedGateConfig(engine);

  for (const ev of events) {
    abort();
    const existing = await engine.readPageSnapshot(ev.slug, { sourceId, includeDeleted: true });
    const verdict = judgeTarget(existing, owned);
    if (!verdict.write) { result.protected.push({ slug: ev.slug, reason: verdict.reason }); continue; }
    const content = serializeMarkdown(ev.frontmatter, ev.compiledTruth, '', { type: 'event', title: ev.title, tags: [] });
    // #5575 B3: the event's summary lands on the depth page's timeline; a quarantined or rejected one projects nothing.
    const projectionGate = assessTimelineForGate({ summary: ev.summary, source: `life-chronicle:event:${ev.slug}` }, derivedGateInput(derivation.trust), gateCfg);
    const projection = timelineRowAllowed(projectionGate) ? { depth_slug: pin.slug, date: ev.day, summary: ev.summary } : undefined;
    try {
      if (maintenance) {
        const intent = { kind: CHRONICLE_EVENT_INTENT, content, expected_revision: verdict.expectedRevision,
          restore_retired: verdict.restore, depth: pin, decision_request_id: opts.decisionRequestId,
          owned_hashes: [...owned], ...(projection ? { event_projection: projection } : {}), derivation: declareDerivation(derivation.trust, derivation.inputs) };
        await submitDatabaseMaintenanceIntent(engine, maintenance, ev.slug, intent,
          requestIdFor({ writer: maintenance.writer.principal, slug: ev.slug, intent }));
      } else {
        await derivedMaintenanceTransaction(engine, derivation, async (tx) => {
          const reason = await depthPinBroken(tx, sourceId, pin, null);
          if (reason) throw supersededError(reason);
          const again = judgeTarget(await tx.readPageSnapshot(ev.slug, { sourceId, includeDeleted: true }), owned);
          if (!again.write) throw supersededError(again.reason);
          const page = await tx.putPage(ev.slug, { type: 'event', title: ev.title, compiled_truth: ev.compiledTruth,
            frontmatter: { type: 'event', ...ev.frontmatter }, effective_date: safeDate(ev.when) }, { sourceId });
          if (projection) {
            await tx.upsertEventProjection({ depthSlug: pin.slug, eventSlug: ev.slug, date: ev.day, summary: ev.summary, sourceId });
            await recordProjectionFlag(tx, projectionGate, page.id, ev.day, sourceId);
          }
          return { result: undefined, rows: [{ table: 'pages', id: page.id, sourceId }] };
        });
      }
    } catch (error) {
      if (!isSupersession(error)) throw error;
      return { ...result, superseded: 'superseded' };
    }
    const written = await engine.readPageSnapshot(ev.slug, { sourceId });
    if (written?.page.content_hash) {
      result.written.push({ slug: ev.slug, hash: String(written.page.content_hash) });
      owned.add(String(written.page.content_hash));
    }
  }

  const keep = new Set(events.map((e) => e.slug));
  const stale = await engine.executeRaw<{ slug: string; revision: string; content_hash: string }>(
    `SELECT slug, knowledge_revision::text AS revision, content_hash FROM pages
      WHERE source_id=$1 AND type='event' AND deleted_at IS NULL AND frontmatter->'event'->>'depth'=$2
        AND frontmatter->>'captured_via' LIKE 'life-chronicle:%' AND content_hash = ANY($3::text[])
      ORDER BY slug`,
    [sourceId, pin.slug, [...owned]]);
  for (const event of stale) {
    if (keep.has(event.slug)) continue;
    abort();
    try {
      if (maintenance) {
        const intent = { kind: CHRONICLE_RETIRE_INTENT, expected_revision: event.revision, depth: pin,
          decision_request_id: opts.decisionRequestId, owned_hashes: [...owned] };
        await submitDatabaseMaintenanceIntent(engine, maintenance, event.slug, intent,
          requestIdFor({ writer: maintenance.writer.principal, slug: event.slug, intent }));
      } else {
        await maintenanceTransaction(engine, async (tx) => {
          const reason = await depthPinBroken(tx, sourceId, pin, null);
          if (reason) throw supersededError(reason);
          const live = await tx.readPageSnapshot(event.slug, { sourceId });
          if (!live || !owned.has(String(live.page.content_hash ?? ''))) return;
          await tx.softDeletePage(event.slug, { sourceId });
          await stampRetired(tx, sourceId, event.slug);
        });
      }
      result.retired.push(event.slug);
    } catch (error) {
      if (!isSupersession(error)) throw error;
      return { ...result, superseded: 'superseded' };
    }
  }
  return result;
}

async function stampRetired(tx: BrainEngine, sourceId: string, slug: string): Promise<void> {
  await tx.executeRaw(`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
    WHERE source_id=$3 AND slug=$4 AND deleted_at IS NOT NULL`, [CHRONICLE_RETIRED_BY, new Date().toISOString(), sourceId, slug]);
}

function safeDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface ChronicleIntent extends Record<string, unknown> {
  kind: string;
  depth: ChronicleDepthPin;
  decision_request_id: string | null;
  owned_hashes: string[];
  restore_retired?: boolean;
  event_projection?: { depth_slug: string; date: string; summary: string };
}

/** Preparer for the two chronicle maintenance intents; validation re-runs under the publication's page locks. */
export async function prepareChronicleMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as ChronicleIntent | null;
  if (!p || !p.depth || !Array.isArray(p.owned_hashes) || row.authority.remote) {
    throw opError('invalid_params', 'Unsupported Life Chronicle maintenance intent.',
      'Life Chronicle maintenance is submitted only by the chronicle phase on the brain host; let `gbrain dream --phase chronicle` resubmit it rather than replaying this request.');
  }
  const owned = new Set(p.owned_hashes);
  const retire = p.kind === CHRONICLE_RETIRE_INTENT;
  const check = async (tx: BrainEngine) => {
    const reason = await depthPinBroken(tx, row.source_id, p.depth, p.decision_request_id);
    if (reason) throw supersededError(reason);
    const target = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
    if (retire) {
      if (!target || target.page.deleted_at || !owned.has(String(target.page.content_hash ?? ''))) throw supersededError('event_changed');
      return;
    }
    const verdict = judgeTarget(target, owned);
    if (!verdict.write) throw supersededError(verdict.reason);
  };
  await check(engine);
  const operation = retire ? 'delete_page' : 'put_page';
  const intent = row.intent!.expected_revision === null ? { ...row.intent, expected_revision: undefined } : row.intent;
  const prepared = await preparePageMutation(engine, { ...row, operation, intent }, config, undefined, undefined, { allowMissingFile: true });
  return { ...prepared, additionalPageKeys: [...prepared.additionalPageKeys ?? [], { sourceId: row.source_id, slug: p.depth.slug }],
    validate: async (tx) => { await prepared.validate?.(tx); await check(tx); },
    apply: async (tx) => {
      const outcome = await prepared.apply(tx);
      if (retire) {
        if (!prepared.noop) await stampRetired(tx, row.source_id, row.slug);
        return { ...outcome, retired_by: CHRONICLE_RETIRED_BY };
      }
      const projection = p.event_projection;
      if (!projection) return outcome;
      const { projected } = await tx.upsertEventProjection({ depthSlug: projection.depth_slug, eventSlug: row.slug,
        date: projection.date, summary: projection.summary, sourceId: row.source_id });
      const declaration = readDerivationDeclaration(p.derivation);
      if (projected && declaration) {
        const assessment = assessTimelineForGate({ summary: projection.summary, source: `life-chronicle:event:${row.slug}` },
          derivedGateInput(declaredWriteTrust(declaration), row.id), await derivedGateConfig(tx));
        const [event] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [row.source_id, row.slug]);
        if (event) await recordProjectionFlag(tx, assessment, Number(event.id), projection.date, row.source_id, row.id);
      }
      return { ...outcome, event_projected: projected };
    } };
}

/** A flagged event projection's receipt on its timeline row (found by its event page and date). */
async function recordProjectionFlag(tx: BrainEngine, assessment: WriteGateAssessment, eventPageId: number, date: string, sourceId: string, requestId?: string): Promise<void> {
  if (assessment.verdict !== 'flag') return;
  const [entry] = await tx.executeRaw<{ id: number }>('SELECT id FROM timeline_entries WHERE event_page_id=$1 AND date=$2::date', [eventPageId, date]);
  if (entry) await recordWriteGateReceipt(tx, { targetTable: 'timeline_entries', targetId: Number(entry.id), sourceId, assessment, requestId });
}

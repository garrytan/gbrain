/**
 * Life Chronicle ledger (#5876, E1/E3/E6): the write-time decision and the
 * durable record of each page content's extraction. See contract.ts for the
 * columns and reason codes.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { WriteAuthority, WriteRequest } from '../persistence/model.ts';
import { derivedExtractionSkip } from '../persistence/derived-extraction-gate.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import type { BodyStorage } from '../page-body/types.ts';
import { CHRONICLE_ACTIVATED_AT_KEY, autoChronicleSetting, chronicleSettings, type ChronicleSettings } from './config.ts';
import { CHRONICLE_EXTRACTOR_VERSION, type ChronicleLedgerRow, type ChronicleTrigger } from './contract.ts';
import { isChronicleEligible, isChronicleShaped } from './eligibility.ts';
import { chronicleBackstopReceipt, type ChronicleBackstopReceipt, type ChronicleReasonCode, type ChronicleReasonContext } from './reasons.ts';

/** Publications that import page content and therefore carry a decision (C1). */
const DECIDING_OPERATIONS = new Set(['put_page', 'capture', 'edit_page', 'append_page', 'restore_page', 'revert_version']);
const DECIDING_INTENTS = new Set(['managed_sync_import', 'connector_v2_import']);
/** Skip reasons after which an earlier extracted generation of the page is retired (E8). */
export const RETIRE_REASONS = ['not_chronicle_shaped', 'dream_generated', 'too_short'] as const;

export interface ChronicleDecisionPage {
  type: string;
  slug: string;
  /** For a segmented page, its `truth_lead` (the page row has no `compiled_truth`). */
  compiled_truth?: string | null;
  body_storage?: BodyStorage | null;
  body_bytes?: number | null;
  frontmatter?: Record<string, unknown> | null;
  effective_date?: Date | string | null;
  effective_date_source?: string | null;
}

export type ChronicleDecision =
  | { state: 'pending'; reason: null; nextAttemptAt: Date }
  | { state: 'pending'; reason: 'not_yet_happened'; nextAttemptAt: Date }
  | { state: 'skipped'; reason: ChronicleReasonCode | string; nextAttemptAt: null };

/**
 * The automatic-path decision for one revision of a chronicle-shaped page.
 * `authority` is the writer (null for trusted local unmanaged scans). The
 * time rules come from the shared eligibility function; the settle window
 * and the invite end become the row's `next_attempt_at`.
 */
export function decideChronicle(input: {
  page: ChronicleDecisionPage; authority: Pick<WriteAuthority, 'restrictedNamespace' | 'delegated' | 'slugPrefixes' | 'operations'> | null;
  noExtract: boolean; enabled: boolean; settings: Pick<ChronicleSettings, 'recentDays' | 'settleSeconds'>; now: Date;
  /** The stored auto_chronicle word was neither true nor false (reads as off). */
  invalidSetting?: boolean;
}): ChronicleDecision {
  const skip = (reason: string): ChronicleDecision => ({ state: 'skipped', reason, nextAttemptAt: null });
  if (!input.enabled) return skip(input.invalidSetting ? 'auto_chronicle_invalid' : 'auto_chronicle_off');
  if (input.noExtract) return skip('no_extract');
  const confined = input.authority ? derivedExtractionSkip(input.authority) : null;
  if (confined) return skip(confined);
  const { page } = input;
  const eligible = isChronicleEligible({
    type: page.type as never, slug: page.slug, body: page.compiled_truth ?? '',
    dreamGenerated: page.frontmatter?.dream_generated === true,
    effectiveDate: page.effective_date ?? null, effectiveDateSource: page.effective_date_source ?? null,
    frontmatter: page.frontmatter ?? null,
  }, { now: input.now, recentDays: input.settings.recentDays });
  if (!eligible.ok) {
    if ('wait' in eligible) {
      return { state: 'pending', reason: 'not_yet_happened', nextAttemptAt: new Date(eligible.until.getTime() + input.settings.settleSeconds * 1000) };
    }
    return skip(eligible.reason.startsWith('kind:') ? 'not_chronicle_shaped' : eligible.reason);
  }
  return { state: 'pending', reason: null, nextAttemptAt: new Date(input.now.getTime() + input.settings.settleSeconds * 1000) };
}

/**
 * The `chronicle_backstop` receipt for a decision: built by reasons.ts from the one reason table
 * (stored fix Actions, rendered here with this page's source, today's date and the brain's limits).
 */
export function chronicleReceipt(decision: Pick<ChronicleDecision, 'state' | 'reason'>,
  ctx: ChronicleReasonContext & { dailyRemaining?: number }): ChronicleBackstopReceipt | undefined {
  return chronicleBackstopReceipt(decision, ctx);
}

/** Automatic judge calls left in the rolling 24 h window. */
export async function chronicleDailyRemaining(engine: BrainEngine, limit: number): Promise<number> {
  return Math.max(0, limit - await engine.countRecentChronicleReservations());
}

/**
 * E3: take one automatic judge slot immediately before the call. Serialized
 * across every executor (a transaction-scoped advisory lock on the SQL engines,
 * one store write transaction on Rust; engine-sql/chronicle-ledger.ts), so
 * concurrent hosts cannot both take the last slot. false = the limit is used up.
 */
export async function reserveChronicleSlot(engine: BrainEngine, limit: number,
  key: { sourceId: string; pageId: number; contentHash: string }): Promise<boolean> {
  return engine.reserveChronicleJudgeSlot(limit, key);
}

/** Reservations older than the window serve nothing; keep two days for doctor. */
export async function pruneChronicleReservations(engine: BrainEngine): Promise<void> {
  await engine.pruneChronicleReservations();
}

export interface ChronicleRowWrite {
  sourceId: string;
  pageId: number;
  contentHash: string;
  slug: string;
  state: 'pending' | 'skipped';
  reason: string | null;
  trigger: ChronicleTrigger;
  principalKind?: string | null;
  principalId?: string | null;
  requestId?: string | null;
  noExtract?: boolean;
  nextAttemptAt: Date | null;
}

/**
 * Record a decision. An extracted row stays extracted unless a later
 * generation of the page was extracted after it (A→B→A re-extracts A once,
 * E9); a pending or failed backfill row is never overwritten by an
 * automatic decision. A new decision leaves any `--max-usd` campaign
 * (#6199): its stamp is cleared, and only campaign.ts writes one.
 */
export async function upsertChronicleRow(engine: BrainEngine, w: ChronicleRowWrite): Promise<boolean> {
  return engine.upsertChronicleRow({
    sourceId: w.sourceId, pageId: w.pageId, contentHash: w.contentHash, extractorVersion: CHRONICLE_EXTRACTOR_VERSION,
    slug: w.slug, state: w.state, reason: w.reason, trigger: w.trigger,
    principalKind: w.principalKind ?? null, principalId: w.principalId ?? null, requestId: w.requestId ?? null,
    noExtract: w.noExtract === true, nextAttemptAt: w.nextAttemptAt ? w.nextAttemptAt.toISOString() : null,
  });
}

/** Does an extracted generation with events exist for this page (so an ineligible revision must retire it)? */
function hasExtractedEvents(engine: BrainEngine, sourceId: string, pageId: number): Promise<boolean> {
  return engine.hasExtractedEvents(sourceId, pageId);
}

/** Record a skipped decision and schedule retirement of the page's earlier automatic events when it has any. */
async function recordSkip(engine: BrainEngine, base: Omit<ChronicleRowWrite, 'state' | 'reason' | 'nextAttemptAt'>, reason: string): Promise<void> {
  const retire = (RETIRE_REASONS as readonly string[]).includes(reason) && await hasExtractedEvents(engine, base.sourceId, base.pageId);
  await upsertChronicleRow(engine, { ...base, state: 'skipped', reason, nextAttemptAt: retire ? new Date() : null });
}

type DecidingRequest = Pick<WriteRequest, 'id' | 'source_id' | 'slug'> & Partial<Pick<WriteRequest, 'operation' | 'intent' | 'authority' | 'principal_kind' | 'principal_id'>>;

/**
 * E1: inside the publication transaction, record the decision for the
 * published revision and put the receipt hint on the request outcome
 * (`chronicle_backstop`). Pages that are not chronicle-shaped get neither,
 * unless an earlier revision produced events that must now be retired.
 */
export async function recordChronicleDecision(tx: BrainEngine, row: DecidingRequest, snapshot: PageSnapshot | null,
  outcome: Record<string, unknown>): Promise<void> {
  if (!snapshot || snapshot.page.deleted_at || !snapshot.page.content_hash || !row.operation) return;
  const kind = typeof row.intent?.kind === 'string' ? row.intent.kind : null;
  const page = snapshot.page;
  if (!DECIDING_OPERATIONS.has(row.operation) && !(row.operation === 'submit_job' && kind && DECIDING_INTENTS.has(kind))) {
    // #9636: add_link authors no content; it only carries a still-pending automatic decision to the revision it publishes.
    if (row.operation !== 'add_link' || !(await tx.hasPendingAutoChronicleRow(row.source_id, Number(page.id), CHRONICLE_EXTRACTOR_VERSION))) return;
  }
  const base = { sourceId: row.source_id, pageId: Number(page.id), contentHash: String(page.content_hash), slug: page.slug,
    trigger: 'auto' as const, principalKind: row.principal_kind ?? null, principalId: row.principal_id ?? null, requestId: row.id };
  if (!isChronicleShaped(page.type, page.slug)) {
    if (await hasExtractedEvents(tx, base.sourceId, base.pageId)) await recordSkip(tx, base, 'not_chronicle_shaped');
    return;
  }
  const processing = row.intent?.processingOptions as { noExtract?: unknown } | undefined;
  const noExtract = processing?.noExtract === true;
  const [enabledRaw, settings] = await Promise.all([tx.getConfig('auto_chronicle').catch(() => null), chronicleSettings(tx)]);
  // The first decision after the upgrade activates the automatic path; earlier revisions stay history.
  if (!settings.activatedAt) {
    await tx.insertConfigIfAbsent(CHRONICLE_ACTIVATED_AT_KEY, new Date().toISOString());
  }
  const now = new Date();
  const setting = autoChronicleSetting(enabledRaw);
  const decisionPage: ChronicleDecisionPage = isSegmentedPage(page) ? { type: page.type, slug: page.slug, frontmatter: page.frontmatter,
    effective_date: page.effective_date, effective_date_source: page.effective_date_source, body_storage: page.body_storage, body_bytes: page.body_bytes,
    compiled_truth: await tx.readPageTruthLead(Number(page.id)) } : page;
  const decision = decideChronicle({ page: decisionPage, authority: row.authority ?? null, noExtract,
    enabled: setting === 'on', invalidSetting: setting === 'invalid', settings, now });
  const receiptCtx: ChronicleReasonContext = { sourceId: base.sourceId, since: now.toISOString().slice(0, 10),
    dailyLimit: settings.dailyLimit, recentDays: settings.recentDays };
  if (decision.state === 'skipped') await recordSkip(tx, { ...base, noExtract }, String(decision.reason));
  else if (!(await upsertChronicleRow(tx, { ...base, noExtract, state: 'pending', reason: decision.reason, nextAttemptAt: decision.nextAttemptAt }))) {
    // The content's current generation is already extracted (or queued by backfill): say so, not "pending".
    const kept = await readChronicleRow(tx, base);
    if (kept?.state === 'extracted') {
      outcome.chronicle_backstop = chronicleReceipt({ state: 'skipped', reason: 'already_extracted' }, receiptCtx);
      return;
    }
  }
  const dailyRemaining = decision.state === 'pending' && decision.reason === null ? await chronicleDailyRemaining(tx, settings.dailyLimit) : undefined;
  outcome.chronicle_backstop = chronicleReceipt(decision, { ...receiptCtx, dailyRemaining });
}

export async function readChronicleRow(engine: BrainEngine, key: { sourceId: string; pageId: number; contentHash: string }): Promise<ChronicleLedgerRow | null> {
  return engine.readChronicleRow({ sourceId: key.sourceId, pageId: key.pageId, contentHash: key.contentHash, extractorVersion: CHRONICLE_EXTRACTOR_VERSION });
}

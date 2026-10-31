/**
 * Receipted publication of conversation pages' derived facts on a managed
 * brain (wave 9 follow-ups, item 1), batched across pages (Decision 9:
 * batching, no migration).
 *
 * `gbrain extract-conversation-facts` replaces a page's
 * `cli:extract-conversation-facts*` rows with a fresh batch: the facts the
 * model extracted plus the page outcome (EXTRACTION_COMPLETE or
 * EXTRACTION_NOT_APPLICABLE). On a managed brain each page's batch is frozen
 * into a page entry, and one database-only `managed_maintenance_conversation_facts`
 * request carries the entries of up to BATCH_CAPS.pages pages (at most
 * BATCH_CAPS.factPages with extracted facts, at most BATCH_CAPS.bytes of
 * intent), so every row change commits in the same transaction as its
 * receipt while one request id and one receipt reservation cover many pages.
 * The request sits on ANCHOR_SLUG, a slug no page can hold (a dot-led
 * segment), so no single member page's revision gates the whole batch; the
 * member pages' keys are locked with it.
 *
 * Generation identity. A page entry belongs to one logical extraction
 * generation, keyed by the intent protocol, the source incarnation, the page
 * id, its revision and parser-input version token (sidecar bytes included),
 * the extractor version (`CONVERSATION_EXTRACTOR_VERSION`), the selectors
 * (`--since`, `--segment-limit`) and the page's newest extractor row id (so
 * every committed batch, an approved repair or `--force` after a commit
 * starts the next generation). A batch's request id is the digest of its
 * members' (generation, attempt) pairs; an id another write already holds,
 * or a receipt that lost its intent without committing, moves the batch to
 * its members' next attempt (#7516). Before a page's model work the run
 * consults the writer's unsettled and failed batch requests (loaded once per
 * run; compacted ones drop out):
 *   - a member of a still-unsettled batch (a crash after admission) waits for
 *     it and replays its receipt, with zero model calls;
 *   - a member of a batch that failed retryably is resubmitted from the stored
 *     entry in the next batch, still with zero model calls;
 *   - a member of a batch that failed deterministically (validation,
 *     authorization, size), or of MAX_GENERATION_ATTEMPTS failed batches, is
 *     blocked: no model call until the page changes.
 * Under the lock each member is rechecked on its own: a page that was
 * deleted, replaced, or whose revision or version token moved is skipped and
 * reported in the receipt (the next run extracts it again); a page whose rows
 * fail validation is blocked by a durable not-extractable outcome naming the
 * reason. Neither fails the batch. A committed partial entry (no outcome row)
 * is not a completed page.
 *
 * Apply re-pins source, page slug, source prefix and visibility from the
 * request, rechecks authority, page identity, revision and version token,
 * the embedding signature (vectors under another signature are dropped, the
 * rows embedded later like any unembedded fact) and entity merges, allocates
 * row numbers under the page lock, and fails the request when an insert is
 * lost.
 */
import { backgroundPaused, readBackgroundPauseShare } from '../persistence/admission-origin.ts';
import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page } from '../types.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { FrozenExtractedFact } from '../persistence/facts-maintenance.ts';
import type { FactEmbeddingSignature } from './extract.ts';
import { ALL_FACT_KINDS } from '../engine.ts';
import { isTerminal } from '../persistence/model.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { ensureWellFormed } from '../text-safe.ts';
import { readFix } from '../ops/op-fix.ts';
import { authorizeStoredRequest, authorizeWrite } from '../persistence/authority.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { receiptReservation } from '../persistence/receipt-bytes.ts';
import { getWriteRequestById, intentDigest } from '../persistence/journal.ts';
import { journalLimitKey, oneYearCapacity, readJournalLimits } from '../persistence/limits.ts';
import { principalKey } from '../persistence/model.ts';
import { PERSISTENCE_IPC_MAX_BYTES } from '../persistence/ipc.ts';
import { resolveManagedFactsEmbedding } from '../persistence/facts-maintenance.ts';
import { maintenanceCallerPreflight, maintenancePreflight, submitDatabaseMaintenanceIntent, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { loadConfig } from '../config.ts';
import { waitForWrite } from '../persistence/service.ts';
import { catalogueError } from '../error-catalogue.ts';
import { AUDIT_ROW_SOURCES, CONVERSATION_EXTRACTOR_VERSION, NON_EXTRACTABLE_AUDIT_SOURCE, outcomeMarkerSql, TERMINAL_AUDIT_SOURCE, stampExtractorVersion } from './audit-sources.ts';
import { ALLOWED_TYPES, pageTypesForAllowed, type AllowedType } from './conversation-types.ts';
import { withWriteTrust } from '../persistence/context.ts';
import { conversationDerivation } from '../persistence/derived-facts.ts';
import { RELINKED_DERIVED_ROW, inheritRelinkedEntities } from './conversation-relink-carry.ts';
import { recordReextractMemo } from './conversation-memo.ts';
import { tightenToPage } from './visibility.ts';
import { recordTaintEdges } from '../trust/taint.ts';
import { applyGateDecision, derivedGateConfig, derivedGateInput } from '../trust/derived-gate.ts';
import { decideFactWrite, recordFlaggedRow } from '../write-gate-store.ts';
import { sourceWindowKey, type SourceWindow } from '../page-body/derivations.ts';
import { findCaptureDuplicate } from './capture-dedup.ts';

export const CONVERSATION_FACTS_INTENT = 'managed_maintenance_conversation_facts';
export const CONVERSATION_FACTS_PROTOCOL = 1;
export const CONVERSATION_FACTS_SOURCE_PREFIX = 'cli:extract-conversation-facts';
/** The request slug of every conversation-facts batch: a dot-led segment, which no page slug may have. */
export const ANCHOR_SLUG = '.maintenance/conversation-facts';
export const MAX_GENERATION_ATTEMPTS = 3;
/** Admission stops once the principal's outstanding requests, reserved receipt bytes or request ids reach this share of their limit. */
export const OUTSTANDING_ADMISSION_SHARE = 0.8;
/** Pages per batch request: at most `pages`, at most `factPages` carrying extracted facts, at most `bytes` of intent. */
export const DEFAULT_BATCH_CAPS = Object.freeze({ pages: 25, factPages: 10, bytes: 8 * 1024 * 1024 });
let batchCaps: { pages: number; factPages: number; bytes: number } = { ...DEFAULT_BATCH_CAPS };
/** Test seam: smaller batch caps (null restores the defaults). Returns the restore function. */
export function __setConversationBatchCapsForTests(caps: Partial<{ pages: number; factPages: number; bytes: number }> | null): () => void {
  const previous = batchCaps;
  batchCaps = caps ? { ...DEFAULT_BATCH_CAPS, ...caps } : { ...DEFAULT_BATCH_CAPS };
  return () => { batchCaps = previous; };
}
/** Facts per segment the extractor returns at most (extractFactsFromTurn's default maxFactsPerTurn). */
const MAX_FACTS_PER_SEGMENT = 10;
/** Upper bound for one frozen row without its vector: claim, context, provenance and JSON overhead. */
const ROW_BYTES = 4096;
/** One embedding dimension as JSON text ("-0.012345678901234567,"). */
const DIMENSION_BYTES = 24;

/**
 * Request error codes that fail the same way on every retry. `invalid_params`
 * is not one (#6500): the envelope validator refuses a batch that names a page
 * twice, which is the run's fault, never a member's, so the stored entries
 * resubmit (de-duplicated) and MAX_GENERATION_ATTEMPTS bounds a genuinely
 * malformed envelope.
 */
const DETERMINISTIC_CODES = new Set(['permission_denied', 'request_too_large', 'payload_too_large']);
/** Retryable codes whose stored entries are stale: the next attempt extracts again. */
const REEXTRACT_CODES = new Set(['embedding_configuration', 'revision_conflict', 'page_identity_changed', 'page_not_found']);
const OUTCOME_SOURCES = new Set([TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE]);

export type ConversationFactRow = NewFact & { row_num: number; source_markdown_slug: string };
/**
 * What a run saw of a page (#7013): every segment in scope (`full`), only the segments after `--since` (`window`),
 * or fewer segments than in scope (`partial`: a `--segment-limit` cut, a page that changed during the run).
 */
export type ConversationScope = 'full' | 'window' | 'partial';
const SCOPES: ReadonlySet<string> = new Set<ConversationScope>(['full', 'window', 'partial']);
/** A frozen row: no source, page or row number (the request pins them) and no visibility (one per entry). */
export type FrozenConversationFact = Omit<FrozenExtractedFact, 'visibility' | 'entity_inferred'>;

/** One page's frozen batch inside a batch request. */
export interface ConversationPageEntry {
  slug: string;
  page_id: number;
  expected_revision: string;
  version_token: string;
  extractor_version: number;
  generation: string;
  attempt: number;
  selectors: { since: string | null; segment_limit: number };
  /** True when the entry carries the page outcome (EXTRACTION_COMPLETE / EXTRACTION_NOT_APPLICABLE). */
  complete: boolean;
  /** What the run saw of the page (#7013); absent on entries frozen before it (`applyEntry` derives it from the outcome and selectors). */
  scope?: ConversationScope;
  /** The checkpoint end of the newest extracted segment, echoed in the receipt. */
  newest_end: string | null;
  visibility: 'private' | 'world';
  embedding: FactEmbeddingSignature | null;
  rows: FrozenConversationFact[];
}

export interface ConversationFactsIntent extends Record<string, unknown> {
  kind: typeof CONVERSATION_FACTS_INTENT;
  protocol: number;
  expected_revision: null;
  pages: ConversationPageEntry[];
}

/** One member's result in a committed batch receipt. */
export interface ConversationPageResult {
  slug: string;
  generation: string;
  status: 'committed' | 'skipped' | 'blocked';
  reason?: string;
  deleted: number;
  facts_inserted: number;
  /** #7438: extracted claims left out because they match a purge tombstone. */
  facts_skipped_purged?: number;
  page_outcome: 'complete' | 'non_extractable' | null;
  newest_end: string | null;
}

export interface Generation { key: string; revision: string; pageId: number }

const receiptFix = (requestId: string) => readFix('Reads the conversation facts request\'s durable receipt: its state, outcome and recorded error, read-only.',
  { argv: ['gbrain', 'write-request', '--', requestId] });

/** The page's generation as it is now; throws `revision_conflict` when it moved since the caller read it. */
export async function conversationGeneration(engine: BrainEngine, authority: MaintenanceAuthority,
  input: { slug: string; page: Page; versionToken: string; since: string | null; segmentLimit: number }): Promise<Generation> {
  const sourceId = authority.writer.sourceId;
  const snapshot = await engine.readPageSnapshot(input.slug, { sourceId });
  if (!snapshot || snapshot.page.id !== input.page.id || snapshot.page.knowledge_revision !== input.page.knowledge_revision) {
    throw opError('revision_conflict', 'The conversation page changed before extraction started; nothing was submitted.',
      `Page ${input.slug} in source ${sourceId} changed or was replaced after it was read, so no model work ran for it. The next run extracts the current page.`);
  }
  const [base] = await engine.executeRaw<{ id: number | string | null }>(
    `SELECT max(id) AS id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%'`,
    [sourceId, input.slug]);
  const key = digest(['conversation-facts', CONVERSATION_FACTS_PROTOCOL, authority.writer.sourceIncarnation, snapshot.page.id,
    snapshot.revision, input.versionToken, CONVERSATION_EXTRACTOR_VERSION, input.since, input.segmentLimit,
    base?.id == null ? null : Number(base.id)]);
  return { key, revision: snapshot.revision, pageId: snapshot.page.id };
}

function batchRequestId(sourceIncarnation: string, pages: ReadonlyArray<Pick<ConversationPageEntry, 'generation' | 'attempt'>>): string {
  const h = digest(['conversation-facts-batch-v1', sourceIncarnation, pages.map(p => `${p.generation}:${p.attempt}`).sort()]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * #7516: the batch at the first attempt, from its members' own upward, whose request id is unspent: unused, or used by
 * this very batch (a replay) whose receipt still holds its intent or committed. A receipt without its intent (a
 * purged_content refusal the journal redacts, retention compaction) takes its members' attempt history with it, so
 * startManagedPage can derive an attempt whose id admission would refuse as idempotency_conflict or answer with the
 * compacted failure, on every run. Each step raises every member's attempt by one, and the journal's rows are finite.
 */
async function unspentBatch(engine: BrainEngine, authority: MaintenanceAuthority, pages: ConversationPageEntry[]): Promise<{ intent: ConversationFactsIntent; requestId: string }> {
  const { principal, sourceId, sourceIncarnation } = authority.writer;
  for (let raise = 0; ; raise++) {
    const members = pages.map(entry => ({ ...entry, attempt: entry.attempt + raise }));
    const intent: ConversationFactsIntent = { kind: CONVERSATION_FACTS_INTENT, protocol: CONVERSATION_FACTS_PROTOCOL, expected_revision: null, pages: members };
    const requestId = batchRequestId(sourceIncarnation, members);
    const [spent] = await engine.executeRaw<{ request_id: string }>(`SELECT request_id::text AS request_id FROM persistence_requests
      WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid AND (digest<>$4 OR (compacted AND state<>'committed'))`,
    [principal.kind, principal.id, requestId, intentDigest({ operation: 'submit_job', sourceId, slug: ANCHOR_SLUG, callerIntent: intent })]);
    if (!spent) return { intent, requestId };
    log(`batch request ${spent.request_id} already belongs to another or a compacted write; publishing the batch at its members' next attempt`);
  }
}

/** What this writer's unsettled and failed batch requests say about one generation. */
interface GenerationHistory {
  /** An admitted batch that has not settled yet. */
  pending: { id: string; attempt: number } | null;
  /**
   * Failed batches holding this generation: their row id, error code, the member's attempt, and whether the batch held
   * this generation alone (GBRA-130 A-51: only then is a deterministic code this page's own).
   */
  failed: Array<{ id: string; requestId: string; code: string; attempt: number; alone: boolean }>;
}

/**
 * The writer's unsettled and failed (not yet compacted) conversation-facts
 * batches of this source, by member generation. One read per run: the
 * request slug is the anchor, so only these batches are read, and only their
 * members' keys leave the database.
 */
export async function loadGenerationIndex(engine: BrainEngine, authority: MaintenanceAuthority): Promise<Map<string, GenerationHistory>> {
  const rows = await engine.executeRaw<{ id: string; request_id: string; state: string; error_code: string | null; members: Array<{ generation: string; attempt: number }> | null }>(
    `SELECT r.id::text AS id, r.request_id::text AS request_id, r.state, r.error_code,
            (SELECT jsonb_agg(jsonb_build_object('generation', p->>'generation', 'attempt', (p->>'attempt')::int)) FROM jsonb_array_elements(r.intent->'pages') p) AS members
       FROM persistence_requests r
      WHERE r.principal_kind=$1 AND r.principal_id=$2 AND r.source_id=$3 AND r.slug=$4 AND r.operation='submit_job'
        AND r.state<>'committed' AND NOT r.compacted
      ORDER BY r.sequence`,
  [authority.writer.principal.kind, authority.writer.principal.id, authority.writer.sourceId, ANCHOR_SLUG]);
  const index = new Map<string, GenerationHistory>();
  for (const row of rows) {
    // One history entry per DISTINCT request (#6500): an envelope that listed a
    // generation several times failed once, not once per member, so it counts
    // once toward MAX_GENERATION_ATTEMPTS; the member attempt is the largest.
    const attempts = new Map<string, number>();
    for (const member of row.members ?? []) attempts.set(member.generation, Math.max(attempts.get(member.generation) ?? 0, Number(member.attempt)));
    for (const [generation, attempt] of attempts) {
      const history = index.get(generation) ?? { pending: null, failed: [] };
      if (!isTerminal(row as unknown as WriteRequest)) history.pending = { id: row.id, attempt };
      else history.failed.push({ id: row.id, requestId: row.request_id, code: row.error_code ?? row.state, attempt, alone: attempts.size === 1 });
      index.set(generation, history);
    }
  }
  return index;
}

/** The stored entry of `generation` in the failed batch `id`, for a resubmission without model work. */
async function storedEntry(engine: BrainEngine, id: string, generation: string): Promise<ConversationPageEntry | null> {
  const [row] = await engine.executeRaw<{ entry: ConversationPageEntry | null }>(`SELECT p AS entry FROM persistence_requests r, jsonb_array_elements(r.intent->'pages') p
    WHERE r.id=$1::uuid AND NOT r.compacted AND p->>'generation'=$2 LIMIT 1`, [id, generation]);
  return row?.entry && Array.isArray(row.entry.rows) ? row.entry : null;
}
/** The largest frozen batch `segments` segments can produce, in intent bytes. */
export function estimateConversationIntentBytes(segments: number, embedding: FactEmbeddingSignature | null): number {
  const perRow = ROW_BYTES + (embedding ? embedding.dimensions * DIMENSION_BYTES : 0);
  return 16_384 + (segments * MAX_FACTS_PER_SEGMENT + 1) * perRow;
}

/** The byte ceiling one conversation facts request may carry on this brain. */
export async function conversationIntentByteLimit(engine: BrainEngine): Promise<number> {
  const limits = await readJournalLimits(engine);
  return Math.min(limits.principalIntentBytes, limits.brainIntentBytes, PERSISTENCE_IPC_MAX_BYTES);
}

/**
 * Before model work: stop admitting once this writer's outstanding requests
 * pass OUTSTANDING_ADMISSION_SHARE of their limit (`maintenance_backpressure`,
 * retryable: they settle), or its reserved receipt bytes or permanent request
 * ids would pass the background pause line (`write_capacity_backpressure`,
 * host-only, A5): the writer is the local CLI principal the user's own CLI
 * writes share, so the rest stays theirs. Reserved receipt bytes free only
 * when receipts compact, request ids never. `needed` is the run's planned
 * batch requests up front, 1 before each new batch.
 */
export async function assertConversationAdmissionHeadroom(engine: BrainEngine, authority: MaintenanceAuthority, needed = 1): Promise<void> {
  const limits = await readJournalLimits(engine);
  const [counter] = await engine.executeRaw<{ outstanding_count: number | string; terminal_bytes: number | string; lifetime_ids: number | string }>(
    'SELECT outstanding_count, terminal_bytes, lifetime_ids FROM persistence_counters WHERE key=$1', [principalKey(authority.writer.principal)]);
  const sourceId = authority.writer.sourceId;
  const outstanding = Number(counter?.outstanding_count ?? 0);
  if (outstanding >= Math.max(1, Math.floor(limits.principalOutstanding * OUTSTANDING_ADMISSION_SHARE))) {
    throw catalogueError('maintenance_backpressure',
      `Conversation fact extraction stopped admitting: ${outstanding} of this writer's ${limits.principalOutstanding} outstanding requests are still pending.`,
      `Let the pending requests settle (gbrain sources writer status --source ${sourceId} --json shows them; a resident gbrain serve or the next CLI run publishes them), then rerun the same command. Pages already published keep their facts.`);
  }
  // #6696 (A5): the cumulative caps follow the background pause, with the host-only, resource-specific fix: waiting frees no request id.
  const pause = await readBackgroundPauseShare(engine);
  const reservation = receiptReservation({ authority: authority.writer });
  const key = principalKey(authority.writer.principal);
  for (const r of [
    { resource: 'terminal_bytes' as const, setting: 'principalTerminalBytes' as const, used: Number(counter?.terminal_bytes ?? 0), per: reservation },
    { resource: 'lifetime_ids' as const, setting: 'principalLifetimeIds' as const, used: Number(counter?.lifetime_ids ?? 0), per: 1 },
  ]) {
    const limit = limits[r.setting];
    const ceiling = Math.floor(limit * pause);
    if (r.used + needed * r.per <= ceiling) continue;
    const room = Math.max(0, Math.floor((ceiling - r.used) / r.per)) * batchCaps.factPages;
    throw backgroundPaused(key, r.resource, r.used, limit, pause, journalLimitKey(r.setting),
      await oneYearCapacity(engine, key, r.resource === 'lifetime_ids' ? 'LifetimeIds' : 'TerminalBytes', r.used, limit), {
        what: `Conversation fact extraction stopped before admitting ${needed > 1 ? `${needed} planned` : 'the next'} request(s)`,
        alternative: room > 0 ? `A smaller batch fits: gbrain extract-conversation-facts --source-id ${authority.writer.sourceId} --limit ${room}.` : undefined });
  }
}

/**
 * The batch requests a run plans: its pages (the named pages, or every page
 * of the conversation types, `opts.types` else all, that has no active
 * outcome yet; `--force`: every such page; capped by `--limit`), counted as
 * fact pages, BATCH_CAPS.factPages per request.
 */
async function plannedAdmissions(engine: BrainEngine, sourceId: string,
  opts: { slugs?: string[]; slug?: string; limit?: number; force?: boolean; types?: readonly AllowedType[] }): Promise<number> {
  const requests = (pages: number) => Math.max(1, Math.ceil(pages / batchCaps.factPages));
  if (opts.slugs) return requests(opts.slugs.length);
  if (opts.slug) return 1;
  const [row] = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM pages p
    WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.type=ANY($2::text[])
      AND ($3::boolean OR NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_id=p.source_id AND f.source_markdown_slug=p.slug
        AND f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%' AND f.source IN ($4,$5) AND f.expired_at IS NULL))`,
  [sourceId, pageTypesForAllowed(opts.types ?? ALLOWED_TYPES), opts.force === true, TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE]);
  const backlog = Number(row?.n ?? 0);
  return requests(opts.limit ? Math.min(opts.limit, backlog) : backlog);
}

function freezeRow(row: ConversationFactRow): FrozenConversationFact {
  return {
    fact: row.fact, kind: row.kind ?? 'fact', entity_slug: row.entity_slug ?? null, context: row.context ?? null,
    valid_from: (row.valid_from ?? new Date()).toISOString(), valid_until: row.valid_until ? row.valid_until.toISOString() : null,
    source: row.source, source_session: row.source_session ?? null, confidence: row.confidence ?? 1.0,
    notability: row.notability ?? 'medium', embedding: row.embedding ? Array.from(row.embedding) : null,
    embedding_model: row.embedding ? row.embedding_model ?? null : null,
    claim_metric: row.claim_metric ?? null, claim_value: row.claim_value ?? null, claim_unit: row.claim_unit ?? null,
    claim_period: row.claim_period ?? null, event_type: row.event_type ?? null, attributed_to: row.attributed_to ?? null,
  };
}


/** Freezes one page's rows into its entry for one generation attempt. */
export async function buildConversationPage(engine: BrainEngine, config: GBrainConfig,
  input: { slug: string; generation: Generation; attempt: number; versionToken: string; since: string | null; segmentLimit: number; scope?: ConversationScope },
  rows: ConversationFactRow[], opts: { newestEnd: string | null; visibility: 'private' | 'world' }): Promise<ConversationPageEntry> {
  // Vectors freeze only under the brain's current facts embedding signature; any other
  // vector is dropped and its row is embedded later, as an unembedded fact is.
  const signature = rows.some(row => row.embedding) ? await resolveManagedFactsEmbedding(engine, config) : null;
  const keep = (row: ConversationFactRow) => !!signature && !!row.embedding && row.embedding.length === signature.dimensions
    && (!row.embedding_model || row.embedding_model === signature.model);
  return {
    slug: input.slug, page_id: input.generation.pageId, expected_revision: input.generation.revision, version_token: input.versionToken,
    extractor_version: CONVERSATION_EXTRACTOR_VERSION, generation: input.generation.key, attempt: input.attempt,
    selectors: { since: input.since, segment_limit: input.segmentLimit }, complete: rows.some(row => OUTCOME_SOURCES.has(row.source)), scope: input.scope,
    newest_end: opts.newestEnd, visibility: opts.visibility, embedding: signature,
    rows: rows.map(row => freezeRow(keep(row) ? { ...row, embedding_model: signature!.model } : { ...row, embedding: null })),
  };
}

/**
 * Submits one batch request carrying `pages` and returns its committed
 * receipt (`pages`: one ConversationPageResult per member). A request still
 * pending after the job's wait throws `write_pending`.
 */
export async function submitConversationPages(engine: BrainEngine, authority: MaintenanceAuthority, pages: ConversationPageEntry[]): Promise<Record<string, unknown>> {
  const { intent, requestId } = await unspentBatch(engine, authority, pages);
  const limit = await conversationIntentByteLimit(engine);
  const bytes = jsonBytes(intent);
  if (bytes > limit) {
    throw opError('request_too_large', 'The frozen fact batch exceeds the request size limit; the pages\' prior facts were kept.',
      `The batch of ${pages.map(p => p.slug).join(', ')} is ${bytes} bytes, over the ${limit}-byte limit for one request, so nothing was submitted. Narrow the run with --segment-limit, or raise persistence.limits.principal_intent_bytes (the user's call).`);
  }
  return submitDatabaseMaintenanceIntent(engine, authority, ANCHOR_SLUG, intent, requestId);
}

function invalid(row: WriteRequest, cause: string): OperationError {
  return opError('invalid_params', 'The conversation facts request is malformed.',
    `Request ${row.request_id} in source ${row.source_id} ${cause}, so nothing changed. Run gbrain extract-conversation-facts --source-id ${row.source_id} again; its pages submit fresh batches.`,
    { fix: receiptFix(row.request_id) });
}

/** The batch envelope; a malformed envelope fails the whole request (deterministic). */
function validateIntent(row: WriteRequest): ConversationFactsIntent {
  const p = row.intent as ConversationFactsIntent | null;
  if (!p || p.kind !== CONVERSATION_FACTS_INTENT || p.protocol !== CONVERSATION_FACTS_PROTOCOL) throw invalid(row, 'carries a protocol this gbrain version does not publish (likely queued by another release)');
  if (row.slug !== ANCHOR_SLUG || row.page_id !== null || !Array.isArray(p.pages) || !p.pages.length) throw invalid(row, 'does not carry a batch of pages');
  const slugs = p.pages.map(entry => entry?.slug);
  if (slugs.some(slug => typeof slug !== 'string' || !slug || slug === ANCHOR_SLUG) || new Set(slugs).size !== slugs.length) throw invalid(row, 'names a page twice or names no page');
  return p;
}

/** Why one member's frozen rows cannot be published, or null when they can. Deterministic: a retry fails the same way. */
function entryProblem(entry: ConversationPageEntry): string | null {
  if (!Array.isArray(entry.rows) || typeof entry.version_token !== 'string' || typeof entry.generation !== 'string' || !Number.isSafeInteger(Number(entry.page_id))) {
    return 'the entry does not name its page, version and rows';
  }
  if (entry.visibility !== 'private' && entry.visibility !== 'world') return 'it names an unknown fact visibility';
  if (entry.scope !== undefined && !SCOPES.has(entry.scope)) return 'it names an unknown extraction scope';
  const outcomes = entry.rows.filter(fact => OUTCOME_SOURCES.has(fact.source));
  if (outcomes.length !== (entry.complete ? 1 : 0)) return entry.complete ? 'it does not carry exactly one page outcome' : 'it carries a page outcome in a partial batch';
  for (const fact of entry.rows) {
    if (typeof fact.fact !== 'string' || !fact.fact.trim() || typeof fact.source !== 'string' || !fact.source.startsWith(CONVERSATION_FACTS_SOURCE_PREFIX)
      || !ALL_FACT_KINDS.includes((fact.kind ?? 'fact') as never) || (fact.source_session != null && !String(fact.source_session).startsWith(CONVERSATION_FACTS_SOURCE_PREFIX))
      || Number.isNaN(Date.parse(fact.valid_from)) || (fact.valid_until != null && Number.isNaN(Date.parse(fact.valid_until)))) {
      return 'a row falls outside the conversation extractor\'s provenance or fact kinds';
    }
    if (OUTCOME_SOURCES.has(fact.source) && fact.source_session !== `${fact.source}:${entry.slug}:${entry.version_token}`) return 'it carries an outcome for another page version';
    if (fact.embedding && (!entry.embedding || fact.embedding.length !== entry.embedding.dimensions || !fact.embedding.every(Number.isFinite))) {
      return 'a vector does not match its embedding signature';
    }
  }
  return null;
}
/** Canonical slugs for entity slugs that became aliases of a live page since extraction. */
async function mergedEntities(tx: BrainEngine, sourceId: string, slugs: string[]): Promise<Map<string, string>> {
  if (!slugs.length) return new Map();
  const rows = await tx.executeRaw<{ alias_slug: string; canonical_slug: string }>(`SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a
    WHERE a.source_id=$1 AND a.alias_slug=ANY($2::text[])
      AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)`, [sourceId, [...new Set(slugs)]]);
  return new Map(rows.map(row => [row.alias_slug, row.canonical_slug]));
}

type UnnumberedFact = Omit<ConversationFactRow, 'row_num' | 'source_markdown_slug'>;

/**
 * A segmented page's incremental publication (wave-b spec 8.2, PR 4): `windows[i]` anchors `rows[i]` (facts.source_window;
 * null for an outcome row). Facts are deleted only by exact window key: `replace` (windows extracted again: their prior
 * facts give way to the new rows) and the destination of a move (the reused facts stand for it); a fully settled page
 * also passes `live`, and every conversation fact whose window key is not in it (and every unanchored one, from older
 * full-pass runs) is cleared. Any other publication only adds and replaces.
 */
export interface ConversationSegmentsPublication {
  windows: ReadonlyArray<SourceWindow | null>;
  /** Facts re-anchored, not re-extracted (ids unchanged): the same rendered window under the same context has another key now. */
  moves: ReadonlyArray<{ from: string; to: SourceWindow }>;
  replace: readonly string[];
  live: readonly string[] | null;
}

const STAMP_BATCH_ROWS = 1000;
const WINDOW_KEY_SQL = `(f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha')`;

/**
 * Re-anchors the page's extractor facts of each `from` window key to its `to` window (ids unchanged) in one statement, so
 * a chain of moves among windows of the same text applies at once; the facts a destination key held beforehand (another
 * context's, or left by an earlier run) are cleared first, so a key never holds two batches.
 */
async function moveSourceWindows(tx: BrainEngine, sourceId: string, slug: string, moves: ConversationSegmentsPublication['moves']): Promise<number> {
  if (!moves.length) return 0;
  const sources = new Set(moves.map(m => m.from));
  const displaced = moves.map(m => sourceWindowKey(m.to)).filter(key => !sources.has(key));
  const cleared = displaced.length ? await clearConversationFacts(tx, sourceId, slug, { keys: displaced, keep: false, unanchored: false }) : 0;
  await tx.executeRaw(`UPDATE facts f SET source_window = r.w FROM jsonb_to_recordset($3::text::jsonb) AS r(k text, w jsonb)
    WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%' AND ${WINDOW_KEY_SQL} = r.k`,
  [sourceId, slug, JSON.stringify(moves.map(m => ({ k: m.from, w: m.to })))]);
  return cleared;
}

/** Anchors freshly inserted facts to their windows, in bounded batches; one JSON bind per batch, so JSONB stays an object. */
async function stampSourceWindows(tx: BrainEngine, ids: readonly number[], windows: ReadonlyArray<SourceWindow | null>): Promise<void> {
  const pairs = ids.flatMap((id, i) => windows[i] ? [{ id, w: windows[i] }] : []);
  for (let i = 0; i < pairs.length; i += STAMP_BATCH_ROWS) {
    await tx.executeRaw(`UPDATE facts f SET source_window = r.w FROM jsonb_to_recordset($1::text::jsonb) AS r(id bigint, w jsonb) WHERE f.id = r.id`,
      [JSON.stringify(pairs.slice(i, i + STAMP_BATCH_ROWS))]);
  }
}

/**
 * One page's extractor rows published under its lock, shared by the managed
 * apply and the unmanaged writer. Fact rows pass the write gate at the page's
 * derived tier (#5575 I2/B3); outcome rows are not gated. #7013: only a
 * complete replacement (`full` scope, at least one fact, none held or
 * rejected by the gate) retires the prior batch (`replaceConversationFacts`),
 * or any replacement of a page with no active extractor facts. Otherwise the
 * prior facts stay: the outcome replaces the page's prior outcome rows, so
 * the page is not paid for again, a `window` run's facts are added beside
 * the prior ones, and a partial run's facts are not published over them.
 * #7043: a fact an active row of the source already states is not stored
 * again (the capture lane's fingerprint, entity and visibility rule with no
 * time bound); the page's own rows a replacement clears do not count.
 */
export async function publishConversationFacts(tx: BrainEngine, sourceId: string, slug: string, rows: UnnumberedFact[],
  opts: { scope: ConversationScope; requestId?: string; segments?: ConversationSegmentsPublication }): Promise<{ deleted: number; facts_inserted: number; duplicates_skipped: number; purged_skipped: number }> {
  const derivation = await conversationDerivation(tx, sourceId, slug);
  const cfg = await derivedGateConfig(tx);
  const gated = rows.map((row, index) => ({ row, index, decision: OUTCOME_SOURCES.has(row.source) ? null : decideFactWrite(row,
    { sourceId, slug, payload: { ...row, embedding: null }, input: derivedGateInput(derivation.trust, opts.requestId), cfg }) }));
  for (const { decision } of gated) if (decision && decision.action !== 'insert') await applyGateDecision(tx, decision, { table: 'facts', sourceId }, async () => null);
  const kept = gated.filter(({ decision }) => decision?.action !== 'hold' && decision?.action !== 'reject');
  const [active] = await tx.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2
    AND f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%' AND f.expired_at IS NULL AND NOT (f.source = ANY($3::text[]))`, [sourceId, slug, [...AUDIT_ROW_SOURCES]]);
  const segments = opts.segments;
  const retire = !segments && (!Number(active?.n ?? 0) || (opts.scope === 'full' && kept.length === rows.length && kept.some(({ row }) => !OUTCOME_SOURCES.has(row.source))));
  // A segmented page's windowed publication clears or keeps its own rows window by window, so the page's own rows never count as duplicates.
  const scope = { engine: tx, sourceId, lane: CONVERSATION_FACTS_SOURCE_PREFIX, sessionId: null, anchor: null, ...(retire || segments ? { replacingPage: slug } : {}) };
  const published: typeof kept = [];
  let duplicates = 0;
  for (const entry of retire || opts.scope === 'window' || segments ? kept : kept.filter(({ row }) => OUTCOME_SOURCES.has(row.source))) {
    const { row } = entry;
    if (OUTCOME_SOURCES.has(row.source) || !await findCaptureDuplicate(scope, { fact: row.fact, entitySlug: row.entity_slug ?? null,
      visibility: row.visibility ?? 'private', attributedTo: row.attributed_to ?? null })) published.push(entry);
    else duplicates++;
  }
  const { deleted, ids, purged } = await withWriteTrust(tx, derivation.trust, async () => {
    if (retire) return replaceConversationFacts(tx, sourceId, slug, published.map(({ row }) => row));
    let retiredWindows = 0;
    if (segments) {
      retiredWindows += await moveSourceWindows(tx, sourceId, slug, segments.moves);
      if (segments.replace.length) retiredWindows += await clearConversationFacts(tx, sourceId, slug, { keys: segments.replace, keep: false, unanchored: false });
      if (segments.live) retiredWindows += await clearConversationFacts(tx, sourceId, slug, { keys: segments.live, keep: true, unanchored: true });
    }
    const outcomes = published.some(({ row }) => OUTCOME_SOURCES.has(row.source)) ? await tx.executeRaw<{ id: number }>(`DELETE FROM facts
      WHERE source_id=$1 AND source_markdown_slug=$2 AND source = ANY($3::text[]) RETURNING id`, [sourceId, slug, [...AUDIT_ROW_SOURCES]]) : [];
    return { deleted: retiredWindows + outcomes.length, ...await insertConversationFacts(tx, sourceId, slug, published.map(({ row }) => row)) };
  });
  const stored = published.filter((_, i) => !purged.has(i));
  if (segments) await stampSourceWindows(tx, ids, stored.map(({ index }) => segments.windows[index] ?? null));
  for (const [i, id] of ids.entries()) {
    await recordTaintEdges(tx, { table: 'facts', id, sourceId }, derivation.inputs);
    const decision = stored[i]?.decision;
    if (decision && ids.length === stored.length) await recordFlaggedRow(tx, decision, { table: 'facts', id, sourceId });
  }
  if (stored.some(({ row }) => row.source === TERMINAL_AUDIT_SOURCE)) await recordReextractMemo(tx, sourceId, slug); // #6764
  return { deleted, facts_inserted: stored.filter(({ row }) => !OUTCOME_SOURCES.has(row.source)).length, duplicates_skipped: duplicates, purged_skipped: purged.size };
}

/**
 * The page's replacement under its lock: deletes the prior extractor rows
 * and inserts `rows` numbered above every remaining fact row of the page.
 * Callers publish through `publishConversationFacts`, which decides whether
 * the prior batch may be retired.
 */
export async function replaceConversationFacts(tx: BrainEngine, sourceId: string, slug: string,
  rows: UnnumberedFact[]): Promise<{ deleted: number; inserted: number; ids: number[]; purged: Set<number> }> {
  const deleted = await clearConversationFacts(tx, sourceId, slug);
  return { deleted, ...await insertConversationFacts(tx, sourceId, slug, rows) };
}

/**
 * Inserts `rows` numbered above every fact row of the page; a lost insert throws, rolling the publication back.
 * #7438: a row whose claim matches a purge tombstone (under the entity it carries after relink inheritance) is left
 * out and its index returned in `purged`; the facts insert guard would otherwise refuse the whole statement.
 * #7778: never the page outcome row, which no tombstone applies to (the guard exempts it too).
 */
async function insertConversationFacts(tx: BrainEngine, sourceId: string, slug: string, rows: UnnumberedFact[]): Promise<{ inserted: number; ids: number[]; purged: Set<number> }> {
  if (!rows.length) return { inserted: 0, ids: [], purged: new Set() };
  rows = await inheritRelinkedEntities(tx, sourceId, slug, rows);
  const matches = await tx.executeRaw<{ ord: number | string }>(`SELECT n.ord FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS n(fact, visibility, subject, source, ord)
    WHERE NOT ${outcomeMarkerSql('n')} AND EXISTS (SELECT 1 FROM fact_purges p WHERE p.source_id=$1 AND p.visibility=n.visibility AND p.subject IN ('*', n.subject)
      AND p.fact_hash=gbrain_fact_fingerprint(n.fact))`,
  [sourceId, rows.map(row => ensureWellFormed(row.fact)), rows.map(row => row.visibility ?? 'private'), rows.map(row => row.entity_slug ? ensureWellFormed(row.entity_slug) : null), rows.map(row => row.source ?? null)]);
  const purged = new Set(matches.map(match => Number(match.ord) - 1));
  rows = rows.filter((_, i) => !purged.has(i));
  if (!rows.length) return { inserted: 0, ids: [], purged };
  const [top] = await tx.executeRaw<{ n: number | string | null }>(
    'SELECT max(row_num) AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [sourceId, slug]);
  const start = top?.n == null ? 0 : Number(top.n) + 1;
  const { inserted, ids } = await tx.insertFacts(rows.map((fact, i) => ({ ...fact, row_num: start + i, source_markdown_slug: slug })), { source_id: sourceId }); // gbrain-allow-direct-insert: a conversation page's derived fact batch replaced under its page lock (inside the receipted publication on a managed brain)
  if (inserted !== rows.length) {
    throw opError('storage_error', 'A conversation fact insert was lost; the page\'s prior facts were kept.',
      `Only ${inserted} of ${rows.length} fact rows of ${slug} in source ${sourceId} were inserted, so the replacement rolled back. Run the extraction for the page again; report this if it repeats.`);
  }
  return { inserted, ids, purged };
}

/** Context marker `gbrain repair conversation-labels` appends to the rows it retires. */
export const LABEL_RETIRED_MARKER = 'retired: conversation-labels';

/**
 * Clears a page's prior extractor batch before a replacement, keeping the
 * history other records depend on: a row an open loop (`open_loops.fact_id`,
 * no FK) or another fact's `superseded_by` references is expired, never
 * deleted, and rows `gbrain repair conversation-labels` retired stay expired.
 * A row `gbrain facts relink --conversation` linked is expired too, so the
 * replacement inherits its entity (conversation-relink-carry.ts); the previous
 * clear's expired relinked rows go first. Every other extractor row of the
 * page is deleted. Returns the rows removed from the active batch.
 */
/** The page's conversation facts, audit rows aside: what a clear would lose that a window extraction may not see again. */
export async function countConversationFacts(db: BrainEngine, sourceId: string, slug: string): Promise<number> {
  const [row] = await db.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2
    AND f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%' AND NOT (f.source = ANY($3::text[]))`, [sourceId, slug, [...AUDIT_ROW_SOURCES]]);
  return Number(row?.count ?? 0);
}

/** The page's active conversation facts anchored to window `key`. */
export async function countWindowFacts(db: BrainEngine, sourceId: string, slug: string, key: string): Promise<number> {
  const [row] = await db.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2
    AND f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%' AND f.expired_at IS NULL AND f.source_window IS NOT NULL AND ${WINDOW_KEY_SQL} = $3`, [sourceId, slug, key]);
  return Number(row?.count ?? 0);
}

/** The page's active conversation facts a settled collection keeping window `keys` removes: anchored to another window, or unanchored. */
export async function countConversationFactsOutside(db: BrainEngine, sourceId: string, slug: string, keys: readonly string[]): Promise<number> {
  const [row] = await db.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2
    AND f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%' AND NOT (f.source = ANY($3::text[])) AND f.expired_at IS NULL
    AND (f.source_window IS NULL OR NOT (${WINDOW_KEY_SQL} = ANY($4::text[])))`, [sourceId, slug, [...AUDIT_ROW_SOURCES], [...keys]]);
  return Number(row?.count ?? 0);
}

/**
 * With `windows`, only the page's anchored facts whose window key is in `keys` (`keep` false) or not in it (`keep` true),
 * and its unanchored facts when `unanchored`.
 */
export async function clearConversationFacts(db: BrainEngine, sourceId: string, slug: string,
  windows?: { keys: readonly string[]; keep: boolean; unanchored: boolean }): Promise<number> {
  const page = `f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%'` + (windows
    ? ` AND NOT (f.source = ANY($3::text[])) AND (CASE WHEN f.source_window IS NULL THEN $4::boolean ELSE (${WINDOW_KEY_SQL} = ANY($5::text[])) <> $6::boolean END)` : '');
  const params = windows ? [sourceId, slug, [...AUDIT_ROW_SOURCES], windows.unanchored, [...windows.keys], windows.keep] : [sourceId, slug];
  const referenced = 'EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)';
  await db.executeRaw(`DELETE FROM facts f WHERE ${page} AND f.expired_at IS NOT NULL AND ${RELINKED_DERIVED_ROW} AND NOT (${referenced})`, params);
  const [relinked] = await db.executeRaw<{ count: string }>(`WITH up AS (UPDATE facts f SET expired_at=now()
    WHERE ${page} AND f.expired_at IS NULL AND ${RELINKED_DERIVED_ROW} RETURNING 1) SELECT COUNT(*)::text AS count FROM up`, params);
  const [expired] = await db.executeRaw<{ count: string }>(`WITH up AS (UPDATE facts f SET expired_at=now()
    WHERE ${page} AND f.expired_at IS NULL AND (${referenced}) RETURNING 1) SELECT COUNT(*)::text AS count FROM up`, params);
  const [deleted] = await db.executeRaw<{ count: string }>(`WITH del AS (DELETE FROM facts f
    WHERE ${page} AND NOT (${referenced}) AND COALESCE(f.context,'') NOT LIKE '%${LABEL_RETIRED_MARKER}%' AND NOT (${RELINKED_DERIVED_ROW}) RETURNING 1)
    SELECT COUNT(*)::text AS count FROM del`, params);
  return Number(relinked?.count ?? 0) + Number(expired?.count ?? 0) + Number(deleted?.count ?? 0);
}


type VersionTokenOf = (db: BrainEngine, page: Page) => Promise<string>;

/**
 * Under the lock, one member on its own: skipped when its page was deleted,
 * replaced or moved; blocked (a durable not-extractable outcome naming the
 * reason, prior facts kept) when its rows cannot be published; replaced
 * otherwise. Never throws for one member's state.
 */
async function applyEntry(tx: BrainEngine, row: WriteRequest, entry: ConversationPageEntry, signature: FactEmbeddingSignature | null,
  versionTokenOf: VersionTokenOf): Promise<ConversationPageResult & { vectors_dropped: number }> {
  const base = { slug: entry.slug, generation: entry.generation, deleted: 0, facts_inserted: 0, page_outcome: null, newest_end: null, vectors_dropped: 0 };
  const page = await tx.getPage(entry.slug, { sourceId: row.source_id });
  if (!page || page.id !== Number(entry.page_id)) return { ...base, status: 'skipped', reason: 'page_identity_changed' };
  const token = await versionTokenOf(tx, page);
  if (page.knowledge_revision !== entry.expected_revision || token !== entry.version_token) return { ...base, status: 'skipped', reason: 'revision_conflict' };
  const problem = entryProblem(entry);
  if (problem) {
    const [top] = await tx.executeRaw<{ n: number | string | null }>('SELECT max(row_num) AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [row.source_id, entry.slug]);
    const blocked: ConversationFactRow = { fact: 'EXTRACTION_NOT_APPLICABLE', kind: 'fact', entity_slug: null, source: NON_EXTRACTABLE_AUDIT_SOURCE,
      source_session: `${NON_EXTRACTABLE_AUDIT_SOURCE}:${entry.slug}:${token}`, confidence: 1.0, notability: 'low',
      context: stampExtractorVersion(`scanned, not extractable: blocked: ${problem} (request ${row.request_id})`),
      row_num: top?.n == null ? 0 : Number(top.n) + 1, source_markdown_slug: entry.slug };
    const { inserted } = await tx.insertFacts([blocked], { source_id: row.source_id }); // gbrain-allow-direct-insert: the durable blocked outcome of a conversation page whose frozen rows failed validation, inside its receipted batch publication
    if (inserted !== 1) throw opError('storage_error', 'A blocked conversation outcome was not written; the batch rolled back.',
      `Request ${row.request_id} could not record that ${entry.slug} in source ${row.source_id} is blocked, so none of its pages changed. Run the extraction again; report this if it repeats.`,
      { fix: receiptFix(row.request_id) });
    return { ...base, status: 'blocked', reason: problem, page_outcome: 'non_extractable' };
  }
  const vectors = !!signature && !!entry.embedding && signature.model === entry.embedding.model && signature.dimensions === entry.embedding.dimensions;
  const merges = await mergedEntities(tx, row.source_id, entry.rows.map(fact => fact.entity_slug).filter((s): s is string => !!s));
  const rows = entry.rows.map(fact => ({
    ...fact, visibility: OUTCOME_SOURCES.has(fact.source) ? 'private' as const : entry.visibility, entity_slug: fact.entity_slug ? merges.get(fact.entity_slug) ?? fact.entity_slug : null,
    valid_from: new Date(fact.valid_from), valid_until: fact.valid_until ? new Date(fact.valid_until) : null,
    embedding: vectors && fact.embedding ? new Float32Array(fact.embedding) : null,
    embedding_model: vectors && fact.embedding ? entry.embedding!.model : null,
  }));
  // Entries frozen before #7013 carry no scope: a --since run counts as a window, an entry without its outcome as partial.
  const scope = entry.scope ?? (!entry.complete ? 'partial' : entry.selectors?.since ? 'window' : 'full');
  const { deleted, facts_inserted, purged_skipped } = await publishConversationFacts(tx, row.source_id, entry.slug, rows, { scope, requestId: row.id });
  const outcome = entry.rows.find(fact => OUTCOME_SOURCES.has(fact.source));
  return { ...base, status: 'committed', deleted, facts_inserted, ...(purged_skipped ? { facts_skipped_purged: purged_skipped } : {}),
    page_outcome: outcome ? (outcome.source === TERMINAL_AUDIT_SOURCE ? 'complete' : 'non_extractable') : null, newest_end: entry.newest_end,
    vectors_dropped: vectors ? 0 : entry.rows.filter(fact => fact.embedding).length };
}

/** Preparer for `managed_maintenance_conversation_facts`: a database-only batch publication holding every member's page key. */
export async function prepareConversationFactsPublication(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = validateIntent(row);
  const { currentConversationVersionToken } = await import('../../commands/extract-conversation-facts.ts');
  const authorize = async (db: BrainEngine) => {
    await authorizeWrite(db, row.authority, 'submit_job', row.slug);
    for (const entry of p.pages) await authorizeWrite(db, row.authority, 'submit_job', entry.slug);
  };
  await authorize(engine);
  return { observedRevision: null, noop: true, additionalPageKeys: p.pages.map(entry => ({ sourceId: row.source_id, slug: entry.slug })),
    validate: authorize,
    apply: async tx => {
      const signature = p.pages.some(entry => entry.rows?.some(fact => fact.embedding)) ? await resolveManagedFactsEmbedding(tx, config, true) : null;
      const pages: ConversationPageResult[] = [];
      let dropped = 0;
      for (const entry of p.pages) {
        const { vectors_dropped, ...result } = await applyEntry(tx, row, entry, signature, currentConversationVersionToken);
        dropped += vectors_dropped;
        pages.push(result);
      }
      const count = (status: ConversationPageResult['status']) => pages.filter(page => page.status === status).length;
      return { status: 'completed', pages, committed: count('committed'), skipped: count('skipped'), blocked: count('blocked'),
        facts_inserted: pages.reduce((n, page) => n + page.facts_inserted, 0), ...(dropped ? { vectors_dropped: dropped } : {}) };
    } };
}

/** A managed extraction run's publication context; null on an unmanaged brain or a dry run. */
export interface ManagedConversationPublisher {
  engine: BrainEngine;
  config: GBrainConfig;
  /** Resolves the run's publication context once, for the first page with managed work (`readyPublisher`). */
  prepare: () => Promise<ManagedPublisherRun>;
  run: Promise<ManagedPublisherRun> | null;
  /** Unsettled batches this run already waited for, by request row id. */
  settled: Map<string, WriteRequest>;
  /** The batch being filled, and its entries' intent bytes. */
  batch: ConversationPageEntry[];
  bytes: number;
}

interface ManagedPublisherRun {
  authority: MaintenanceAuthority;
  /** The facts embedding signature frozen entries carry (null: no vectors). */
  embedding: FactEmbeddingSignature | null;
  /** The writer's unsettled and failed batches by member generation, read once per run. */
  index: Map<string, GenerationHistory>;
}

/** Errors from resolving a run's publication context: they stop the run, not one page. */
const RUN_STOPPING = new WeakSet<object>();

/** The run counters a managed batch publication books into. */
export interface ManagedRunCounters {
  pages_processed: number; pages_marked_non_extractable: number; pages_skipped_too_large: number; pages_failed: number;
  orphan_facts_cleaned: number; facts_inserted: number; facts_skipped_purged?: number; pages_pending?: number; pages_blocked?: number;
  /** Pages the run listed more than once and extracted once (#6500). */
  pages_skipped_duplicate_listing?: number;
}

interface ManagedRunState {
  managed: ManagedConversationPublisher | null;
  sourceId: string;
  segmentLimit: number;
  factVisibility: 'private' | 'world';
  result: ManagedRunCounters;
  /** The run's per-page checkpoint ends, keyed `${sourceId}|${slug}`. */
  cpMap: Map<string, string>;
}

interface PageSnapshot { page: Page; versionToken: string }
export interface ManagedPageStart { generation: Generation; attempt: number; since: string | null }

const log = (line: string) => process.stderr.write(`[extract-conversation-facts] ${line}\n`);

/**
 * On a managed brain, refuses a caller the coordinator cannot accept (a
 * remote job or writer) and an inactive source before any provider work,
 * dry runs included; then (not for a dry run, which writes and registers
 * nothing) returns the run's publisher. Once per run, at the first page with managed work and
 * before its model call, it preflights the maintenance authority, resolves
 * the facts embedding signature, checks that the planned batch requests fit
 * the writer's request capacity, and reads its unsettled and failed batches;
 * a failure there stops the run. A run with nothing to publish preflights
 * nothing, so a source whose owner is on another host is not reported failed.
 */
export async function managedConversationPublisher(engine: BrainEngine, sourceId: string,
  opts: { dryRun?: boolean; slugs?: string[]; slug?: string; limit?: number; force?: boolean; types?: readonly AllowedType[] }): Promise<ManagedConversationPublisher | null> {
  if (!await maintenanceCallerPreflight(engine, sourceId) || opts.dryRun) return null;
  const config = loadConfig() ?? { engine: engine.kind };
  const prepare = async (): Promise<ManagedPublisherRun> => {
    const authority = (await maintenancePreflight(engine, sourceId))!;
    await assertConversationAdmissionHeadroom(engine, authority, await plannedAdmissions(engine, sourceId, opts));
    return { authority, embedding: await resolveManagedFactsEmbedding(engine, config), index: await loadGenerationIndex(engine, authority) };
  };
  return { engine, config, prepare, run: null, settled: new Map(), batch: [], bytes: 0 };
}

/** The run's publication context, resolved by its first page with managed work, so a run with nothing to publish never preflights. */
function readyPublisher(m: ManagedConversationPublisher): Promise<ManagedPublisherRun> {
  return m.run ??= m.prepare().catch((error: unknown) => {
    if (error && typeof error === 'object') RUN_STOPPING.add(error);
    throw error;
  });
}

async function settledRequest(m: ManagedConversationPublisher, r: ManagedPublisherRun, id: string): Promise<WriteRequest> {
  const cached = m.settled.get(id);
  if (cached) return cached;
  const prior = (await getWriteRequestById(m.engine, id))!;
  await authorizeStoredRequest(m.engine, prior);
  const wait = r.authority.wait!;
  const row = wait.observe(await waitForWrite(m.engine, prior, m.config, wait.ms()));
  m.settled.set(id, row);
  return row;
}

/**
 * Before any model work for one page: resolve its generation and settle it
 * without the model when this writer already admitted it in a batch
 * (replayed, resubmitted, pending or blocked), or when its largest possible
 * entry cannot fit one request. Returns the generation to extract into
 * otherwise.
 */
export async function startManagedPage(state: ManagedRunState, snapshot: PageSnapshot, sinceIso: string | undefined, segments: number,
): Promise<{ done: { newEndIso: null } } | { start: ManagedPageStart }> {
  const m = state.managed!;
  const r = await readyPublisher(m);
  const { page } = snapshot;
  const done = { done: { newEndIso: null } } as const;
  const generation = await conversationGeneration(m.engine, r.authority, {
    slug: page.slug, page, versionToken: snapshot.versionToken, since: sinceIso ?? null, segmentLimit: state.segmentLimit,
  });
  const history = r.index.get(generation.key) ?? { pending: null, failed: [] };
  if (history.pending) {
    const row = await settledRequest(m, r, history.pending.id);
    if (!isTerminal(row)) {
      state.result.pages_pending = (state.result.pages_pending ?? 0) + 1;
      log(`${page.slug}: its batch request ${row.request_id} is accepted and still pending; rerun to confirm (no model call)`);
      return done;
    }
    const result = row.state === 'committed' ? ((row.outcome?.pages ?? []) as ConversationPageResult[]).find(r => r.generation === generation.key) : undefined;
    if (result) {
      log(`${page.slug}: replaying its committed batch request ${row.request_id}; no model call`);
      bookPage(state, result);
      return done;
    }
    if (row.state !== 'committed') history.failed.push({ id: row.id, requestId: row.request_id, code: row.error_code ?? row.state, attempt: history.pending.attempt,
      alone: new Set(((row.intent as ConversationFactsIntent | null)?.pages ?? []).map(entry => entry.generation)).size === 1 });
    history.pending = null;
  }
  const deterministic = history.failed.find(f => f.alone && DETERMINISTIC_CODES.has(f.code));
  if (deterministic || history.failed.length >= MAX_GENERATION_ATTEMPTS) {
    const last = deterministic ?? history.failed.at(-1)!;
    state.result.pages_blocked = (state.result.pages_blocked ?? 0) + 1;
    log(`SKIP ${page.slug}: ${deterministic ? `its batch request ${last.requestId} failed (${last.code})` : `${MAX_GENERATION_ATTEMPTS} batch requests holding it failed`} at this page version, so no model call runs again until the page changes. Read the receipt: gbrain write-request -- ${last.requestId}`);
    return done;
  }
  const attempt = history.failed.length ? Math.max(...history.failed.map(f => f.attempt)) + 1 : 0;
  const last = history.failed.at(-1);
  const stored = last && !REEXTRACT_CODES.has(last.code) ? await storedEntry(m.engine, last.id, generation.key) : null;
  if (!m.batch.length) await assertConversationAdmissionHeadroom(m.engine, r.authority);
  if (stored) {
    log(`${page.slug}: resubmitting its stored entry from failed batch request ${last!.requestId} (attempt ${attempt + 1}); no model call`);
    await enqueueEntry(state, { ...stored, attempt });
    return done;
  }
  const planned = state.segmentLimit > 0 ? Math.min(segments, state.segmentLimit) : segments;
  const estimate = estimateConversationIntentBytes(planned, r.embedding);
  const limit = await conversationIntentByteLimit(m.engine);
  if (estimate > limit) {
    state.result.pages_skipped_too_large++;
    log(`SKIP ${page.slug}: up to ${planned} segment(s) could freeze a ${estimate}-byte batch, over the ${limit}-byte request limit; its prior facts were kept and no model call ran. Narrow it with --slug ${page.slug} --segment-limit <n>`);
    return done;
  }
  return { start: { generation, attempt, since: sinceIso ?? null } };
}

/** Freezes one extracted page into the run's batch; the batch publishes once a cap is reached (and at the end of the run). */
export async function enqueueManagedPage(state: ManagedRunState, snapshot: PageSnapshot, start: ManagedPageStart,
  rows: ConversationFactRow[], newestEnd: string | null, scope: ConversationScope): Promise<void> {
  const m = state.managed!;
  await enqueueEntry(state, await buildConversationPage(m.engine, m.config, { slug: snapshot.page.slug, generation: start.generation, attempt: start.attempt,
    versionToken: snapshot.versionToken, since: start.since, segmentLimit: state.segmentLimit, scope }, rows, { newestEnd, visibility: tightenToPage(state.factVisibility, snapshot.page) }));
}

async function enqueueEntry(state: ManagedRunState, entry: ConversationPageEntry): Promise<void> {
  const m = state.managed!;
  // De-dup before the byte-cap flush (#6500): the envelope validator refuses a
  // batch naming a page twice. The same generation is the same frozen rows, so
  // the newcomer is dropped; a different generation means the page moved
  // between the two reads, so the earlier entry publishes first (apply skips it
  // as stale) and the newcomer opens the next batch.
  const held = m.batch.find(e => e.slug === entry.slug);
  if (held) {
    if (held.generation === entry.generation) {
      state.result.pages_skipped_duplicate_listing = (state.result.pages_skipped_duplicate_listing ?? 0) + 1;
      log(`${entry.slug}: already frozen in this run's batch at the same generation; the second listing is dropped`);
      return;
    }
    await flushManagedBatch(state);
  }
  const bytes = jsonBytes(entry);
  const cap = Math.min(batchCaps.bytes, await conversationIntentByteLimit(m.engine) - 65_536);
  if (m.batch.length && m.bytes + bytes > cap) await flushManagedBatch(state);
  m.batch.push(entry);
  m.bytes += bytes;
  const factPages = m.batch.filter(e => e.rows.some(fact => !OUTCOME_SOURCES.has(fact.source))).length;
  if (m.batch.length >= batchCaps.pages || factPages >= batchCaps.factPages || m.bytes >= cap) await flushManagedBatch(state);
}

/** #7438: counts and logs a page's extracted claims left out because they match a purge tombstone. */
export function notePurgedSkips(counters: { facts_skipped_purged?: number }, slug: string, skipped: number): void {
  if (!skipped) return;
  counters.facts_skipped_purged = (counters.facts_skipped_purged ?? 0) + skipped;
  log(`${slug}: left out ${skipped} extracted fact(s) that match a purge tombstone (#7438)`);
}

/** Books one member's committed-batch result into the run's counters. */
function bookPage(state: ManagedRunState, result: ConversationPageResult): void {
  state.result.orphan_facts_cleaned += Number(result.deleted ?? 0);
  state.result.facts_inserted += Number(result.facts_inserted ?? 0);
  notePurgedSkips(state.result, result.slug, result.facts_skipped_purged ?? 0);
  if (result.status === 'skipped') {
    state.result.pages_failed++;
    log(`${result.slug} changed during extraction (${result.reason}); its prior facts were kept and it stays unfinished for the next run`);
    return;
  }
  if (result.status === 'blocked') {
    state.result.pages_blocked = (state.result.pages_blocked ?? 0) + 1;
    log(`SKIP ${result.slug}: blocked at this page version (${result.reason}); no model call runs again until the page changes`);
    return;
  }
  if (result.page_outcome === 'non_extractable') { state.result.pages_marked_non_extractable++; return; }
  state.result.pages_processed++;
  if (result.newest_end) state.cpMap.set(`${state.sourceId}|${result.slug}`, result.newest_end);
}

/**
 * Publishes the run's current batch as one request and books each member.
 * A batch still pending after the job's wait leaves its pages pending (the
 * next run replays it, no model call); a failed batch leaves them unfinished
 * (the next run resubmits or blocks them from the stored request).
 */
export async function flushManagedBatch(state: ManagedRunState, opts: { afterError?: boolean } = {}): Promise<void> {
  const m = state.managed;
  if (!m || !m.batch.length) return;
  // After a run-ending error the run's own error is the one reported; a flush failure only leaves the batch's pages unfinished.
  if (opts.afterError) return flushManagedBatch(state).catch((error: unknown) => {
    log(`the run's last batch did not publish (${error instanceof Error ? error.message : String(error)}); its pages stay unfinished`);
  });
  const pages = m.batch.splice(0);
  m.bytes = 0;
  await publishBatch(state, m, pages);
}

/**
 * One batch request. GBRA-130 A-51: a deterministic failure of more than one page is re-published in halves, so the
 * code is booked only against the page that fails alone and its batch-mates still commit in this run.
 */
async function publishBatch(state: ManagedRunState, m: ManagedConversationPublisher, pages: ConversationPageEntry[]): Promise<void> {
  try {
    const receipt = await submitConversationPages(m.engine, (await readyPublisher(m)).authority, pages);
    for (const result of receipt.pages as ConversationPageResult[]) bookPage(state, result);
    log(`published ${pages.length} page(s) in batch request ${String(receipt.request_id)} (${Number(receipt.committed ?? 0)} committed, ${Number(receipt.skipped ?? 0)} skipped, ${Number(receipt.blocked ?? 0)} blocked)`);
  } catch (error) {
    if (!(error instanceof OperationError) || stopsRun(error)) throw error;
    const requestId = error.writeRequest?.request_id;
    if (error.code === 'write_pending') {
      state.result.pages_pending = (state.result.pages_pending ?? 0) + pages.length;
      log(`batch request ${requestId ?? ''} with ${pages.length} page(s) is accepted and still pending; rerun to confirm (the rerun replays it, no model call)`);
      return;
    }
    if (DETERMINISTIC_CODES.has(error.code) && pages.length > 1) {
      log(`batch request ${requestId ?? ''} with ${pages.length} page(s) failed (${error.code}); re-publishing it in halves so the code lands only on the page that fails alone`);
      const half = Math.ceil(pages.length / 2);
      await publishBatch(state, m, pages.slice(0, half));
      await publishBatch(state, m, pages.slice(half));
      return;
    }
    state.result.pages_failed += pages.length;
    log(`batch request ${requestId ?? ''} with ${pages.length} page(s) failed (${error.code}): ${error.message}; the next run ${DETERMINISTIC_CODES.has(error.code) ? 'blocks it until it changes' : 'resubmits their stored entries without model calls'}`);
  }
}
/** Managed admission backpressure and exhausted request ids stop the whole run, not one page. */
export function stopsRun(err: unknown): boolean {
  return (!!err && typeof err === 'object' && RUN_STOPPING.has(err))
    || (err instanceof OperationError && (err.code === 'maintenance_backpressure' || err.code === 'queue_capacity' || err.code === 'write_quota_exhausted' || err.code === 'write_capacity_backpressure'));
}

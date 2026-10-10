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
 * members' (generation, attempt) pairs. Before a page's model work the run
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
import { readFix } from '../ops/op-fix.ts';
import { authorizeStoredRequest, authorizeWrite } from '../persistence/authority.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { getWriteRequestById } from '../persistence/journal.ts';
import { readJournalLimits } from '../persistence/limits.ts';
import { principalKey } from '../persistence/model.ts';
import { PERSISTENCE_IPC_MAX_BYTES } from '../persistence/ipc.ts';
import { resolveManagedFactsEmbedding } from '../persistence/facts-maintenance.ts';
import { maintenanceCallerPreflight, maintenancePreflight, submitDatabaseMaintenanceIntent, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { loadConfig } from '../config.ts';
import { waitForWrite } from '../persistence/service.ts';
import { catalogueError } from '../error-catalogue.ts';
import { CONVERSATION_EXTRACTOR_VERSION, NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE, stampExtractorVersion } from './audit-sources.ts';
import { ALLOWED_TYPES, pageTypesForAllowed, type AllowedType } from './conversation-types.ts';
import { withWriteTrust } from '../persistence/context.ts';
import { conversationDerivation } from '../persistence/derived-facts.ts';
import { recordTaintEdges } from '../trust/taint.ts';
import { applyGateDecision, derivedGateConfig, derivedGateInput } from '../trust/derived-gate.ts';
import { decideFactWrite, recordFlaggedRow } from '../write-gate-store.ts';

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

/** Request error codes that fail the same way on every retry. */
const DETERMINISTIC_CODES = new Set(['invalid_params', 'permission_denied', 'request_too_large', 'payload_too_large']);
/** Retryable codes whose stored entries are stale: the next attempt extracts again. */
const REEXTRACT_CODES = new Set(['embedding_configuration', 'revision_conflict', 'page_identity_changed', 'page_not_found']);
const OUTCOME_SOURCES = new Set([TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE]);

export type ConversationFactRow = NewFact & { row_num: number; source_markdown_slug: string };
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

/** What this writer's unsettled and failed batch requests say about one generation. */
interface GenerationHistory {
  /** An admitted batch that has not settled yet. */
  pending: { id: string; attempt: number } | null;
  /** Failed batches holding this generation: their row id, error code and the member's attempt. */
  failed: Array<{ id: string; requestId: string; code: string; attempt: number }>;
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
    for (const member of row.members ?? []) {
      const history = index.get(member.generation) ?? { pending: null, failed: [] };
      if (!isTerminal(row as unknown as WriteRequest)) history.pending = { id: row.id, attempt: Number(member.attempt) };
      else history.failed.push({ id: row.id, requestId: row.request_id, code: row.error_code ?? row.state, attempt: Number(member.attempt) });
      index.set(member.generation, history);
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
 * Before model work: stop admitting once this writer's outstanding requests,
 * reserved receipt bytes or permanent request ids would pass
 * OUTSTANDING_ADMISSION_SHARE of their limit. The writer is the local CLI
 * principal the user's own CLI writes share, so the last 20% stays theirs:
 * reserved receipt bytes free only when receipts compact (after the retention
 * window), request ids never. `needed` is the run's planned batch requests
 * up front, 1 before each new batch; the suggested `--limit` is in pages.
 */
export async function assertConversationAdmissionHeadroom(engine: BrainEngine, authority: MaintenanceAuthority, needed = 1): Promise<void> {
  const limits = await readJournalLimits(engine);
  const [counter] = await engine.executeRaw<{ outstanding_count: number | string; terminal_bytes: number | string; lifetime_ids: number | string }>(
    'SELECT outstanding_count, terminal_bytes, lifetime_ids FROM persistence_counters WHERE key=$1', [principalKey(authority.writer.principal)]);
  const sourceId = authority.writer.sourceId;
  const share = (limit: number) => Math.max(1, Math.floor(limit * OUTSTANDING_ADMISSION_SHARE));
  const outstanding = Number(counter?.outstanding_count ?? 0);
  if (outstanding >= share(limits.principalOutstanding)) {
    throw catalogueError('maintenance_backpressure',
      `Conversation fact extraction stopped admitting: ${outstanding} of this writer's ${limits.principalOutstanding} outstanding requests are still pending.`,
      `Let the pending requests settle (gbrain sources writer status --source ${sourceId} --json shows them; a resident gbrain serve or the next CLI run publishes them), then rerun the same command. Pages already published keep their facts.`);
  }
  const reservation = Math.max(16_384, jsonBytes(authority.writer) + 8192);
  const cumulative = [
    { resource: 'reserved receipt bytes', key: 'persistence.limits.principal_terminal_bytes', used: Number(counter?.terminal_bytes ?? 0),
      limit: limits.principalTerminalBytes, per: reservation,
      why: 'each request reserves its receipt for the retention window (persistence.receipt_retention_days), and the reservation frees only when receipts compact' },
    { resource: 'permanent request ids', key: 'persistence.limits.principal_lifetime_ids', used: Number(counter?.lifetime_ids ?? 0),
      limit: limits.principalLifetimeIds, per: 1, why: 'request ids are never reused or freed' },
  ];
  for (const r of cumulative) {
    const ceiling = share(r.limit);
    if (r.used + needed * r.per <= ceiling) continue;
    const room = Math.max(0, Math.floor((ceiling - r.used) / r.per)) * batchCaps.factPages;
    const planned = needed > 1 ? `${needed} planned` : 'the next';
    throw catalogueError('maintenance_backpressure',
      `Conversation fact extraction stopped before admitting ${planned} request(s): this writer's ${r.resource} would pass 80% of its limit (${r.used} used of ${r.limit}).`,
      `The last 20% stays free for this CLI writer's other writes; ${r.why}. ${room > 0 ? `Run a smaller batch that fits: gbrain extract-conversation-facts --source-id ${sourceId} --limit ${room}. ` : ''}`
        + `Check the writer with gbrain sources writer status --source ${sourceId} --json; raising ${r.key} (gbrain config set ${r.key} <n>) is the user's call.`);
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
  input: { slug: string; generation: Generation; attempt: number; versionToken: string; since: string | null; segmentLimit: number },
  rows: ConversationFactRow[], opts: { newestEnd: string | null; visibility: 'private' | 'world' }): Promise<ConversationPageEntry> {
  // Vectors freeze only under the brain's current facts embedding signature; any other
  // vector is dropped and its row is embedded later, as an unembedded fact is.
  const signature = rows.some(row => row.embedding) ? await resolveManagedFactsEmbedding(engine, config) : null;
  const keep = (row: ConversationFactRow) => !!signature && !!row.embedding && row.embedding.length === signature.dimensions
    && (!row.embedding_model || row.embedding_model === signature.model);
  return {
    slug: input.slug, page_id: input.generation.pageId, expected_revision: input.generation.revision, version_token: input.versionToken,
    extractor_version: CONVERSATION_EXTRACTOR_VERSION, generation: input.generation.key, attempt: input.attempt,
    selectors: { since: input.since, segment_limit: input.segmentLimit }, complete: rows.some(row => OUTCOME_SOURCES.has(row.source)),
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
  const intent: ConversationFactsIntent = { kind: CONVERSATION_FACTS_INTENT, protocol: CONVERSATION_FACTS_PROTOCOL, expected_revision: null, pages };
  const limit = await conversationIntentByteLimit(engine);
  const bytes = jsonBytes(intent);
  if (bytes > limit) {
    throw opError('request_too_large', 'The frozen fact batch exceeds the request size limit; the pages\' prior facts were kept.',
      `The batch of ${pages.map(p => p.slug).join(', ')} is ${bytes} bytes, over the ${limit}-byte limit for one request, so nothing was submitted. Narrow the run with --segment-limit, or raise persistence.limits.principal_intent_bytes (the user's call).`);
  }
  return submitDatabaseMaintenanceIntent(engine, authority, ANCHOR_SLUG, intent, batchRequestId(authority.writer.sourceIncarnation, pages));
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

/**
 * The page's replacement under its lock: deletes the prior extractor rows
 * and inserts `rows` numbered above every remaining fact row of the page.
 * Shared by the managed apply and the unmanaged writer.
 */
export async function replaceConversationFacts(tx: BrainEngine, sourceId: string, slug: string,
  rows: Array<Omit<ConversationFactRow, 'row_num' | 'source_markdown_slug'>>): Promise<{ deleted: number; inserted: number; ids: number[] }> {
  const deleted = await clearConversationFacts(tx, sourceId, slug);
  if (!rows.length) return { deleted, inserted: 0, ids: [] };
  const [top] = await tx.executeRaw<{ n: number | string | null }>(
    'SELECT max(row_num) AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [sourceId, slug]);
  const start = top?.n == null ? 0 : Number(top.n) + 1;
  const { inserted, ids } = await tx.insertFacts(rows.map((fact, i) => ({ ...fact, row_num: start + i, source_markdown_slug: slug })), { source_id: sourceId }); // gbrain-allow-direct-insert: a conversation page's derived fact batch replaced under its page lock (inside the receipted publication on a managed brain)
  if (inserted !== rows.length) {
    throw opError('storage_error', 'A conversation fact insert was lost; the page\'s prior facts were kept.',
      `Only ${inserted} of ${rows.length} fact rows of ${slug} in source ${sourceId} were inserted, so the replacement rolled back. Run the extraction for the page again; report this if it repeats.`);
  }
  return { deleted, inserted, ids };
}

/** Context marker `gbrain repair conversation-labels` appends to the rows it retires. */
export const LABEL_RETIRED_MARKER = 'retired: conversation-labels';

/**
 * Clears a page's prior extractor batch before a replacement, keeping the
 * history other records depend on: a row an open loop (`open_loops.fact_id`,
 * no FK) or another fact's `superseded_by` references is expired, never
 * deleted, and rows `gbrain repair conversation-labels` retired stay expired.
 * Every other extractor row of the page is deleted. Returns the rows removed
 * from the active batch.
 */
export async function clearConversationFacts(db: BrainEngine, sourceId: string, slug: string): Promise<number> {
  const page = `f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%'`;
  const referenced = 'EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)';
  const [expired] = await db.executeRaw<{ count: string }>(`WITH up AS (UPDATE facts f SET expired_at=now()
    WHERE ${page} AND f.expired_at IS NULL AND (${referenced}) RETURNING 1) SELECT COUNT(*)::text AS count FROM up`, [sourceId, slug]);
  const [deleted] = await db.executeRaw<{ count: string }>(`WITH del AS (DELETE FROM facts f
    WHERE ${page} AND NOT (${referenced}) AND COALESCE(f.context,'') NOT LIKE '%${LABEL_RETIRED_MARKER}%' RETURNING 1)
    SELECT COUNT(*)::text AS count FROM del`, [sourceId, slug]);
  return Number(expired?.count ?? 0) + Number(deleted?.count ?? 0);
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
  // #5575 I2/B3: the rows carry the conversation page's tier and pass the write gate at it; outcome audit rows are not gated.
  const derivation = await conversationDerivation(tx, row.source_id, entry.slug);
  const cfg = await derivedGateConfig(tx);
  const decisions = rows.map(fact => OUTCOME_SOURCES.has(fact.source) ? null : decideFactWrite(fact,
    { sourceId: row.source_id, slug: entry.slug, payload: { ...fact, embedding: null }, input: derivedGateInput(derivation.trust, row.id), cfg }));
  for (const d of decisions) if (d && d.action !== 'insert') await applyGateDecision(tx, d, { table: 'facts', sourceId: row.source_id }, async () => null);
  const kept = rows.filter((_, i) => decisions[i]?.action !== 'hold' && decisions[i]?.action !== 'reject');
  const flags = decisions.filter(d => d?.action !== 'hold' && d?.action !== 'reject');
  const { deleted, ids } = await withWriteTrust(tx, derivation.trust, () => replaceConversationFacts(tx, row.source_id, entry.slug, kept));
  for (const [i, id] of ids.entries()) {
    await recordTaintEdges(tx, { table: 'facts', id, sourceId: row.source_id }, derivation.inputs);
    if (flags[i] && ids.length === kept.length) await recordFlaggedRow(tx, flags[i]!, { table: 'facts', id, sourceId: row.source_id });
  }
  const outcome = entry.rows.find(fact => OUTCOME_SOURCES.has(fact.source));
  return { ...base, status: 'committed', deleted, facts_inserted: kept.filter(fact => !OUTCOME_SOURCES.has(fact.source)).length,
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
  orphan_facts_cleaned: number; facts_inserted: number; pages_pending?: number; pages_blocked?: number;
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
    if (row.state !== 'committed') history.failed.push({ id: row.id, requestId: row.request_id, code: row.error_code ?? row.state, attempt: history.pending.attempt });
    history.pending = null;
  }
  const deterministic = history.failed.find(f => DETERMINISTIC_CODES.has(f.code));
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
  rows: ConversationFactRow[], newestEnd: string | null): Promise<void> {
  const m = state.managed!;
  await enqueueEntry(state, await buildConversationPage(m.engine, m.config, { slug: snapshot.page.slug, generation: start.generation, attempt: start.attempt,
    versionToken: snapshot.versionToken, since: start.since, segmentLimit: state.segmentLimit }, rows, { newestEnd, visibility: state.factVisibility }));
}

async function enqueueEntry(state: ManagedRunState, entry: ConversationPageEntry): Promise<void> {
  const m = state.managed!;
  const bytes = jsonBytes(entry);
  const cap = Math.min(batchCaps.bytes, await conversationIntentByteLimit(m.engine) - 65_536);
  if (m.batch.length && m.bytes + bytes > cap) await flushManagedBatch(state);
  m.batch.push(entry);
  m.bytes += bytes;
  const factPages = m.batch.filter(e => e.rows.some(fact => !OUTCOME_SOURCES.has(fact.source))).length;
  if (m.batch.length >= batchCaps.pages || factPages >= batchCaps.factPages || m.bytes >= cap) await flushManagedBatch(state);
}

/** Books one member's committed-batch result into the run's counters. */
function bookPage(state: ManagedRunState, result: ConversationPageResult): void {
  state.result.orphan_facts_cleaned += Number(result.deleted ?? 0);
  state.result.facts_inserted += Number(result.facts_inserted ?? 0);
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
    state.result.pages_failed += pages.length;
    log(`batch request ${requestId ?? ''} with ${pages.length} page(s) failed (${error.code}): ${error.message}; the next run ${DETERMINISTIC_CODES.has(error.code) ? 'blocks them until they change' : 'resubmits their stored entries without model calls'}`);
  }
}
/** Managed admission backpressure and exhausted request ids stop the whole run, not one page. */
export function stopsRun(err: unknown): boolean {
  return (!!err && typeof err === 'object' && RUN_STOPPING.has(err))
    || (err instanceof OperationError && (err.code === 'maintenance_backpressure' || err.code === 'queue_capacity'));
}

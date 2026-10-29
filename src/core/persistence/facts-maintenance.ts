import { isConnectorSourceKind } from './connector-identity.ts';
import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { FactsBackstopCtx } from '../facts/backstop.ts';
import { factEventTime } from '../facts/event-time.ts';
import { ENTITY_HINTS_CAP, type ExtractedFact, type FactEmbeddingSignature } from '../facts/extract.ts';
import { readFactsEmbeddingDim } from '../embedding-dim-check.ts';
import { currentEmbeddingSignature } from '../embedding.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { hostFix, opTransport, readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { appendContextNote, type InferredVia } from '../facts/subject-infer.ts';
import { inferenceNote } from '../facts/subject-infer-write.ts';
import { resolveDefaultVisibility } from '../facts/visibility.ts';
import { FACT_WITHDRAWN_MESSAGE, isFactWithdrawn, withdrawnFromDetail } from '../facts/withdrawal.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { authorizeStoredRequest, authorizeWrite, submissionAuthority } from './authority.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { initializeLocalPersistence } from './page-mutations.ts';
import { prepareFileTarget } from './page-prepare.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled, probeWorktreeWriter, type WorktreeBinding } from './ownership.ts';
import { authorizeFactsBackstop } from './effect-facts.ts';
import { admitWriteInTransaction, getWriteRequest, getWriteRequestById, receiptFor } from './journal.ts';
import { assertPersistenceAccepting, awaitWrite, persistenceConsumerConfig, writeResponse } from './service.ts';
import { MaintenanceWriteWait } from './maintenance-wait.ts';
import { digest, requireUuid, sha256 } from './digest.ts';
import { isTerminal, type WriteAuthority, type WriteRequest } from './model.ts';
import type { WriteReceipt } from './types.ts';
import { FACTS_BATCH_INCOMPLETE_MESSAGE, isEntityMovedRefusal } from './verb-errors.ts';
import { assertAmbientCaptureAdmissible, captureGateLaneForSource } from '../facts/capture-sources.ts';
import { declareDerivation, type DerivationDeclaration } from '../trust/taint.ts';
import type { TaintInput, WriteTrust } from '../trust/tier.ts';

export interface ManagedFactsResult {
  inserted: number; duplicate: number; superseded: number; fact_ids: number[]; entity_slugs: string[]; write_requests: WriteReceipt[];
  /** #6506: candidates the automatic extraction skipped because the exact claim was forgotten in this source and visibility. */
  withdrawn_skipped?: number;
  /** #6333 shadow: same-page rewordings the managed preparer counted; nothing was dropped. */
  would_dedup_same_page?: number;
  /** GBRA-130 A-36: entity requests that ended refused for their own page; the other entities' facts committed. */
  refused?: ManagedFactsRefusal[];
}
export interface ManagedFactsRefusal { slug: string; code: string; request_id: string }
export interface ManagedFactOrigin { slug: string; pageId: number; revision: string; }
export type FrozenExtractedFact = Omit<NewFact, 'embedding' | 'valid_from' | 'valid_until' | 'expired_at'> & {
  embedding: number[] | null; valid_from: string; valid_until: string | null;
  /** #5836: a write-time inferred subject dedups exact text only, never superseding or dropping a similar fact. */
  entity_inferred?: InferredVia;
};
export interface ManagedFactIntent extends Record<string, unknown> {
  kind: 'managed_facts_entity' | 'managed_facts_complete';
  batchKey: string; inputDigest: string; origin: ManagedFactOrigin | null; originalRequestId: string | null;
  expected_revision?: string; facts?: FrozenExtractedFact[]; children?: string[];
  /** Direct single-fact writes keep writeSingleFact's supersession rule. */
  supersede?: true;
  /**
   * #6506: automatic extraction only. A candidate whose exact claim was forgotten in this source and visibility is
   * skipped and counted (`withdrawn_skipped`) instead of refusing the entity's whole group; a purge tombstone still
   * refuses. Explicit writers (remember, the fence writers) never set it and keep the refusal. Frozen in the stored
   * intent, so a replay and a resumed batch decide exactly as the admission did.
   */
  withdrawn?: 'skip';
  /**
   * writeSingleFact only: a `memory/unattributed` row keeps the resolver's
   * fallback slug as its entity (no row number), so dedup stays per entity.
   */
  attribute_fallback?: true;
  embedding?: FactEmbeddingSignature | null;
  /** #6091: the ambient capture lane (`hook:*`, `sweep:*`) the facts came from; admission re-checks its gate. */
  capture_source?: string;
  /** #5575 I2: the extraction's taint, declared at prompt-build time (trust/taint.ts). */
  derivation?: DerivationDeclaration;
  /**
   * #6898 follow-up: set when the entity's facts were split into parts of at most
   * MANAGED_FACTS_PUBLICATION_MAX facts, each its own request and publication. `deferred_facts` counts
   * the facts left to later parts and `follow_up` names their request ids; both are copied into the
   * part's receipt, so a part never reads as the whole group (the batch's completion request does).
   */
  part?: ManagedFactsPart;
}
export interface ManagedFactsPart { index: number; of: number; deferred_facts: number; follow_up: string[] }
export interface ManagedFactsSession {
  authority: WriteAuthority; binding: WorktreeBinding | null; config: GBrainConfig;
  batchKey: string; inputDigest: string; origin: ManagedFactOrigin | null; originalRequestId: string | null;
  completionRequestId: string;
  embedding?: FactEmbeddingSignature | null;
  /** #6048: the batch is keyed by its input alone and the caller asked to re-admit facts the canonical file check refused. */
  fileRefusalRetry?: boolean;
  /** #6506: the batch is keyed by its input alone (no request id), so a stored withdrawal refusal would replay on every run. */
  inputKeyed?: boolean;
  /**
   * #7602: automatic extraction with no caller request id re-admits an entity request refused because its entity page
   * moved, at the page's current revision. Explicit fact writers (remember, the fence writers) leave it unset and keep the refusal.
   */
  entityMoveRetry?: boolean;
  /** #6091: set when the facts come from an ambient capture lane. */
  captureSource?: string;
  /**
   * GBRA-130 A-36: automatic extraction reports an entity refused for its own page under `refused` instead of throwing,
   * so a replay returns the committed entities' counts. Explicit fact writers leave it unset and keep the refusal.
   */
  reportRefusals?: boolean;
  derivation?: DerivationDeclaration;
  /**
   * #6778: the publish wait, one budget per session: 30 s bounded by the job's deadline
   * (FactsBackstopCtx.deadlineAtMs), zero for later publishes once one is still pending.
   */
  wait: MaintenanceWriteWait;
  /** The job's abort signal: a cancelled job stops waiting at once and its write stays pending. */
  signal?: AbortSignal;
}

/** #6048: follow-up batches one extraction may admit for each followed refusal walk (file check, withdrawal, #7602 moved entity). */
export const MAX_FILE_REFUSAL_RETRIES = 3;

/**
 * #6898 follow-up: the most facts one entity request publishes. A publication holds the brain-wide
 * persistence_counters row from its admission check to its commit, and each fact adds a dedup check and
 * an index insert to that window (measured ~3.5 ms per fact on Postgres; 200 facts on a 1.6 MB entity page
 * held it 1.2 s, past the 1 s lock_timeout every other admission waits under). A larger group is admitted
 * as parts in the same batch, published one after another in queue order.
 */
export const MANAGED_FACTS_PUBLICATION_MAX = 50;

const receiptFix = (requestId: string): Action => readFix('Reads the fact request\'s durable receipt: its operation, state and outcome, read-only.',
  { argv: ['gbrain', 'write-request', '--', requestId], mcp: { tool: 'get_write_request', arguments: { request_id: requestId } } });
const pageFix = (sourceId: string, slug: string): Action => readFix(`Shows page ${slug} in source ${sourceId} as it is now, with its revision.`,
  { argv: ['gbrain', 'get', '--source', sourceId, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId } } });
const ownerStatusFix = (sourceId: string): Action => readFix(`Shows source ${sourceId}'s canonical owner, its state and any write in flight, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
const embeddingsFix = (): Action => readFix('Reports the brain\'s embedding model, dimensions and vector columns, read-only.',
  { argv: ['gbrain', 'doctor', '--only', 'embeddings', '--json'] });

function managedFactRequestId(batchKey: string, slug: string, part = 1): string {
  const hex = digest(part === 1 ? [batchKey, slug] : [batchKey, slug, part]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function validateManagedFactsCompletion(engine: BrainEngine, session: ManagedFactsSession, prior: WriteRequest): Promise<void> {
  await authorizeStoredRequest(engine, prior);
  const inputDigest = prior.intent?.inputDigest ?? prior.outcome?.input_digest;
  if (prior.operation !== 'extract_facts' || prior.slug !== '__managed_facts_complete__'
    || prior.source_id !== session.authority.sourceId || prior.source_incarnation !== session.authority.sourceIncarnation
    || inputDigest !== undefined && inputDigest !== session.inputDigest) {
    throw opError('idempotency_conflict', 'This request ID already belongs to another operation or extraction input.',
      `Request ${prior.request_id} was already accepted for a different operation or extraction input, so nothing was admitted. Give this extraction a new request_id; read the receipt to see what the original request did.`,
      { fix: receiptFix(prior.request_id) });
  }
  if (prior.compacted && !prior.intent && isTerminal(prior) && prior.state !== 'committed') {
    const error = new OperationError('facts_payload_expired', 'The accepted fact extraction failed and its retained payload has expired.',
      'Inspect the original receipt. Any new extraction requires separate approval and a new request identity.');
    error.writeRequest = receiptFor(prior);
    throw error;
  }
  if (inputDigest !== session.inputDigest) throw opError('idempotency_conflict', 'The retained fact request cannot verify this extraction input.',
    `Request ${prior.request_id} no longer retains the input digest needed to prove it matches this extraction, so nothing was admitted. Read its receipt; a new extraction needs a new request_id.`,
    { fix: receiptFix(prior.request_id) });
}

export async function resolveManagedFactsEmbedding(engine: BrainEngine, config: GBrainConfig,
  lock = false): Promise<FactEmbeddingSignature | null> {
  const rows = await engine.executeRaw<{ key: string; value: string }>(`SELECT key,value FROM config
    WHERE key IN ('embedding_model','embedding_dimensions','embedding_disabled') ORDER BY key${lock ? ' FOR SHARE' : ''}`);
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  if (values.embedding_disabled !== undefined && values.embedding_disabled !== 'true' && values.embedding_disabled !== 'false') {
    throw opError('embedding_configuration', 'Selected brain embedding_disabled must be true or false.',
      'The brain\'s embedding_disabled setting is neither true nor false, so fact extraction stopped before admission. Read it, then have the user set it to true or false with gbrain config set embedding_disabled.',
      { fix: readFix('Shows the stored embedding_disabled value and the plane it comes from, read-only.', { argv: ['gbrain', 'config', 'get', 'embedding_disabled'] }) });
  }
  if (config.embedding_disabled || values.embedding_disabled === 'true') return null;
  const model = values.embedding_model;
  if (!model) return null;
  const dimensions = /^[1-9]\d*$/.test(values.embedding_dimensions ?? '') ? Number(values.embedding_dimensions) : null;
  if (!/[:/]/.test(model) && /^[^\s]+$/.test(model) && dimensions) {
    // #6113: a legacy row stores the model without its provider. Name the one supported rewrite (a preview first).
    const signature = currentEmbeddingSignature();
    const gateway = signature ? signature.slice(0, signature.lastIndexOf(':')) : null;
    const target = gateway?.endsWith(`:${model}`) ? gateway : null;
    throw opError('embedding_configuration', 'The selected brain records its embedding model without a provider, so facts cannot be embedded.',
      `The brain's embedding_model row is ${JSON.stringify(model)} with no provider prefix (a row from an older install), so fact extraction stopped before admission; gbrain config set cannot change it. `
      + `Preview the supported rewrite with gbrain migrate embeddings --to ${target ?? `<provider>:${model}`} --dry-run and show the user its cost: it re-embeds active facts, so applying it needs the user's paid authorization.`,
      { fix: target ? readFix(`Previews rewriting the brain's embedding identity to ${target}, read-only.`, { argv: ['gbrain', 'migrate', 'embeddings', '--to', target, '--dry-run'] }) : embeddingsFix() });
  }
  if (!/^[^\s:]+:[^\s]+$/.test(model) || !dimensions || !Number.isSafeInteger(dimensions)) {
    throw opError('embedding_configuration', 'The selected brain has no verifiable facts embedding model and dimensions.',
      `The brain's embedding_model (${JSON.stringify(model)}) is not provider:model or embedding_dimensions is not a positive integer, so fact extraction stopped before admission. Check embedding readiness; correcting the configuration is the user's decision.`,
      { fix: embeddingsFix() });
  }
  const shape = await readFactsEmbeddingDim(engine);
  if (!shape.exists || !shape.columnType || shape.dims !== dimensions) {
    throw opError('embedding_configuration', 'The selected brain facts embedding provenance does not match its vector column.',
      `The facts vector column ${shape.exists ? `holds ${shape.dims ?? 'unknown'}-dimension vectors` : 'is missing'}, but ${model} is configured for ${dimensions}, so fact extraction stopped before admission. Check embedding readiness and show the user the mismatch.`,
      { fix: embeddingsFix() });
  }
  return { model, dimensions };
}

export async function assertManagedFactsEmbedding(engine: BrainEngine, config: GBrainConfig,
  expected: FactEmbeddingSignature | null | undefined, lock = false): Promise<void> {
  const current = await resolveManagedFactsEmbedding(engine, config, lock);
  if (!expected || !current || expected.model !== current.model || expected.dimensions !== current.dimensions) {
    throw opError('embedding_configuration', 'The selected brain facts embedding policy or model changed; retained vectors cannot be installed.',
      `The facts embedding changed from ${expected ? `${expected.model} (${expected.dimensions})` : 'none'} to ${current ? `${current.model} (${current.dimensions})` : 'none'} after the facts were embedded, so nothing was admitted. Run the extraction again (the same request_id is safe: nothing was accepted) to embed under the current model.`,
      { fix: embeddingsFix() });
  }
}

export async function prepareManagedFactsSession(ctx: FactsBackstopCtx,
  input: { turnText: string; pageSlug?: string }, derivation?: { trust: WriteTrust; inputs: readonly TaintInput[] }): Promise<ManagedFactsSession | null> {
  const engine = ctx.engine;
  if (!(await managedPersistenceEnabled(engine))) return null;
  assertPersistenceAccepting(engine);
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
    "SELECT incarnation,archived,local_path,config->>'kind' AS kind FROM sources WHERE id=$1", [ctx.sourceId]);
  if (!source || source.archived) throw opError('source_changed', 'The fact extraction source is unavailable.',
    `Source ${ctx.sourceId} is missing or archived, so no facts were extracted. Extract into an active source, or restore ${ctx.sourceId} first (the user's decision).`,
    { fix: readFix('Lists the registered sources with their archived state, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  let authority: WriteAuthority;
  let origin: ManagedFactOrigin | null = null;
  if (ctx.persistenceRequestId) {
    const original = await getWriteRequestById(engine, requireUuid(ctx.persistenceRequestId));
    if (!original || original.state !== 'committed' || original.source_id !== ctx.sourceId || original.source_incarnation !== source.incarnation || original.slug !== input.pageSlug) {
      throw opError('permission_denied', 'Fact extraction requires its original committed page authority.',
        `The page write that triggered fact extraction for ${input.pageSlug ?? 'this turn'} in source ${ctx.sourceId} is not a committed write of that page, so nothing was extracted. Read the write's receipt; facts are extracted only after it commits.`,
        original ? { fix: receiptFix(original.request_id) } : {});
    }
    await authorizeFactsBackstop(engine, original);
    authority = structuredClone(original.authority);
  } else {
    let operation = ctx.operationContext;
    if (!operation) {
      const verified = currentVerifiedLocalWriter();
      const job = currentSubmissionAuthority();
      if (job && job.kind !== 'application' || ctx.remote !== false && !verified && job?.kind !== 'application') {
        throw opError('writer_coordinator_required', 'Managed facts require the original operation or durable job authority before extraction.',
          `Fact extraction for source ${ctx.sourceId} ran outside an operation or durable job, so it has no authority to publish; nothing was extracted. Submit it as the extract_facts operation (an MCP tool call, or gbrain call extract_facts on the brain host).`);
      }
      operation = { engine, remote: verified?.remote ?? false, sourceId: ctx.sourceId, config: { engine: engine.kind } } as OperationContext;
    }
    if (operation.engine !== engine || operation.sourceId && operation.sourceId !== ctx.sourceId) throw opError('permission_denied', 'The extraction context does not match its source.',
      `The calling operation targets ${operation.sourceId ? `source ${operation.sourceId}` : 'another brain'}, but extraction was asked to write into source ${ctx.sourceId}; nothing was extracted. Run the extraction with the same source as its operation.`);
    await initializeLocalPersistence(operation);
    authority = await submissionAuthority(operation, 'extract_facts', ctx.sourceId, source.incarnation, input.pageSlug ?? 'memory/unattributed');
  }
  if (authority.slugPrefixes !== null || authority.restrictedNamespace || authority.delegated) {
    throw opError('permission_denied', 'Multi-entity fact extraction requires an unconfined source grant.',
      `This writer's grant on source ${ctx.sourceId} is limited to slug prefixes, a restricted namespace or a delegation, so it cannot write facts across entities; nothing was extracted. Save a single fact inside the grant with remember, or ask the brain host's operator for a source-wide grant.`,
      { fix: ctx.operationContext
        ? hostFix(ctx.operationContext, opTransport(ctx.operationContext) === 'http' ? ['gbrain', 'auth', 'clients', '--json'] : ['gbrain', 'auth', 'local-writer', 'list', '--json'],
          'Shows the connection\'s current grant so the operator can decide whether to widen it to the whole source.')
        : readFix('Shows the CLI writer registrations and their grants, read-only.', { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] }) });
  }
  await authorizeWrite(engine, authority, 'extract_facts', input.pageSlug ?? 'memory/unattributed');
  for (const hint of ctx.entityHints?.slice(0, ENTITY_HINTS_CAP) ?? []) {
    const resolved = await resolveEntitySlugWithSource(engine, ctx.sourceId, hint);
    if (resolved && resolved.source !== 'fallback_slugify') {
      await authorizeWrite(engine, authority, 'extract_facts', resolved.slug);
      await authorizePageVisibility(engine, authority, resolved.slug);
    }
  }
  if (input.pageSlug) {
    await authorizePageVisibility(engine, authority, input.pageSlug);
    const snapshot = await engine.readPageSnapshot(input.pageSlug, { sourceId: ctx.sourceId });
    if (!snapshot || snapshot.sourceIncarnation !== source.incarnation || snapshot.page.compiled_truth !== input.turnText) {
      throw opError('revision_conflict', 'The source page changed before fact extraction.',
        `Page ${input.pageSlug} in source ${ctx.sourceId} no longer holds the text being extracted, so nothing was extracted. Read the current page and extract from its current text.`,
        { fix: pageFix(ctx.sourceId, input.pageSlug) });
    }
    origin = { slug: input.pageSlug, pageId: snapshot.page.id, revision: snapshot.revision };
    if (ctx.persistenceRequestId) {
      const original = (await getWriteRequestById(engine, ctx.persistenceRequestId))!;
      if (original.outcome?.revision !== snapshot.revision) throw opError('revision_conflict', 'The original page write has been superseded.',
        `A newer write replaced page ${input.pageSlug} in source ${ctx.sourceId} after request ${original.request_id} committed, so facts are not extracted from the superseded revision. Nothing needs resubmitting: the newer revision's write runs its own extraction.`,
        { fix: pageFix(ctx.sourceId, input.pageSlug) });
    }
  }
  const binding = await getWorktreeBinding(engine, ctx.sourceId);
  const root = source.local_path || (ctx.sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  // An unbound connector source is database-only by design (connector_database), like its connector sync.
  const connectorDatabase = writeThrough && !binding && isConnectorSourceKind(source.kind);
  if (writeThrough && root && !binding && !connectorDatabase) throw opError('owner_unavailable', 'The fact source has no canonical owner; extraction has not started.',
    `Source ${ctx.sourceId} has a checkout but no canonical owner, so facts cannot be written through to it. Check writer status; claiming the checkout is the user's decision on the brain host.`,
    { fix: ownerStatusFix(ctx.sourceId) });
  if (writeThrough && binding) {
    if (binding.state !== 'active' || !binding.owner_host_id) throw opError('owner_unavailable', 'The canonical fact writer is unavailable; extraction has not started.',
      `Source ${ctx.sourceId}'s canonical worktree is ${binding.state}, not active, so facts cannot be published yet. Check writer status and extract again once the owner is active.`,
      { fix: ownerStatusFix(ctx.sourceId) });
    if (binding.owner_host_id === localHostId()) {
      if (!await probeWorktreeWriter(binding, engine)) throw opError('writer_lock_unavailable', 'The canonical fact writer is busy; extraction has not started.',
        `Another write holds source ${ctx.sourceId}'s canonical writer. Nothing was admitted, so run the extraction again once the writer is idle (the same request_id is safe).`,
        { fix: ownerStatusFix(ctx.sourceId) });
    }
  }
  if (!writeThrough) authority.databaseOnlyReason = 'disabled_by_config';
  else if (connectorDatabase) authority.databaseOnlyReason = 'connector_database';
  else if (!binding) authority.databaseOnlyReason = 'no_repo_configured';
  const inputDigest = digest(ctx.requestIntent ?? { text: sha256(input.turnText), source: ctx.source, sessionId: ctx.sessionId, entityHints: ctx.entityHints ?? [],
    visibility: ctx.visibility ?? null, validFrom: ctx.validFrom?.toISOString() ?? null, sourceSlug: ctx.sourceSlug ?? null,
    model: ctx.model ?? null, filter: ctx.notabilityFilter ?? 'all' });
  const seed = ctx.persistenceRequestId ?? (ctx.requestId ? requireUuid(ctx.requestId) : inputDigest);
  const batchKey = digest(['managed-facts-v1', authority.principal, source.incarnation, seed]);
  // With no caller config, admit under the config this process's consumer prepares with, so the embedding signature
  // checked at admission is the one checked at preparation (a keyless consumer never receives embedded facts).
  const config = ctx.operationContext?.config ?? ctx.config ?? persistenceConsumerConfig(engine) ?? { engine: engine.kind } as GBrainConfig;
  const session: ManagedFactsSession = { authority, binding: writeThrough ? binding : null, config,
    batchKey, inputDigest, origin, originalRequestId: ctx.persistenceRequestId ?? null,
    completionRequestId: ctx.requestId ? requireUuid(ctx.requestId) : managedFactRequestId(batchKey, '__managed_facts_complete__'),
    // #7439: a page-triggered job keeps its write's batch identity on retry, so its retained file refusal is
    // rechecked once the hold clears instead of replayed forever. #7402: a caller's explicit request_id keeps
    // returning its own recorded outcome, so it never rechecks.
    fileRefusalRetry: !ctx.requestId && (!!ctx.persistenceRequestId || ctx.reAdmitFileRefusals === true && seed === inputDigest),
    inputKeyed: seed === inputDigest,
    wait: new MaintenanceWriteWait(ctx.deadlineAtMs ?? null), ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    ...(captureGateLaneForSource(ctx.source) ? { captureSource: ctx.source } : {}),
    ...(derivation ? { derivation: declareDerivation(derivation.trust, derivation.inputs) } : {}) };
  const prior = await getWriteRequest(engine, authority.principal, session.completionRequestId);
  if (prior) await validateManagedFactsCompletion(engine, session, prior);
  return session;
}

/**
 * GBRA-130 A-36: codes one entity request ends on for reasons of its own page (changed, segmented, fence or content
 * refused). Automatic extraction reports them under `refused` and keeps the committed entities' counts. A file-check
 * refusal (`source_changed`) and a withdrawal refusal are not among them: they keep the batch refused, so the
 * follow-up walks (#6048, #6506) re-admit their retained facts once the cause clears. An automatic extraction follows a
 * `revision_conflict` whose entity page moved (#7602, followEntityMoves) before it reports it.
 */
const ENTITY_REFUSAL_CODES: ReadonlySet<string> = new Set(['revision_conflict', 'invalid_fence', 'target_fence_malformed', 'page_body_segmented',
  'invalid_params', 'page_identity_changed', 'page_not_found', 'request_too_large', 'payload_too_large']);

/**
 * Every row is awaited and collected before anything throws. A refused entity (ENTITY_REFUSAL_CODES) is reported when
 * the session asks for it and another entity committed, and the completion receipt that only says the batch is
 * incomplete is not a failure of its own; any other terminal row, then a still-pending one, then a refusal with
 * nothing committed beside it, throws as its receipt.
 */
async function collectManagedFacts(engine: BrainEngine, session: ManagedFactsSession, rows: WriteRequest[]): Promise<ManagedFactsResult> {
  const result: ManagedFactsResult = { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [], write_requests: [] };
  const refused: WriteRequest[] = [];
  let pending: WriteRequest | null = null;
  let failed: WriteRequest | null = null;
  let committed = 0;
  for (const row of rows) {
    if ((row.intent?.inputDigest ?? row.outcome?.input_digest) !== session.inputDigest) throw opError('idempotency_conflict', 'The fact request ID was already used with different extraction input.',
      `Request ${row.request_id} in source ${row.source_id} was accepted for different extraction input, so this extraction was not merged into it. Give this extraction a new request_id; read the receipt to see the original.`,
      { fix: receiptFix(row.request_id) });
    await authorizeStoredRequest(engine, row);
    const finished = session.wait.observe((await awaitWrite(engine, row, session.config, { waitMs: session.wait.ms(), signal: session.signal })).row);
    result.write_requests.push(receiptFor(finished));
    if (finished.state !== 'committed') {
      if (!isTerminal(finished)) pending ??= finished;
      else if (isEntityRequest(finished) && ENTITY_REFUSAL_CODES.has(finished.error_code ?? '') && !withdrawalRefusal(finished)) refused.push(finished);
      else if (isEntityRequest(finished) || !refused.length || finished.error_message !== FACTS_BATCH_INCOMPLETE_MESSAGE) failed ??= finished;
      continue;
    }
    if (isEntityRequest(row)) {
      committed++;
      const out = finished.outcome!;
      result.inserted += Number(out.inserted ?? 0);
      result.duplicate += Number(out.duplicate ?? 0);
      result.superseded += Number(out.superseded ?? 0);
      result.fact_ids.push(...(out.fact_ids as number[] ?? []));
      if (out.withdrawn_skipped) result.withdrawn_skipped = (result.withdrawn_skipped ?? 0) + Number(out.withdrawn_skipped);
      if (out.would_dedup_same_page) result.would_dedup_same_page = (result.would_dedup_same_page ?? 0) + Number(out.would_dedup_same_page);
      if (out.inserted && out.fenced && !result.entity_slugs.includes(row.slug)) result.entity_slugs.push(row.slug);
    }
  }
  for (const row of [failed, pending]) if (row) writeResponse(row);
  // #7602: the refusal stands after every follow-up walk, so a retry replays the same stored receipt.
  if (refused.length && !(session.reportRefusals && committed)) {
    try {
      writeResponse(refused[0]);
    } catch (error) {
      if (error instanceof OperationError) error.retryable = false;
      throw error;
    }
  }
  if (refused.length) result.refused = refused.map(row => ({ slug: row.slug, code: row.error_code!, request_id: row.request_id }));
  return result;
}

export async function resumeManagedFacts(engine: BrainEngine, session: ManagedFactsSession): Promise<ManagedFactsResult | null> {
  const stored = await storedBatch(engine, session);
  if (!stored) return null;
  const files = session.fileRefusalRetry ? await followFileRefusals(engine, session, stored) : stored;
  const rows = session.inputKeyed ? await followWithdrawalRefusals(engine, session, files) : files;
  return collectManagedFacts(engine, session, session.entityMoveRetry ? await followEntityMoves(engine, session, rows) : rows);
}

/** Every request journaled under the session's batch key, once its completion receipt validates; null when nothing was accepted. */
async function storedBatch(engine: BrainEngine, session: ManagedFactsSession): Promise<WriteRequest[] | null> {
  const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE operation='extract_facts'
    AND source_id=$1 AND source_incarnation=$2::uuid AND principal_kind=$3 AND principal_id=$4
    AND (request_id=$6::uuid OR COALESCE(intent->>'batchKey',outcome->>'batch_key')=$5) ORDER BY sequence`, [session.authority.sourceId, session.authority.sourceIncarnation,
    session.authority.principal.kind, session.authority.principal.id, session.batchKey, session.completionRequestId]);
  if (!rows.length) return null;
  const completion = rows.find(row => row.request_id === session.completionRequestId);
  if (!completion) throw opError('storage_error', 'The accepted facts batch has no completion receipt.',
    `Facts batch requests were accepted in source ${session.authority.sourceId} but their completion request ${session.completionRequestId} was never journaled, so the outcome is unconfirmed. Inspect accepted request ${rows[0].request_id} before resubmitting anything.`,
    { fix: receiptFix(rows[0].request_id) });
  await validateManagedFactsCompletion(engine, session, completion);
  return rows;
}

const isEntityRequest = (row: WriteRequest) => (row.intent?.kind ?? row.outcome?.kind) === 'managed_facts_entity';

/**
 * #6048, #7439: an input-keyed batch (the sweep has no request id to give a window)
 * and a page-triggered job's batch (keyed by its write) would replay a terminal
 * file-check refusal forever. Walk the follow-up
 * batches instead: while every request of the latest one is terminal and each
 * uncommitted entity request is a `source_changed` refusal that kept its facts,
 * look for the next follow-up, or admit it when every refused page now passes
 * the file check. Returns the committed entity requests of earlier batches and
 * all requests of the latest one, for collectManagedFacts to report.
 */
async function followFileRefusals(engine: BrainEngine, session: ManagedFactsSession, stored: WriteRequest[]): Promise<WriteRequest[]> {
  return followRefusals(engine, session, stored, 'file-refusal-retry', row => row.error_code === 'source_changed', readmitRefusedFacts);
}

/**
 * #6506 (UC1): the same walk for an input-keyed batch whose entity request was
 * refused because a candidate's exact claim had been forgotten. Older batches
 * were admitted before automatic extraction skipped withdrawn candidates, so
 * the stored refusal (`invalid_params` with the fact_withdrawn message, or the
 * typed `error_detail.origin = 'withdrawal'`, which a withdrawal committed
 * between preparation and locked validation also leaves) would replay on every
 * run of the unchanged input. The follow-up re-admits the retained facts under
 * `withdrawn: 'skip'`; no extraction runs again and the historical receipts
 * stay as they were.
 */
async function followWithdrawalRefusals(engine: BrainEngine, session: ManagedFactsSession, stored: WriteRequest[]): Promise<WriteRequest[]> {
  return followRefusals(engine, session, stored, 'withdrawal-retry', withdrawalRefusal, readmitWithdrawnFacts);
}

/**
 * #7602: two extractions target one entity page and the other publishes first, so this batch's entity request, admitted
 * at the revision it read, is refused `revision_conflict` at preparation or publication. The retained facts never
 * depended on the entity's content: the follow-up re-admits them at the page's current revision, no extraction runs
 * again, and the historical receipt stays as it was. A page deleted or replaced since keeps the refusal. Each batch is
 * settled first, so a follow-up that loses the race again is followed within the same run.
 */
async function followEntityMoves(engine: BrainEngine, session: ManagedFactsSession, rows: WriteRequest[]): Promise<WriteRequest[]> {
  const settle = async (batch: WriteRequest[]) => {
    const settled: WriteRequest[] = [];
    for (const row of batch) settled.push(isTerminal(row) ? row
      : session.wait.observe((await awaitWrite(engine, row, session.config, { waitMs: session.wait.ms(), signal: session.signal })).row));
    return settled;
  };
  return followRefusals(engine, session, await settle(rows), 'entity-moved-retry', isEntityMovedRefusal, readmitMovedFacts, settle);
}

function withdrawalRefusal(row: WriteRequest): boolean {
  return withdrawnFromDetail(row.error_detail) !== undefined || row.error_code === 'invalid_params' && row.error_message === FACT_WITHDRAWN_MESSAGE;
}

/**
 * While every request of the latest batch is terminal and each uncommitted
 * entity request is a `refused` refusal that kept its facts for this input,
 * look for the next follow-up batch (`digest([batchKey, label, n])`), or admit
 * it through `readmit`, at most MAX_FILE_REFUSAL_RETRIES times. With `settle`
 * (partial mode), only the matching refusals are followed, each admitted batch
 * is settled before the next look, and every other entity request of the batch,
 * and a matching one `readmit` left out, is carried as it stands.
 */
async function followRefusals(engine: BrainEngine, session: ManagedFactsSession, stored: WriteRequest[], label: string,
  refused: (row: WriteRequest) => boolean,
  readmit: (engine: BrainEngine, followUp: ManagedFactsSession, refused: WriteRequest[]) => Promise<WriteRequest[] | null>,
  settle?: (batch: WriteRequest[]) => Promise<WriteRequest[]>): Promise<WriteRequest[]> {
  const carried: WriteRequest[] = [];
  let latest = stored;
  for (let retry = 1; retry <= MAX_FILE_REFUSAL_RETRIES; retry++) {
    if (latest.some(row => !isTerminal(row))) break;
    const uncommitted = latest.filter(row => isEntityRequest(row) && row.state !== 'committed');
    const followed = uncommitted.filter(row => refused(row) && (row.intent as ManagedFactIntent | null)?.facts?.length
      && (row.intent as ManagedFactIntent).inputDigest === session.inputDigest);
    const retained = followed.map(row => row.intent as ManagedFactIntent);
    if (!followed.length || !settle && followed.length !== uncommitted.length
      || retained.some(intent => !sameSignature(intent.embedding, retained[0]!.embedding))) break;
    const followUpKey = digest([session.batchKey, label, retry]);
    const followUp: ManagedFactsSession = { ...session, batchKey: followUpKey, embedding: retained[0]!.embedding ?? null,
      completionRequestId: managedFactRequestId(followUpKey, '__managed_facts_complete__') };
    const admitted = await storedBatch(engine, followUp) ?? await readmit(engine, followUp, followed);
    if (!admitted) break;
    carried.push(...latest.filter(row => isEntityRequest(row)
      && (row.state === 'committed' || !followed.includes(row) || !admitted.some(next => next.slug === row.slug))));
    latest = settle ? await settle(admitted) : admitted;
  }
  return [...carried, ...latest];
}

function sameSignature(a: FactEmbeddingSignature | null | undefined, b: FactEmbeddingSignature | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * #6048: admit the refused requests' retained facts as `followUp`, or return
 * null (nothing admitted) while any refused page still fails the canonical
 * file check. Each refused request must still be authorized under its stored
 * authority and its page under the current writer grant; facts target the
 * page's current revision and are never wider than the current default
 * visibility. No extraction runs again.
 */
async function readmitRefusedFacts(engine: BrainEngine, followUp: ManagedFactsSession, refused: WriteRequest[]): Promise<WriteRequest[] | null> {
  const { sourceId, remote } = followUp.authority;
  const activePack = (await loadActivePackForEngine(engine, { remote, sourceId }).catch(() => null))?.manifest;
  const privateOnly = await resolveDefaultVisibility(engine) === 'private';
  const entities: ManagedFactsEntityInput[] = [];
  for (const row of refused) {
    await authorizeStoredRequest(engine, row);
    await authorizeWrite(engine, followUp.authority, 'extract_facts', row.slug);
    const page = await engine.readPageSnapshot(row.slug, { sourceId });
    if (!page) return null;
    try {
      await prepareFileTarget(engine, { source_id: sourceId, worktree_id: followUp.binding?.worktree_id ?? null, slug: row.slug }, page, null, undefined, { activePack, remote });
    } catch (refusal) {
      if (refusal instanceof OperationError) return null;
      throw refusal;
    }
    const { expected_revision: _refusedRevision, facts, ...kept } = row.intent as ManagedFactIntent;
    entities.push({ slug: row.slug, pageId: page.page.id, intent: { ...kept, batchKey: followUp.batchKey, expected_revision: page.revision,
      facts: privateOnly ? facts!.map(fact => ({ ...fact, visibility: 'private' as const })) : facts } });
  }
  return admitManagedFactsBatch(engine, followUp, regroupParts(followUp.batchKey, entities), entities.some(entity => entity.intent.facts!.some(fact => fact.embedding != null)));
}

/**
 * #6506: admit the refused requests' retained facts as `followUp` with
 * `withdrawn: 'skip'`. Each refused request must still be authorized under
 * its stored authority and its page under the current writer grant; facts
 * target the entity page's current revision (the retained origin revision is
 * re-checked at preparation) and are never wider than the current default
 * visibility. No extraction runs again.
 */
async function readmitWithdrawnFacts(engine: BrainEngine, followUp: ManagedFactsSession, refused: WriteRequest[]): Promise<WriteRequest[] | null> {
  const { sourceId } = followUp.authority;
  const narrowed = await retainedVisibility(engine, sourceId);
  const entities: ManagedFactsEntityInput[] = [];
  for (const row of refused) {
    await authorizeStoredRequest(engine, row);
    await authorizeWrite(engine, followUp.authority, 'extract_facts', row.slug);
    const page = await engine.readPageSnapshot(row.slug, { sourceId });
    const { expected_revision: _refusedRevision, facts, ...kept } = row.intent as ManagedFactIntent;
    if (!page && (row.page_id !== null || facts!.some(fact => fact.entity_slug === row.slug))) return null;
    entities.push({ slug: row.slug, pageId: page?.page.id ?? null, intent: { ...kept, batchKey: followUp.batchKey, withdrawn: 'skip',
      ...(page ? { expected_revision: page.revision } : {}), facts: await Promise.all(facts!.map(narrowed)) } });
  }
  return admitManagedFactsBatch(engine, followUp, regroupParts(followUp.batchKey, entities), entities.some(entity => entity.intent.facts!.some(fact => fact.embedding != null)));
}

/**
 * Retained facts are never wider than the current default visibility. A fact forgotten at its retained visibility keeps
 * that visibility, so preparation skips and counts it; narrowing it to private would re-save a forgotten claim under a
 * visibility the ledger never covered.
 */
async function retainedVisibility(engine: BrainEngine, sourceId: string): Promise<(fact: FrozenExtractedFact) => Promise<FrozenExtractedFact>> {
  const privateOnly = await resolveDefaultVisibility(engine) === 'private';
  return async fact => privateOnly && fact.visibility !== 'private'
    && !await isFactWithdrawn(engine, sourceId, fact.visibility ?? 'private', fact.fact, fact.entity_slug ?? null) ? { ...fact, visibility: 'private' } : fact;
}

/**
 * #7602: admit the refused requests' retained facts as `followUp` at each entity page's current revision. A request whose
 * page was deleted or replaced since admission is left out and keeps its refusal; null when none is left. Each refused request must still be authorized
 * under its stored authority and its page under the current writer grant; the retained intent is otherwise kept as
 * admitted. No extraction runs again.
 */
async function readmitMovedFacts(engine: BrainEngine, followUp: ManagedFactsSession, refused: WriteRequest[]): Promise<WriteRequest[] | null> {
  const { sourceId } = followUp.authority;
  const narrowed = await retainedVisibility(engine, sourceId);
  const entities: ManagedFactsEntityInput[] = [];
  for (const row of refused) {
    await authorizeStoredRequest(engine, row);
    await authorizeWrite(engine, followUp.authority, 'extract_facts', row.slug);
    const page = await engine.readPageSnapshot(row.slug, { sourceId });
    if ((page?.page.id ?? null) !== row.page_id) continue;
    const { expected_revision: _movedRevision, facts, ...kept } = row.intent as ManagedFactIntent;
    entities.push({ slug: row.slug, pageId: row.page_id, intent: { ...kept, batchKey: followUp.batchKey,
      ...(page ? { expected_revision: page.revision } : {}), facts: await Promise.all(facts!.map(narrowed)) } });
  }
  if (!entities.length) return null;
  return admitManagedFactsBatch(engine, followUp, regroupParts(followUp.batchKey, entities), entities.some(entity => entity.intent.facts!.some(fact => fact.embedding != null)));
}

export async function publishManagedFacts(engine: BrainEngine, session: ManagedFactsSession, ctx: FactsBackstopCtx,
  facts: ExtractedFact[], visibility: 'private' | 'world', pageSlug?: string,
  options: { supersede?: boolean; explicitContext?: boolean; attributeFallback?: boolean; withdrawn?: 'skip' } = {}): Promise<ManagedFactsResult> {
  const embedded = facts.some(fact => fact.embedding !== null && fact.embedding !== undefined);
  if (embedded) await assertManagedFactsEmbedding(engine, session.config, session.embedding);
  const sourceId = session.authority.sourceId;
  const groups = new Map<string, FrozenExtractedFact[]>();
  for (const fact of facts) {
    if (ctx.abortSignal?.aborted) throw new DOMException('Fact extraction was aborted before admission.', 'AbortError');
    if (ctx.notabilityFilter === 'high-only' && fact.notability !== 'high' || ctx.notabilityFilter === 'medium-and-up' && fact.notability === 'low') continue;
    const resolved = fact.entity_slug ? await resolveEntitySlugWithSource(engine, sourceId, fact.entity_slug) : null;
    const entitySlug = resolved && resolved.source !== 'fallback_slugify' ? resolved.slug : null;
    const slug = entitySlug ?? 'memory/unattributed';
    const attributed = entitySlug ?? (options.attributeFallback && resolved ? resolved.slug : null);
    await authorizeWrite(engine, session.authority, 'extract_facts', slug);
    await authorizePageVisibility(engine, session.authority, slug);
    const group = groups.get(slug) ?? [];
    const context = options.explicitContext ? fact.context ?? null : ctx.sourceSlug ?? pageSlug ?? null;
    // #5836: an inferred subject carries its provenance note into the fence cell and the row.
    group.push({ ...fact, entity_slug: attributed, visibility, context: fact.entity_inferred ? appendContextNote(context, inferenceNote(fact.entity_inferred)) : context,
      embedding: fact.embedding ? Array.from(fact.embedding) : null,
      valid_from: (factEventTime(fact, ctx) ?? new Date()).toISOString(), valid_until: fact.valid_until?.toISOString() ?? null });
    groups.set(slug, group);
  }
  const inputs: ManagedFactsEntityInput[] = [];
  for (const [slug, group] of groups) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    if (snapshot?.page.deleted_at || group.some(fact => fact.entity_slug === slug) && !snapshot) throw opError('page_identity_changed', 'The resolved fact entity was removed.',
      `Entity page ${slug} in source ${sourceId} was deleted after the facts were resolved to it, so nothing was admitted. Run the extraction again (the same request_id is safe: nothing was accepted); it resolves entities against the current pages.`,
      { fix: pageFix(sourceId, slug) });
    const intent: ManagedFactIntent = { kind: 'managed_facts_entity', batchKey: session.batchKey,
      inputDigest: session.inputDigest, origin: session.origin, originalRequestId: session.originalRequestId,
      embedding: session.embedding ?? null, ...(options.supersede ? { supersede: true as const } : {}),
      ...(options.attributeFallback ? { attribute_fallback: true as const } : {}),
      ...(options.withdrawn === 'skip' ? { withdrawn: 'skip' as const } : {}),
      ...(session.captureSource ? { capture_source: session.captureSource } : {}),
      ...(session.derivation ? { derivation: session.derivation } : {}),
      ...(snapshot ? { expected_revision: snapshot.revision } : {}), facts: group };
    inputs.push(...entityParts(session.batchKey, { slug, pageId: snapshot?.page.id ?? null, intent }));
  }
  const admitted = await admitManagedFactsBatch(engine, session, inputs, embedded, ctx.abortSignal);
  return collectManagedFacts(engine, session, session.entityMoveRetry ? await followEntityMoves(engine, session, admitted) : admitted);
}

interface ManagedFactsEntityInput { slug: string; pageId: number | null; intent: ManagedFactIntent }

/**
 * #6898 follow-up: one entity's facts as requests of at most MANAGED_FACTS_PUBLICATION_MAX facts. A group
 * within the cap stays one request, exactly as before. Every part targets the revision the batch read; a
 * later part also accepts the revision its committed predecessor left (facts-prepare.ts).
 */
/** A follow-up batch re-admits refused parts: an entity's retained facts are rejoined in part order and split again. */
function regroupParts(batchKey: string, inputs: ManagedFactsEntityInput[]): ManagedFactsEntityInput[] {
  const bySlug = new Map<string, ManagedFactsEntityInput>();
  for (const { intent: { part: _part, ...intent }, ...input } of inputs) {
    const seen = bySlug.get(input.slug);
    bySlug.set(input.slug, seen ? { ...seen, intent: { ...seen.intent, facts: [...seen.intent.facts!, ...intent.facts!] } } : { ...input, intent });
  }
  return [...bySlug.values()].flatMap(input => entityParts(batchKey, input));
}

function entityParts(batchKey: string, input: ManagedFactsEntityInput): ManagedFactsEntityInput[] {
  const facts = input.intent.facts!;
  if (facts.length <= MANAGED_FACTS_PUBLICATION_MAX) return [input];
  const of = Math.ceil(facts.length / MANAGED_FACTS_PUBLICATION_MAX);
  const ids = Array.from({ length: of }, (_, i) => managedFactRequestId(batchKey, input.slug, i + 1));
  return ids.map((_, i) => ({ ...input, intent: { ...input.intent,
    facts: facts.slice(i * MANAGED_FACTS_PUBLICATION_MAX, (i + 1) * MANAGED_FACTS_PUBLICATION_MAX),
    part: { index: i + 1, of, deferred_facts: Math.max(0, facts.length - (i + 1) * MANAGED_FACTS_PUBLICATION_MAX), follow_up: ids.slice(i + 1) } } }));
}

/** One transaction: the session's per-entity fact requests, then the completion request that names them. */
async function admitManagedFactsBatch(engine: BrainEngine, session: ManagedFactsSession, inputs: ManagedFactsEntityInput[],
  embedded: boolean, signal?: AbortSignal): Promise<WriteRequest[]> {
  const sourceId = session.authority.sourceId;
  return engine.transaction(async tx => {
    await assertAmbientCaptureAdmissible(tx, session.captureSource);
    if (embedded) await assertManagedFactsEmbedding(tx, session.config, session.embedding, true);
    const children: string[] = [];
    const accepted: WriteRequest[] = [];
    for (const input of [...inputs, { slug: '__managed_facts_complete__', pageId: null, intent: {
      kind: 'managed_facts_complete', batchKey: session.batchKey, inputDigest: session.inputDigest,
      origin: session.origin, originalRequestId: session.originalRequestId, children,
      ...(session.captureSource ? { capture_source: session.captureSource } : {}) } as ManagedFactIntent }]) {
      if (signal?.aborted) throw new DOMException('Fact extraction was aborted before admission.', 'AbortError');
      await authorizePageVisibility(tx, session.authority, input.slug);
      const requestId = input.intent.kind === 'managed_facts_complete' ? session.completionRequestId
        : managedFactRequestId(session.batchKey, input.slug, input.intent.part?.index);
      const row = await admitWriteInTransaction(tx, { principal: session.authority.principal, authority: session.authority,
        operation: 'extract_facts', sourceId, sourceIncarnation: session.authority.sourceIncarnation,
        worktreeId: session.binding?.worktree_id, topologyGeneration: session.binding?.topology_generation,
        requestId, slug: input.slug, pageId: input.pageId, callerIntent: input.intent, intent: input.intent });
      accepted.push(row);
      if (input.intent.kind === 'managed_facts_entity') children.push(row.id);
    }
    return accepted;
  });
}

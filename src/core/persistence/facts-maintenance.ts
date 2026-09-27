import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { FactsBackstopCtx } from '../facts/backstop.ts';
import { ENTITY_HINTS_CAP, type ExtractedFact, type FactEmbeddingSignature } from '../facts/extract.ts';
import { readFactsEmbeddingDim } from '../embedding-dim-check.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { authorizeStoredRequest, authorizeWrite, submissionAuthority } from './authority.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { initializeLocalPersistence } from './page-mutations.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { acquireWorktree, getWorktreeBinding, managedPersistenceEnabled, type WorktreeBinding } from './ownership.ts';
import { authorizeFactsBackstop } from './effect-facts.ts';
import { admitWriteInTransaction, getWriteRequest, getWriteRequestById, receiptFor } from './journal.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';
import { digest, requireUuid, sha256 } from './digest.ts';
import { isTerminal, type WriteAuthority, type WriteRequest } from './model.ts';
import type { WriteReceipt } from './types.ts';

export interface ManagedFactsResult {
  inserted: number; duplicate: number; superseded: number; fact_ids: number[]; entity_slugs: string[]; write_requests: WriteReceipt[];
}
export interface ManagedFactOrigin { slug: string; pageId: number; revision: string; }
export type FrozenExtractedFact = Omit<NewFact, 'embedding' | 'valid_from' | 'valid_until' | 'expired_at'> & {
  embedding: number[] | null; valid_from: string; valid_until: string | null;
};
export interface ManagedFactIntent extends Record<string, unknown> {
  kind: 'managed_facts_entity' | 'managed_facts_complete';
  batchKey: string; inputDigest: string; origin: ManagedFactOrigin | null; originalRequestId: string | null;
  expected_revision?: string; facts?: FrozenExtractedFact[]; children?: string[];
  embedding?: FactEmbeddingSignature | null;
}
export interface ManagedFactsSession {
  authority: WriteAuthority; binding: WorktreeBinding | null; config: GBrainConfig;
  batchKey: string; inputDigest: string; origin: ManagedFactOrigin | null; originalRequestId: string | null;
  completionRequestId: string;
  embedding?: FactEmbeddingSignature | null;
}

function managedFactRequestId(batchKey: string, slug: string): string {
  const hex = digest([batchKey, slug]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function validateManagedFactsCompletion(engine: BrainEngine, session: ManagedFactsSession, prior: WriteRequest): Promise<void> {
  await authorizeStoredRequest(engine, prior);
  const inputDigest = prior.intent?.inputDigest ?? prior.outcome?.input_digest;
  if (prior.operation !== 'extract_facts' || prior.slug !== '__managed_facts_complete__'
    || prior.source_id !== session.authority.sourceId || prior.source_incarnation !== session.authority.sourceIncarnation
    || inputDigest !== undefined && inputDigest !== session.inputDigest) {
    throw new OperationError('idempotency_conflict', 'This request ID already belongs to another operation or extraction input.');
  }
  if (prior.compacted && !prior.intent && isTerminal(prior) && prior.state !== 'committed') {
    const error = new OperationError('facts_payload_expired', 'The accepted fact extraction failed and its retained payload has expired.',
      'Inspect the original receipt. Any new extraction requires separate approval and a new request identity.');
    error.writeRequest = receiptFor(prior);
    throw error;
  }
  if (inputDigest !== session.inputDigest) throw new OperationError('idempotency_conflict', 'The retained fact request cannot verify this extraction input.');
}

export async function resolveManagedFactsEmbedding(engine: BrainEngine, config: GBrainConfig,
  lock = false): Promise<FactEmbeddingSignature | null> {
  const rows = await engine.executeRaw<{ key: string; value: string }>(`SELECT key,value FROM config
    WHERE key IN ('embedding_model','embedding_dimensions','embedding_disabled') ORDER BY key${lock ? ' FOR SHARE' : ''}`);
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  if (values.embedding_disabled !== undefined && values.embedding_disabled !== 'true' && values.embedding_disabled !== 'false') {
    throw new OperationError('embedding_configuration', 'Selected brain embedding_disabled must be true or false.');
  }
  if (config.embedding_disabled || values.embedding_disabled === 'true') return null;
  const model = values.embedding_model;
  if (!model) return null;
  const dimensions = /^[1-9]\d*$/.test(values.embedding_dimensions ?? '') ? Number(values.embedding_dimensions) : null;
  if (!/^[^\s:]+:[^\s]+$/.test(model) || !dimensions || !Number.isSafeInteger(dimensions)) {
    throw new OperationError('embedding_configuration', 'The selected brain has no verifiable facts embedding model and dimensions.');
  }
  const shape = await readFactsEmbeddingDim(engine);
  if (!shape.exists || !shape.columnType || shape.dims !== dimensions) {
    throw new OperationError('embedding_configuration', 'The selected brain facts embedding provenance does not match its vector column.');
  }
  return { model, dimensions };
}

export async function assertManagedFactsEmbedding(engine: BrainEngine, config: GBrainConfig,
  expected: FactEmbeddingSignature | null | undefined, lock = false): Promise<void> {
  const current = await resolveManagedFactsEmbedding(engine, config, lock);
  if (!expected || !current || expected.model !== current.model || expected.dimensions !== current.dimensions) {
    throw new OperationError('embedding_configuration', 'The selected brain facts embedding policy or model changed; retained vectors cannot be installed.');
  }
}

export async function prepareManagedFactsSession(ctx: FactsBackstopCtx,
  input: { turnText: string; pageSlug?: string }): Promise<ManagedFactsSession | null> {
  const engine = ctx.engine;
  if (!(await managedPersistenceEnabled(engine))) return null;
  assertPersistenceAccepting(engine);
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null }>(
    'SELECT incarnation,archived,local_path FROM sources WHERE id=$1', [ctx.sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The fact extraction source is unavailable.');
  let authority: WriteAuthority;
  let origin: ManagedFactOrigin | null = null;
  if (ctx.persistenceRequestId) {
    const original = await getWriteRequestById(engine, requireUuid(ctx.persistenceRequestId));
    if (!original || original.state !== 'committed' || original.source_id !== ctx.sourceId || original.source_incarnation !== source.incarnation || original.slug !== input.pageSlug) {
      throw new OperationError('permission_denied', 'Fact extraction requires its original committed page authority.');
    }
    await authorizeFactsBackstop(engine, original);
    authority = structuredClone(original.authority);
  } else {
    let operation = ctx.operationContext;
    if (!operation) {
      const verified = currentVerifiedLocalWriter();
      const job = currentSubmissionAuthority();
      if (job && job.kind !== 'application' || ctx.remote !== false && !verified && job?.kind !== 'application') {
        throw new OperationError('writer_coordinator_required', 'Managed facts require the original operation or durable job authority before extraction.');
      }
      operation = { engine, remote: verified?.remote ?? false, sourceId: ctx.sourceId, config: { engine: engine.kind } } as OperationContext;
    }
    if (operation.engine !== engine || operation.sourceId && operation.sourceId !== ctx.sourceId) throw new OperationError('permission_denied', 'The extraction context does not match its source.');
    await initializeLocalPersistence(operation);
    authority = await submissionAuthority(operation, 'extract_facts', ctx.sourceId, source.incarnation, input.pageSlug ?? 'memory/unattributed');
  }
  if (authority.slugPrefixes !== null || authority.restrictedNamespace || authority.delegated) {
    throw new OperationError('permission_denied', 'Multi-entity fact extraction requires an unconfined source grant.');
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
      throw new OperationError('revision_conflict', 'The source page changed before fact extraction.');
    }
    origin = { slug: input.pageSlug, pageId: snapshot.page.id, revision: snapshot.revision };
    if (ctx.persistenceRequestId) {
      const original = (await getWriteRequestById(engine, ctx.persistenceRequestId))!;
      if (original.outcome?.revision !== snapshot.revision) throw new OperationError('revision_conflict', 'The original page write has been superseded.');
    }
  }
  const binding = await getWorktreeBinding(engine, ctx.sourceId);
  const root = source.local_path || (ctx.sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  if (writeThrough && root && !binding) throw new OperationError('owner_unavailable', 'The fact source has no canonical owner; extraction has not started.');
  if (writeThrough && binding) {
    if (binding.state !== 'active' || !binding.owner_host_id) throw new OperationError('owner_unavailable', 'The canonical fact writer is unavailable; extraction has not started.');
    if (binding.owner_host_id === localHostId()) {
      const lock = await acquireWorktree(binding);
      if (!lock) throw new OperationError('writer_lock_unavailable', 'The canonical fact writer is busy; extraction has not started.');
      await lock.release();
    }
  }
  if (!writeThrough) authority.databaseOnlyReason = 'disabled_by_config';
  else if (!binding) authority.databaseOnlyReason = 'no_repo_configured';
  const inputDigest = digest(ctx.requestIntent ?? { text: sha256(input.turnText), source: ctx.source, sessionId: ctx.sessionId, entityHints: ctx.entityHints ?? [],
    visibility: ctx.visibility ?? null, validFrom: ctx.validFrom?.toISOString() ?? null, sourceSlug: ctx.sourceSlug ?? null,
    model: ctx.model ?? null, filter: ctx.notabilityFilter ?? 'all' });
  const seed = ctx.persistenceRequestId ?? (ctx.requestId ? requireUuid(ctx.requestId) : inputDigest);
  const batchKey = digest(['managed-facts-v1', authority.principal, source.incarnation, seed]);
  const session: ManagedFactsSession = { authority, binding: writeThrough ? binding : null, config: ctx.operationContext?.config ?? ctx.config ?? { engine: engine.kind } as GBrainConfig,
    batchKey, inputDigest, origin, originalRequestId: ctx.persistenceRequestId ?? null,
    completionRequestId: ctx.requestId ? requireUuid(ctx.requestId) : managedFactRequestId(batchKey, '__managed_facts_complete__') };
  const prior = await getWriteRequest(engine, authority.principal, session.completionRequestId);
  if (prior) await validateManagedFactsCompletion(engine, session, prior);
  return session;
}

async function collectManagedFacts(engine: BrainEngine, session: ManagedFactsSession, rows: WriteRequest[]): Promise<ManagedFactsResult> {
  const result: ManagedFactsResult = { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [], write_requests: [] };
  for (const row of rows) {
    if ((row.intent?.inputDigest ?? row.outcome?.input_digest) !== session.inputDigest) throw new OperationError('idempotency_conflict', 'The fact request ID was already used with different extraction input.');
    await authorizeStoredRequest(engine, row);
    const finished = await waitForWrite(engine, row, session.config);
    writeResponse(finished);
    result.write_requests.push(receiptFor(finished));
    if ((row.intent?.kind ?? row.outcome?.kind) === 'managed_facts_entity') {
      const out = finished.outcome!;
      result.inserted += Number(out.inserted ?? 0);
      result.duplicate += Number(out.duplicate ?? 0);
      result.fact_ids.push(...(out.fact_ids as number[] ?? []));
      if (out.inserted && out.fenced) result.entity_slugs.push(row.slug);
    }
  }
  return result;
}

export async function resumeManagedFacts(engine: BrainEngine, session: ManagedFactsSession): Promise<ManagedFactsResult | null> {
  const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE operation='extract_facts'
    AND source_id=$1 AND source_incarnation=$2::uuid AND principal_kind=$3 AND principal_id=$4
    AND (request_id=$6::uuid OR COALESCE(intent->>'batchKey',outcome->>'batch_key')=$5) ORDER BY sequence`, [session.authority.sourceId, session.authority.sourceIncarnation,
    session.authority.principal.kind, session.authority.principal.id, session.batchKey, session.completionRequestId]);
  if (!rows.length) return null;
  const completion = rows.find(row => row.request_id === session.completionRequestId);
  if (!completion) throw new OperationError('storage_error', 'The accepted facts batch has no completion receipt.');
  await validateManagedFactsCompletion(engine, session, completion);
  return collectManagedFacts(engine, session, rows);
}

export async function publishManagedFacts(engine: BrainEngine, session: ManagedFactsSession, ctx: FactsBackstopCtx,
  facts: ExtractedFact[], visibility: 'private' | 'world', pageSlug?: string): Promise<ManagedFactsResult> {
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
    await authorizeWrite(engine, session.authority, 'extract_facts', slug);
    await authorizePageVisibility(engine, session.authority, slug);
    const group = groups.get(slug) ?? [];
    group.push({ ...fact, entity_slug: entitySlug, visibility, context: ctx.sourceSlug ?? pageSlug ?? null,
      embedding: fact.embedding ? Array.from(fact.embedding) : null,
      valid_from: (fact.valid_from ?? ctx.validFrom ?? new Date()).toISOString(), valid_until: fact.valid_until?.toISOString() ?? null });
    groups.set(slug, group);
  }
  const inputs: Array<{ slug: string; pageId: number | null; intent: ManagedFactIntent }> = [];
  for (const [slug, group] of groups) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    if (snapshot?.page.deleted_at || group.some(fact => fact.entity_slug !== null) && !snapshot) throw new OperationError('page_identity_changed', 'The resolved fact entity was removed.');
    inputs.push({ slug, pageId: snapshot?.page.id ?? null, intent: { kind: 'managed_facts_entity', batchKey: session.batchKey,
      inputDigest: session.inputDigest, origin: session.origin, originalRequestId: session.originalRequestId,
      embedding: session.embedding ?? null,
      ...(snapshot ? { expected_revision: snapshot.revision } : {}), facts: group } });
  }
  const rows = await engine.transaction(async tx => {
    if (embedded) await assertManagedFactsEmbedding(tx, session.config, session.embedding, true);
    const children: string[] = [];
    const accepted: WriteRequest[] = [];
    for (const input of [...inputs, { slug: '__managed_facts_complete__', pageId: null, intent: {
      kind: 'managed_facts_complete', batchKey: session.batchKey, inputDigest: session.inputDigest,
      origin: session.origin, originalRequestId: session.originalRequestId, children } as ManagedFactIntent }]) {
      if (ctx.abortSignal?.aborted) throw new DOMException('Fact extraction was aborted before admission.', 'AbortError');
      await authorizePageVisibility(tx, session.authority, input.slug);
      const requestId = input.intent.kind === 'managed_facts_complete' ? session.completionRequestId : managedFactRequestId(session.batchKey, input.slug);
      const row = await admitWriteInTransaction(tx, { principal: session.authority.principal, authority: session.authority,
        operation: 'extract_facts', sourceId, sourceIncarnation: session.authority.sourceIncarnation,
        worktreeId: session.binding?.worktree_id, topologyGeneration: session.binding?.topology_generation,
        requestId, slug: input.slug, pageId: input.pageId, callerIntent: input.intent, intent: input.intent });
      accepted.push(row);
      if (input.intent.kind === 'managed_facts_entity') children.push(row.id);
    }
    return accepted;
  });
  return collectManagedFacts(engine, session, rows);
}

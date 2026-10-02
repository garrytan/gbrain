import { readFileSync } from 'node:fs';
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { acceptedPendingReceipt } from './accepted-pending.ts';
import { OperationError } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { authorizeStoredRequest, authorizeWrite, submissionAuthority } from './authority.ts';
import { currentVerifiedLocalWriter, localHostId, registerLocalWriter } from './identity.ts';
import { admitWriteInTransaction, getWriteRequest, receiptFor } from './journal.ts';
import { digest, requireUuid, sha256 } from './digest.ts';
import { acquireWorktree, getWorktreeBinding, managedPersistenceEnabled, type WorktreeBinding } from './ownership.ts';
import { preparePageMutation } from './page-prepare.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteAuthority, WriteRequest } from './model.ts';
import type { WriteReceipt } from './types.ts';
import { writeAtomPageState } from '../cycle/extract-atoms-page-state.ts';
import { effectiveVisibility } from '../search/private-visibility.ts';

export interface AtomOrigin {
  kind: 'page' | 'transcript';
  locator: string;
  contentHash: string;
  textHash: string;
  pageId: number | null;
  revision: string | null;
  visibility: 'private' | 'world';
  generation?: number;
}
export interface ManagedAtomSession {
  sourceId: string;
  incarnation: string;
  authority: WriteAuthority;
  binding: WorktreeBinding | null;
  config: GBrainConfig;
  retry?: { runKey: string; checkpointKey: string; expectedCheckpoint: unknown; rows: WriteRequest[]; origin: AtomOrigin };
}
export interface AtomIntent extends Record<string, unknown> {
  kind: 'managed_atom_page' | 'managed_atom_delete' | 'managed_atom_complete';
  runKey: string;
  origin: AtomOrigin;
  expected_revision?: string;
  content?: string;
  children?: string[];
  links?: LinkBatchInput[];
  failure?: string;
  checkpointKey?: string;
  expectedCheckpoint?: unknown;
}

export async function managedAtomSession(engine: BrainEngine, sourceId: string, retry?: { requestId: string; retryId: string }): Promise<ManagedAtomSession | null> {
  if (!(await managedPersistenceEnabled(engine))) return null;
  assertPersistenceAccepting(engine);
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw new OperationError('permission_denied', 'Atom extraction cannot mutate a managed brain through an untrusted caller; a trusted local, source-wide writer is required.');
  }
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null }>(
    'SELECT incarnation,archived,local_path FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The atom source is unavailable.');
  if (!currentVerifiedLocalWriter()) await registerLocalWriter(engine, 'cli');
  const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext,
    'submit_job', sourceId, source.incarnation, '__managed_atom_complete__');
  if (authority.slugPrefixes || authority.restrictedNamespace || authority.delegated) {
    throw new OperationError('permission_denied', 'Atom maintenance requires a source-wide grant.');
  }
  await authorizeWrite(engine, authority, 'put_page', 'atoms/preflight');
  await authorizeWrite(engine, authority, 'delete_page', 'atoms/preflight');
  const binding = await getWorktreeBinding(engine, sourceId);
  const root = source.local_path || (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  if (writeThrough && root && !binding) throw new OperationError('owner_unavailable', 'Atom maintenance requires the configured canonical owner.');
  if (writeThrough && binding && (binding.owner_host_id !== localHostId() || binding.state !== 'active' || !binding.local_path)) {
    throw new OperationError('owner_unavailable', 'The canonical atom owner is unavailable; no extraction was started.');
  }
  if (writeThrough && binding) {
    const lock = await acquireWorktree(binding, 0, undefined, engine);
    if (!lock) throw new OperationError('writer_lock_unavailable', 'The canonical atom writer is busy; no extraction was started.');
    await lock.release();
  }
  if (!writeThrough) authority.databaseOnlyReason = 'disabled_by_config';
  else if (!binding) authority.databaseOnlyReason = 'no_repo_configured';
  const session: ManagedAtomSession = { sourceId, incarnation: source.incarnation, authority, binding: writeThrough ? binding : null, config: { engine: engine.kind } as GBrainConfig };
  if (retry) {
    if (!retry.retryId || retry.retryId.length > 128) throw new OperationError('invalid_params', 'A bounded explicit atom retry identity is required.');
    const prior = await getWriteRequest(engine, authority.principal, requireUuid(retry.requestId));
    if (!prior || prior.operation !== 'submit_job' || prior.source_id !== sourceId || prior.source_incarnation !== source.incarnation) {
      throw new OperationError('not_found', 'No retained atom batch belongs to this writer, source and request.');
    }
    await authorizeStoredRequest(engine, prior);
    if (prior.compacted && !prior.intent) expiredAtomReceipt(prior);
    if (!String(prior.intent?.kind).startsWith('managed_atom_')) throw new OperationError('not_found', 'No retained atom batch belongs to this writer, source and request.');
    const p = prior.intent as AtomIntent;
    const rows = await atomBatchRows(engine, session, p.runKey);
    for (let i = 0; i < rows.length; i++) {
      await authorizeStoredRequest(engine, rows[i]);
      if (['queued', 'running', 'recovering'].includes(rows[i].state)) rows[i] = await waitForWrite(engine, rows[i], session.config);
      if (['queued', 'running', 'recovering'].includes(rows[i].state)) writeResponse(rows[i]);
    }
    const expired = rows.find(row => row.compacted && !row.intent);
    if (expired) expiredAtomReceipt(expired);
    if (!rows.some(row => row.state !== 'committed' || row.outcome?.failure)) throw new OperationError('invalid_params', 'This atom batch already completed successfully.');
    const checkpointKey = p.checkpointKey ?? p.runKey;
    const [checkpoint] = await engine.executeRaw<{ completed_keys: unknown }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-atoms' AND fingerprint=$1", [checkpointKey]);
    session.retry = { runKey: digest([checkpointKey, prior.id, retry.retryId]), checkpointKey,
      expectedCheckpoint: checkpoint?.completed_keys ?? null, rows, origin: p.origin };
  }
  return session;
}

export async function readAtomOrigin(engine: BrainEngine, session: ManagedAtomSession,
  item: { kind: 'page'; slug: string; content: string; contentHash: string } | { kind: 'transcript'; filePath: string; content: string; contentHash: string }): Promise<AtomOrigin> {
  if (item.kind === 'transcript') {
    if (sha256(readFileSync(item.filePath)) !== sha256(item.content)) throw new OperationError('source_changed', 'The atom transcript changed before extraction.');
    return { kind: item.kind, locator: item.filePath, contentHash: item.contentHash, textHash: sha256(item.content), pageId: null, revision: null,
      visibility: effectiveVisibility({ kind: 'transcript' }) };
  }
  const snapshot = await engine.readPageSnapshot(item.slug, { sourceId: session.sourceId });
  if (!snapshot || snapshot.sourceIncarnation !== session.incarnation || snapshot.page.content_hash !== item.contentHash || snapshot.page.compiled_truth !== item.content) {
    throw new OperationError('revision_conflict', 'The atom input changed before extraction.');
  }
  const generation = await atomGeneration(engine, snapshot.page.id, item.contentHash);
  return { kind: item.kind, locator: item.slug, contentHash: item.contentHash, textHash: sha256(item.content), pageId: snapshot.page.id,
    revision: snapshot.revision, visibility: effectiveVisibility({ kind: 'page', page: snapshot.page }), ...(generation > 0 ? { generation } : {}) };
}

export const ATOM_GENERATION_OP = 'managed-atoms-generation';
export const ATOM_RETIRED_BY_REEXTRACT = 'managed-reextract';

/**
 * The generation a page's content keys on: the content a retirement kept (the extraction that retired) keeps
 * the generation its accepted batch already used, so that batch stays resumable; every other content moves on.
 */
async function atomGeneration(engine: BrainEngine, pageId: number, contentHash: string): Promise<number> {
  const [row] = await engine.executeRaw<{ generation: string | null; keep: string | null; keep_generation: string | null }>(
    `SELECT completed_keys->0->>'generation' AS generation, completed_keys->0->>'keep' AS keep, completed_keys->0->>'keep_generation' AS keep_generation
       FROM op_checkpoints WHERE op='${ATOM_GENERATION_OP}' AND fingerprint=$1`, [String(pageId)]);
  if (!row) return 0;
  return Number((row.keep !== null && row.keep === contentHash ? row.keep_generation : row.generation) ?? 0);
}

/**
 * Retiring an origin page's atoms invalidates its earlier completed extractions: the generation
 * changes the run key of every other content, so a retained receipt is not replayed, and discovery
 * offers the page again. `keepContentHash` (the extraction that retired) keeps its key and its state.
 */
export async function bumpAtomGeneration(tx: BrainEngine, sourceId: string, incarnation: string, pageId: number, keepContentHash: string | null): Promise<void> {
  const kept = keepContentHash === null ? null : await atomGeneration(tx, pageId, keepContentHash);
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES('${ATOM_GENERATION_OP}',$1,jsonb_build_array(jsonb_build_object('generation',1,'keep',$2::text,'keep_generation',$3::integer)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=jsonb_build_array(jsonb_build_object('generation',
      COALESCE((op_checkpoints.completed_keys->0->>'generation')::integer,0)+1,'keep',$2::text,'keep_generation',$3::integer))`,
  [String(pageId), keepContentHash, kept]);
  await tx.executeRaw('DELETE FROM extract_atoms_page_state WHERE source_incarnation=$1::uuid AND page_id=$2 AND content_hash IS DISTINCT FROM $3::text',
    [incarnation, pageId, keepContentHash]);
  await tx.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1
    AND completed_keys->0->>'kind'='page' AND completed_keys->0->>'pageId'=$2 AND completed_keys->0->>'contentHash' IS DISTINCT FROM $3::text`,
  [sourceId, String(pageId), keepContentHash]);
}

/**
 * The atom input a run key covers. Revision and visibility are left out, so a
 * revision-only source change (a tag, a timeline row) is the same input for
 * the drain and for an explicit retry (#5699).
 */
function atomInput(session: ManagedAtomSession, origin: AtomOrigin): unknown[] {
  return ['managed-atoms-v1', session.incarnation, origin.kind, origin.locator, origin.pageId, origin.contentHash];
}

/** A retirement's regeneration generation enters the drain's key above 0, so earlier receipts are not replayed. */
function atomInputKey(session: ManagedAtomSession, origin: AtomOrigin): string {
  return digest([...atomInput(session, origin), ...(origin.generation ? [origin.generation] : [])]);
}

/**
 * The retry check adds the extracted text's hash: a transcript retry reads the current file under the retained content hash.
 * It leaves the generation out: a retirement the reviewed batch itself committed must not invalidate its own retry.
 */
export function atomRetryInputKey(session: ManagedAtomSession, origin: AtomOrigin): string {
  return digest([digest(atomInput(session, origin)), origin.textHash]);
}

function runKey(session: ManagedAtomSession, origin: AtomOrigin): string {
  if (session.retry) {
    if (atomRetryInputKey(session, session.retry.origin) !== atomRetryInputKey(session, origin)) throw new OperationError('source_changed', 'The atom retry input no longer matches its accepted source snapshot.');
    return session.retry.runKey;
  }
  return atomInputKey(session, origin);
}

function atomRequestId(key: string, slug: string): string {
  const hex = digest([key, slug]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function atomBatchRows(engine: BrainEngine, session: ManagedAtomSession, key: string): Promise<WriteRequest[]> {
  const completionId = atomRequestId(key, '__managed_atom_complete__');
  const completion = await getWriteRequest(engine, session.authority.principal, completionId);
  if (completion && (completion.operation !== 'submit_job' || completion.source_id !== session.sourceId ||
    completion.source_incarnation !== session.incarnation || completion.slug !== '__managed_atom_complete__')) {
    throw new OperationError('idempotency_conflict', 'The atom completion request ID belongs to another accepted operation.');
  }
  const children = (completion?.intent as AtomIntent | null)?.children ?? [];
  return engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE source_id=$1 AND source_incarnation=$2::uuid
    AND principal_kind=$3 AND principal_id=$4 AND ((intent->>'runKey'=$5 AND intent->>'kind' LIKE 'managed_atom_%')
      OR request_id=$6::uuid OR id=ANY($7::uuid[])) ORDER BY sequence`,
  [session.sourceId, session.incarnation, session.authority.principal.kind, session.authority.principal.id, key, completionId, children]);
}

function expiredAtomReceipt(row: WriteRequest): never {
  const error = new OperationError('recovery_required', 'The retained payload for this accepted request has expired; atom retry cannot recover it.',
    'Inspect the original receipt and current source and atom pages before deciding how to recover. No extraction was started.');
  error.writeRequest = receiptFor(row);
  error.writeError = 'recovery_required';
  throw error;
}

function malformedAtomReceipt(row: WriteRequest): never {
  if (row.compacted && !row.intent) expiredAtomReceipt(row);
  const error = new OperationError('extraction_failed', 'The accepted atom extraction produced malformed output.',
    `Approve one new attempt with gbrain jobs submit extract-atoms-drain --params '${JSON.stringify({ sourceId: row.source_id, retryRequestId: row.request_id })}'.`);
  error.writeRequest = receiptFor(row);
  throw error;
}

export async function resumeManagedAtoms(engine: BrainEngine, session: ManagedAtomSession, origin: AtomOrigin): Promise<boolean> {
  const key = runKey(session, origin);
  const [checkpoint] = await engine.executeRaw<{ completed_keys: Array<{ failure?: string; requestId?: string }> }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='managed-atoms' AND fingerprint=$1", [key]);
  if (checkpoint) {
    if (!checkpoint.completed_keys[0]?.failure) return true;
    const requestId = checkpoint.completed_keys[0]?.requestId;
    if (requestId) {
      const failed = await getWriteRequest(engine, session.authority.principal, requestId);
      if (failed) { await authorizeStoredRequest(engine, failed); malformedAtomReceipt(failed); }
    }
  }
  const rows = await atomBatchRows(engine, session, key);
  if (!rows.length) return false;
  for (const row of rows) {
    await authorizeStoredRequest(engine, row);
    const completed = await waitForWrite(engine, row, session.config);
    writeResponse(completed);
    if (completed.outcome?.failure) malformedAtomReceipt(completed);
  }
  if (!rows.some(row => row.request_id === atomRequestId(key, '__managed_atom_complete__'))) throw new OperationError('storage_error', 'The accepted atom batch has no completion receipt.');
  return true;
}

export interface ManagedAtomRetirement {
  slug: string;
  pageId: number;
  revision: string;
}

export async function publishManagedAtoms(engine: BrainEngine, session: ManagedAtomSession, origin: AtomOrigin,
  atoms: Array<{ slug: string; content: string; links: LinkBatchInput[]; expectedTarget?: { pageId: number | null; revision: string | null } }>,
  failure?: string, reviewedRetirements?: ManagedAtomRetirement[]): Promise<WriteReceipt[]> {
  const key = runKey(session, origin);
  const inputs: Array<{ slug: string; pageId: number | null; intent: AtomIntent }> = [];
  for (const atom of atoms) {
    await authorizeWrite(engine, session.authority, 'put_page', atom.slug);
    const snapshot = await engine.readPageSnapshot(atom.slug, { sourceId: session.sourceId, includeDeleted: true });
    if (snapshot && ((snapshot.page.deleted_at && !snapshot.page.frontmatter.retired_by) || snapshot.page.type !== 'atom' ||
      (origin.kind === 'page' ? snapshot.page.frontmatter.source_slug !== origin.locator : snapshot.page.frontmatter.source_path !== origin.locator))) {
      throw new OperationError('page_identity_changed', 'The atom target belongs to another origin or was removed.');
    }
    const target = atom.expectedTarget ?? { pageId: snapshot?.page.id ?? null, revision: snapshot?.revision ?? null };
    if ((snapshot?.page.id ?? null) !== target.pageId || (snapshot?.revision ?? null) !== target.revision) {
      throw new OperationError('page_identity_changed', 'The reviewed atom retry target changed before admission.');
    }
    inputs.push({ slug: atom.slug, pageId: target.pageId, intent: { kind: 'managed_atom_page', runKey: key, origin,
      ...(session.retry ? { checkpointKey: session.retry.checkpointKey, expectedCheckpoint: session.retry.expectedCheckpoint } : {}),
      ...(target.revision ? { expected_revision: target.revision } : {}), content: atom.content, links: atom.links } as AtomIntent });
  }
  const originKey = origin.kind === 'page' ? 'source_slug' : 'source_path';
  const retirements = failure ? [] : reviewedRetirements ?? await engine.executeRaw<ManagedAtomRetirement>(
    `SELECT slug,id AS "pageId",knowledge_revision::text AS revision FROM pages
      WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL
        AND frontmatter->>'${originKey}'=$2
        AND COALESCE(frontmatter->>'source_hash','')<>$3
        AND NULLIF(frontmatter->>'imported_from','') IS NULL
        AND NOT (slug=ANY($4::text[]))
      ORDER BY slug`,
    [session.sourceId, origin.locator, origin.contentHash.slice(0, 16), atoms.map(atom => atom.slug)],
  );
  for (const retirement of retirements) {
    await authorizeWrite(engine, session.authority, 'delete_page', retirement.slug);
    inputs.push({ slug: retirement.slug, pageId: retirement.pageId, intent: {
      kind: 'managed_atom_delete', runKey: key, origin, expected_revision: retirement.revision,
      ...(session.retry ? { checkpointKey: session.retry.checkpointKey, expectedCheckpoint: session.retry.expectedCheckpoint } : {}),
    } as AtomIntent });
  }
  const rows = await engine.transaction(async tx => {
    const children: string[] = [];
    const accepted: WriteRequest[] = [];
    for (const input of [...inputs, { slug: '__managed_atom_complete__', pageId: null,
      intent: { kind: 'managed_atom_complete', runKey: key, origin, children, ...(failure ? { failure } : {}),
        ...(session.retry ? { checkpointKey: session.retry.checkpointKey, expectedCheckpoint: session.retry.expectedCheckpoint } : {}) } as AtomIntent }]) {
      const requestId = atomRequestId(key, input.slug);
      const row = await admitWriteInTransaction(tx, { principal: session.authority.principal, authority: session.authority,
        operation: 'submit_job', sourceId: session.sourceId, sourceIncarnation: session.incarnation,
        worktreeId: session.binding?.worktree_id, topologyGeneration: session.binding?.topology_generation,
        slug: input.slug, pageId: input.pageId, requestId, callerIntent: input.intent, intent: input.intent });
      accepted.push(row);
      if (input.intent.kind !== 'managed_atom_complete') children.push(row.id);
    }
    return accepted;
  });
  const receipts: WriteReceipt[] = [];
  for (const row of rows) {
    const finished = await waitForWrite(engine, row, session.config);
    try { writeResponse(finished); }
    catch (error) {
      // #5601: an accepted batch still publishing is progress; its deterministic request ids resume it next run.
      const pending = acceptedPendingReceipt(error);
      if (!pending) throw error;
      receipts.push(pending);
      continue;
    }
    receipts.push(receiptFor(finished));
  }
  return receipts;
}

export async function prepareManagedAtomMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as AtomIntent | null;
  if (!p || !['managed_atom_page', 'managed_atom_delete', 'managed_atom_complete'].includes(p.kind) || !p.origin || row.authority.remote) {
    throw new OperationError('permission_denied', 'Unsupported atom maintenance intent.');
  }
  const validate = async (tx: BrainEngine) => {
    if (p.origin.kind === 'transcript') {
      if (sha256(readFileSync(p.origin.locator)) !== p.origin.textHash) throw new OperationError('source_changed', 'The accepted atom transcript changed.');
    } else {
      await authorizeWrite(tx, row.authority, 'submit_job', p.origin.locator);
      const snapshot = await tx.readPageSnapshot(p.origin.locator, { sourceId: row.source_id });
      if (!snapshot || snapshot.page.id !== p.origin.pageId || snapshot.revision !== p.origin.revision || snapshot.page.content_hash !== p.origin.contentHash) {
        throw new OperationError('revision_conflict', 'The accepted atom source page changed.');
      }
    }
  };
  await validate(engine);
  const additionalPageKeys = p.origin.kind === 'page' ? [{ sourceId: row.source_id, slug: p.origin.locator }] : [];
  if (p.kind === 'managed_atom_delete') {
    await authorizeWrite(engine, row.authority, 'delete_page', row.slug);
    const prepared = await preparePageMutation(engine, { ...row, operation: 'delete_page' }, config, undefined, undefined, { allowMissingFile: true });
    return { ...prepared, additionalPageKeys, validate: async tx => {
      await validate(tx);
      await authorizeWrite(tx, row.authority, 'delete_page', row.slug);
      await prepared.validate?.(tx);
    }, apply: async tx => {
      const result = await prepared.apply(tx);
      if (!prepared.noop) {
        await tx.executeRaw(`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
          WHERE id=$3 AND source_id=$4 AND deleted_at IS NOT NULL`, [ATOM_RETIRED_BY_REEXTRACT, new Date().toISOString(), row.page_id, row.source_id]);
        if (p.origin.kind === 'page' && p.origin.pageId !== null) {
          await bumpAtomGeneration(tx, row.source_id, row.source_incarnation, p.origin.pageId, p.origin.contentHash);
        }
      }
      return { ...result, atom_run_key: p.runKey, atom_kind: p.kind };
    } };
  }
  if (p.kind === 'managed_atom_complete') {
    const targets = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE id=ANY($1::uuid[]) AND source_incarnation=$2::uuid',
      [p.children ?? [], row.source_incarnation]);
    additionalPageKeys.push(...targets.map(target => ({ sourceId: row.source_id, slug: target.slug })));
    return { observedRevision: null, noop: true, additionalPageKeys, validate, apply: async tx => {
      const children = p.children ?? [];
      const committed = await tx.executeRaw<{ id: string; kind: AtomIntent['kind'] }>(`SELECT r.id,
        COALESCE(r.intent->>'kind',r.outcome->>'atom_kind') AS kind FROM persistence_requests r
        JOIN pages atom ON atom.source_id=r.source_id AND atom.slug=r.slug AND atom.type='atom'
        WHERE r.id=ANY($1::uuid[]) AND r.source_incarnation=$2::uuid
        AND r.state='committed' AND COALESCE(r.intent->>'runKey',r.outcome->>'atom_run_key')=$3
        AND ((COALESCE(r.intent->>'kind',r.outcome->>'atom_kind')='managed_atom_page'
          AND atom.knowledge_revision::text=r.outcome->>'revision' AND atom.deleted_at IS NULL)
          OR (COALESCE(r.intent->>'kind',r.outcome->>'atom_kind')='managed_atom_delete'
          AND atom.id=r.page_id AND atom.deleted_at IS NOT NULL))`, [children, row.source_incarnation, p.runKey]);
      if (committed.length !== children.length) throw new OperationError('revision_conflict', 'The atom batch is not fully committed.');
      if (p.origin.kind === 'page') {
        const snapshot = await tx.readPageSnapshot(p.origin.locator, { sourceId: row.source_id });
        if (!snapshot) throw new OperationError('revision_conflict', 'The accepted atom source page changed.');
        await writeAtomPageState(tx, row.source_id, { slug: p.origin.locator, content: snapshot.page.compiled_truth,
          contentHash: p.origin.contentHash, identity: { pageId: p.origin.pageId!, sourceIncarnation: row.source_incarnation,
            revision: p.origin.revision! } }, p.failure ? 'failure' : 'complete');
      }
      const checkpoint = JSON.stringify([{ sourceId: row.source_id, incarnation: row.source_incarnation, requestId: row.request_id,
        kind: p.origin.kind, locator: p.origin.locator, pageId: p.origin.pageId, contentHash: p.origin.contentHash, ...(p.failure ? { failure: p.failure } : {}) }]);
      await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-atoms',$1,$2::text::jsonb)
        ON CONFLICT(op,fingerprint) DO NOTHING`, [p.runKey, checkpoint]);
      if (p.checkpointKey) {
        const advanced = await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-atoms',$1,$2::text::jsonb)
          ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()
          WHERE op_checkpoints.completed_keys=$3::text::jsonb RETURNING fingerprint`,
        [p.checkpointKey, checkpoint, p.expectedCheckpoint === null ? null : JSON.stringify(p.expectedCheckpoint)]);
        if (!advanced.length) throw new OperationError('revision_conflict', 'The reviewed atom retry checkpoint changed.');
      }
      return { status: p.failure ? 'failed' : 'completed',
        atoms: committed.filter(child => child.kind === 'managed_atom_page').length,
        retired: committed.filter(child => child.kind === 'managed_atom_delete').length,
        ...(p.failure ? { failure: p.failure } : {}) };
    } };
  }
  await authorizeWrite(engine, row.authority, 'put_page', row.slug);
  const prepared = await preparePageMutation(engine, { ...row, operation: 'put_page' }, config, undefined, undefined, { allowMissingFile: true });
  return { ...prepared, additionalPageKeys, validate: async tx => { await validate(tx); await authorizeWrite(tx, row.authority, 'put_page', row.slug); await prepared.validate?.(tx); }, apply: async tx => {
    const result = await prepared.apply(tx);
    if (p.links?.length) await tx.addLinksBatch(p.links, { auditSite: 'cycle.extract_atoms.provenance' });
    return { ...result, atom_run_key: p.runKey, atom_kind: p.kind };
  } };
}

/** The completed, failure-free `managed-atoms` checkpoint `ac` for one page at its current content hash. */
export function managedAtomCompletedSql(page: { sourceId: string; slug: string; pageId: string; contentHash: string }): string {
  return `ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=${page.sourceId}
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=${page.sourceId})
    AND ac.completed_keys->0->>'kind'='page' AND ac.completed_keys->0->>'locator'=${page.slug}
    AND ac.completed_keys->0->>'pageId'=${page.pageId}::text AND ac.completed_keys->0->>'contentHash'=${page.contentHash}
    AND ac.completed_keys->0->>'failure' IS NULL`;
}

export const MANAGED_ATOM_DISCOVERY_SQL = `AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ${managedAtomCompletedSql({ sourceId: 'p.source_id', slug: 'p.slug', pageId: 'p.id', contentHash: 'p.content_hash' })})`;

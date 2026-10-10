import { readFileSync } from 'node:fs';
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { acceptedPendingReceipt } from './accepted-pending.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { authorizeStoredRequest, authorizeWrite, submissionAuthority } from './authority.ts';
import { currentVerifiedLocalWriter, localHostId, registerLocalWriter } from './identity.ts';
import { admitWriteInTransaction, getWriteRequest, receiptFor } from './journal.ts';
import { digest, requireUuid, sha256 } from './digest.ts';
import { getWorktreeBinding, managedPersistenceEnabled, probeWorktreeWriter, type WorktreeBinding } from './ownership.ts';
import { isConnectorSourceKind } from './connector-identity.ts';
import { preparePageMutation } from './page-prepare.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';
import { MaintenanceWriteWait } from './maintenance-wait.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteAuthority, WriteRequest } from './model.ts';
import type { WriteReceipt } from './types.ts';
import { writeAtomPageState } from '../cycle/extract-atoms-page-state.ts';
import { effectiveVisibility } from '../search/private-visibility.ts';
import { declareDerivation, deriveTrust, lowerToDerivedTier, recordTaintEdges } from '../trust/taint.ts';

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
  /** #5854: the publish wait of the job this session runs in (a drain attempt shares one across its batches). */
  wait: MaintenanceWriteWait;
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

const ownerStatusFix = (sourceId: string): Action => readFix(
  `Shows source ${sourceId}'s canonical owner, its state and any write in flight, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
const receiptFix = (requestId: string): Action => readFix(
  'Reads the atom request\'s durable receipt: its state, outcome and error, read-only.',
  { argv: ['gbrain', 'write-request', '--', requestId] });
const drainFix = (sourceId: string): Action => ({
  argv: ['gbrain', 'dream', '--drain', '--source', sourceId, '--json'], consent: ['paid'], actor: 'agent', requires_exclusive: false,
  why: `Re-reads source ${sourceId}'s current content and extracts its atom backlog under a new run; extraction calls the configured LLM.`,
});
const pageFix = (sourceId: string, slug: string): Action => readFix(
  `Shows which page holds ${slug} in source ${sourceId} now, with its type and revision.`,
  { argv: ['gbrain', 'get', '--source', sourceId, '--', slug] });

/**
 * The managed atom write target of a source and the owner refusal its session raises (null when it can run).
 * An unbound connector source is database-only by design (connector_database), like its connector sync:
 * its local_path is the connector's state directory, not a canonical checkout.
 */
async function atomOwnerTarget(engine: BrainEngine, sourceId: string, source: { local_path: string | null; kind: string | null }) {
  const binding = await getWorktreeBinding(engine, sourceId);
  const root = source.local_path || (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  const connectorDatabase = writeThrough && !binding && isConnectorSourceKind(source.kind);
  const refusal = writeThrough && root && !binding && !connectorDatabase ? 'Atom maintenance requires the configured canonical owner.'
    : writeThrough && binding && (binding.owner_host_id !== localHostId() || binding.state !== 'active' || !binding.local_path)
      ? 'The canonical atom owner is unavailable; no extraction was started.' : null;
  return { binding, writeThrough, connectorDatabase, refusal };
}

/** #5856: the owner refusal a managed atom drain of this source would hit in its session preflight, or null (always null when unmanaged). */
export async function atomDrainOwnerRefusal(engine: BrainEngine, sourceId: string): Promise<string | null> {
  if (!(await managedPersistenceEnabled(engine))) return null;
  const [source] = await engine.executeRaw<{ local_path: string | null; kind: string | null }>(
    "SELECT local_path,config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
  return source ? (await atomOwnerTarget(engine, sourceId, source)).refusal : null;
}

export async function managedAtomSession(engine: BrainEngine, sourceId: string, retry?: { requestId: string; retryId: string },
  wait: MaintenanceWriteWait = new MaintenanceWriteWait()): Promise<ManagedAtomSession | null> {
  if (!(await managedPersistenceEnabled(engine))) return null;
  assertPersistenceAccepting(engine);
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw opError('permission_denied', 'Atom extraction cannot mutate a managed brain through an untrusted caller; a trusted local, source-wide writer is required.',
      `Run atom extraction for source ${sourceId} from the gbrain CLI in a terminal on the brain host; MCP and delegated callers cannot publish atoms. Nothing was extracted.`,
      { reason: 'trusted_cli_required', fix: { ...drainFix(sourceId), actor: 'user',
        user_message: 'Atom extraction has to run from a terminal on the machine that hosts this brain. Please run the command shown there; it calls the configured LLM.' } });
  }
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
    "SELECT incarnation,archived,local_path,config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
  if (!source || source.archived) throw opError('source_changed', 'The atom source is unavailable.',
    `Source ${sourceId} is missing or archived, so no atoms were extracted. Check the registered sources and run extraction against an active one (or restore ${sourceId} first).`,
    { fix: readFix('Lists the registered sources with their archived state, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  if (!currentVerifiedLocalWriter()) await registerLocalWriter(engine, 'cli');
  const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext,
    'submit_job', sourceId, source.incarnation, '__managed_atom_complete__');
  if (authority.slugPrefixes || authority.restrictedNamespace || authority.delegated) {
    throw opError('permission_denied', 'Atom maintenance requires a source-wide grant.',
      `This host's CLI writer registration is limited to slug prefixes, a restricted namespace or a delegation, so it cannot publish atoms across source ${sourceId}. Review the registration; widening it is the user's decision.`,
      { fix: readFix('Shows the CLI writer registrations and their grants, read-only.', { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] }) });
  }
  await authorizeWrite(engine, authority, 'put_page', 'atoms/preflight');
  await authorizeWrite(engine, authority, 'delete_page', 'atoms/preflight');
  const { binding, writeThrough, connectorDatabase, refusal } = await atomOwnerTarget(engine, sourceId, source);
  if (refusal) throw opError('owner_unavailable', refusal,
    `No extraction was started for source ${sourceId}. Check its canonical owner: run atom extraction on the host that owns the checkout, or have the user claim the checkout on this host with gbrain sources writer claim.`,
    { fix: ownerStatusFix(sourceId) });
  if (writeThrough && binding) {
    if (!await probeWorktreeWriter(binding, engine)) throw opError('writer_lock_unavailable', 'The canonical atom writer is busy; no extraction was started.',
      `Another write holds source ${sourceId}'s canonical writer. Nothing was started, so run the atom drain again once the owner status shows it idle.`,
      { fix: ownerStatusFix(sourceId) });
  }
  if (!writeThrough) authority.databaseOnlyReason = 'disabled_by_config';
  else if (connectorDatabase) authority.databaseOnlyReason = 'connector_database';
  else if (!binding) authority.databaseOnlyReason = 'no_repo_configured';
  const session: ManagedAtomSession = { sourceId, incarnation: source.incarnation, authority, binding: writeThrough ? binding : null, config: { engine: engine.kind } as GBrainConfig, wait };
  if (retry) {
    if (!retry.retryId || retry.retryId.length > 128) throw opError('invalid_params', 'A bounded explicit atom retry identity is required.',
      `Submit the atom retry for request ${retry.requestId} as an extract-atoms-drain job; the job supplies its own bounded retry identity. Nothing was started.`,
      { fix: { argv: ['gbrain', 'jobs', 'submit', 'extract-atoms-drain', '--params', JSON.stringify({ sourceId, retryRequestId: retry.requestId })],
        consent: ['paid'], actor: 'agent', requires_exclusive: false,
        why: 'Queues one reviewed retry of the retained atom batch; extraction calls the configured LLM.' } });
    const prior = await getWriteRequest(engine, authority.principal, requireUuid(retry.requestId));
    if (!prior || prior.operation !== 'submit_job' || prior.source_id !== sourceId || prior.source_incarnation !== source.incarnation) {
      throw opError('not_found', 'No retained atom batch belongs to this writer, source and request.',
        `Request ${retry.requestId} is not an atom batch this CLI writer accepted for source ${sourceId}. Read the receipt to see which operation and source it belongs to; nothing was retried.`,
        { fix: receiptFix(retry.requestId) });
    }
    await authorizeStoredRequest(engine, prior);
    if (prior.compacted && !prior.intent) expiredAtomReceipt(prior);
    if (!String(prior.intent?.kind).startsWith('managed_atom_')) throw opError('not_found', 'No retained atom batch belongs to this writer, source and request.',
      `Request ${retry.requestId} in source ${sourceId} is a ${prior.operation} request, not an atom batch, so atom retry does not apply. Read its receipt instead; nothing was retried.`,
      { fix: receiptFix(retry.requestId) });
    const p = prior.intent as AtomIntent;
    const rows = await atomBatchRows(engine, session, p.runKey);
    for (let i = 0; i < rows.length; i++) {
      await authorizeStoredRequest(engine, rows[i]);
      if (['queued', 'running', 'recovering'].includes(rows[i].state)) rows[i] = session.wait.observe(await waitForWrite(engine, rows[i], session.config, session.wait.ms()));
      if (['queued', 'running', 'recovering'].includes(rows[i].state)) writeResponse(rows[i]);
    }
    const expired = rows.find(row => row.compacted && !row.intent);
    if (expired) expiredAtomReceipt(expired);
    if (!rows.some(row => row.state !== 'committed' || row.outcome?.failure)) throw opError('invalid_params', 'This atom batch already completed successfully.',
      `Every request in atom batch ${retry.requestId} for source ${sourceId} committed without a failure, so there is nothing to retry. Its receipt shows the outcome; new content is extracted by the regular atom drain.`,
      { fix: receiptFix(retry.requestId) });
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
    if (sha256(readFileSync(item.filePath)) !== sha256(item.content)) throw opError('source_changed', 'The atom transcript changed before extraction.',
      `The transcript was edited while source ${session.sourceId}'s atom extraction read it; nothing was extracted from it. Run the drain again to extract the current file.`,
      { fix: drainFix(session.sourceId) });
    return { kind: item.kind, locator: item.filePath, contentHash: item.contentHash, textHash: sha256(item.content), pageId: null, revision: null,
      visibility: effectiveVisibility({ kind: 'transcript' }) };
  }
  const snapshot = await engine.readPageSnapshot(item.slug, { sourceId: session.sourceId });
  if (!snapshot || snapshot.sourceIncarnation !== session.incarnation || snapshot.page.content_hash !== item.contentHash || snapshot.page.compiled_truth !== item.content) {
    throw opError('revision_conflict', 'The atom input changed before extraction.',
      `Page ${item.slug} in source ${session.sourceId} changed while its atoms were being prepared; nothing was extracted from it. Run the drain again to extract the current revision.`,
      { fix: drainFix(session.sourceId) });
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
    if (atomRetryInputKey(session, session.retry.origin) !== atomRetryInputKey(session, origin)) throw opError('source_changed', 'The atom retry input no longer matches its accepted source snapshot.',
      `${origin.kind === 'page' ? `Page ${origin.locator}` : 'The transcript'} in source ${session.sourceId} changed after the reviewed atom batch was accepted, so the retry cannot replay it. Nothing was retried; the regular drain extracts the current content as a new run.`,
      { fix: drainFix(session.sourceId) });
    return session.retry.runKey;
  }
  // A database-only connector run is its own run: once an owner claims the source, the owner's
  // run extracts again instead of replaying the batch the claim refused (claiming keeps the incarnation).
  const key = atomInputKey(session, origin);
  return session.authority.databaseOnlyReason === 'connector_database' ? digest([key, 'connector_database']) : key;
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
    throw opError('idempotency_conflict', 'The atom completion request ID belongs to another accepted operation.',
      `Atom completion request ${completionId} is already held by a ${completion.operation} request for ${completion.slug} in source ${completion.source_id}; nothing was admitted. Read that receipt and report the collision to the user with it rather than resubmitting.`,
      { fix: receiptFix(completionId) });
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
  const failure = (row.outcome as { failure?: unknown } | null)?.failure;
  const params = JSON.stringify({ sourceId: row.source_id, retryRequestId: row.request_id });
  const error = new OperationError('extraction_failed', `The accepted atom extraction failed${typeof failure === 'string' && failure ? ` (${failure})` : ''}; a new attempt needs approval.`,
    `Approve one new attempt with gbrain jobs submit extract-atoms-drain --params '${params}'.`);
  error.why = 'A failed managed atom batch keeps its failure receipt instead of retrying on its own, so the same input is not paid for every cycle; the earlier atoms of the page stay as they were.';
  error.fix = { argv: ['gbrain', 'jobs', 'submit', 'extract-atoms-drain', '--params', params], consent: ['paid'], actor: 'agent', requires_exclusive: false,
    why: 'Runs one new paid extraction attempt for this batch; ask the user before spending.',
    verify: { argv: ['gbrain', 'write-request', '--', row.request_id] } };
  error.contractVersion = 1;
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
    const completed = session.wait.observe(await waitForWrite(engine, row, session.config, session.wait.ms()));
    writeResponse(completed);
    if (completed.outcome?.failure) malformedAtomReceipt(completed);
  }
  if (!rows.some(row => row.request_id === atomRequestId(key, '__managed_atom_complete__'))) throw opError('storage_error', 'The accepted atom batch has no completion receipt.',
    `Source ${session.sourceId}'s atom pages were accepted but the batch's completion was never journaled, so its outcome is unconfirmed. Inspect the accepted request ${rows[0].request_id} and the owner before resubmitting anything.`,
    { fix: receiptFix(rows[0].request_id) });
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
      throw opError('page_identity_changed', 'The atom target belongs to another origin or was removed.',
        `Atom slug ${atom.slug} in source ${session.sourceId} is held by a page this extraction does not own (another origin, a non-atom page or a deleted page); nothing was admitted. Read that page; whether to move or remove it is the user's decision.`,
        { fix: pageFix(session.sourceId, atom.slug) });
    }
    const target = atom.expectedTarget ?? { pageId: snapshot?.page.id ?? null, revision: snapshot?.revision ?? null };
    if ((snapshot?.page.id ?? null) !== target.pageId || (snapshot?.revision ?? null) !== target.revision) {
      throw opError('page_identity_changed', 'The reviewed atom retry target changed before admission.',
        `Atom page ${atom.slug} in source ${session.sourceId} changed after the retry was reviewed; nothing was admitted. Read its current revision; the regular drain extracts against it as a new run.`,
        { fix: pageFix(session.sourceId, atom.slug) });
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
    const finished = session.wait.observe(await waitForWrite(engine, row, session.config, session.wait.ms()));
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
    throw opError('permission_denied', 'Unsupported atom maintenance intent.',
      `Request ${row.request_id} in source ${row.source_id} is not an atom maintenance intent the trusted local writer can publish, so the coordinator refused it before any change. Atom extraction runs only from the gbrain CLI on the brain host; inspect the owner before resubmitting anything.`,
      { fix: ownerStatusFix(row.source_id) });
  }
  const validate = async (tx: BrainEngine) => {
    // A connector preflighted as unbound publishes database-only; one claimed since then must use its owner.
    if (row.authority.databaseOnlyReason === 'connector_database' && await getWorktreeBinding(tx, row.source_id)) {
      throw opError('source_changed', 'The connector source gained a canonical owner after atom preflight; the next run extracts through its owner.',
        `Connector source ${row.source_id} was claimed by a canonical owner after this database-only atom run started; request ${row.request_id} changed nothing. Run the atom drain on the owning host.`,
        { fix: ownerStatusFix(row.source_id) });
    }
    if (p.origin.kind === 'transcript') {
      if (sha256(readFileSync(p.origin.locator)) !== p.origin.textHash) throw opError('source_changed', 'The accepted atom transcript changed.',
        `The transcript behind atom request ${row.request_id} in source ${row.source_id} was edited after acceptance, so the request published nothing. Run the atom drain again to extract the current file.`,
        { fix: drainFix(row.source_id) });
    } else {
      await authorizeWrite(tx, row.authority, 'submit_job', p.origin.locator);
      const snapshot = await tx.readPageSnapshot(p.origin.locator, { sourceId: row.source_id });
      if (!snapshot || snapshot.page.id !== p.origin.pageId || snapshot.revision !== p.origin.revision || snapshot.page.content_hash !== p.origin.contentHash) {
        throw opError('revision_conflict', 'The accepted atom source page changed.',
          `Page ${p.origin.locator} in source ${row.source_id} changed after atom request ${row.request_id} was accepted, so the request published nothing. Run the atom drain again to extract the current revision.`,
          { fix: drainFix(row.source_id) });
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
      if (committed.length !== children.length) throw opError('revision_conflict', 'The atom batch is not fully committed.',
        `Some atom pages in batch ${row.request_id} for source ${row.source_id} did not commit or changed afterwards, so the batch was not marked complete. Read the batch receipt; the next atom drain extracts the source again.`,
        { fix: receiptFix(row.request_id) });
      if (p.origin.kind === 'page') {
        const snapshot = await tx.readPageSnapshot(p.origin.locator, { sourceId: row.source_id });
        if (!snapshot) throw opError('revision_conflict', 'The accepted atom source page changed.',
          `Page ${p.origin.locator} in source ${row.source_id} is gone since atom batch ${row.request_id} was accepted, so the batch was not marked complete. Read the page to confirm; nothing more is extracted from a removed page.`,
          { fix: pageFix(row.source_id, p.origin.locator) });
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
        if (!advanced.length) throw opError('revision_conflict', 'The reviewed atom retry checkpoint changed.',
          `Another atom run completed source ${row.source_id}'s reviewed checkpoint after retry ${row.request_id} was accepted, so the retry was not recorded. Read the retry receipt; the later run's atoms stand.`,
          { fix: receiptFix(row.request_id) });
      }
      return { status: p.failure ? 'failed' : 'completed',
        atoms: committed.filter(child => child.kind === 'managed_atom_page').length,
        retired: committed.filter(child => child.kind === 'managed_atom_delete').length,
        ...(p.failure ? { failure: p.failure } : {}) };
    } };
  }
  await authorizeWrite(engine, row.authority, 'put_page', row.slug);
  // #5575 I2: the extractor read only the origin (a page, or a transcript file of the user's own sessions); the page write carries the declaration.
  const derivation = await deriveTrust(engine, p.origin.kind === 'page' && p.origin.pageId !== null ? [{ table: 'pages', id: p.origin.pageId }] : [],
    { channel: 'derive:atoms', requestId: row.id });
  const prepared = await preparePageMutation(engine, { ...row, operation: 'put_page', intent: { ...p, derivation: declareDerivation(derivation.trust, derivation.inputs) } },
    config, undefined, undefined, { allowMissingFile: true });
  return { ...prepared, trust: derivation.trust, additionalPageKeys, validate: async tx => { await validate(tx); await authorizeWrite(tx, row.authority, 'put_page', row.slug); await prepared.validate?.(tx); }, apply: async tx => {
    const result = await prepared.apply(tx);
    if (p.links?.length) await tx.addLinksBatch(p.links, { auditSite: 'cycle.extract_atoms.provenance' });
    const [atom] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [row.source_id, row.slug]);
    if (atom) {
      await lowerToDerivedTier(tx, 'pages', [Number(atom.id)], derivation.trust);
      await recordTaintEdges(tx, { table: 'pages', id: Number(atom.id), sourceId: row.source_id }, derivation.inputs);
    }
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

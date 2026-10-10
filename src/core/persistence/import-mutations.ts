import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { isImageFilePath, type ImportResult } from '../import-file.ts';
import { loadConfig } from '../config.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { getWorktreeBinding } from './ownership.ts';
import { SCREENING_SHARED_READS, batchSharedReads, emitFenceNotice, initializeLocalPersistence, pendingAwareResponse, preparePageAdmission, requestPrincipalForContext, withBatchAdmission } from './page-mutations.ts';
import { admitBatch } from './page-batch.ts';
import { writeOutcomeUnknown } from './admission-retry.ts';
import { assertPersistenceAccepting, waitForWrites } from './service.ts';
import type { WriteAdmission } from './journal.ts';
import type { WriteRequest } from './model.ts';
import { digest, sha256 } from './digest.ts';
import { assertImportPaths, managedImportContent, prepareManagedImportMutation, readImportBytes, type ImportPack, type ManagedImportIntent } from './import-prepare.ts';
import { submissionAuthority } from './authority.ts';
import { inspectUnchanged, screeningRequest } from './noop-kernel.ts';
import { withScreeningPaths } from './screening-paths.ts';
import type { WorktreeBinding } from './ownership.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';

/** One file of a managed import batch: its path and the source-relative path its slug is derived from. */
export interface ManagedImportFile { filePath: string; sourcePath: string }
/** A managed import admits at most this many files in one transaction; their publication groups hold PAGE_BATCH_GROUP_MAX pages each. */
export const IMPORT_BATCH_MAX_PAGES = 32;
export const IMPORT_BATCH_MAX_BYTES = 8 * 1024 * 1024;
/**
 * The files of `queue` from `start` that one `runImport` batch takes: at least one, at most the page and byte caps;
 * exactly one when the import is not a managed one (`batched` false). `runImport` accounts each file of a batch, in
 * order, through its per-file bookkeeping.
 */
export function nextImportBatch(queue: readonly string[], start: number, batched = true): string[] {
  if (!batched) return [queue[start]!];
  const batch: string[] = [];
  let bytes = 0;
  for (let i = start; i < queue.length && batch.length < IMPORT_BATCH_MAX_PAGES; i++) {
    const size = lstatSync(queue[i]!, { throwIfNoEntry: false })?.size ?? 0;
    if (batch.length && bytes + size > IMPORT_BATCH_MAX_BYTES) break;
    batch.push(queue[i]!);
    bytes += size;
  }
  return batch;
}
/**
 * One `runImport` batch: the result of every file of `batch` in its order, undefined for a held path (the caller
 * accounts it as held). A batch that fails as a whole settles each of its files with that failure.
 */
export async function settleManagedImportBatch(engine: BrainEngine, batch: readonly string[], sourcePathOf: (file: string) => string,
  held: (sourcePath: string) => boolean, opts: Parameters<typeof importManagedFiles>[2]): Promise<Array<PromiseSettledResult<ImportResult> | undefined>> {
  const open = batch.filter(file => !held(sourcePathOf(file)));
  const t0 = Date.now();
  const settled: PromiseSettledResult<ImportResult>[] = !open.length ? [] : await importManagedFiles(engine, open.map(filePath => ({ filePath, sourcePath: sourcePathOf(filePath) })), opts)
    .catch(reason => open.map(() => ({ status: 'rejected' as const, reason })));
  if (Date.now() - t0 > 5000 * open.length) console.error(`[gbrain phase] import.process_batch slow ${Date.now() - t0}ms files=${open.length} first=${sourcePathOf(open[0]!)}`);
  return batch.map(file => settled[open.indexOf(file)]);
}
const IMPORT_OP = 'managed-file-import';
/** How long an import waits for one file's publication, as a single import always has. */
const IMPORT_WAIT_MS = 30_000;
type PendingImport = ManagedImportIntent & { request_id: string; source_id: string };

export async function importManagedFile(engine: BrainEngine, filePath: string, sourcePath: string,
  opts: { sourceId?: string; noEmbed?: boolean; activePack?: ImportPack; signal?: AbortSignal; slugRoot?: string } = {}): Promise<ImportResult> {
  const [settled] = await importManagedFiles(engine, [{ filePath, sourcePath }], opts);
  if (settled!.status === 'rejected') throw settled!.reason;
  return settled!.value;
}

/**
 * Imports files through the source's canonical owner. Every file keeps its own
 * durable intent (op_checkpoints), request, receipt and result; a batch admits
 * its new requests in one transaction, marked with one `import_batch` id so the
 * owner publishes them in groups (journal.ts publicationGroupKey). A file's
 * refusal settles that file only. A slug a batch already holds ends the batch
 * there; that file and the rest import after it, as they would one by one.
 */
export async function importManagedFiles(engine: BrainEngine, files: readonly ManagedImportFile[],
  opts: { sourceId?: string; noEmbed?: boolean; activePack?: ImportPack; signal?: AbortSignal; slugRoot?: string } = {}): Promise<PromiseSettledResult<ImportResult>[]> {
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw trustedCliRequired('Managed filesystem import requires the trusted local CLI.');
  }
  opts.signal?.throwIfAborted();
  const settled: PromiseSettledResult<ImportResult>[] = new Array(files.length);
  const fail = (i: number, reason: unknown) => { settled[i] = { status: 'rejected', reason }; };
  const sourceId = opts.sourceId ?? 'default';
  const binding = await getWorktreeBinding(engine, sourceId);
  const unowned = !binding?.local_path || binding.owner_host_id !== localHostId() || binding.state !== 'active'
    ? opError('owner_unavailable', 'Managed import must run on the active canonical owner for the selected source.',
      `This host is not the active owner of source ${sourceId}, so nothing was imported. Run the import on the owner host that writer status names, or wait until its owner is active.`,
      { fix: readFix(`Shows source ${sourceId}'s owner host and state, read-only.`, { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] }) }) : null;
  const ctx = { engine, remote: false, sourceId, config: loadConfig() ?? { engine: engine.kind } } as OperationContext;
  const reads = batchSharedReads(engine);
  const planned: Array<{ i: number; slug: string; content: string; sourcePath: string; path: string; inputPath: string; inputHash: string; target: string }> = [];
  const slugs = new Set<string>();
  let rest = files.length;
  await withScreeningPaths(async () => { for (let i = 0; i < files.length; i++) {
    let { filePath, sourcePath } = files[i]!;
    try {
      if (isImageFilePath(sourcePath) && process.env.GBRAIN_EMBEDDING_MULTIMODAL !== 'true') {
        throw opError('invalid_params', 'Image import requires GBRAIN_EMBEDDING_MULTIMODAL=true.',
          `${sourcePath} is an image and multimodal embeddings are off, so it was not imported. Import only text files, or ask the user whether to enable GBRAIN_EMBEDDING_MULTIMODAL=true for the gbrain process (image embeddings can cost money).`);
      }
      if (unowned) throw unowned;
      const root = join(binding!.local_path!, binding!.relative_path);
      const inputPath = resolve(filePath);
      const canonicalRelative = relative(root, inputPath);
      const canonicalInput = canonicalRelative && !isAbsolute(canonicalRelative) && canonicalRelative !== '..' && !canonicalRelative.startsWith(`..${sep}`);
      if (canonicalInput && !opts.slugRoot) sourcePath = canonicalRelative;
      const path = canonicalInput ? canonicalRelative : sourcePath;
      const target = resolve(root, path);
      await assertImportPaths(reads, sourceId, root, inputPath, target);
      const bytes = readImportBytes(inputPath);
      const { slug, content } = managedImportContent(sourcePath, bytes, opts.activePack);
      if (slugs.has(slug)) { rest = i; break; }
      slugs.add(slug);
      planned.push({ i, slug, content, sourcePath, path, inputPath, inputHash: sha256(bytes), target });
    } catch (error) { fail(i, error); }
  } });
  if (planned.length) await importPlanned(ctx, binding!, planned, opts, fail, (i, value) => { settled[i] = { status: 'fulfilled', value }; });
  if (rest < files.length) settled.splice(rest, files.length - rest, ...await importManagedFiles(engine, files.slice(rest), opts));
  return settled;
}

async function importPlanned(ctx: OperationContext, binding: WorktreeBinding,
  planned: Array<{ i: number; slug: string; content: string; sourcePath: string; path: string; inputPath: string; inputHash: string; target: string }>,
  opts: { noEmbed?: boolean; activePack?: ImportPack },
  fail: (i: number, reason: unknown) => void, done: (i: number, value: ImportResult) => void): Promise<void> {
  const { engine } = ctx;
  const sourceId = binding.source_id;
  let principal: Awaited<ReturnType<typeof requestPrincipalForContext>>;
  try {
    await initializeLocalPersistence(ctx);
    principal = await requestPrincipalForContext(ctx);
  } catch (error) { for (const entry of planned) fail(entry.i, error); return; }
  const members = planned.map(entry => ({ ...entry, key: digest({ principal, incarnation: binding.source_incarnation, inputPath: entry.inputPath, sourcePath: entry.sourcePath,
    path: entry.path, inputHash: entry.inputHash, noEmbed: !!opts.noEmbed, activePack: opts.activePack ?? null }), params: undefined as PendingImport | undefined }));
  const readPending = async (keys: string[]) => new Map((await engine.executeRaw<{ fingerprint: string; completed_keys: [PendingImport] }>(
    'SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])', [IMPORT_OP, keys])).map(row => [row.fingerprint, row.completed_keys[0]]));
  const open = new Set(members);
  const settle = (member: (typeof members)[number], value: ImportResult) => { open.delete(member); done(member.i, value); };
  const refuse = (member: (typeof members)[number], reason: unknown) => { open.delete(member); fail(member.i, reason); };
  const batch = randomUUID();
  // The no-op screen only decides whether a file is skipped; a file it does not
  // skip is admitted and rechecked under lock, so the batch answers its shared reads once.
  const screening: OperationContext = { ...ctx, engine: batchSharedReads(engine, SCREENING_SHARED_READS) };
  try {
    const pending = await readPending(members.map(member => member.key));
    const fresh: typeof members = [];
    await withScreeningPaths(async () => { for (const member of members) {
      member.params = pending.get(member.key);
      if (member.params) continue;
      try {
        const snapshot = await engine.readPageSnapshot(member.slug, { sourceId, includeDeleted: true });
        // The input is the canonical file itself (the common case): its hash was taken from the bytes just read.
        const targetHash = member.target === member.inputPath ? member.inputHash : existsSync(member.target) ? sha256(readImportBytes(member.target)) : null;
        const intent: ManagedImportIntent = { kind: 'managed_file_import', slug: member.slug, content: member.content, sourcePath: member.sourcePath, path: member.path,
          inputPath: member.inputPath, inputHash: member.inputHash, targetHash,
          ownerEpoch: String(binding.owner_epoch), ...(snapshot ? { expected_revision: snapshot.revision } : {}),
          noEmbed: !!opts.noEmbed, ...(opts.activePack ? { activePack: opts.activePack } : {}) };
        // #5470: an import whose publication would change nothing takes no admission.
        if (await unchangedManagedImport(screening, binding, intent, snapshot)) { settle(member, { slug: member.slug, status: 'skipped', chunks: 0 }); continue; }
        member.params = { ...intent, ...(members.length > 1 ? { import_batch: batch } : {}), request_id: randomUUID(), source_id: sourceId };
        fresh.push(member);
      } catch (error) { refuse(member, error); }
    } });
    if (fresh.length) {
      await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
        SELECT $1,k,c::jsonb FROM unnest($2::text[],$3::text[]) AS u(k,c) ON CONFLICT DO NOTHING`,
      [IMPORT_OP, fresh.map(member => member.key), fresh.map(member => JSON.stringify([member.params]))]);
      const stored = await readPending(fresh.map(member => member.key));
      for (const member of fresh) member.params = stored.get(member.key)!;
    }
  } catch (error) { for (const member of [...open]) refuse(member, error); return; }
  const submitted = members.filter(member => open.has(member));
  if (!submitted.length) return;
  const outcomes = await submitManagedImports(ctx, batch, submitted.map(member => member.params!));
  const cleared: typeof submitted = [];
  submitted.forEach((member, position) => {
    const outcome = outcomes[position]!;
    if (outcome.status === 'fulfilled') {
      cleared.push(member);
      const value = outcome.value;
      done(member.i, { slug: String(value.slug), status: value.status as ImportResult['status'], chunks: Number(value.chunks ?? 0),
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
        ...(value.type_warning ? { type_warning: value.type_warning as ImportResult['type_warning'] } : {}) });
      return;
    }
    const error = outcome.reason;
    if (error instanceof OperationError && error.writeRequest && ['failed', 'conflict', 'cancelled'].includes(error.writeRequest.state)) cleared.push(member);
    fail(member.i, error);
  });
  if (!cleared.length) return;
  try {
    await engine.executeRaw(`DELETE FROM op_checkpoints o USING unnest($2::text[],$3::text[]) AS d(k,c)
      WHERE o.op=$1 AND o.fingerprint=d.k AND o.completed_keys=d.c::jsonb`,
    [IMPORT_OP, cleared.map(member => member.key), cleared.map(member => JSON.stringify([member.params]))]);
  } catch (error) { for (const member of cleared) fail(member.i, error); }
}

/**
 * The batch's owner-file `put_page` intents prepared under one writer
 * verification, the new ones admitted in one transaction (page-batch.ts
 * admitBatch) and awaited together. Each settles as submitPageMutation
 * would settle it alone; a request still pending after its share of the
 * wait settles as `write_pending`.
 */
async function submitManagedImports(ctx: OperationContext, batch: string, params: readonly PendingImport[]): Promise<PromiseSettledResult<Record<string, unknown>>[]> {
  const settled: PromiseSettledResult<Record<string, unknown>>[] = new Array(params.length);
  const rows: Array<{ index: number; row: WriteRequest; admitted: boolean; typeWarning?: unknown; slugAdvisory?: unknown }> = [];
  try {
    assertPersistenceAccepting(ctx.engine);
    await withBatchAdmission(ctx, async (own, shared) => {
      const admissions: Array<{ index: number; admission: WriteAdmission; typeWarning: unknown; slugAdvisory: unknown }> = [];
      for (let index = 0; index < params.length; index++) {
        try {
          const prepared = await preparePageAdmission(index === 0 ? own : shared, { operation: 'put_page', params: params[index]!, managedFileImport: true });
          if (prepared.prior) rows.push({ index, row: prepared.prior, admitted: false });
          else admissions.push({ index, admission: prepared.admission, typeWarning: prepared.typeWarning, slugAdvisory: prepared.slugAdvisory });
        } catch (reason) { settled[index] = { status: 'rejected', reason }; }
      }
      if (!admissions.length) return;
      try {
        const admitted = await admitBatch(ctx, batch, admissions.map(entry => entry.admission));
        admissions.forEach((entry, position) => rows.push({ index: entry.index, row: admitted[position]!, admitted: true, typeWarning: entry.typeWarning, slugAdvisory: entry.slugAdvisory }));
      } catch (reason) {
        // #6355: the batch's outcome is unknown for every file; each file names its own request id to read (and replay).
        const unknown = reason instanceof OperationError && reason.code === 'write_outcome_unknown';
        for (const entry of admissions) settled[entry.index] = { status: 'rejected',
          reason: unknown ? writeOutcomeUnknown(entry.admission.requestId!, new Error(String(reason.detail ?? reason.message))) : reason };
      }
    });
  } catch (reason) {
    for (let index = 0; index < params.length; index++) settled[index] ??= { status: 'rejected', reason };
    return settled;
  }
  rows.sort((a, b) => a.index - b.index);
  const done = await waitForWrites(ctx.engine, rows.map(entry => entry.row), ctx.config, IMPORT_WAIT_MS * rows.length);
  rows.forEach((entry, position) => {
    try {
      const response = pendingAwareResponse(ctx, done[position]!);
      if (entry.admitted) emitFenceNotice(ctx, response, done[position]!.slug);
      settled[entry.index] = { status: 'fulfilled', value: { ...response, ...(entry.typeWarning ? { type_warning: entry.typeWarning } : {}),
        ...(entry.slugAdvisory ? { slug_advisory: entry.slugAdvisory } : {}) } };
    } catch (reason) { settled[entry.index] = { status: 'rejected', reason }; }
  });
  return settled;
}

/** Runs the managed-import preparer on an unadmitted request; true only when the no-op kernel finds nothing to publish. */
async function unchangedManagedImport(ctx: OperationContext, binding: WorktreeBinding, intent: ManagedImportIntent, snapshot: PageSnapshot | null): Promise<boolean> {
  if (!snapshot) return false;
  try {
    const authority = await submissionAuthority(ctx, 'put_page', binding.source_id, binding.source_incarnation, intent.slug);
    const row = screeningRequest({ source_id: binding.source_id, source_incarnation: binding.source_incarnation, slug: intent.slug,
      page_id: snapshot.page.id, worktree_id: binding.worktree_id, authority, intent, operation: 'put_page' });
    const prepared = await prepareManagedImportMutation(ctx.engine, row, ctx.config, { snapshot });
    if ((await inspectUnchanged(ctx.engine, { prepared, snapshot, sourcePath: intent.sourcePath, databaseOnly: false })).admitReason) return false;
    await prepared.validate?.(ctx.engine);
    return true;
  } catch {
    return false;
  }
}

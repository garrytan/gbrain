import { ownerImportTrust, ownerSourceGateInput } from '../trust/channel.ts';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { importFromContent, type ParsedPage } from '../import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { alignWithStored } from './align-stored.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, restoreHiddenFactRows, type ParsedFact } from '../facts-fence.ts';
import { opError } from '../ops/contract.ts';
import { privateRequestRefusal } from './visibility-request.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { sameCanonicalImport } from '../page-state/import-guard.ts';
import { transferLegacyAtomPageState } from '../cycle/extract-atoms-page-state.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { authorizeStoredRequest } from './authority.ts';
import { materializeTimeline, prepareCanonicalProjections } from './canonical-projections.ts';
import { preserveProtectedTakes } from './protected-takes.ts';
import { digest, sha256 } from './digest.ts';
import { mergeReconcile, reconcileCanonical, type ReconcileDecision } from './reconcile-merge.ts';
import { stabilizeSafetyAssessments } from './reconcile-safety.ts';
import { fileWinsContent } from './file-wins-content.ts';
import { ABSENT_FILE_HASH, assertReconcilePins, readCanonicalFileText, readReconcileState, reconcileFileReading, reconcileReadOptions, staleReconcile, validateReconcileArtifact, type ReconcileState } from './reconcile-state.ts';
import { verifyReconcileBackup } from './reconcile-backup.ts';
import { assertAutoDecisions } from './reconcile-additive.ts';
import { admissionAllows, readSyncAdmission } from './sync-admission.ts';
import { bindOrigin } from './origin-guard.ts';

const pageFix = (sourceId: string, slug: string): Action => readFix(`Shows page ${slug} in source ${sourceId} as stored now, with its revision, read-only.`,
  { argv: ['gbrain', 'get', '--source', sourceId, '--', slug] });
const receiptFix = (row: WriteRequest): Action => readFix('Reads the reconcile request\'s durable receipt: its state, outcome and recorded error, read-only.',
  { argv: ['gbrain', 'write-request', '--', row.request_id] });
const freshPreview = (sourceId: string, slug: string) => `Generate a fresh preview with gbrain sources reconcile ${sourceId} ${slug} --preview (with the same --brain), review it and apply that file; nothing from this attempt was written.`;

/** A copied private context shorter than this is too common to count as a copy ("Slack import", "meeting notes"). */
export const PRIVATE_CONTEXT_COPY_MIN_CHARS = 24;

/**
 * #6137: the first incoming fact row reconcile must refuse, or null. A row's
 * identity is its (row number, claim), as `restoreHiddenFactRows` uses.
 *   - Identity rule: a stored non-world row that the incoming fence carries at
 *     the same identity must be unchanged (same digest, so same visibility).
 *   - Copy rule: a row at no stored identity must not carry a stored private
 *     claim under another visibility, and a world row must not carry a stored
 *     private row's context verbatim when it is at least
 *     PRIVATE_CONTEXT_COPY_MIN_CHARS long (nor may a stored world row's
 *     context be changed to one). Sources are never compared: rows share
 *     provenance such as "Slack import".
 * A row at a stored world identity is a world row, whatever private row shares
 * its claim. This guards against verbatim copying; reworded text is not
 * detected, so it is not a confidentiality proof.
 */
export function privateFactViolation(next: readonly ParsedFact[], prior: readonly ParsedFact[]): number | null {
  const identity = (f: ParsedFact) => `${f.rowNum}\u0000${f.claim}`;
  const stored = new Map(prior.map(f => [identity(f), f]));
  const hidden = prior.filter(f => f.visibility !== 'world');
  const copiedContext = (f: ParsedFact) => {
    const context = f.context?.trim() ?? '';
    return context.length >= PRIVATE_CONTEXT_COPY_MIN_CHARS && hidden.some(h => h.context?.trim() === context);
  };
  for (const fact of next) {
    const at = stored.get(identity(fact));
    if (at) {
      if (at.visibility !== 'world' && digest(fact) !== digest(at)) return fact.rowNum;
      if (fact.visibility === 'world' && fact.context?.trim() !== at.context?.trim() && copiedContext(fact)) return fact.rowNum;
      continue;
    }
    if (hidden.some(h => h.claim === fact.claim && h.visibility !== fact.visibility)) return fact.rowNum;
    if (fact.visibility === 'world' && copiedContext(fact)) return fact.rowNum;
  }
  return null;
}

function preservePrivateFacts(incoming: string, stored: string, section: string, sourceId: string, slug: string): string {
  const next = parseFactsFence(incoming), prior = parseFactsFence(stored);
  if (next.warnings.length || prior.warnings.length) throw opError('invalid_params', 'Fact fences must parse losslessly before reconciliation.',
    'The ## Facts table of the file or of the stored page has rows that do not parse cleanly, so reconciliation cannot prove its private facts are kept; nothing was written. Repair the malformed rows in the file, then generate a fresh preview and apply it.');
  const row = privateFactViolation(next.facts, prior.facts);
  if (row !== null) {
    throw opError('permission_denied', 'Reconciliation cannot modify protected private facts; use the scoped fact workflow.',
      `Row ${row} of the ## Facts table in the reconciled ${section} would edit, renumber or change the visibility of a private fact, or copy a private fact's claim or context into another row, which reconcile never does; nothing was written. `
      + `Read the stored page with the command in fix, keep row ${row} as stored in the file (or remove the copied text), then ${freshPreview(sourceId, slug).replace(/^Generate/, 'generate')} Change private facts through the fact tools (remember, forget) instead.`,
      { why: `Row ${row} conflicts with a private fact row stored for ${slug}; reconcile only publishes rows whose (row number, claim) identity it can prove is not a private row edited or copied.`,
        fix: pageFix(sourceId, slug), docs: 'docs/guides/write-refusals.md#reconcile-private-facts' });
  }
  const merged = restoreHiddenFactRows(next, prior);
  return merged ? replaceOrInsertFactsFence(incoming, renderFactsTable(merged.merged)) : incoming;
}
export async function prepareReconcileResult(engine: BrainEngine, state: ReconcileState, decisions: ReconcileDecision[]) {
  const merged = mergeReconcile(state.file, reconcileCanonical(state.snapshot.page, state.snapshot.tags), decisions);
  if (merged.conflicts.length) return { ...merged, ready: undefined };
  const result = merged.result;
  for (const key of ['compiled_truth', 'timeline'] as const) {
    result[key] = preservePrivateFacts(preserveProtectedTakes(result[key], state.snapshot.page[key] ?? ''), state.snapshot.page[key] ?? '',
      key === 'timeline' ? 'timeline' : 'page body', state.pins.source_id, state.pins.slug);
  }
  // #5567: reconcile renders from the merged database state; an operator-approved
  // body decision edits the file side, every other merge preserves history.
  const writer = decisions.some(d => d.path === '/timeline' || d.path === '/compiled_truth') ? 'editing' : 'preserving';
  result.timeline = (await materializeTimeline(engine, result, state.pins.slug, state.snapshot, writer)).timeline;
  const content = serializePageToMarkdown({ ...state.snapshot.page, ...result }, result.tags);
  let ready: PreparedContentImport | undefined;
  const imported = await importFromContent(engine, state.pins.slug, content, {
    sourceId: state.pins.source_id, sourcePath: state.snapshot.page.source_path ?? state.originSourcePath ?? undefined,
    filename: basename(state.path).replace(/\.mdx?$/i, ''), noEmbed: true, remote: false, preserveGateMarkers: true, allowEmptyOverwrite: true,
    overrideTier: (await ownerSourceGateInput(engine, state.pins.source_id, result.frontmatter)).tier,
    prepareFrontmatter: page => stabilizeSafetyAssessments(page.frontmatter, state.snapshot.page.frontmatter, state.pins.assessment_at),
    prepare: async prepared => { ready = prepared; return prepared.result; }, holdNoncanonicalPrivate: true,
  });
  if (imported.refusal?.code === 'visibility_noncanonical') throw privateRequestRefusal(state.pins, result.frontmatter);
  if (!ready || ready.slug !== state.pins.slug) throw opError('invalid_params', imported.error ?? 'Reconciliation cannot change page identity or deduplicate to another page.',
    `The reconciled content of ${state.pins.slug} in source ${state.pins.source_id} does not import as that same page (a changed frontmatter slug or a match to another page), and reconcile never changes page identity. Keep its slug as ${state.pins.slug} in the file. ${freshPreview(state.pins.source_id, state.pins.slug)}`,
    { fix: pageFix(state.pins.source_id, state.pins.slug) });
  if (ready.observedRevision !== state.snapshot.revision) staleReconcile('revision changed during policy assessment');
  const resolved = reconcileCanonical(ready.parsedPage, [...new Set([...state.snapshot.tags, ...ready.parsedPage.tags])]);
  const project = await prepareCanonicalProjections(engine, resolved, state.pins.slug, state.pins.source_id, state.snapshot, writer);
  return { ...merged, result: resolved, ready, project };
}

/**
 * #6712 PR 4b (design v3.2 §8 fencing point 2): a keep_db reconcile (`intent.keepDb`, admitted by the sync pass) re-reads
 * `sync.admission` at preparation and inside the publication transaction; when it is not `normal` the request completes
 * `cancelled` with `admission_paused` (coordinator.ts) and nothing is written. The path is a candidate again on the next pass.
 */
async function assertKeepDbAdmission(engine: Pick<BrainEngine, 'executeRaw'>, row: WriteRequest): Promise<void> {
  if (!row.intent?.keepDb) return;
  const admission = await readSyncAdmission(engine);
  if (admissionAllows(admission, 'destructive')) return;
  throw opError('admission_paused', `sync.admission is ${admission}, so this keep_db write was cancelled before it published.`,
    `Nothing was written to ${row.slug} in source ${row.source_id}. keep_db writes resume when sync.admission is normal again (gbrain config set sync.admission normal); the next sync pass admits this page again.`,
    { fix: readFix('Shows the sync admission switch and what the newest pass paused, read-only.', { argv: ['gbrain', 'sync', 'status', '--source', row.source_id, '--json'] }) });
}

export async function prepareReconcileMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  if (row.operation !== 'put_page' || row.intent?.kind !== 'canonical_reconcile' || row.authority.remote !== false || row.authority.principal.kind !== 'local_cli') {
    throw trustedCliRequired('Canonical reconciliation requires trusted local administration.');
  }
  await authorizeStoredRequest(engine, row);
  await assertKeepDbAdmission(engine, row);
  const artifact = validateReconcileArtifact(row.intent.preview);
  const reference = row.intent.backup_reference;
  if (typeof reference !== 'string') throw opError('storage_error', 'Reconciliation has no retained preimages.',
    `Reconcile request ${row.request_id} for ${row.slug} in source ${row.source_id} carries no backup reference, so it cannot publish without its preimages. ${freshPreview(row.source_id, row.slug)}`,
    { fix: receiptFix(row) });
  verifyReconcileBackup(reference, artifact);
  if (artifact.status !== 'ready' || artifact.preconditions.source_id !== row.source_id || artifact.preconditions.slug !== row.slug || artifact.preconditions.page_id !== row.page_id) {
    throw opError('invalid_params', 'The reconciliation artifact does not name the accepted page.',
      `The resolved preview applied by request ${row.request_id} is not ready or names a different source, page or page id than ${row.slug} in source ${row.source_id}. ${freshPreview(row.source_id, row.slug)}`,
      { fix: receiptFix(row) });
  }
  const adopt = reconcileReadOptions(artifact);
  const state = await readReconcileState(engine, row.source_id, row.slug, artifact.preconditions.assessment_at, adopt);
  assertReconcilePins(artifact.preconditions, state.pins);
  assertAutoDecisions(artifact.auto_decisions ?? [], state.file, reconcileCanonical(state.snapshot.page, state.snapshot.tags), artifact.decisions);
  const prepared = await prepareReconcileResult(engine, state, artifact.decisions);
  if (!prepared.ready || digest(prepared.result) !== artifact.result_digest) staleReconcile('canonical policy result changed');
  // #6643 / GBRA-133: a request that asks to keep the file's bytes (repair file-drift --prefer file) leaves the file as it is plus
  // the protected parts reconcile kept (appended keys and timeline rows), and refuses any result that would re-render the file.
  // #6712 wave: a preview that observed the file absent recreates it from the page and expects no bytes there.
  const absent = state.pins.raw_file_hash === ABSENT_FILE_HASH;
  const content = !absent && row.intent.keep_file_bytes === true
    ? fileWinsContent(state.raw.toString('utf8'), state.file, prepared.result, text => readCanonicalFileText(state, row.slug, text), { sourceId: row.source_id, slug: row.slug })
    : serializePageToMarkdown({ ...state.snapshot.page, ...prepared.result }, prepared.result.tags);
  const ready = prepared.ready;
  return {
    observedRevision: state.snapshot.revision, trust: await ownerImportTrust(engine, row, prepared.result.frontmatter, state.path),
    file: { path: state.path, root: state.root, content, expectedBeforeHash: absent ? null : state.pins.raw_file_hash },
    // A database-only page matched by its slug path always records that file as its origin.
    noop: ready.noop && sha256(content) === state.pins.raw_file_hash && state.origin === 'recorded',
    validate: async tx => {
      await authorizeStoredRequest(tx, row, true);
      await assertKeepDbAdmission(tx, row);
      assertReconcilePins(artifact.preconditions, (await readReconcileState(tx, row.source_id, row.slug, artifact.preconditions.assessment_at, adopt)).pins);
      verifyReconcileBackup(reference, artifact);
      await ready.validate(tx);
    },
    apply: async tx => {
      await ready.apply(tx);
      if (state.originSourcePath) {
        await bindOrigin(tx, { sourceId: row.source_id, slug: row.slug, sourcePath: state.originSourcePath, onlyIfUnset: true, liveOnly: true });
      }
      // The page has a canonical origin (adopted above, or already recorded, #6536): drop the #5254 database-only classification.
      await tx.executeRaw(`UPDATE pages SET database_only_reason=NULL WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL
        AND database_only_reason IN ('unbound_source', 'origin_twin', 'mirror_read_only') AND source_path IS NOT NULL`, [row.source_id, row.slug]);
      if (!ready.noop) { await prepared.project!(tx); await sealPageTextProjection(tx, row.slug, row.source_id); }
      const final = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id });
      const scanStateTransferred = final ? await transferLegacyAtomPageState(tx, state.snapshot, final) : false;
      const reading = reconcileFileReading(readFileSync(state.path, 'utf8'), state.importPath, final?.page ?? state.snapshot.page);
      const file = parseMarkdown(reading.content, row.slug);
      if (final) alignWithStored(file, final.page, reading.inferred);
      if (!sameCanonicalImport(final, prepared.result) || digest(reconcileCanonical(file, file.tags)) !== artifact.result_digest) {
        throw opError('storage_error', 'Reconciliation canonical readback did not match the reviewed result.',
          `After publishing, ${row.slug} in source ${row.source_id} read back differently from the reviewed result, so the database change rolled back and the owner's recovery restores the file. Inspect request ${row.request_id}'s receipt before anything else and do not apply the preview again until it is terminal.`,
          { fix: receiptFix(row) });
      }
      return { status: 'reconciled', source_id: row.source_id, slug: row.slug, backup_reference: reference,
        result_digest: artifact.result_digest, database_changed: !ready.noop, file_changed: sha256(content) !== state.pins.raw_file_hash,
        scan_state_transferred: scanStateTransferred };
    },
  };
}

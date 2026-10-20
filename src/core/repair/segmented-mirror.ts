/**
 * `gbrain repair segmented-mirror [--source <id>]`: re-mirror the canonical files of pages stored in segments that an
 * older binary's withdrawal mirror passed by. Before v0.60.299.0 a withdrawal (`forget`, `forget_fact`, `purge_fact`)
 * struck the row in the page's segments but skipped its file (`skipped` reason `page_body_segmented`), so the file can
 * still hold the withdrawn or purged row.
 *
 * Preview (read-only, on the source's owner host): every live, file-backed segmented page of a source with a withdrawal
 * ledger is checked in bounded memory. A page is listed when its file is an older render the repair can explain: the
 * file passes the same file/database check the withdrawal mirror runs (the ledger overlaid on the file's facts fences
 * matches the stored body), and overlaying the ledger changes the file (it still holds a withdrawn or purged row). Each
 * listed page names its file's SHA-256 and size and those of the canonical render (`gbrain export`'s bytes, streamed
 * from the segments). A file that differs from the database for any other reason (`file_database_drift`) is listed as
 * held with the reconcile preview and is never overwritten. The hash binds the listed pages, their revisions and both
 * file hashes.
 *
 * `--apply --expect <hash> --yes` re-checks every listed page (revision and file hash, else `preview_changed`) and admits,
 * per page, one journal request (its receipt, request id derived from the hash) that commits a targeted
 * `withdrawal-mirror` and `git` effect for that page: the existing mirror (recovery record, staged stream, owner checks,
 * native lock, drift check) rewrites the file and the Git effect commits it. An apply replayed with the same hash is a
 * no-op. Explicit-only: never from `--all`, a remediation plan or an upgrade.
 */
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { fileBodyDigests, overlaidFileBodyDigests } from '../page-body/body-digests.ts';
import { ledgerApplies, type BodyLedger } from '../page-body/segment-ledger.ts';
import { fenceTooLargeError } from '../page-body/read-range.ts';
import { FileBytes } from '../persistence/large-file.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { localHostId } from '../persistence/identity.ts';
import { prepareFileTarget, unreadPageFile } from '../persistence/page-prepare.ts';
import { loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { admitWriteInTransaction, completeWrite, getWriteRequest } from '../persistence/journal.ts';
import { submissionAuthority } from '../persistence/authority.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { requestAttribution } from '../persistence/attribution.ts';
import { retryWriteAdmission } from '../persistence/admission-retry.ts';
import { isTerminal, type WriteRequest } from '../persistence/model.ts';
import { digest } from '../persistence/digest.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export const SEGMENTED_MIRROR_OPERATION = 'repair_segmented_mirror';
const DOCS = 'docs/guides/repair.md#segmented-mirror';

/** One listed page: its identity at preview time and the two file versions the preview compared. */
export interface StaleMirror {
  source_id: string; slug: string; page_id: number; revision: string; path: string;
  file_sha256: string; file_bytes: number; expected_sha256: string; expected_bytes: number;
}
/** A page (or, with slug '*', a source) the preview does not rewrite, with why and the read-only command that shows it. */
export interface HeldMirror { source_id: string; slug: string; reason: string; message: string; fix?: string[] }

type Selection = { sources: string[] };
type MirrorItem = RepairItem & { stale: StaleMirror; hash: string };

const previewCommand = (scope: Pick<RepairScope, 'source_ids'>) => `gbrain repair segmented-mirror${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
const toItem = (stale: StaleMirror, index: number, hash: string): MirrorItem => ({ cursor: { phase: 0, id: index + 1 }, source_id: stale.source_id, slug: stale.slug,
  chars: 0, action: 'remirror_file', change: { from: stale.file_sha256, to: stale.expected_sha256 }, stale, hash });
const hashOf = (scope: RepairScope, selection: Selection, items: StaleMirror[]) => previewHash({ kind: 'segmented-mirror-v1', brain_id: scope.brain_id, selection,
  items: items.map(({ source_id, slug, page_id, revision, path, file_sha256, expected_sha256 }) => ({ source_id, slug, page_id, revision, path, file_sha256, expected_sha256 })) });

/** The request id an apply admits for one page under one approved hash: a replay finds its receipt instead of admitting again. */
function remirrorRequestId(hash: string, stale: Pick<StaleMirror, 'source_id' | 'slug' | 'page_id'>): string {
  const h = digest(['segmented-mirror-request-v1', hash, stale.source_id, stale.slug, stale.page_id]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const ledgerOf = (snapshot: PageSnapshot): BodyLedger => ({ withdrawals: snapshot.withdrawals, ...(snapshot.globalPurges ? { globalPurges: snapshot.globalPurges } : {}) });

/**
 * Whether the withdrawal ledger changes the file: the digest of each body region as the file holds it against the same
 * region with the ledger overlaid on its facts fences, both streamed over the file in pieces (body-digests.ts).
 */
async function fileHoldsWithdrawnRows(engine: BrainEngine, snapshot: PageSnapshot, bytes: FileBytes): Promise<boolean> {
  const reading = { prefix: new Uint8Array(0), skip: 0 };
  const file = fileBodyDigests(bytes, reading, snapshot.page.slug, {});
  if (file.kind !== 'ok' || !file.factsFence) return false;
  const ledger = ledgerOf(snapshot);
  const overlaid = await overlaidFileBodyDigests(bytes, reading, file.regions, async text => (await overlayCanonicalBodies(engine.executeRaw.bind(engine), text, '',
    ledger.withdrawals, { sourceId: snapshot.page.source_id, marker: ledger.globalPurges })).compiled_truth,
  fence => fenceTooLargeError(snapshot.page.slug, snapshot.page.source_id, fence));
  return overlaid.truth !== file.digests.truth || overlaid.timeline !== file.digests.timeline;
}

const heldFrom = (sourceId: string, slug: string, error: OperationError): HeldMirror => {
  const drift = error.code === 'source_changed' && error.detail === 'file_database_drift';
  return { source_id: sourceId, slug, reason: drift ? 'file_database_drift' : error.code, message: error.message, ...(error.fix?.argv ? { fix: [...error.fix.argv] } : {}) };
};

/** Every listed and held page of the sources, in (source, slug) order, read on this host one page at a time. */
export async function scanSegmentedMirrors(engine: BrainEngine, sourceIds: readonly string[]): Promise<{ items: StaleMirror[]; held: HeldMirror[]; residuals: Record<string, number> }> {
  const hostId = localHostId();
  const items: StaleMirror[] = [], held: HeldMirror[] = [];
  const residuals: Record<string, number> = {};
  const hold = (entry: HeldMirror) => { held.push(entry); residuals[entry.reason] = (residuals[entry.reason] ?? 0) + 1; };
  for (const sourceId of sourceIds) {
    const binding = await getWorktreeBinding(engine, sourceId, hostId);
    if (!binding) continue;
    const slugs = (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND body_storage='segmented' AND deleted_at IS NULL ORDER BY slug", [sourceId]))
      .map(row => row.slug);
    if (!slugs.length) continue;
    if (binding.owner_host_id !== hostId || !binding.local_path) {
      hold({ source_id: sourceId, slug: '*', reason: 'not_owner_host',
        message: `This host does not hold source ${sourceId}'s canonical worktree, so the files of its ${slugs.length} segmented page(s) were not read. Run the preview on the owner host.`,
        fix: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
      continue;
    }
    const root = binding.local_path;
    for (const slug of slugs) {
      const snapshot = await engine.readPageSnapshot(slug, { sourceId });
      if (!snapshot || !isSegmentedPage(snapshot.page) || !ledgerApplies(ledgerOf(snapshot))) continue;
      try {
        const target = await prepareFileTarget(engine, { source_id: sourceId, worktree_id: binding.worktree_id, slug }, snapshot, null, hostId, { allowMissing: true });
        if (!target || !existsSync(target.path)) continue;
        const bytes = FileBytes.open(target.path);
        let holds: boolean, file: { sha256: string; bytes: number };
        try { holds = await fileHoldsWithdrawnRows(engine, snapshot, bytes); file = { sha256: bytes.hash(), bytes: bytes.length }; } finally { bytes.close(); }
        if (!holds) continue;
        const expected = await unreadPageFile(engine, snapshot);
        if (expected.hash === file.sha256) continue;
        items.push({ source_id: sourceId, slug, page_id: Number(snapshot.page.id), revision: snapshot.revision, path: relative(root, target.path).split(sep).join('/'),
          file_sha256: file.sha256, file_bytes: file.bytes, expected_sha256: expected.hash, expected_bytes: expected.bytes });
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        hold(heldFrom(sourceId, slug, error));
      }
    }
  }
  return { items, held, residuals };
}

/** The listed page as it is now: its live revision and id, and its file's streamed SHA-256, read on this host. */
async function currentState(engine: BrainEngine, stale: StaleMirror): Promise<{ revision: string | null; page_id: number | null; file_sha256: string | null }> {
  const snapshot = await engine.readPageSnapshot(stale.slug, { sourceId: stale.source_id });
  const binding = await getWorktreeBinding(engine, stale.source_id, localHostId());
  const path = binding?.local_path ? join(binding.local_path, ...stale.path.split('/')) : null;
  let file_sha256: string | null = null;
  if (path && existsSync(path)) {
    const bytes = FileBytes.open(path);
    try { file_sha256 = bytes.hash(); } finally { bytes.close(); }
  }
  return { revision: snapshot?.revision ?? null, page_id: snapshot ? Number(snapshot.page.id) : null, file_sha256 };
}

/** One page's receipt and its mirror and Git effects, admitted and committed in one transaction as a withdrawal's are. */
async function admitRemirror(ctx: OperationContext, stale: StaleMirror, hash: string, requestId: string): Promise<WriteRequest> {
  const engine = ctx.engine;
  const { requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
  const principal = await requestPrincipalForContext(ctx);
  const callerIntent = { kind: 'segmented_mirror', slug: stale.slug, page_id: stale.page_id, preview_hash: hash, file_sha256: stale.file_sha256, expected_sha256: stale.expected_sha256 };
  return retryWriteAdmission(requestId, remaining => engine.transaction(async tx => {
    await declareDurablePersistence(tx, `${Math.min(1000, remaining)}ms`, `${remaining}ms`);
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE', [stale.source_id]);
    if (!source || source.archived) throw opError('source_changed', 'The source is missing or archived.',
      `Source ${stale.source_id} is archived or missing, so ${stale.slug} was not re-mirrored. Run ${previewCommand({ source_ids: [stale.source_id] })} again.`);
    const prior = await getWriteRequest(tx, principal, requestId);
    if (prior) return prior;
    const authority = await submissionAuthority({ ...ctx, engine: tx }, SEGMENTED_MIRROR_OPERATION, stale.source_id, source.incarnation, stale.slug);
    const row = await admitWriteInTransaction(tx, { principal, operation: SEGMENTED_MIRROR_OPERATION, sourceId: stale.source_id, sourceIncarnation: source.incarnation,
      slug: stale.slug, pageId: stale.page_id, requestId, callerIntent, intent: callerIntent, authority });
    if (isTerminal(row)) return row;
    return withCoordinatedWrite(tx, [stale.source_id], async () => {
      await tx.lockPageKeys([{ sourceId: stale.source_id, slug: stale.slug }]);
      const snapshot = await tx.readPageSnapshot(stale.slug, { sourceId: stale.source_id });
      if (snapshot?.revision !== stale.revision || Number(snapshot.page.id) !== stale.page_id) throw previewChangedError(hash, previewCommand({ source_ids: [stale.source_id] }));
      await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
        SELECT $1::uuid,k.kind,$3::text::jsonb,s.id,s.incarnation,b.worktree_id
        FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
        CROSS JOIN (VALUES ('withdrawal-mirror'),('git')) AS k(kind)
        WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`, [row.id, stale.source_id, JSON.stringify({ version: 2,
        commit_subject: `gbrain: re-mirror segmented page ${stale.slug}`, commit_line: `re-mirror ${stale.slug} without withdrawn rows`,
        targets: [{ slug: stale.slug, page_id: stale.page_id, revision: stale.revision }],
        approved_file: { slug: stale.slug, file_sha256: stale.file_sha256, expected_sha256: stale.expected_sha256 } })]);
      return completeWrite(tx, row, 'committed', { segmented_mirror: { ...callerIntent, revision: stale.revision, path: stale.path, effects: ['withdrawal-mirror', 'git'] } });
    }, requestAttribution(row));
  }), undefined, error => engine.reconnect({ error }));
}

interface EffectState { kind: string; state: string; error_code: string | null; recovering: boolean; parked: boolean; skipped: Array<{ slug?: string; reason?: string }> }
async function readEffects(engine: BrainEngine, requestRowId: string): Promise<EffectState[]> {
  const rows = await engine.executeRaw<EffectState>(`SELECT kind,state,error_code,recovery IS NOT NULL AS recovering,data ? 'parked' AS parked,
    COALESCE(data->'skipped','[]'::jsonb) AS skipped FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind`, [requestRowId]);
  return rows.map(row => ({ ...row, skipped: typeof row.skipped === 'string' ? JSON.parse(row.skipped) : row.skipped }));
}
const effectSettled = (effect: EffectState) => !effect.recovering && (effect.state === 'committed' || effect.state === 'failed' || effect.parked);

/** Wakes this process's consumer and waits up to `waitMs` for the request's mirror and Git effects to settle. */
async function awaitEffects(ctx: OperationContext, requestRowId: string, waitMs: number): Promise<EffectState[]> {
  const { startPersistenceConsumer } = await import('../persistence/service.ts');
  startPersistenceConsumer(ctx.engine, ctx.config ?? { engine: ctx.engine.kind }).wake(true);
  const deadline = Date.now() + waitMs;
  for (let delay = 50; ; delay = Math.min(500, delay * 2)) {
    const effects = await readEffects(ctx.engine, requestRowId);
    if (effects.every(effectSettled) || Date.now() >= deadline) return effects;
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(1, deadline - Date.now()))));
  }
}

function outcomeOf(stale: StaleMirror, row: WriteRequest, effects: EffectState[], replayed: boolean): RepairItemOutcome {
  const detail = { request_id: row.request_id, path: stale.path, file_sha256_before: stale.file_sha256, expected_sha256: stale.expected_sha256,
    effects: effects.map(effect => ({ kind: effect.kind, state: effect.state, ...(effect.error_code ? { error: effect.error_code } : {}) })) };
  const mirror = effects.find(effect => effect.kind === 'withdrawal-mirror');
  const skip = mirror?.skipped.find(entry => entry.slug === stale.slug);
  if (skip?.reason === 'preview_changed') {
    const preview = ['gbrain', 'repair', 'segmented-mirror', '--source', stale.source_id, '--json'];
    const failure = opError('preview_changed', `The file of ${stale.slug} or its canonical render changed after the preview, so the withdrawal mirror did not rewrite it.`,
      `Run ${preview.slice(0, -1).join(' ')} again, show the user the new listing, and apply its new hash.`,
      { fix: readFix(`Previews the segmented-mirror repair of source ${stale.source_id} again, read-only; it lists ${stale.slug} with its current file hash.`, { argv: preview }) });
    return { applied: false, outcome: 'refused', reason: 'preview_changed', failure, detail: { ...detail, fix: failure.fix } };
  }
  if (replayed) return { applied: false, outcome: 'replayed', detail };
  if (skip) return { applied: false, outcome: 'held', reason: skip.reason ?? 'skipped', detail };
  if (mirror?.state === 'committed' && !mirror.recovering) return { applied: true, outcome: 'mirrored', detail };
  if (mirror && (mirror.state === 'failed' || mirror.parked)) return { applied: false, outcome: 'failed', reason: mirror.error_code ?? 'mirror_failed', detail };
  return { applied: true, outcome: 'mirror_queued', detail };
}

export const segmentedMirrorRepair: RepairHandler = {
  kind: 'segmented-mirror',
  embeds: false,
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts = { apply: false }): Promise<RepairPlan> {
    const selection: Selection = { sources: scope.source_ids };
    const command = previewCommand(scope);
    if (!opts.apply) {
      const scan = await scanSegmentedMirrors(engine, scope.source_ids);
      const hash = hashOf(scope, selection, scan.items);
      if (scan.items.length) await saveApprovedSet<StaleMirror & { selection: Selection }>(engine, { command: 'segmented-mirror', hash }, scan.items.map(stale => ({ ...stale, selection })));
      return { items: scan.items.map((stale, index) => toItem(stale, index, hash)), preview_hash: hash, residuals: scan.residuals,
        listing: scan.items.map(stale => ({ item: `${stale.source_id}:${stale.slug}`, class: 'stale_render',
          detail: `${stale.path}: file sha256 ${stale.file_sha256} (${stale.file_bytes} bytes), canonical render sha256 ${stale.expected_sha256} (${stale.expected_bytes} bytes)` })),
        details: { stale: scan.items, held: scan.held } };
    }
    if (!opts.expect) throw new OperationError('invalid_params', 'gbrain repair segmented-mirror --apply needs the preview hash.',
      `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, DOCS);
    const expect = opts.expect;
    const approved = (await loadApprovedSet<StaleMirror & { selection: Selection }>(engine, { command: 'segmented-mirror', hash: expect, previewCommand: command,
      emptyHash: async () => hashOf(scope, selection, (await scanSegmentedMirrors(engine, scope.source_ids)).items) })).items;
    if (approved.some(entry => JSON.stringify(entry.selection) !== JSON.stringify(selection))) throw previewChangedError(expect, command);
    const stale = approved.map(({ selection: _selection, ...entry }) => entry);
    const admitted = new Set((await engine.executeRaw<{ request_id: string }>('SELECT request_id::text AS request_id FROM persistence_requests WHERE request_id=ANY($1::uuid[])',
      [stale.map(entry => remirrorRequestId(expect, entry))])).map(row => row.request_id));
    // Every page not yet admitted under this hash still has the revision and file bytes the user saw, or nothing is written.
    for (const entry of stale) {
      if (admitted.has(remirrorRequestId(expect, entry))) continue;
      const now = await currentState(engine, entry);
      if (now.revision !== entry.revision || now.page_id !== entry.page_id || now.file_sha256 !== entry.file_sha256) throw previewChangedError(expect, command);
    }
    return { items: stale.map((entry, index) => toItem(entry, index, expect)).filter(item => afterCursor(item.cursor, after)), preview_hash: expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { stale, hash } = entry as MirrorItem;
    const { initializeLocalPersistence, requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
    await initializeLocalPersistence(ctx);
    const requestId = remirrorRequestId(hash, stale);
    const prior = await getWriteRequest(ctx.engine, await requestPrincipalForContext(ctx), requestId);
    const row = prior ?? await admitRemirror(ctx, stale, hash, requestId);
    if (row.state !== 'committed') return { applied: false, outcome: 'failed', reason: row.error_code ?? row.state, detail: { request_id: row.request_id } };
    const effects = prior ? await readEffects(ctx.engine, row.id) : await awaitEffects(ctx, row.id, ctx.writeWaitMs ?? 5_000);
    return outcomeOf(stale, row, effects, prior !== null);
  },
  render(details) {
    const stale = (details.stale ?? []) as StaleMirror[];
    const held = (details.held ?? []) as HeldMirror[];
    return [
      ...stale.map(entry => `  re-mirror ${entry.source_id}:${entry.slug} (${entry.path}): file sha256 ${entry.file_sha256.slice(0, 16)}… ${entry.file_bytes} bytes, `
        + `canonical render sha256 ${entry.expected_sha256.slice(0, 16)}… ${entry.expected_bytes} bytes; the file still holds a withdrawn or purged row`),
      ...held.map(entry => `  held ${entry.source_id}:${entry.slug} (${entry.reason}): not rewritten. ${entry.message}${entry.fix ? ` Read-only next step: ${entry.fix.join(' ')}` : ''}`),
    ];
  },
};

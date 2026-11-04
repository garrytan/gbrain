/**
 * `gbrain repair segmented-tiling --source <id> [--slug <slug>]...` (GST-1209): republish, from the file Git holds at HEAD,
 * each live page stored in segments whose live generation's rows do not cover its body (doctor `segmented_tiling`). Such
 * a page refuses every read (`page_body_rows_unreadable`) and a managed sync holds its file on every retry: a write once
 * committed a generation without its rows (its staging, collected by a fact purge's abort or a sweep's expiry while the
 * write prepared, was moved back to `prepared`; that move and such a flip now refuse).
 *
 * Preview (read-only; trusted local CLI, on the host that owns the source's checkout): each damaged page with its live
 * generation, the bytes its rows cover, its file, HEAD's commit, the file's blob at HEAD (object id, SHA-256 and size) and
 * the sync hold on it. The hash binds the pages, their revisions and generations, the blobs and the holds. A page with no
 * file, a file HEAD does not hold or one over pages.max_bytes is listed held and never written, as is one another sync
 * hold withholds (any but the unreadable-body `page_write_failed` hold) or one the next sync's import screen would hold
 * (purged page content, the write gate, private visibility, a fence it refuses), one that changes who can read the page
 * or one the next sync's content gate would quarantine, flag or skip embedding (the apply keeps the stored frontmatter),
 * or one over the 24 MiB the screen reads whole. A source without a Git
 * checkout (a repo-less brain) that holds a damaged page refuses: this repair republishes the copy Git holds, and the
 * database has no other; with no damaged page the preview lists nothing.
 *
 * `--apply --expect <hash>` re-checks every page (`preview_changed`), then per page, in one transaction under the page's
 * key lock (a coordinated maintenance write on a managed brain; refused while a sync or write in flight names the file):
 * versions the damaged generation by reference, screens the blob again and stages the body the screen's fence step and
 * the purge and withdrawal overlay admit (a purged claim the file still carries stays out), publishes it as a new generation through the
 * generation flip (which refuses one that does not tile), keeps the page's title, type, frontmatter, tags and trust tier,
 * clears the sync hold the preview saw, records the new revision as imported from the HEAD blob when the file imports to
 * the stored metadata (so the next sync holds no file_drift), asks the next sync to re-screen the file (so a file that differs from the
 * stored page in anything else imports normally), and writes the page's receipt, also appended to the `segmented-tiling`
 * audit log. Explicit-only: never from doctor, a remediation plan or an upgrade.
 */
import { execFileSync } from '../spawn.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { parseMarkdown } from '../markdown.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { stableJson } from '../persistence/digest.ts';
import { withoutSafetyAssessments } from '../persistence/reconcile-safety.ts';
import { withCoordinatedWrite, withWriteAttribution } from '../persistence/context.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { checkOwner, ownerUnavailableError } from '../persistence/owner-refusal.ts';
import { hostIdFor } from '../persistence/identity.ts';
import { gitChildEnv } from '../git-env.ts';
import { loadRepairBusySet, repairBusy, repairBusyError } from '../persistence/repair-busy.ts';
import { clearGitHold, readGitHold, recordSyncImportProvenance, requestGitHoldRetry, syncImportParserFor, type GitHoldRecord } from '../persistence/sync-holds.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { VERSION } from '../../version.ts';
import { unreadPageImportScreen } from '../persistence/sync-screen.ts';
import { PAGE_BODY_FAULT_CODES } from '../persistence/sync-fault-class.ts';
import { preserveWithdrawnFenceRows } from '../facts/withdrawal.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { applySegmentedBody, sealSegmentedPage, segmentedLivePage } from '../persistence/segmented-apply.ts';
import { withPageTierKept } from '../trust/fence-append.ts';
import { prepareSegmentedBody, stringBodyFlags, stringRegion } from '../page-body/ingest.ts';
import { readPageBodyPolicy } from '../page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { assertPreparedFactWithdrawals } from '../facts/withdrawal.ts';
import { buildSegmentedProjection } from '../page-body/projection.ts';
import { untiledSegmentedPages, type UntiledPage } from '../page-body/body-tiling.ts';
import { CONTENT_FLAG_KEY, isQuarantined, QUARANTINE_KEY } from '../quarantine.ts';
import { EMBED_SKIP_KEY } from '../embed-skip.ts';
import { settleContentDisposition, stripGateOwnedMarkers } from '../import-screen.ts';
import { ownerSourceGateInput } from '../trust/channel.ts';
import { isPrivatePage, PRIVACY_ALIASES } from '../search/private-visibility.ts';
import { createAuditWriter } from '../audit/audit-writer.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

const DOCS = 'docs/guides/repair.md#segmented-tiling';
export const SEGMENTED_TILING_RECEIPT_OP = 'segmented-tiling-receipt';

/** A damaged page the apply republishes: its state at preview time and the blob it republishes. */
export interface HealPage extends UntiledPage {
  source_path: string; incarnation: string; head: string; blob_oid: string; blob_sha256: string; blob_bytes: number; hold_observed_at: string | null;
}
type Selection = { source_id: string; slugs: string[] };
type HealItem = RepairItem & { page: HealPage; hash: string; last: boolean };

const previewCommand = (selection: Selection) => `gbrain repair segmented-tiling --source ${selection.source_id}${selection.slugs.map(slug => ` --slug ${slug}`).join('')}`;
const receiptKey = (hash: string, pageId: number) => `${hash}:${pageId}`;
const audit = createAuditWriter<{ ts: string } & Record<string, unknown>>({ featureName: 'segmented-tiling', errorLabel: 'segmented-tiling-audit', errorTrailer: '; repair continues' });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const git = (root: string, args: string[], maxBuffer = 1024 * 1024) => execFileSync('git', ['-C', root, ...args], { env: gitChildEnv(), maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
const gitText = (root: string, args: string[]): string | null => { try { return git(root, args).toString('utf8').trim(); } catch { return null; } };

/**
 * The checkout this host reads the source's files from: the owner's worktree on a managed source (refused off the owner
 * host), else the source's local path. Refuses a source with no Git checkout: a repo-less brain has no copy to republish.
 */
async function sourceCheckout(engine: BrainEngine, sourceId: string): Promise<{ root: string; incarnation: string; managed: boolean }> {
  const [source] = await engine.executeRaw<{ local_path: string | null; incarnation: string }>('SELECT local_path, incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source) throw new OperationError('invalid_params', `Source ${sourceId} does not exist.`, 'List the sources with gbrain sources list, then preview again with one of them.', DOCS);
  const managed = await readManagedMode(engine);
  let root = source.local_path;
  if (managed) {
    const binding = await getWorktreeBinding(engine, sourceId);
    if (binding) {
      const owner = checkOwner(binding, source.incarnation, hostIdFor(engine));
      if (owner.reason) throw ownerUnavailableError({ sourceId, reason: owner.reason, binding, incarnation: source.incarnation, hostId: hostIdFor(engine), remote: false, work: 'the segmented-tiling repair' });
      root = join(owner.binding.local_path, owner.binding.relative_path);
    }
  }
  if (!root || gitText(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) === null) {
    throw opError('not_a_git_repo', `Source ${sourceId} has no Git checkout with a commit, so the pages it lists cannot be republished from Git.`,
      'This repair republishes the copy of each page Git holds at HEAD; a repo-less source has no copy outside the database, so nothing was read or written. Rewrite the page from a copy you hold (put_page), or restore an earlier version of it (gbrain history).',
      { docs: DOCS });
  }
  return { root, incarnation: source.incarnation, managed };
}

/** HEAD's commit and the blob it holds at the page's file, or why there is none. */
function headBlob(root: string, path: string, maxBytes: number): { head: string; oid: string; bytes: number } | { held: string } {
  const head = gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'])!;
  const oid = gitText(root, ['rev-parse', '--verify', '--quiet', `HEAD:./${path}`]);
  if (!oid || gitText(root, ['cat-file', '-t', oid]) !== 'blob') return { held: `HEAD (${head.slice(0, 12)}) holds no file at ${path}` };
  const bytes = Number(gitText(root, ['cat-file', '-s', oid]));
  if (bytes > maxBytes) return { held: `the file at HEAD is ${bytes} bytes, over pages.max_bytes (${maxBytes})` };
  if (bytes > PAGE_MAX_BYTES) return { held: `the file at HEAD is ${bytes} bytes, over the ${PAGE_MAX_BYTES} bytes this repair screens whole as the next sync's import would` };
  return { head, oid, bytes };
}

const readBlob = (root: string, oid: string, bytes: number) => git(root, ['cat-file', 'blob', oid], bytes + 1024 * 1024);

const hashOf = (scope: RepairScope, selection: Selection, pages: readonly HealPage[]) => previewHash({ kind: 'segmented-tiling-v1', brain_id: scope.brain_id, selection,
  pages: pages.map(page => ({ page_id: page.page_id, slug: page.slug, revision: page.revision, generation: page.body_generation, head: page.head, blob: page.blob_oid,
    blob_sha256: page.blob_sha256, hold: page.hold_observed_at })) });

function selectionOf(scope: RepairScope, slugs: readonly string[] | undefined): Selection {
  if (scope.source_ids.length !== 1) {
    throw new OperationError('invalid_params', 'gbrain repair segmented-tiling works on one source at a time; pass --source <id>.',
      'Run doctor (gbrain doctor --only segmented_tiling) to see which sources hold damaged pages, then preview each with --source.', DOCS);
  }
  return { source_id: scope.source_ids[0]!, slugs: [...new Set(slugs ?? [])].sort() };
}

const describe = (page: HealPage) => `generation ${page.body_generation}: ${page.rows} row(s) cover ${page.covered_bytes ?? 'with a gap'}${page.covered_bytes === null ? '' : ' bytes'} of ${page.body_bytes}; `
  + `republish ${page.source_path} from HEAD ${page.head.slice(0, 12)} (blob ${page.blob_oid.slice(0, 12)}, ${page.blob_bytes} bytes)${page.hold_observed_at ? '; clears its sync hold' : ''}`;

/** A sync hold this repair may clear: the one a managed sync opens when it cannot read the page's stored body. */
const segmentedReadHold = (hold: GitHoldRecord) => hold.code === 'page_write_failed'
  && PAGE_BODY_FAULT_CODES.has(String((hold.meta as { write_failure?: { code?: unknown } } | null)?.write_failure?.code ?? ''));

/**
 * The body this repair publishes from `content` (the blob HEAD holds), or why the page is held: a sync hold other than the
 * unreadable-body one withholds the file, or the screen the next sync gives the file refuses it. Admitted bytes take the
 * fence step and the purge and withdrawal overlay an import applies, so a purged claim the file still carries stays out.
 */
async function stageable(engine: BrainEngine, page: { source_id: string; slug: string; source_path: string }, checkout: { root: string; incarnation: string },
  content: string): Promise<{ held: string } | { truth: string; timeline: string; hold: GitHoldRecord | null; asStored: boolean }> {
  const hold = await readGitHold(engine, page.source_id, checkout.incarnation, page.source_path);
  if (hold && !segmentedReadHold(hold)) return { held: `its sync hold (${hold.code}) withholds the file; resolve that hold first (gbrain sources status ${page.source_id})` };
  const screen = await unreadPageImportScreen(engine, { sourceId: page.source_id, root: checkout.root, path: page.source_path, slug: page.slug, content,
    snapshot: await engine.readPageSnapshot(page.slug, { sourceId: page.source_id }) });
  if (screen.status === 'refused') return { held: `the next sync would hold the file (${screen.refusal.code}): ${screen.refusal.message}` };
  const parsed = screen.status === 'importable' && screen.parsed ? screen.parsed : parseMarkdown(content, `${page.slug}.md`);
  const [stored] = await engine.executeRaw<{ type: string; title: string; frontmatter: Record<string, unknown> | null; tags: string[] }>(`SELECT p.type, p.title, p.frontmatter,
    COALESCE((SELECT jsonb_agg(t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS tags FROM pages p WHERE p.source_id=$1 AND p.slug=$2`, [page.source_id, page.slug]);
  const storedFrontmatter = stored?.frontmatter ?? {};
  const access = (fm: Record<string, unknown>) => JSON.stringify(['visibility', 'readable_by', 'pinned_question', ...Object.keys(PRIVACY_ALIASES)].map(key => fm[key] ?? null));
  if (access(parsed.frontmatter) !== access(storedFrontmatter)
    || isPrivatePage({ type: parsed.type, frontmatter: parsed.frontmatter }) !== isPrivatePage({ type: stored?.type ?? null, frontmatter: storedFrontmatter })) {
    return { held: 'the file changes who can read the page (visibility, readable_by, a privacy alias such as access or confidentiality, or a type that is private by default), and this repair republishes the body under the stored frontmatter' };
  }
  const settled = structuredClone(parsed);
  const gate = await ownerSourceGateInput(engine, page.source_id, settled.frontmatter);
  stripGateOwnedMarkers(settled, { preserveGateMarkers: true, writeGate: gate });
  try { await settleContentDisposition(engine, settled, { slug: page.slug, sourceId: page.source_id, stripped: false, writeGate: gate }); } catch (error) {
    return { held: `the next sync's content gate refuses the file: ${error instanceof Error ? error.message : String(error)}` };
  }
  const marked = [QUARANTINE_KEY, EMBED_SKIP_KEY, CONTENT_FLAG_KEY].filter(key => settled.frontmatter[key] != null && storedFrontmatter[key] == null);
  if (marked.length) return { held: `the next sync's content gate would mark the page ${marked.join(', ')}, and this repair republishes the body under the stored frontmatter` };
  const body = screen.status === 'importable' && screen.fences ? screen.fences.after : { compiled_truth: parsed.compiled_truth, timeline: parsed.timeline ?? '' };
  // The republished page is what an import of the file makes only when the metadata it keeps is what the file imports (an import keeps tags it lacks).
  const storedTags = new Set(stored?.tags ?? []);
  const asStored = settled.title === stored?.title && settled.type === stored?.type && settled.tags.every(tag => storedTags.has(tag))
    && stableJson(withoutSafetyAssessments(settled.frontmatter)) === stableJson(withoutSafetyAssessments(storedFrontmatter));
  return { hold, asStored, truth: (await preserveWithdrawnFenceRows(engine, page.source_id, body.compiled_truth, page.slug)).trim(),
    timeline: (await preserveWithdrawnFenceRows(engine, page.source_id, body.timeline ?? '', page.slug)).trim() };
}

/** The most damaged pages one preview lists; a preview that finds more says so (`truncated`), and the next preview after the apply lists the rest. */
export const PREVIEW_PAGE_LIMIT = 1000;

/** Every damaged page of the selection, as the preview lists it (republishable pages and held ones), up to `limit`. */
export async function survey(engine: BrainEngine, selection: Selection, limit = PREVIEW_PAGE_LIMIT): Promise<{ pages: HealPage[]; listing: RepairListing[]; held: number; truncated: boolean }> {
  const found = await untiledSegmentedPages(engine, { sourceIds: [selection.source_id], ...(selection.slugs.length ? { slugs: selection.slugs } : {}), limit: limit + 1 });
  const truncated = found.length > limit;
  const damaged = found.slice(0, limit);
  if (!damaged.length) return { pages: [], listing: [], held: 0, truncated };
  const checkout = await sourceCheckout(engine, selection.source_id);
  const { maxBytes } = await readPageBodyPolicy(engine);
  const pages: HealPage[] = [];
  const listing: RepairListing[] = [];
  let held = 0;
  for (const page of damaged) {
    const label = `${page.source_id}:${page.slug} (revision ${page.revision})`;
    const blob = page.source_path ? headBlob(checkout.root, page.source_path, maxBytes) : { held: 'the page has no file, so Git holds no copy of it' };
    if ('held' in blob) { held++; listing.push({ item: label, class: 'held', detail: blob.held }); continue; }
    const bytes = readBlob(checkout.root, blob.oid, blob.bytes);
    const staged = await stageable(engine, { ...page, source_path: page.source_path! }, checkout, bytes.toString('utf8'));
    if ('held' in staged) { held++; listing.push({ item: label, class: 'held', detail: staged.held }); continue; }
    const heal: HealPage = { ...page, source_path: page.source_path!, incarnation: checkout.incarnation, head: blob.head, blob_oid: blob.oid, blob_sha256: sha256(bytes),
      blob_bytes: bytes.length, hold_observed_at: staged.hold?.observed_at ?? null };
    pages.push(heal);
    listing.push({ item: label, class: 'republish', detail: describe(heal) });
  }
  return { pages: pages.sort((a, b) => a.page_id - b.page_id), listing, held, truncated };
}

/**
 * Republishes one page's body (`stageable`'s) in the caller's transaction and clears the sync hold the preview saw (a newer
 * one stays for the requested re-screen); false when the page, or a fact withdrawal it carries, changed since the preview.
 */
async function republish(tx: BrainEngine, page: HealPage, body: { truth: string; timeline: string; asStored: boolean }): Promise<{ generation: number; unsealed: boolean; hold_cleared: boolean } | false> {
  await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
  const [now] = await untiledSegmentedPages(tx, { sourceIds: [page.source_id], slugs: [page.slug] });
  if (!now || now.page_id !== page.page_id || now.revision !== page.revision || now.body_generation !== page.body_generation) return false;
  try { await assertPreparedFactWithdrawals(tx, page.source_id, body.truth, body.timeline, page.slug); } catch (error) {
    if (error instanceof OperationError && error.code === 'revision_conflict') return false;
    throw error;
  }
  const [row] = await tx.executeRaw<{ title: string; type: string; page_kind: string; frontmatter: Record<string, unknown> | null; contextual_retrieval_mode: string | null;
    corpus_generation: string | null; tags: string[] }>(`SELECT p.title, p.type, p.page_kind, p.frontmatter, p.contextual_retrieval_mode, p.corpus_generation,
      COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS tags FROM pages p WHERE p.id=$1`, [page.page_id]);
  const frontmatter = row!.frontmatter ?? {};
  const { truth, timeline } = body;
  const { principal } = await maintenanceAttribution(tx);
  await tx.createVersion(page.slug, { sourceId: page.source_id });
  const prepared = await prepareSegmentedBody(tx, { sourceId: page.source_id, slug: page.slug, live: await segmentedLivePage(tx, page.page_id),
    title: row!.title, type: row!.type, frontmatter, tags: row!.tags, truth: stringRegion(truth), timeline: stringRegion(timeline), hasTimeline: timeline.length > 0,
    flags: stringBodyFlags(truth, timeline), declaredBytes: Buffer.byteLength(truth, 'utf8') + Buffer.byteLength(timeline, 'utf8'),
    owner: { kind: 'import', principalKind: principal.kind, principalId: principal.id, baseRevision: page.revision },
    chunking: { quarantined: isQuarantined(frontmatter), ...(row!.contextual_retrieval_mode === 'title'
      ? { tier: 'title' as const, corpusGeneration: row!.corpus_generation } : { tier: 'none' as const, corpusGeneration: null }) } });
  const { flipRetireMaxRows } = await readPageBodyPolicy(tx);
  const applied = await withPageTierKept(tx, { sourceId: page.source_id, slug: page.slug }, () => applySegmentedBody(tx, { slug: page.slug, sourceId: page.source_id,
    pageId: page.page_id, prepared, promotion: false, retireMaxRows: flipRetireMaxRows,
    meta: { title: row!.title, type: row!.type as never, frontmatter: frontmatter as never, page_kind: row!.page_kind as never } }));
  if (applied.complete) await sealSegmentedPage(tx, page.page_id);
  // When the republished revision is what the file at HEAD imports, the import record names that blob and revision, so the next sync
  // prescreens the file instead of holding it file_drift as a database-only edit. Kept metadata the file no longer imports stays guarded.
  if (body.asStored) {
    const [after] = await tx.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1', [page.page_id]);
    const pack = await loadActivePackForEngine(tx, { remote: false, sourceId: page.source_id }).catch(() => null);
    await recordSyncImportProvenance(tx, { source_id: page.source_id, incarnation: page.incarnation, page_id: page.page_id, origin: page.source_path,
      raw_sha256: page.blob_sha256, blob_oid: page.blob_oid, working: false, gbrain_version: VERSION, revision: after!.revision,
      parser: syncImportParserFor(page.source_path, pack?.identity ?? null), disk_sha256: page.blob_sha256, disk_blob_oid: page.blob_oid });
  }
  const hold_cleared = page.hold_observed_at !== null
    && await clearGitHold(tx, { sourceId: page.source_id, incarnation: page.incarnation, path: page.source_path, observedAt: page.hold_observed_at });
  await requestGitHoldRetry(tx, page.source_id, page.incarnation, [page.source_path]);
  return { generation: prepared.newGeneration, unsealed: !applied.complete, hold_cleared };
}

async function receiptsOf(engine: BrainEngine, hash: string, pages: readonly HealPage[]): Promise<Set<number>> {
  const rows = await engine.executeRaw<{ fingerprint: string }>('SELECT fingerprint FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])',
    [SEGMENTED_TILING_RECEIPT_OP, pages.map(page => receiptKey(hash, page.page_id))]);
  return new Set(rows.map(row => Number(row.fingerprint.slice(hash.length + 1))));
}

function item(page: HealPage, hash: string, last: boolean): HealItem {
  return { cursor: { phase: 0, id: page.page_id }, source_id: page.source_id, slug: page.slug, chars: 0, action: describe(page), page, hash, last };
}

export const segmentedTilingRepair: RepairHandler = {
  kind: 'segmented-tiling',
  publication: 'projection',
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (opts?.remote !== false) throw trustedCliRequired('gbrain repair segmented-tiling reads the source\'s Git checkout and republishes stored pages, so it runs only from the trusted local CLI on the brain host.');
    const selection = selectionOf(scope, opts.slugs);
    const command = previewCommand(selection);
    if (!opts.apply) {
      const { pages, listing, held, truncated } = await survey(engine, selection);
      const hash = hashOf(scope, selection, pages);
      if (pages.length) await saveApprovedSet<HealPage & { selection: Selection }>(engine, { command: 'segmented-tiling', hash }, pages.map(page => ({ ...page, selection })));
      return { items: pages.map((page, index) => item(page, hash, index === pages.length - 1)), preview_hash: hash, listing,
        residuals: { pages_to_republish: pages.length, held, ...(truncated ? { more_pages_not_listed: 1 } : {}) },
        details: { pages, ...(truncated ? { truncated: true, next: `More than ${PREVIEW_PAGE_LIMIT} damaged pages: apply this preview, then run ${command} again to list the rest.` } : {}) } };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair segmented-tiling --apply republishes only the set a preview printed.',
        `Preview first: ${command} — show the user the listing, then run the apply command it prints: ${command} --apply --expect <preview-hash>`, DOCS);
    }
    const expect = opts.expect;
    const approved = (await loadApprovedSet<HealPage & { selection: Selection }>(engine, { command: 'segmented-tiling', hash: expect, previewCommand: command,
      emptyHash: async () => hashOf(scope, selection, []) })).items;
    if (approved.some(page => page.selection.source_id !== selection.source_id || page.selection.slugs.join('\n') !== selection.slugs.join('\n'))) throw previewChangedError(expect, command);
    const pages = approved.map(({ selection: _selection, ...page }) => page);
    const done = await receiptsOf(engine, expect, pages);
    const pending = pages.filter(page => !done.has(page.page_id));
    if (pending.length) {
      const checkout = await sourceCheckout(engine, selection.source_id);
      const { maxBytes } = await readPageBodyPolicy(engine);
      const now = new Map((await untiledSegmentedPages(engine, { sourceIds: [selection.source_id], slugs: pending.map(page => page.slug) })).map(page => [page.page_id, page]));
      for (const page of pending) {
        const live = now.get(page.page_id);
        const blob = headBlob(checkout.root, page.source_path, maxBytes);
        if (!live || live.revision !== page.revision || live.body_generation !== page.body_generation || 'held' in blob || blob.oid !== page.blob_oid) throw previewChangedError(expect, command);
      }
    }
    return { items: pages.map((page, index) => item(page, expect, index === pages.length - 1)).filter(entry => afterCursor(entry.cursor, after)),
      preview_hash: expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    if (ctx.remote !== false) throw trustedCliRequired('gbrain repair segmented-tiling runs only from the trusted local CLI on the brain host.');
    const { page, hash, last } = entry as HealItem;
    try {
      if ((await receiptsOf(ctx.engine, hash, [page])).has(page.page_id)) return { applied: true, outcome: 'republished', detail: { generation_before: page.body_generation } };
      const checkout = await sourceCheckout(ctx.engine, page.source_id);
      const bytes = readBlob(checkout.root, page.blob_oid, page.blob_bytes);
      if (sha256(bytes) !== page.blob_sha256) return { applied: false, outcome: 'changed_since_preview', reason: 'the blob no longer has the previewed bytes' };
      const staged = await stageable(ctx.engine, page, checkout, bytes.toString('utf8'));
      if ('held' in staged) return { applied: false, outcome: 'held', reason: staged.held };
      if (checkout.managed) {
        const busy = await loadRepairBusySet(ctx.engine, page.source_id, page.incarnation);
        if (repairBusy(busy, { sourcePath: page.source_path, slug: page.slug })) throw repairBusyError(busy, page.source_id, page.source_path);
      }
      const written = await ctx.engine.transaction(async tx => {
        const attribution = await maintenanceAttribution(tx);
        const write = async () => {
          const result = await republish(tx, page, staged);
          if (!result) return null;
          const [after] = await tx.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1', [page.page_id]);
          const receipt = { kind: 'segmented-tiling', hash, source_id: page.source_id, slug: page.slug, page_id: page.page_id, revision_before: page.revision,
            revision_after: after?.revision ?? null, generation_before: page.body_generation, generation_after: result.generation, path: page.source_path, head: page.head,
            blob: page.blob_oid, blob_sha256: page.blob_sha256, hold_cleared: result.hold_cleared };
          await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES ($1,$2,$3::text::jsonb,now())
            ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [SEGMENTED_TILING_RECEIPT_OP, receiptKey(hash, page.page_id), JSON.stringify([receipt])]);
          return { receipt, unsealed: result.unsealed };
        };
        return checkout.managed ? withCoordinatedWrite(tx, [page.source_id], write, attribution) : withWriteAttribution(tx, attribution, write);
      });
      if (!written) return { applied: false, outcome: 'changed_since_preview', reason: 'the page changed since the preview' };
      audit.log(written.receipt);
      let projection = 'sealed';
      if (written.unsealed) await buildSegmentedProjection(ctx.engine, { sourceId: page.source_id, slug: page.slug }).catch(() => { projection = 'queued'; });
      return { applied: true, outcome: 'republished', detail: { generation_before: page.body_generation, generation_after: written.receipt.generation_after,
        hold_cleared: written.receipt.hold_cleared, projection } };
    } finally {
      if (last) await clearApprovedSet(ctx.engine, { command: 'segmented-tiling', hash });
    }
  },
  render(details) {
    return ((details.pages ?? []) as HealPage[]).map(page => `  ${page.source_id}:${page.slug}: ${describe(page)}`);
  },
};

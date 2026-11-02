/**
 * Wave B (spec 6.1): append_page. Text added to the end of a page region, idempotent by request_id, in time
 * proportional to the text added. The journal intent holds the appended text (or, from an upload session, a
 * reference to its staged parts), never the body.
 *
 * - A segmented page splices the text onto its region's tail (page-body/splice.ts): the tail segment is segmented
 *   again with the text, its new segments are staged and chunked, the content_hash resumes from the midstate before
 *   it, and nothing before the tail is read. A change of the region's fence trust restages the whole body
 *   (`rescanned: true` in the receipt).
 * - An inline page composes the new body and takes put_page's write path, which promotes it when the result crosses
 *   the segmented threshold.
 *
 * Preconditions are optional: `expected_revision` (`revision_changed`) and `expected_tail_sha256`, the sha256 of the
 * region's last min(4096, region bytes) raw bytes as get_page body:'none' returns it (`tail_changed`). A remote
 * caller is never shown, and cannot test, a tail that holds protected or facts text (a hash of hidden text is a
 * guessing oracle), as get_page withholds it.
 *
 * The segmented path writes its derived rows for the appended text after commit as any segmented write does (chunks,
 * embeddings). A remote append to the compiled truth records the bytes it added (`mentionRange`) for its `links` effect,
 * which mines those bytes alone (#7122, effect-links.ts); timeline rows and fence projections of the appended text follow
 * PR 4's incremental derivation.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { OperationContext } from '../operations.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { parseMarkdown, serializePageToMarkdown, timelineSentinelKind } from '../markdown.ts';
import { buildContentFlagMarker, CONTENT_FLAG_KEY, isQuarantined } from '../quarantine.ts';
import { sizeStateField } from '../page-embedding-budget.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { contentRefusalError, loadImportSanityConfig } from '../import-screen.ts';
import { assessWriteGate, DEFAULT_WRITE_GATE_CONFIG, frontmatterText, stripManagedFenceRows, writeGateApplies, writeGateDetail } from '../write-gate.ts';
import { applyTrustAllowRules } from '../trust/allow-rules.ts';
import { gateField, gateInput } from '../trust/gate-outcomes.ts';
import { recordPageGateReceipt } from '../write-gate-store.ts';
import { pageGateTrust, pageWriteTrust, recordAgentPageLowering, stampPageTrustMarker, storedPageTier } from '../trust/page-write.ts';
import { readPageBodyPolicy } from '../page-body/limits.ts';
import { isSegmentedPage, withoutBody } from '../page-body/page-shape.ts';
import { openSegmentedBody, readBodyRange } from '../page-body/read-range.ts';
import { ledgerApplies } from '../page-body/segment-ledger.ts';
import { buildSegmentedProjection } from '../page-body/projection.ts';
import { segmentWriteScope } from '../page-body/ingest.ts';
import { spliceSegmentedBody, splicePage, type BodyReplacement, type SplicePage } from '../page-body/splice.ts';
import { TIMELINE_SEPARATOR } from '../page-window/document.ts';
import { APPEND_TAIL_BYTES, inlineRegions, inlineRegionTail, type RegionTail } from '../page-body/tail-digest.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { pageIdentityError } from './page-identity.ts';
import { remoteLinkHint } from './page-advisories.ts';
import { applySegmentedBody, materializedSnapshot, sealSegmentedPage } from './segmented-apply.ts';
import { StreamedFileContent } from './large-file.ts';
import { pageDatabaseOnlyPublication, pageFix, pageRefusal, preparePageMutation, prepareFileTarget, snapshotLedger } from './page-prepare.ts';
import { submitPageMutation } from './page-mutations.ts';
import { stagedUploadText } from './page-upload.ts';
import { isWriteRequestId } from './types.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import type { ClaimPhaseClock } from './claim-phase.ts';

/** The most text one append_page call carries; a larger append goes through an upload session (mode 'append'). */
export const APPEND_TEXT_MAX_BYTES = 4 * 1024 * 1024;

export type AppendRegion = 'auto' | 'truth' | 'timeline';
export type AppendSeparator = 'auto' | 'none';
/** Staged parts of an upload session holding the text (lane 3b's commit_page_upload, mode 'append'). */
export interface AppendBodyRef { kind: 'staging'; staging_id: string; sha256: string; bytes: number }

export interface AppendPageInput {
  slug: string;
  source_id?: string;
  /** Exactly one of text and body_ref. */
  text?: string;
  body_ref?: AppendBodyRef;
  request_id: string;
  expected_revision?: string;
  expected_tail_sha256?: string;
  region?: AppendRegion;
  separator?: AppendSeparator;
  wait_ms?: unknown;
}

interface AppendIntent {
  kind: 'append_page';
  text?: string;
  body_ref?: AppendBodyRef;
  region: AppendRegion;
  separator: AppendSeparator;
  preconditions: { expected_revision?: string; expected_tail_sha256?: string };
}

/**
 * @internal The forced probe of the append cost test (test/large-pages/append-cost.test.ts): every segmented append
 * restages the whole body, as an append by put_page rewrite would.
 */
export const appendProbe = { fullRewrite: false };

const MARKERS = [FACTS_FENCE_BEGIN, FACTS_FENCE_END, TAKES_FENCE_BEGIN, TAKES_FENCE_END];
const SHA256 = /^[0-9a-f]{64}$/;
const invalid = (message: string, suggestion: string) => opError('invalid_params', message, suggestion);

/** Rejects appended text append_page never writes; the same rules for an inline and a segmented page. */
function assertAppendText(text: string): void {
  if (!text.length) throw invalid('append_page text is empty.', 'Pass the text to add as text.');
  if (text.includes('\0')) throw invalid('append_page text contains a NUL byte.', 'Pass text without NUL bytes; binary files are stored with file_upload.');
  if (!text.isWellFormed()) throw invalid('append_page text contains a lone UTF-16 surrogate.', 'Pass well-formed text.');
  if (MARKERS.some(marker => text.includes(marker))) {
    throw invalid('append_page text contains a protected facts or takes fence marker.',
      'Write facts with remember and takes with takes_add; append_page adds ordinary text only.');
  }
  if (text.split('\n').some(line => timelineSentinelKind(line.trim()) === 'marker')) {
    throw invalid('append_page text contains a timeline sentinel line.', 'Pass region: \'timeline\' to add to the timeline, and drop the sentinel line from text.');
  }
}

function parseAppendInput(input: AppendPageInput): AppendIntent {
  if (typeof input.slug !== 'string' || !input.slug) throw invalid('append_page requires slug.', 'Pass the slug of the page to append to.');
  if (typeof input.request_id !== 'string' || !input.request_id) {
    throw invalid('append_page requires request_id.', 'Pass a new request_id (a UUID) for each append; a retry with the same request_id never appends twice.');
  }
  const region = input.region ?? 'auto';
  if (!['auto', 'truth', 'timeline'].includes(region)) throw invalid('region must be auto, truth or timeline.', 'Omit region to append to the last non-empty region.');
  const separator = input.separator ?? 'auto';
  if (!['auto', 'none'].includes(separator)) throw invalid('separator must be auto or none.', 'Omit separator to insert one newline when the tail lacks one.');
  if (input.expected_revision !== undefined && !isWriteRequestId(input.expected_revision)) {
    throw invalid('expected_revision must be the UUID returned by a page read.', 'Read the page with get_page body: \'none\' and pass its revision unchanged.');
  }
  const tail = input.expected_tail_sha256;
  if (tail !== undefined && (typeof tail !== 'string' || !SHA256.test(tail.toLowerCase()))) {
    throw invalid('expected_tail_sha256 must be a lowercase hex sha256.', 'Pass tail_sha256 from get_page body: \'none\' unchanged.');
  }
  if ((input.text === undefined) === (input.body_ref === undefined)) throw invalid('append_page takes exactly one of text and body_ref.', 'Pass the text to add as text.');
  if (input.text !== undefined) {
    if (typeof input.text !== 'string') throw invalid('append_page text must be a string.', 'Pass the text to add as text.');
    const bytes = Buffer.byteLength(input.text, 'utf8');
    if (bytes > APPEND_TEXT_MAX_BYTES) {
      throw opError('request_too_large', `append_page text is ${bytes} bytes, over the ${APPEND_TEXT_MAX_BYTES}-byte limit of one call.`,
        'Nothing was admitted. Send a larger append through an upload session: begin_page_upload with mode: \'append\', then upload_page_part and commit_page_upload.');
    }
    assertAppendText(input.text);
  } else {
    const ref = input.body_ref!;
    if (ref?.kind !== 'staging' || !isWriteRequestId(ref.staging_id) || typeof ref.sha256 !== 'string' || !SHA256.test(ref.sha256)
      || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) throw invalid('body_ref must name a sealed upload staging.', 'Commit the upload session with commit_page_upload.');
  }
  return { kind: 'append_page', ...(input.text !== undefined ? { text: input.text } : { body_ref: { kind: 'staging', staging_id: input.body_ref!.staging_id,
    sha256: input.body_ref!.sha256, bytes: input.body_ref!.bytes } }), region, separator,
    preconditions: { ...(input.expected_revision ? { expected_revision: input.expected_revision.toLowerCase() } : {}),
      ...(tail ? { expected_tail_sha256: tail.toLowerCase() } : {}) } };
}

/**
 * Admit one append (append_page, and lane 3b's commit_page_upload for mode 'append' with `body_ref`) and wait for its
 * receipt as put_page does. A `tail_changed` refusal carries the current tail digest when the caller may see it.
 */
export async function admitPageAppend(ctx: OperationContext, input: AppendPageInput, opts: { stagedBody?: true } = {}): Promise<Record<string, unknown>> {
  const intent = parseAppendInput(input);
  const params = { slug: input.slug, ...(input.source_id !== undefined ? { source_id: input.source_id } : {}), request_id: input.request_id,
    ...(input.wait_ms !== undefined ? { wait_ms: input.wait_ms } : {}), ...intent };
  try {
    return await submitPageMutation(ctx, { operation: 'append_page', params, ...opts });
  } catch (error) {
    if (!(error instanceof OperationError) || (error.canonical ?? error.code) !== 'tail_changed') throw error;
    const sourceId = String(error.receiptFields?.source_id ?? input.source_id ?? ctx.sourceId ?? 'default');
    const slug = String(error.receiptFields?.slug ?? input.slug).toLowerCase();
    const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId });
    const found = snapshot && !snapshot.page.deleted_at ? await regionTail(ctx.engine, snapshot, intent.region) : null;
    const tail = found && !(ctx.remote !== false && found.guarded) ? found : null;
    Object.assign(error, tailChangedError(sourceId, slug, tail));
    throw error;
  }
}

/** The region an append targets: `auto` is the last non-empty region (the timeline when it holds text). */
const targetRegion = (region: AppendRegion, hasTimeline: boolean): 'truth' | 'timeline' => region === 'auto' ? (hasTimeline ? 'timeline' : 'truth') : region;
const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The tail of a segmented region: its last rows' raw text, guarded when one of those rows holds a protected or facts region. */
async function segmentedRegionTail(engine: BrainEngine, sourceId: string, page: Pick<SplicePage, 'id' | 'generation'>, region: 'truth' | 'timeline'): Promise<RegionTail> {
  const rows = await engine.executeRaw<{ sha256: Uint8Array; byte_len: number; guarded: boolean }>(`SELECT sha256, byte_len,
      (protected_regions <> '[]'::jsonb OR facts_slots <> '[]'::jsonb) AS guarded FROM page_body_manifest
    WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2) AND region=$3 AND byte_len > 0
    ORDER BY seq DESC LIMIT 8`, [page.id, page.generation, region]);
  const tail: typeof rows = [];
  for (let i = 0, bytes = 0; i < rows.length && bytes < APPEND_TAIL_BYTES; i++) { tail.unshift(rows[i]!); bytes += Number(rows[i]!.byte_len); }
  if (!tail.length) return { region, bytes: new Uint8Array(), guarded: false };
  const texts = await engine.readSegmentTexts(sourceId, tail.map(r => r.sha256));
  const raw = Buffer.concat(tail.map(r => {
    const text = texts.get(Buffer.from(r.sha256).toString('hex'));
    if (!text) throw new Error(`Segment text ${Buffer.from(r.sha256).toString('hex')} of page ${page.id} is missing.`);
    return text;
  }));
  return { region, bytes: raw.subarray(Math.max(0, raw.length - APPEND_TAIL_BYTES)), guarded: tail.some(r => r.guarded) };
}

/** The tail an append to `region` of the page in `snapshot` extends, raw; null for a segmented page that stopped being one. */
async function regionTail(engine: BrainEngine, snapshot: PageSnapshot, region: AppendRegion): Promise<RegionTail | null> {
  if (isSegmentedPage(snapshot.page)) {
    const page = await splicePage(engine, Number(snapshot.page.id));
    return page && segmentedRegionTail(engine, snapshot.page.source_id, page, targetRegion(region, page.bodyBytes > page.truthBytes));
  }
  const { truth, timeline } = await inlineRegions(engine, Number(snapshot.page.id));
  const target = targetRegion(region, !!timeline);
  return inlineRegionTail(target === 'timeline' ? timeline : truth, target);
}

function tailChangedError(sourceId: string, slug: string, tail: RegionTail | null): { fix: ReturnType<typeof readFix>; detail: string } {
  const current = tail ? sha256Hex(tail.bytes) : null;
  const read = readFix(current ? `Returns the current revision and tail_sha256 (now ${current}).` : 'Returns the current revision and size.', {
    argv: ['gbrain', 'get', '--source', sourceId, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId, body: 'none' } } });
  return { detail: JSON.stringify({ current_tail_sha256: current, ...(tail ? { tail_region: tail.region } : {}) }),
    fix: current ? { ...read, then: { mcp: { tool: 'append_page', arguments: { slug, source_id: sourceId, expected_tail_sha256: current } }, consent: [], actor: 'agent',
      why: 'Appends against the current tail, once the reread shows the text is still missing.', requires_exclusive: false,
      inputs: [{ name: 'text', how: 'the text to add' }, { name: 'request_id', how: 'a new request_id' }] } } : read };
}

function tailRefusal(row: WriteRequest, region: string): OperationError {
  return opError('tail_changed', `The ${region} tail of page ${row.slug} no longer has the expected sha256, so nothing was appended.`,
    `Another write changed the end of the page. Read it again (get_page body: 'none' returns tail_sha256), check whether the text is still missing, and append against the current tail with a new request_id.`,
    { fix: pageFix(row.source_id, row.slug) });
}

function revisionRefusal(row: WriteRequest, current: string): OperationError {
  return opError('revision_changed', `Page ${row.slug} changed since expected_revision was read (now ${current}), so nothing was appended.`,
    'Read the page again with get_page body: \'none\' and append against its current revision with a new request_id, or omit expected_revision to append unconditionally.',
    { detail: JSON.stringify({ current_revision: current }),
      fix: readFix('Returns the current revision and size.', { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug],
        mcp: { tool: 'get_page', arguments: { slug: row.slug, source_id: row.source_id, body: 'none' } } }) });
}

/** The appended text: the intent's, or an upload session's staged parts read back in order and checked against the reference. */
async function appendedText(engine: BrainEngine, intent: AppendIntent): Promise<string> {
  if (intent.text !== undefined) return intent.text;
  const ref = intent.body_ref!;
  const text = await stagedUploadText(engine, ref);
  if (text === null) {
    throw opError('body_staging_expired', 'The staged text of this append is gone or changed, so nothing was appended.',
      'Begin a new upload session and send the text again.', { detail: JSON.stringify({ staging_id: ref.staging_id }) });
  }
  assertAppendText(text);
  return text;
}

/** The new Markdown file of a segmented page: its stored regions with `replacements` applied (a ledger that rewrites bytes refuses: null). */
async function splicedPageFile(engine: BrainEngine, snapshot: PageSnapshot, frontmatter: Record<string, unknown>, replacements: readonly BodyReplacement[],
  appendTo?: 'truth' | 'timeline'): Promise<StreamedFileContent | null> {
  const ledger = snapshotLedger(snapshot);
  if (!appendTo && (ledgerApplies(ledger) || replacements.some(r => r.start === r.end))) return null;
  const head = serializePageToMarkdown({ ...withoutBody(snapshot.page), frontmatter, compiled_truth: '', timeline: '' } as never, snapshot.tags).slice(0, -1);
  const pageId = Number(snapshot.page.id);
  const produce = async function* (exec: BrainEngine): AsyncIterable<Uint8Array | string> {
    const body = await openSegmentedBody(exec, { pageId, ledger });
    yield head;
    let separated = false;
    for (const region of ['truth', 'timeline'] as const) {
      const pieces = async function* (): AsyncIterable<Uint8Array> {
        for await (const piece of readBodyRange(exec, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'trusted', region, body })) {
          if (appendTo) { yield piece.bytes; continue; }
          const start = piece.storedStart, end = start + piece.bytes.length;
          let at = 0;
          for (const r of replacements) {
            if (r.start >= end || r.end <= start) continue;
            if (r.start > start + at) yield piece.bytes.subarray(at, r.start - start);
            if (r.start >= start) yield r.bytes;
            at = Math.max(at, Math.min(r.end, end) - start);
          }
          if (at < piece.bytes.length) yield piece.bytes.subarray(at);
        }
        if (appendTo === region) for (const r of replacements) yield r.bytes;
      };
      for await (const bytes of pieces()) {
        if (!bytes.length) continue;
        if (region === 'timeline' && !separated) { yield TIMELINE_SEPARATOR; separated = true; }
        yield bytes;
      }
    }
    yield '\n';
  };
  return StreamedFileContent.measure(engine, produce);
}

export interface SegmentedSpliceRequest {
  /** The replacements to publish, from the live page's metadata; null declines (the caller takes its whole-body path). */
  replacements(page: SplicePage): Promise<{ replacements: BodyReplacement[]; appendTo?: 'truth' | 'timeline'; outcome?: Record<string, unknown> } | null>;
  /** Restage the whole body (appendProbe). */
  full?: boolean;
}

/**
 * The publication of a splice of a segmented page (append_page, segmented edit_page): stage the touched segments,
 * then, in the publication transaction, version the page, flip the generation and reseal it when every occurrence has
 * chunks; as put_page, the write stamps the writer's trust marker and files a lowering. Null when the splice does not
 * apply: an external_untrusted write the gate scans whole, an always-loaded core page, a change that creates or empties
 * a region, or a file a withdrawal ledger rewrites. The caller then takes its whole-body path.
 */
export async function prepareSegmentedSpliceMutation(engine: BrainEngine, row: WriteRequest, stored: PageSnapshot, request: SegmentedSpliceRequest): Promise<PreparedMutation | null> {
  const source = { sourceId: row.source_id };
  const frontmatter: Record<string, unknown> = { ...(stored.page.frontmatter ?? {}) };
  if (frontmatter.always_load !== undefined || frontmatter.core_priority !== undefined) return null;
  const [, pack, storedTier] = await Promise.all([assertKnowledgePublicationAllowed(engine, row),
    loadActivePackForEngine(engine, { remote: row.authority.remote, sourceId: row.source_id }).catch(() => null), storedPageTier(engine, row.source_id, row.slug)]);
  const trust = pageWriteTrust(row, frontmatter);
  const gateTrust = pageGateTrust(row, trust, storedTier);
  const gateConfig = (await loadImportSanityConfig(engine)).writeGate ?? DEFAULT_WRITE_GATE_CONFIG;
  if (gateTrust?.tier === 'external_untrusted' && writeGateApplies(gateTrust.tier, gateConfig)) return null;
  const pageId = Number(stored.page.id);
  const page = await splicePage(engine, pageId);
  if (!page) return null;
  const built = await request.replacements(page);
  if (!built) return null;
  const policy = await readPageBodyPolicy(engine);
  const bodyBytes = built.replacements.reduce((n, r) => n + r.bytes.length - (r.end - r.start), page.bodyBytes);
  if (bodyBytes > policy.maxBytes && bodyBytes > page.bodyBytes) {
    throw contentRefusalError({ code: 'file_too_large', message: `File too large (${bodyBytes} bytes): page ${row.slug} would be over pages.max_bytes (${policy.maxBytes}), so nothing was written.` },
      `Page ${row.slug} is near the configured page ceiling, so this write refuses on every retry. Start a new page for further text, or ask the owner to raise pages.max_bytes.`,
      { fix: pageFix(row.source_id, row.slug) });
  }
  stampPageTrustMarker(row, frontmatter, trust, storedTier, stored.page.frontmatter);
  // As put_page's gate (import-screen.ts settleContentDisposition), over the new text only: the stored text was assessed when it was written.
  const gate = gateTrust && writeGateApplies(gateTrust.tier, gateConfig) ? await applyTrustAllowRules(engine, assessWriteGate([['title', stored.page.title],
    ['body', stripManagedFenceRows(built.replacements.map(r => Buffer.from(r.bytes).toString('utf8')).join('\n'))], ['frontmatter', frontmatterText(frontmatter)]],
    gateInput(gateTrust, row.id), gateConfig), { sourceId: row.source_id, sourceUri: gateTrust.origin?.source_uri ?? null }) : null;
  if (gate?.verdict === 'flag' && !isQuarantined(frontmatter)) frontmatter[CONTENT_FLAG_KEY] = buildContentFlagMarker('instruction_like', writeGateDetail(gate));
  const content = row.worktree_id ? await splicedPageFile(engine, stored, frontmatter, built.replacements, built.appendTo) : undefined;
  if (content === null) return null;
  const quarantined = isQuarantined(frontmatter);
  const splice = await spliceSegmentedBody(engine, { sourceId: row.source_id, slug: row.slug, page, frontmatter, tags: stored.tags, replacements: built.replacements,
    owner: { kind: row.operation === 'append_page' ? 'append' : 'edit', principalKind: row.principal_kind, principalId: row.principal_id, baseRevision: stored.revision },
    chunking: { quarantined, tier: page.crTier, corpusGeneration: page.corpusGeneration }, full: request.full });
  if (!splice) return null;
  const { prepared } = splice;
  const abort = () => engine.setBodyStagingState(prepared.stagingId, 'aborted').catch(() => undefined);
  try {
    const file = content ? await prepareFileTarget(engine, row, stored, content, undefined, { activePack: pack?.manifest, remote: row.authority.remote }) : undefined;
    const { flipRetireMaxRows } = policy;
    let applied: { complete: boolean } | null = null;
    return { observedRevision: stored.revision, file, ...await pageDatabaseOnlyPublication(engine, row, file), ...(trust ? { trust } : {}),
      apply: async tx => {
        await tx.createVersion(row.slug, source);
        applied = await applySegmentedBody(tx, { slug: row.slug, sourceId: row.source_id, pageId, prepared, promotion: false, retireMaxRows: flipRetireMaxRows,
          meta: { title: stored.page.title, type: stored.page.type, frontmatter: frontmatter as never, page_kind: page.pageKind as never } });
        const lowered = storedTier ? await recordAgentPageLowering(tx, row, { tier: storedTier, revision: stored.revision }) : null;
        if (applied.complete) await sealSegmentedPage(tx, pageId);
        if (gate) await recordPageGateReceipt(tx, { slug: row.slug, sourceId: row.source_id, assessment: gate, requestId: row.id });
        const gateOutcome = gateField(gate, `p:${row.source_id}/${row.slug}`, null);
        const [after] = await tx.executeRaw<{ body_bytes: string }>('SELECT body_bytes::text AS body_bytes FROM pages WHERE id=$1', [pageId]);
        return { ...remoteLinkHint(row), status: 'created_or_updated', slug: row.slug, source_id: row.source_id, chunks: prepared.rows.chunks, noop: false,
          searchable: quarantined ? false : applied.complete ? true : 'pending', ...(applied.complete ? {} : { projection: 'pending' }),
          ...(splice.rescanned ? { rescanned: true } : {}), ...(lowered ? { trust_lowered: lowered } : {}),
          body_bytes: Number(after?.body_bytes ?? prepared.body.body_bytes), chunks_new: prepared.rows.chunks, ...built.outcome,
          ...await sizeStateField(tx, row.source_id, row.slug, { body_storage: 'segmented', body_bytes: prepared.body.body_bytes, frontmatter }),
          ...(gateOutcome ? { gate: gateOutcome } : {}) };
      },
      afterCommit: async target => {
        if (!applied) { await abort(); return; }
        if (!applied.complete) await buildSegmentedProjection(target, { sourceId: row.source_id, slug: row.slug }).catch(() => undefined);
        await segmentWriteScope(target, row.source_id).then(writes => writes(exec => exec.sweepSegments({ pageId }))).catch(() => undefined);
      } };
  } catch (error) {
    await abort();
    throw error;
  }
}

/** The preparer of an append_page request (service.ts dispatch). */
export async function prepareAppendMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, signal?: AbortSignal, clock?: ClaimPhaseClock): Promise<PreparedMutation> {
  signal?.throwIfAborted();
  const intent = row.intent as unknown as AppendIntent;
  const stored = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if (!stored || stored.page.deleted_at) throw pageRefusal('page_not_found', 'Page not found.', row,
    `Page ${row.slug} does not exist in source ${row.source_id} or is deleted, so nothing was appended. Create it with put_page; restore a deleted page with restore_page.`,
    pageFix(row.source_id, row.slug));
  if ((stored.page.id ?? null) !== row.page_id) throw pageIdentityError(true, 'The accepted page was deleted or recreated.');
  const expected = intent.preconditions?.expected_revision;
  if (expected && expected !== stored.revision) throw revisionRefusal(row, stored.revision);
  const text = await appendedText(engine, intent);
  const remote = row.authority.remote;
  const expectedTail = intent.preconditions?.expected_tail_sha256;
  const checkTail = (tail: RegionTail) => {
    if (expectedTail && ((remote && tail.guarded) || sha256Hex(tail.bytes) !== expectedTail)) throw tailRefusal(row, tail.region);
  };
  const separatorFor = (tail: RegionTail) => intent.separator === 'auto' && tail.bytes.length > 0 && tail.bytes[tail.bytes.length - 1] !== 0x0a ? '\n' : '';

  if (isSegmentedPage(stored.page)) {
    let mentionRange: PreparedMutation['mentionRange'];
    const prepared = await prepareSegmentedSpliceMutation(engine, row, stored, { full: appendProbe.fullRewrite, replacements: async page => {
      const region = targetRegion(intent.region, page.bodyBytes > page.truthBytes);
      const tail = await segmentedRegionTail(engine, row.source_id, page, region);
      checkTail(tail);
      if (region === 'timeline' && page.bodyBytes === page.truthBytes) return null;
      const bytes = Buffer.from(separatorFor(tail) + text, 'utf8');
      const at = region === 'truth' ? page.truthBytes : page.bodyBytes;
      mentionRange = region === 'truth' ? { start: at, end: at + bytes.length, sha256: sha256Hex(bytes) } : undefined;
      return { replacements: [{ start: at, end: at, bytes }], appendTo: region, outcome: { appended_bytes: bytes.length, region } };
    } });
    if (prepared) {
      if (mentionRange) prepared.mentionRange = mentionRange;
      return prepared;
    }
    if (Number((stored.page as { body_bytes?: number | null }).body_bytes ?? 0) + Buffer.byteLength(text, 'utf8') + 1 > PAGE_MAX_BYTES) {
      throw opError('page_body_segmented', `Page ${row.slug} cannot take this append in segments (an external_untrusted write the gate scans whole, an always-loaded core page, or an append that starts a region), and it is over the ${PAGE_MAX_BYTES}-byte limit of a whole-body write. Nothing was appended.`,
        'Append to the last non-empty region (omit region), or write from a trusted caller.', { fix: pageFix(row.source_id, row.slug) });
    }
  }
  // Inline (or a segmented page the splice declined, within the whole-body limit): compose the body and take put_page's path.
  const snapshot = (await materializedSnapshot(engine, stored))!;
  const page = snapshot.page;
  const region = targetRegion(intent.region, !!(page.timeline ?? ''));
  const before = (region === 'timeline' ? page.timeline : page.compiled_truth) ?? '';
  checkTail((await regionTail(engine, stored, region))!);
  const after = before + separatorFor(inlineRegionTail(before, region)) + text;
  const content = serializePageToMarkdown({ ...page, ...(region === 'timeline' ? { timeline: after } : { compiled_truth: after }) }, snapshot.tags);
  const beforeBytes = Buffer.byteLength(page.compiled_truth ?? '', 'utf8') + Buffer.byteLength(page.timeline ?? '', 'utf8');
  const prepared = await preparePageMutation(engine, row, config, { content, expectedRevision: stored.revision }, signal, { clock });
  const apply = prepared.apply.bind(prepared);
  // The bytes the append adds to the stored truth: the parsed truth (trimmed) after the old one. Publication may still
  // rewrite bytes before them (Tier 1 fence normalization), so their range is taken from the end of the stored truth.
  const truth = region === 'truth' ? Buffer.from(parseMarkdown(content, row.slug).compiled_truth, 'utf8') : null;
  const start = Buffer.byteLength(before, 'utf8');
  const appended = truth && truth.length > start && truth.subarray(0, start).equals(Buffer.from(before, 'utf8')) ? truth.subarray(start) : null;
  const result = { ...prepared, apply: async (tx, preimage) => {
    const outcome = await apply(tx, preimage);
    const [row2] = await tx.executeRaw<{ bytes: string | null; truth: string | null }>(`SELECT COALESCE(body_bytes, octet_length(COALESCE(compiled_truth,'')) + octet_length(COALESCE(timeline,'')))::text AS bytes,
      (CASE WHEN body_storage='segmented' THEN truth_bytes ELSE octet_length(COALESCE(compiled_truth,'')) END)::text AS truth FROM pages WHERE id=$1`, [stored.page.id]);
    const bodyBytes = Number(row2?.bytes ?? 0);
    const truthEnd = Number(row2?.truth ?? 0);
    if (appended && truthEnd >= appended.length) result.mentionRange = { start: truthEnd - appended.length, end: truthEnd, sha256: sha256Hex(appended) };
    return { ...outcome, body_bytes: bodyBytes, appended_bytes: Math.max(0, bodyBytes - beforeBytes), chunks_new: Number(outcome.chunks ?? 0), region };
  } } as PreparedMutation;
  return result;
}

/**
 * Put one fact into an entity page's `## Facts` fence through the door (GBRA-190 G4).
 *
 * `prepareFenceFactAppend` prepares, inside a coordinator preparer, the page write and the facts row of one fact on
 * the request's page (`row.slug`). Git is the parent: the coordinator publishes the file before its publication
 * transaction opens, and `apply` (which runs in that transaction) writes the page row first and the facts row second,
 * so a facts row never exists for a fence row the file does not hold. The page write is prepared unprojected (the
 * helper writes the one facts row itself), whatever the request's operation, as remember's always was.
 *
 * Modes:
 * - `append` (default): renders the fact as a new fence row with `fenceRowOf` (the one renderer) at the next row
 *   number past both the fence and every facts row indexed from the page (a row the fence lost still owns its number,
 *   #6696 C9), optionally strikes the superseded row of the same page, and prepares the page write. The stored fence is
 *   normalized first (#6188); a fence that does not parse cleanly refuses typed (`target_fence_malformed`, #6385 R12).
 *   When the page has no facts fence at all (a rewrite dropped the section, so its rows are held `fence_absent`), the
 *   live rows a fence of the page held are rendered back into the section this append creates (`withHeldFactsFence`):
 *   otherwise the next projected write reads the new one-row section as the user's answer and expires them.
 * - A request on `memory/unattributed` (`UNATTRIBUTED_MEMORY_SLUG`) with no page yet creates it: a `note` whose body is
 *   the one facts fence. Its rows project with no entity (extract-from-fence.ts), so a fact saved without an entity
 *   has a file home (GBRA-190 G4, D3). No other page is ever created here.
 * - `index-existing`: the file already holds the row (a fence-guard hold names it by `payload.row_num`). The cell at
 *   that row number must read back as the fact (`fenceCellReadBackProblem`), else it refuses `fence_row_changed` and
 *   nothing is written. No file changes: the facts row derives from the cell (`extractFactsFromFenceText`, the row a
 *   re-import projects, so the reconciler keeps it) with the caller's embedding and session. The caller's
 *   PreparedMutation carries `snapshot.revision` as its observedRevision: the coordinator re-checks it under the page
 *   lock, so the cell read here is the cell at publication.
 */
import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Action } from '../agent-output.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { Page } from '../types.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, factsFenceSection, fenceCellReadBackProblem, formatFenceDate, parseFactsFenceFor, renderFactsTable, replaceOrInsertFactsFence, strikeFactRowInPage, upsertFactRow } from '../facts-fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { isSegmentedPage, pageBodyOverCeilingError } from '../page-body/page-shape.ts';
import { materializedPage, segmentedOverCeiling } from '../persistence/segmented-apply.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { chooseBodyStorage, readPageBodyPolicy } from '../page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { effectiveBytesBlock } from '../import-screen.ts';
import { EMBED_SKIP_KEY } from '../embed-skip.ts';
import { assertPreparedFactWithdrawals, preserveWithdrawnFenceRows } from './withdrawal.ts';
import { prepareSegmentedSpliceMutation } from '../persistence/page-append.ts';
import type { BodyReplacement, SplicePage } from '../page-body/splice.ts';
import { refuseRuleFactTarget } from '../rules/admission.ts';
import type { CompanionPage, PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { normalizeTargetFences } from '../fence-repair/import-step.ts';
import { refuseUnparsedRewrite } from '../fence-repair/refusal.ts';
import { assertFenceRewritable } from '../fence-shared.ts';
import { pageFencesNormalized } from '../fence-repair/report.ts';
import { withPendingFenceRows } from '../eligibility/fence-overlay.ts';
import { withPageTierKept } from '../trust/fence-append.ts';
import { newHoldingPageFrontmatter } from '../trust/page-write.ts';
import type { TrustTier } from '../trust/tier.ts';
import { extractFactsFromFenceText, pageFactDate } from './extract-from-fence.ts';
import { isHoldingSlug } from '../facts-fence.ts';
import { rememberAcceptsPageCreatedSince } from '../persistence/page-identity.ts';
import { fenceRowOf, withHeldFactsFence, type FenceRowInput } from './unfenced-facts.ts';
import { rewriteVersionBodies } from './purge.ts';
import { carriesClaimSql, claimNeedles } from './purge-verify.ts';
import { withdrawnFact } from './withdrawal-overlay.ts';
import { pruneHoldingPageVersions } from '../page-state/versions.ts';

/**
 * @internal The forced probe of the segmented remember cost test (test/large-pages/remember-cost.test.ts): every fence
 * append to a segmented page takes the whole-body path, as before #10589.
 */
export const fenceAppendProbe = { wholeBody: false };

/**
 * #10589: the stored-byte replacements that turn each region of a segmented page from its stored text (read back whole)
 * into its new text, each pair given as [before, after]: one per region that changed, keeping the bytes the two share
 * at each end. Null when the stored text is not the generation the splice reads (the page moved: the whole-body path refuses it at its revision check).
 */
function regionReplacements(page: SplicePage, generation: number | undefined, truth: readonly [string, string],
  timeline: readonly [string, string]): BodyReplacement[] | null {
  if (generation !== page.generation) return null;
  const out: BodyReplacement[] = [];
  const continuation = (b: Buffer, at: number) => at < b.length && (b[at]! & 0xc0) === 0x80;
  for (const [from, to, start, bytes] of [[...truth, 0, page.truthBytes], [...timeline, page.truthBytes, page.bodyBytes - page.truthBytes]] as const) {
    const a = Buffer.from(from, 'utf8'), b = Buffer.from(to, 'utf8');
    if (a.length !== bytes) return null;
    if (a.equals(b)) continue;
    const shared = Math.min(a.length, b.length);
    let head = 0;
    while (head < shared && a[head] === b[head]) head++;
    while (head > 0 && (continuation(a, head) || continuation(b, head))) head--;
    let tail = 0;
    while (tail < shared - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    while (tail > 0 && (continuation(a, a.length - tail) || continuation(b, b.length - tail))) tail--;
    out.push({ start: start + head, end: start + a.length - tail, bytes: b.subarray(head, b.length - tail) });
  }
  return out;
}

export type FenceFactAppendInput = {
  /** The facts row to publish; `row_num` and `source_markdown_slug` are the helper's. kind and visibility default as insertFacts does. */
  fact: NewFact & { valid_from: Date | null };
  /** The tier the new row's chunks are cut at until its facts row exists (`withPendingFenceRows`); append only. */
  pendingTier: TrustTier;
} & (
  | { mode?: 'append'; supersede?: { rowNum: number; validUntil: Date | null };
      /** GST-2875: the facts row is stored at this visibility while its cell keeps the fact's (a widening the owner decides). */ storedVisibility?: string }
  | { mode: 'index-existing'; rowNum: number }
);

export interface FenceFactAppend {
  /** The page write callers compose into their PreparedMutation (file, exclusiveSources, validate); null in index-existing. */
  prepared: PreparedMutation | null;
  /** The fence row the fact is indexed from. */
  rowNum: number;
  /** `{ fences_normalized }` for the receipt when this write normalized the stored fence; empty otherwise. */
  fencesNormalized: Record<string, unknown>;
  /** In the publication transaction: the page write (its tier kept, #5575 ENG-1), then the facts row at `rowNum`. */
  apply(tx: BrainEngine): Promise<{ id: number; pageReceipt?: Record<string, unknown> }>;
}

/** Read-only fix naming a request's durable receipt (local CLI) or its source's writer status (remote). */
export function requestReceiptFix(row: WriteRequest): Action {
  return row.principal_kind === 'local_cli'
    ? readFix(`Reads request ${row.request_id}'s durable receipt: its state and outcome, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] })
    : readFix(`Shows source ${row.source_id}'s writer and requests in flight, including ${row.request_id}, read-only.`, { argv: ['gbrain', 'sources', 'writer', 'status', '--source', row.source_id, '--json'] });
}

/** In the publication transaction, after the page row: the facts row at `rowNum` of the request's page. */
async function insertFenceFactRow(tx: BrainEngine, row: WriteRequest, rowNum: number, indexed: NewFact): Promise<number> {
  const inserted = await tx.insertFacts([{ ...indexed, row_num: rowNum, source_markdown_slug: row.slug }], { source_id: row.source_id }); // gbrain-allow-direct-insert: coordinator publication of a fence row this request's page file holds, after the file
  if (inserted.ids.length === 1) return inserted.ids[0];
  const [occupant] = await tx.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=$3', [row.source_id, row.slug, rowNum]);
  throw opError('storage_error', 'The new canonical fact row was not indexed.',
    `The fact row for request ${row.request_id} in source ${row.source_id} was not indexed, so its transaction rolled back.`
    + (occupant ? ` Row ${rowNum} of ${row.slug} is already held by fact ${occupant.id}.` : '')
    + ' Inspect the request before submitting it again; if it repeats, run gbrain doctor --json and report it to the user.',
    { fix: requestReceiptFix(row) });
}

/** One fact as its fence cell at `rowNum` (`fenceRowOf`, the one renderer); on a holding page a held fact names its entity (GST-2492). */
function fenceCellFor(fact: FenceFactAppendInput['fact'], rowNum: number, slug: string): ReturnType<typeof fenceRowOf> {
  const entity = isHoldingSlug(slug) && fact.entity_slug ? { entity: fact.entity_slug } : {};
  return { ...entity, ...fenceRowOf({ kind: (fact.kind ?? 'fact') as FenceRowInput['kind'], visibility: fact.visibility ?? 'private', context: fact.context ?? null, valid_from: fact.valid_from,
    valid_until: fact.valid_until ?? null, source: fact.source, claim_metric: fact.claim_metric ?? null, claim_value: fact.claim_value ?? null,
    claim_unit: fact.claim_unit ?? null, claim_period: fact.claim_period ?? null, attributed_to: fact.attributed_to ?? null,
    notability: fact.notability ?? null, confidence: fact.confidence ?? null }, rowNum, fact.fact) };
}

/**
 * GST-359 C2: create the request's page, absent at preparation, holding one fact in its facts fence: `frontmatter`
 * (a complete `---` block) and `heading`, then the fence. The put requires the page still absent, so a page another
 * write created first makes this attempt conflict, and the retry appends to it. File before facts row, as an append.
 */
export async function prepareFenceFactCreate(engine: BrainEngine, row: WriteRequest, config: GBrainConfig,
  input: { fact: NewFact & { valid_from: Date | null }; pendingTier: TrustTier; frontmatter: string; heading: string; storedVisibility?: string }, signal?: AbortSignal): Promise<FenceFactAppend> {
  refuseRuleFactTarget(row.slug, input.fact.entity_slug);
  const page = { sourceId: row.source_id, slug: row.slug };
  const [indexedMax] = await engine.executeRaw<{ n: number }>('SELECT COALESCE(MAX(row_num),0)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [row.source_id, row.slug]);
  const rowNum = (indexedMax?.n ?? 0) + 1;
  const { expected_revision: _ignored, ...intent } = row.intent ?? {};
  const content = `${input.frontmatter}\n${upsertFactRow(`${input.heading}\n`, fenceCellFor(input.fact, rowNum, row.slug)).body}`;
  const prepared = await withPendingFenceRows({ ...page, rowNums: [rowNum], tier: input.pendingTier },
    () => preparePageMutation(engine, { ...row, intent: { ...intent, content, force: false } }, config, undefined, signal, { unprojected: true }));
  if (prepared.observedRevision !== null) {
    throw opError('revision_conflict', 'The page was created during preparation.',
      `Another write created ${row.slug} in source ${row.source_id} while request ${row.request_id} was prepared, so it did not save. Check that request's receipt; once it shows conflict, nothing was saved and submitting it again is safe.`,
      { fix: requestReceiptFix(row) });
  }
  return { prepared, rowNum, fencesNormalized: {}, apply: async tx => {
    const pageReceipt = await withPageTierKept(tx, page, () => prepared.apply(tx));
    return { id: await insertFenceFactRow(tx, row, rowNum, input.storedVisibility ? { ...input.fact, visibility: input.storedVisibility as NewFact['visibility'] } : input.fact), pageReceipt };
  } };
}

export async function prepareFenceFactAppend(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, snapshot: PageSnapshot | null,
  input: FenceFactAppendInput, signal?: AbortSignal): Promise<FenceFactAppend> {
  const { fact } = input;
  refuseRuleFactTarget(row.slug, fact.entity_slug);
  const page = { sourceId: row.source_id, slug: row.slug };
  if (!snapshot && (!isHoldingSlug(row.slug) || input.mode === 'index-existing')) {
    throw opError('storage_error', 'The facts fence target page does not exist.',
      `Request ${row.request_id} writes a facts row on ${row.slug} in source ${row.source_id}, which has no page, so nothing was written. Inspect the request; if it repeats, run gbrain doctor --json and report it to the user.`,
      { fix: requestReceiptFix(row) });
  }
  // Wave B: a segmented page is read back whole up to the single-string ceiling.
  if (snapshot && segmentedOverCeiling(snapshot.page)) throw pageBodyOverCeilingError(snapshot.page, `${row.operation} facts fence write`);
  const base = snapshot ? await materializedPage(engine, snapshot.page)
    : { slug: row.slug, source_id: row.source_id, type: 'note', title: 'Unattributed memory', compiled_truth: '', timeline: '', frontmatter: newHoldingPageFrontmatter(row) } as unknown as Page;
  const insert = (tx: BrainEngine, rowNum: number, indexed: NewFact) => insertFenceFactRow(tx, row, rowNum, indexed);
  // #10288: a row with an empty date cell is indexed at the page's fact date, as its projection is.
  const pageDate = pageFactDate({ slug: row.slug, frontmatter: base.frontmatter, timeZone: await engine.getConfig('brain.timezone') });

  if (input.mode === 'index-existing') {
    const { rowNum } = input;
    const cell = [base.compiled_truth, base.timeline ?? ''].flatMap(text => parseFactsFenceFor(text, page).facts).find(f => f.rowNum === rowNum);
    const problem = fenceCellReadBackProblem(cell, { fact: fact.fact, visibility: fact.visibility ?? 'private' });
    if (problem || !cell) {
      const reason = problem ?? 'row_missing';
      throw opError('fence_row_changed', `Fence row ${rowNum} of ${row.slug} no longer reads back as the fact (${reason}).`,
        `Request ${row.request_id} indexes facts row ${rowNum} of ${row.slug} in source ${row.source_id}, but that fence row is now ${reason}, so nothing was written.`
        + ' Read the page to see the row as it stands; if the fact is still wanted, remember it again.',
        { reason, detail: JSON.stringify({ slug: row.slug, row_num: rowNum, problem: reason }),
          fix: readFix(`Reads ${row.slug} with its current facts fence, read-only.`, { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug] }) });
    }
    const [{ superseded_by_row: _superseded, ...derived }] = extractFactsFromFenceText([cell], row.slug, row.source_id, { pageEffectiveDate: pageDate ?? undefined });
    const indexed: NewFact = { ...derived, embedding: fact.embedding ?? null, embedding_model: fact.embedding_model ?? null, source_session: fact.source_session ?? null };
    return { prepared: null, rowNum, fencesNormalized: {}, apply: async tx => ({ id: await insert(tx, rowNum, indexed) }) };
  }

  // #6188 (D20): the stored fence is normalized in this same write; a residual refuses typed `target_fence_malformed`.
  const target = snapshot ? await normalizeTargetFences(engine, { sourceId: row.source_id, slug: row.slug, kind: 'facts', page: base })
    : { page: { compiled_truth: '', timeline: '' }, fixes: [] };
  const fencesNormalized = target.fixes.length ? { fences_normalized: pageFencesNormalized({ sourceId: row.source_id, slug: row.slug, fixes: target.fixes,
    writer: row.principal_kind, path: snapshot?.page.source_path ?? null, remote: row.authority.remote }) } : {};
  // #6696 C9: a facts row the fence does not hold (extraction, a hand edit) still owns its row_num, so the new row numbers past both.
  const [indexedMax] = await engine.executeRaw<{ n: number }>('SELECT COALESCE(MAX(row_num),0)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [row.source_id, row.slug]);
  // #6686: the fence is edited in the section it lives in (a lone timeline fence stays below the sentinel); the other section is kept byte for byte.
  const section = factsFenceSection(target.page);
  const fenced = { compiled_truth: target.page.compiled_truth, timeline: target.page.timeline ?? '' };
  const rowNum = Math.max(indexedMax?.n ?? 0, ...[fenced.compiled_truth, fenced.timeline].flatMap(text => parseFactsFenceFor(text, page).facts.map(f => f.rowNum))) + 1;
  const cell = fenceCellFor(fact, rowNum, row.slug);
  const unfenced = snapshot ? (await withHeldFactsFence(engine, row.source_id, row.slug, fenced))[section] : fenced[section];
  // #6385 R12: an entity fence that does not parse cleanly refuses typed instead of losing the rows it skipped.
  const appended = refuseUnparsedRewrite(target.page, row.slug, row.source_id, () => upsertFactRow(unfenced, cell, page));
  let next = { ...fenced, [section]: appended.body };
  if (input.supersede) next = strikeFactRowInPage({ ...next, slug: row.slug }, input.supersede.rowNum, rowNum, input.supersede.validUntil ? formatFenceDate(input.supersede.validUntil) : undefined);
  const content = serializePageToMarkdown({ ...base, ...next }, snapshot?.tags ?? []);
  // The canonical parser/chunker and durable filesystem publication; the CAS binds this render to the snapshot.
  // #5575 ENG-1: the new row has no facts row yet; its chunks are cut at the append's tier.
  const pending = { ...page, rowNums: [rowNum], tier: input.pendingTier };
  // #10589: a segmented page publishes the edit as a splice of the segments it touches. The whole-body path re-reads,
  // re-segments, re-hashes and restages the page, so on a page holding a fence over a segment a save outran its
  // preparation budget and was lost; it remains for a splice that declines. The spliced regions are the ones that path
  // stores: trimmed, with rows withdrawn kept struck and purged rows dropped, as its import does.
  const spliced = snapshot && isSegmentedPage(snapshot.page) && !fenceAppendProbe.wholeBody ? await withPendingFenceRows(pending, async () => {
    const region = async (text: string) => (await preserveWithdrawnFenceRows(engine, row.source_id, text, row.slug)).trim();
    const stored = { compiled_truth: await region(next.compiled_truth), timeline: await region(next.timeline) };
    // The splice skips what only that path's import decides, so it declines where the import would decide otherwise:
    // household and rule admission, inline storage under the current writer policy, the single-string page ceiling,
    // and an oversized verdict the stored frontmatter does not already carry.
    const fm = snapshot.page.frontmatter ?? {};
    if (snapshot.page.type === 'household' || snapshot.page.type === 'rule' || fm.household_role !== undefined) return null;
    const bodyBytes = Buffer.byteLength(stored.compiled_truth, 'utf8') + Buffer.byteLength(stored.timeline, 'utf8');
    if (bodyBytes > PAGE_MAX_BYTES) return null;
    const policy = await readPageBodyPolicy(engine);
    if (chooseBodyStorage({ policy, bodyBytes, current: 'segmented', pageKind: 'markdown' }) !== 'segmented') return null;
    if ((bodyBytes > await effectiveBytesBlock(engine)) !== ((fm[EMBED_SKIP_KEY] as { reason?: unknown } | undefined)?.reason === 'oversized')) return null;
    const splice = await prepareSegmentedSpliceMutation(engine, row, snapshot, {
      replacements: async live => {
        const replacements = regionReplacements(live, snapshot.bodyGeneration, [base.compiled_truth, stored.compiled_truth],
          [base.timeline ?? '', stored.timeline]);
        return replacements?.length ? { replacements } : null;
      },
      file: frontmatter => serializePageToMarkdown({ ...base, ...stored, frontmatter } as Page, snapshot.tags),
    });
    // As the import's validate: a withdrawal committed since preparation that would change a fence row refuses the write.
    return splice && { ...splice, validate: async (tx: BrainEngine) => {
      await splice.validate?.(tx);
      await assertPreparedFactWithdrawals(tx, row.source_id, stored.compiled_truth, stored.timeline, row.slug);
    } };
  }) : null;
  const prepared = spliced ?? await withPendingFenceRows(pending,
    () => preparePageMutation(engine, { ...row, ...(snapshot && rememberAcceptsPageCreatedSince(row, snapshot) ? { page_id: snapshot.page.id } : {}),
      intent: { ...row.intent, content, ...(snapshot ? { expected_revision: snapshot.revision } : {}), force: false } }, config, undefined, signal, { unprojected: true }));
  if (prepared.observedRevision !== (snapshot?.revision ?? null)) {
    throw opError('revision_conflict', 'The entity page changed during preparation.',
      `Another write changed ${row.slug} in source ${row.source_id} while request ${row.request_id} was prepared, so it did not save. Check that request's receipt; once it shows conflict, nothing was saved and submitting it again is safe.`,
      { fix: requestReceiptFix(row) });
  }
  return { prepared, rowNum, fencesNormalized, apply: async tx => {
    const pageReceipt = await withPageTierKept(tx, page, () => prepared.apply(tx));
    if (snapshot && isHoldingSlug(row.slug) && !isSegmentedPage(snapshot.page)) await pruneHoldingPageVersions(tx, snapshot.page.id);
    const indexed = { ...fact, valid_from: fact.valid_from ?? pageDate };
    return { id: await insert(tx, rowNum, input.storedVisibility ? { ...indexed, visibility: input.storedVisibility as NewFact['visibility'] } : indexed), pageReceipt };
  } };
}


/**
 * GBRA-190 G4: the fence row `rowNum` of another page, struck in the same publication as the request's own page (a
 * CompanionPage): remember linking a fact saved without an entity strikes its memory/unattributed row, noting the
 * entity it now lives under, so the file never keeps a row whose facts row the link retired. Null when that page or
 * row is gone (nothing in a file to strike). The page write is prepared unprojected, as remember's own is.
 */
export async function prepareFenceRowRetirement(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, slug: string,
  retire: { rowNum: number | readonly number[]; note: string; validUntil: Date | null; forgotten?: boolean; remove?: boolean; drop?: readonly number[] }, signal?: AbortSignal):
  Promise<(CompanionPage & { mutation: PreparedMutation }) | null> {
  const retired = new Set([retire.rowNum].flat()), drop = new Set(retire.drop ?? []);
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: row.source_id, includeDeleted: true });
  if (!snapshot || snapshot.page.deleted_at) return null;
  if (segmentedOverCeiling(snapshot.page)) throw pageBodyOverCeilingError(snapshot.page, `${row.operation} facts fence write`);
  const base = await materializedPage(engine, snapshot.page);
  // #6188 / #6385 R12, as the append: the stored fence is normalized first and a residual refuses typed instead of losing the rows it skipped.
  const target = await normalizeTargetFences(engine, { sourceId: row.source_id, slug, kind: 'facts', page: base });
  const fenced = { compiled_truth: target.page.compiled_truth, timeline: target.page.timeline ?? '' };
  const section = (['compiled_truth', 'timeline'] as const).find(key => parseFactsFenceFor(fenced[key], { slug }).facts.some(f => (retired.has(f.rowNum) && f.active) || (drop.has(f.rowNum) && !f.active)));
  if (!section) return null;
  const until = retire.validUntil ? formatFenceDate(retire.validUntil) : undefined;
  const parsed = parseFactsFenceFor(fenced[section], { slug });
  refuseUnparsedRewrite(target.page, slug, row.source_id, () => assertFenceRewritable('facts', parsed));
  // GST-2492: a forgotten held row is struck as a withdrawal strikes a row (`forgotten: <note>`), so it reads back forgotten;
  // `remove` takes the rows out (a fact moved into a page not every reader can read leaves nothing on the holding page);
  // `drop` takes out struck rows (the withdrawn held rows of an entity that leaves the holding page).
  const rows = parsed.facts.filter(f => !(drop.has(f.rowNum) && !f.active) && (!retire.remove || !retired.has(f.rowNum) || !f.active)).map(f => !retired.has(f.rowNum) || !f.active ? f : retire.forgotten ? withdrawnFact(f, (retire.validUntil ?? new Date()).toISOString().slice(0, 10), retire.note)
    : { ...f, active: false, context: [retire.note, f.context?.trim()].filter(Boolean).join(' | '), ...(until ? { validUntil: until } : {}) });
  const content = serializePageToMarkdown({ ...base, ...fenced, [section]: replaceOrInsertFactsFence(fenced[section], renderFactsTable(rows)) }, snapshot.tags);
  const prepared = await preparePageMutation(engine, { ...row, slug, page_id: snapshot.page.id,
    intent: { ...row.intent, content, expected_revision: snapshot.revision, force: false } }, config, undefined, signal, { unprojected: true });
  return { slug, pageId: snapshot.page.id, observedRevision: prepared.observedRevision, mutation: prepared, ...(prepared.file ? { file: prepared.file } : {}),
    ...(prepared.validate ? { validate: (tx: BrainEngine) => prepared.validate!(tx) } : {}), apply: (tx, preimage) => prepared.apply(tx, preimage) };
}


/**
 * GST-2492 (A2): the rows of `rows` (an entity's held claims) in the saved versions of holding page `slug`, removed when
 * `write`. Each edited version keeps every other byte; only the table lines of those rows go. Database only: Git
 * history is never rewritten. Idempotent (a second run finds nothing). Reads and rewrites through purge's
 * rewriteVersionBodies, the one inline saved-version reader; segmented versions are counted, not edited.
 */
export async function heldRowsInVersions(db: BrainEngine, sourceId: string, slug: string, rows: ReadonlyArray<{ entity: string; claim: string }>, write: boolean):
  Promise<{ versions: number; rows: number; segmented: number }> {
  const out = { versions: 0, rows: 0, segmented: 0 };
  const keys = new Set(rows.map(r => `${r.entity}\0${r.claim.trim()}`));
  const entities = [...new Set(rows.map(r => r.entity))];
  if (!keys.size) return out;
  const strip = (text: string): string => {
    for (let from = 0; ;) {
      const begin = text.indexOf(FACTS_FENCE_BEGIN, from), end = begin < 0 ? -1 : text.indexOf(FACTS_FENCE_END, begin);
      if (end < 0) return text;
      const block = text.slice(begin, end + FACTS_FENCE_END.length);
      const drop = new Set(parseFactsFenceFor(block, { slug }).facts.filter(f => f.entity && keys.has(`${f.entity}\0${f.claim.trim()}`)).map(f => f.rowNum));
      const lines = block.split('\n');
      const kept = lines.filter(line => !drop.has(Number(/^\|\s*(\d+)\s*\|/.exec(line)?.[1] ?? NaN)));
      out.rows += lines.length - kept.length;
      const next = kept.join('\n');
      text = text.slice(0, begin) + next + text.slice(end + FACTS_FENCE_END.length);
      from = begin + next.length;
    }
  };
  await rewriteVersionBodies(db, { columns: '', where: `v.id>$2 AND p.slug=$3 AND (${entities.map((_, i) => carriesClaimSql('v', 4 + 2 * i)).join(' OR ')})`,
    params: after => [sourceId, after, slug, ...entities.flatMap(claimNeedles)], lock: write, keepNullTimeline: true }, strip, (_v, _edited, changed) => { if (changed) out.versions++; }, write);
  const [segmented] = await db.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id
    WHERE p.source_id = $1 AND p.slug = $2 AND v.body_storage = 'segmented'`, [sourceId, slug]);
  out.segmented = Number(segmented?.n ?? 0);
  return out;
}


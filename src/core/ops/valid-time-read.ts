/**
 * GBRA-217 `get_page {as_of}`: the edition of one page in force on a date (valid time), from the frontmatter
 * `valid_from` / `valid_until` of the current page and its retained versions.
 *
 * One statement picks over every row of the resolved page identity, before any visibility check: the greatest
 * `valid_from` on or before the date, the most recently recorded on a tie; with the counts, the gap facts and the
 * ambiguity window the verdict needs (src/core/valid-time.ts). A chosen edition the caller may not see answers as a
 * missing page, never with an older visible edition. Only `in_force` carries text at the top level; any other status
 * puts the edition under `last_in_force` or `earliest_known`. A large edition is read in windows whose cursor pins
 * that edition (`v:<version id>`, or the current page's revision, found again among the versions if the page moved
 * on); an edition that has gone answers `history: incomplete` with no text.
 */
import type { OperationContext, ParamDef } from './contract.ts';
import { opError } from './contract.ts';
import { hostFix, opTransport, readFix } from './op-fix.ts';
import { renderAction, type Action } from '../agent-output.ts';
import { assertExplicitSourceLive, federatedSearchScope, pageNotFoundError, parseSourceIdParam, readHolders, validatePageSlug } from './context.ts';
import { inlineBodyBytes } from './get-page-body.ts';
import { pageTrustForRead, readQuarantined } from './get-page-projection.ts';
import { admitsTrust, type TrustTier } from '../trust/tier.ts';
import { isCalendarDate } from '../link-validity.ts';
import { VALID_TIME_CURRENT_ORD, type ValidTimeIdentityRow } from '../engine-sql/trust-tier-reads.ts';
import { ownerFenceView, resolveExcludePrivatePages, worldOnlyFacts } from '../search/private-visibility.ts';
import { fenceTranscriptText, isQuotedPageType, neutralizeToolCalls, quotesStored } from '../search/transcript-quote.ts';
import { quotedPageMeta } from './get-page-projection.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { heldRowsForCaller } from '../eligibility/fence-overlay.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { pageDocument } from '../page-window/document.ts';
import { DEFAULT_WINDOW_BYTES, MAX_WINDOW_BYTES, decodeCursor, encodeCursor, totalLines, windowFrom, type WindowSlice } from '../page-window/window.ts';
import { openSegmentedBody } from '../page-body/read-range.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { segmentedReadDocument } from '../page-window/segmented.ts';
import { PAGE_INLINE_MAX_BYTES } from '../page-size-policy.ts';
import { LARGE_PAGE_VERSIONS_KEPT } from '../page-body/limits.ts';
import { validTimeVerdict, type ValidTimeVerdict, type ValidTimeWhy } from '../valid-time.ts';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { noteReturnedPages } from '../access/read-log.ts';

export const AS_OF_PARAM: ParamDef = { type: 'string', description: 'YYYY-MM-DD: edition in force then. No valid_time in reply: current page.' };

/** get_page parameters an as_of read does not serve: an edit view, a fuzzy match, another clock or another body cut. */
const AS_OF_UNSUPPORTED = ['fuzzy', 'include_deleted', 'include_timeline_entries', 'grammar_diagnostics', 'include_quarantined',
  'lines', 'bytes', 'around_chunk_id', 'context_lines', 'view', 'outline_from', 'section', 'grep', 'context'] as const;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}/;
/** Sorts after every page_versions id (a SERIAL int): the current page's place in recorded order. */
const CURRENT_ORD = VALID_TIME_CURRENT_ORD;
const AMENDMENTS_CAP = 20;

type Identity = ValidTimeIdentityRow;
interface PickRow {
  version_id: number | null; ord: number; replaced_at: string | null; valid_from: string; valid_until: string | null; visible: boolean;
  reason: string | null; successor_pruned: boolean; segmented: boolean; recorded_since: string | null; introduced_because: string | null; chosen: boolean;
  /** GBRA-286 (GST-687): the stored trust tier of this edition and of the write that replaced it (the next row), for the quote fence. */
  tier: string | null; successor_tier: string | null;
}
interface PickResult { row: PickRow | null; competing: number[]; undated: number; largeVersions: number; segmentedVersions: number; anyFiled: boolean; gapAt: string | null; createdAt: string | null }

const iso = (v: unknown): string | null => v == null ? null : new Date(v as string).toISOString();

/** The as_of date: a calendar date; an instant is the other clock (`known_as_of`), refused `clock_mismatch`. */
function parseAsOf(ctx: OperationContext, value: unknown): string {
  if (isCalendarDate(value)) return value;
  if (typeof value === 'string' && INSTANT.test(value.trim())) {
    throw opError('clock_mismatch', `as_of takes a calendar date (YYYY-MM-DD), not the instant ${value.trim().slice(0, 40)}.`,
      'as_of is valid time: the date an edition was in force. For what the brain had recorded at an instant, pass known_as_of instead; for valid time, pass the date alone (2026-07-01).',
      { reason: 'instant_for_date' });
  }
  throw opError('invalid_params', 'get_page: as_of must be a calendar date YYYY-MM-DD.', 'Pass a date such as 2026-07-01.',
    { fix: readFix('Reads the edition in force on that date.', { mcp: { tool: 'get_page', arguments: { slug: 'policies/policy-4a-example', as_of: '2026-07-01' } } }) });
}

function refuseCombinations(ctx: OperationContext, p: Record<string, unknown>): void {
  const slug = String(p.slug);
  if (p.known_as_of !== undefined) {
    throw opError('invalid_params', 'get_page: as_of (valid time) and known_as_of (recorded time) answer different questions; pass one.',
      'Use as_of for the edition in force on a date, or known_as_of for the page as the brain had recorded it at an instant.',
      { fix: readFix('Reads the edition in force on that date.', { mcp: { tool: 'get_page', arguments: { slug, as_of: p.as_of } } }) });
  }
  if (p.include_content === true || p.content_only === true) {
    throw opError('invalid_params', 'get_page: as_of does not combine with include_content or content_only.',
      'An as_of read returns an older edition; writing it back with put_page would silently revert the page. To edit, read the current page with include_content, then edit it; to quote the old edition, read it with as_of alone.',
      { fix: readFix('Reads the current page with its revision, ready to edit.', { mcp: { tool: 'get_page', arguments: { slug, include_content: true } } }) });
  }
  const extra = AS_OF_UNSUPPORTED.filter(k => p[k] !== undefined && p[k] !== false);
  if (extra.length || (p.body !== undefined && p.body !== 'auto' && p.body !== 'full')) {
    throw opError('invalid_params', `get_page: as_of does not combine with ${extra.length ? extra.join(', ') : `body: ${String(p.body)}`}.`,
      'Read the edition with as_of alone (plus source_id, min_trust, or the cursor and max_bytes of its next call).');
  }
}

/** The one page the read is about: a slug in more than one granted source refuses and asks for source_id. */
async function resolveIdentity(tx: BrainEngine, ctx: OperationContext, slug: string, scope: { sourceId?: string; sourceIds?: string[] }, excludePrivate: boolean, asOf: string): Promise<Identity> {
  const rows = await tx.listValidTimeIdentities({ slug, sourceId: scope.sourceId ?? null, sourceIds: scope.sourceIds ?? null, excludePrivate });
  if (rows.length > 1) {
    const sources = rows.map(r => r.source_id);
    throw opError('invalid_params', `get_page: ${slug} exists in several sources (${sources.join(', ')}); an as_of read follows one page's history.`,
      'Pass source_id to name the page.', { fix: readFix(`Reads the page in source ${sources[0]}.`, { mcp: { tool: 'get_page', arguments: { slug, source_id: sources[0], as_of: asOf } } }) });
  }
  if (!rows[0]) throw pageNotFoundError(ctx, slug, { includeDeleted: false, sourceIdParam: scope.sourceId });
  return rows[0];
}

/**
 * The pick: one statement over the current page and its retained versions. With `pinOrd` it measures that row instead
 * (a cursor's edition). The ambiguity window is the rows recorded after the pick with an earlier valid_from, and the
 * pick's recorded neighbours that keep its body under another valid_from.
 */
async function pick(tx: BrainEngine, pageId: number, asOf: string, excludePrivate: boolean, pinOrd: number | null): Promise<PickResult> {
  const r = await tx.pickValidTimeEdition({ pageId, asOf, excludePrivate, pinOrd, inlineMaxBytes: PAGE_INLINE_MAX_BYTES });
  const row: PickRow | null = r && r.ord != null ? {
    version_id: r.version_id == null ? null : Number(r.version_id), ord: Number(r.ord), replaced_at: iso(r.replaced_at), valid_from: String(r.valid_from),
    valid_until: r.valid_until == null ? null : String(r.valid_until), visible: r.visible === true, reason: (r.reason as string | null) ?? null,
    successor_pruned: r.successor_pruned === true, segmented: r.segmented === true, recorded_since: iso(r.recorded_since),
    introduced_because: (r.introduced_because as string | null) ?? null, chosen: r.chosen === true,
    tier: (r.tier as string | null) ?? null, successor_tier: (r.successor_tier as string | null) ?? null,
  } : null;
  return { row, competing: ((r?.competing as unknown[] | null) ?? []).map(Number), undated: Number(r?.undated ?? 0),
    largeVersions: Number(r?.large_versions ?? 0), segmentedVersions: Number(r?.segmented_versions ?? 0), anyFiled: r?.any_filed === true,
    gapAt: iso(r?.gap_at), createdAt: iso(r?.created_at) };
}

function verdictOf(asOf: string, picked: PickResult): ValidTimeVerdict {
  const row = picked.row;
  return validTimeVerdict({
    asOf, undatedVersions: picked.undated, gapAt: picked.gapAt, gbrainWritten: !picked.anyFiled,
    couldHaveBeenPruned: picked.largeVersions >= LARGE_PAGE_VERSIONS_KEPT || picked.segmentedVersions > 0,
    ambiguous: picked.competing.length > 0,
    edition: row ? { chosen: row.chosen, isCurrent: row.version_id === null, validFrom: row.valid_from, validUntil: row.valid_until,
      successorPruned: row.successor_pruned, recordedSince: row.recorded_since, replacedAt: row.replaced_at } : null,
  });
}

/** Amendment records (`amends` links to the page) dated after the edition took effect and on or before the date: as_of does not fold them in. */
async function amendmentsNotApplied(tx: BrainEngine, pageId: number, editionFrom: string, asOf: string, excludePrivate: boolean, scope: { sourceId?: string; sourceIds?: string[] }) {
  const sourceIds = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : null);
  return tx.listAmendmentsNotApplied({ pageId, editionFrom, asOf, excludePrivate, sourceIds, limit: AMENDMENTS_CAP });
}

/** The serialized frontmatter edit that sets valid_from to the `<DATE>` placeholder: the existing line, or a new first key. */
function validFromEdit(page: Page, tags: string[]): { old_text: string; new_text: string } | null {
  const head = serializePageToMarkdown({ slug: page.slug, type: page.type, title: page.title, frontmatter: page.frontmatter, compiled_truth: '', timeline: '' } as Page, tags);
  const close = head.indexOf('\n---', 4);
  const fm = head.slice(0, close < 0 ? head.length : close + 1);
  const line = fm.split('\n').find(l => l.startsWith('valid_from:'));
  if (line) return { old_text: `${line}\n`, new_text: "valid_from: '<DATE>'\n" };
  const first = fm.split('\n')[1];
  return head.startsWith('---\n') && first ? { old_text: `---\n${first}\n`, new_text: `---\nvalid_from: '<DATE>'\n${first}\n` } : null;
}

/** ask_user for the date an edition took effect, then the templated edit_page that records it as valid_from. */
function askDateFix(identity: Identity, page: Page, tags: string[], revision: string, question: string, why: string): Action {
  const edit = validFromEdit(page, tags);
  return {
    ask_user: true, consent: [], actor: 'user', why, user_message: question, requires_exclusive: false,
    ...(edit ? { then: { mcp: { tool: 'edit_page', arguments: { slug: identity.slug, source_id: identity.source_id, expected_revision: revision, edits: [edit],
      reason: 'Record the date this edition took effect.' } },
      inputs: [{ name: 'DATE', how: 'The date the user named, as YYYY-MM-DD (kept quoted in the frontmatter).' }],
      consent: [], actor: 'agent', why: 'Sets valid_from on the current page, so as_of reads pick it on that date.', requires_exclusive: false } } : {}),
  };
}

/**
 * Where the missing editions can be found: a world-visible file in a source with a Git checkout has them in the file's
 * history (run locally; over MCP the user or host operator runs it); otherwise only a retained copy the user holds.
 */
function recoveryFix(ctx: OperationContext, identity: Identity, asOf: string, why: ValidTimeWhy): Action {
  const gitWhy = `gbrain does not hold every edition of ${identity.slug} around ${asOf} (${why}); the file's Git history does. Read the editions there and their valid_from lines.`;
  if (identity.source_path && identity.world && identity.local_path) {
    if (ctx.remote === false && identity.local_path) {
      return { argv: ['git', '-C', identity.local_path, 'log', '--follow', '-p', '--', identity.source_path], consent: [], actor: 'agent', why: gitWhy, requires_exclusive: false };
    }
    return { ...hostFix(ctx, ['git', 'log', '--follow', '-p', '--', identity.source_path], gitWhy,
      { user_message: `gbrain no longer holds every edition of ${identity.slug} around ${asOf}. In the Git checkout of source ${identity.source_id}, run the command shown and share the editions it prints.` }),
      ...(ctx.remote === false ? {} : { actor: 'user' as const }) };
  }
  return { ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
    why: `gbrain does not hold every edition of ${identity.slug} around ${asOf} (${why}), and the page has no file whose history could fill the gap. Do not retry this read unchanged: the answer will not change.`,
    user_message: `gbrain does not hold every edition of ${identity.slug} around ${asOf}. Do you have a retained copy or a backup of the page from then?` };
}

interface Edition { versionId: number | null; title: string; type: string; tags: string[]; frontmatter: Record<string, unknown>; compiled_truth: string; timeline: string; revision: string; segmented: boolean; generation?: number }

async function loadEdition(tx: BrainEngine, identity: Identity, row: PickRow): Promise<{ edition: Edition; current: { page: Page; tags: string[]; revision: string } } | null> {
  const snap = await tx.readPageSnapshot(identity.slug, { sourceId: identity.source_id });
  if (!snap) return null;
  const current = { page: snap.page, tags: snap.tags, revision: snap.revision };
  if (row.version_id === null) {
    const p = snap.page, segmented = isSegmentedPage(p);
    return { current, edition: { versionId: null, title: p.title, type: p.type, tags: snap.tags, frontmatter: (p.frontmatter ?? {}) as Record<string, unknown>,
      compiled_truth: segmented ? '' : p.compiled_truth ?? '', timeline: segmented ? '' : p.timeline ?? '', revision: snap.revision, segmented, generation: snap.bodyGeneration } };
  }
  const v = await tx.readPageVersionEdition({ pageId: identity.id, versionId: row.version_id });
  if (!v) return null;
  return { current, edition: { versionId: v.id, title: v.title ?? identity.slug, type: v.type ?? '', tags: v.tags, frontmatter: v.frontmatter,
    compiled_truth: v.compiled_truth ?? '', timeline: v.timeline ?? '', revision: v.revision ?? '',
    segmented: v.body_storage === 'segmented', ...(v.body_generation !== null ? { generation: v.body_generation } : {}) } };
}

/**
 * The edition as the caller may read it: whole, or one window (with the next call pinned to it) when it is large or segmented.
 * GBRA-286 (#8042, GST-687): with `quote` (a remote reader, and an edition below the owner's tier or of a third-party
 * type) its text and metadata are fenced as quoted source material, a third-party edition's tool-call blocks summarized,
 * as get_page quotes the current page.
 */
async function editionView(ctx: OperationContext, identity: Identity, e: Edition, asOf: string, offset: number | null, maxBytes: number, quote: boolean): Promise<Record<string, unknown> | 'gone'> {
  const neutralize = quote && ctx.thinClient !== true && isQuotedPageType(e.type);
  const omitRows = e.segmented ? undefined : await heldRowsForCaller(ctx.engine, ctx.remote, { sourceId: identity.source_id, slug: identity.slug, compiled_truth: e.compiled_truth, timeline: e.timeline });
  const clean = (s: string) => {
    if (ctx.remote === false) return s;
    const safe = sanitizeRemoteBody(s, { includeWithdrawn: true, keepMaterializedMarkers: true, omitRows, owner: ownerFenceView(readHolders(ctx)) });
    return neutralize ? neutralizeToolCalls(safe) : safe;
  };
  const fence = (s: string) => quote && s ? fenceTranscriptText(s, identity.slug) : s;
  const { title, frontmatter, tags } = quotedPageMeta({ slug: identity.slug, title: e.title, frontmatter: e.frontmatter }, quote, e.tags);
  const meta = { ...(e.versionId === null ? { revision: e.revision } : { version_id: e.versionId }), title, type: e.type, tags, frontmatter, ...(quote ? { quoted: 'transcript' } : {}) };
  const truth = e.segmented ? '' : clean(e.compiled_truth), timeline = e.segmented ? '' : clean(e.timeline);
  const bytes = Buffer.byteLength(truth, 'utf8') + Buffer.byteLength(timeline, 'utf8');
  if (!e.segmented && offset === null && (ctx.remote === false || bytes <= await inlineBodyBytes(ctx))) return { ...meta, compiled_truth: fence(truth), timeline: fence(timeline) };
  let total: number, slice: WindowSlice, lines: number | undefined;
  if (e.segmented) {
    try {
      const body = await openSegmentedBody(ctx.engine, { pageId: identity.id, ...(e.generation !== undefined ? { generation: e.generation } : {}), hideHeld: worldOnlyFacts(ctx.remote) });
      const seg = await segmentedReadDocument(ctx.engine, body);
      total = seg.total;
      slice = await seg.from(offset ?? 0, maxBytes);
    } catch { return 'gone'; }
  } else {
    const doc = pageDocument({ compiled_truth: truth, timeline });
    total = doc.bytes.length; lines = totalLines(doc.bytes);
    slice = windowFrom(doc.bytes, offset ?? 0, maxBytes);
  }
  const text = fence(e.segmented && neutralize ? neutralizeToolCalls(slice.text) : slice.text);
  const out: Record<string, unknown> = { ...meta, body: 'window', size: { total_bytes: total, ...(lines !== undefined ? { total_lines: lines } : {}) },
    window: text === slice.text ? slice : { ...slice, text }, truncated: slice.byte_start > 0 || slice.byte_end < total };
  if (slice.byte_end < total) {
    const cursor = encodeCursor({ page_id: identity.id, revision: e.versionId === null ? e.revision : `v:${e.versionId}`, view: 'read', offset: slice.byte_end, max_bytes: maxBytes });
    out.next_cursor = cursor;
    out.next = { tool: 'get_page', arguments: { slug: identity.slug, source_id: identity.source_id, as_of: asOf, cursor } };
  }
  return out;
}

/** A cursor's pinned edition as a recorded-order position: its version, or the current page while it is still at the cursor's revision. */
async function pinnedOrd(tx: BrainEngine, ctx: OperationContext, identity: Identity, raw: unknown): Promise<{ ord: number | null; offset: number; maxBytes: number }> {
  const c = typeof raw === 'string' ? decodeCursor(raw) : null;
  if (!c || c.page_id !== identity.id || c.view !== 'read') {
    throw opError('invalid_params', `get_page: cursor is not an as_of window cursor for page ${identity.slug}.`, 'Pass the next_cursor of the previous as_of read, with the same slug, source_id and as_of.');
  }
  if (c.revision.startsWith('v:')) return { ord: Number(c.revision.slice(2)), offset: c.offset, maxBytes: c.max_bytes };
  const row = await tx.readCursorEdition({ pageId: identity.id, revision: c.revision });
  const ord = row?.current === true ? CURRENT_ORD : row?.version_id != null ? row.version_id : -1;
  return { ord, offset: c.offset, maxBytes: c.max_bytes };
}

/** `get_page {as_of}`: the edition in force on the date, with the valid_time block that says how sure the answer is. */
export async function getPageAsOf(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  refuseCombinations(ctx, p);
  const asOf = parseAsOf(ctx, p.as_of);
  const slug = String(p.slug);
  validatePageSlug(slug);
  const sourceIdParam = parseSourceIdParam(p.source_id, 'get_page', { allowAll: true });
  const scope = federatedSearchScope(ctx, sourceIdParam);
  await assertExplicitSourceLive(ctx, sourceIdParam);
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  const read = await ctx.engine.transaction(async tx => {
    await tx.beginSnapshotRead();
    const identity = await resolveIdentity(tx, ctx, slug, scope, excludePrivate, asOf);
    const pin = p.cursor !== undefined ? await pinnedOrd(tx, ctx, identity, p.cursor) : null;
    let picked = await pick(tx, identity.id, asOf, excludePrivate, pin?.ord ?? null);
    const pinGone = pin !== null && !picked.row;
    if (pinGone) picked = await pick(tx, identity.id, asOf, excludePrivate, null);
    const loaded = picked.row ? await loadEdition(tx, identity, picked.row) : null;
    const amendments = picked.row?.chosen ? await amendmentsNotApplied(tx, identity.id, picked.row.valid_from, asOf, excludePrivate, scope) : [];
    return { identity, pin, picked, pinGone, loaded, amendments };
  });
  const { identity, pin, picked, loaded, amendments } = read;
  const row = picked.row;
  const missing = () => pageNotFoundError(ctx, slug, { includeDeleted: false, sourceIdParam });
  const admitted = await pageTrustForRead(ctx, { id: identity.id }, p.min_trust);
  if (!admitted) throw missing();
  const floor = admitted.eligibility.floor;
  if (floor && row && !admitsTrust((row.tier ?? 'unknown') as TrustTier, floor)) throw missing();
  if (!row) {
    const snap = await ctx.engine.readPageSnapshot(identity.slug, { sourceId: identity.source_id });
    if (!snap) throw missing();
    throw opError('valid_time_undeclared', `${identity.slug} declares no valid_from in any retained version, so no edition can be placed on ${asOf}.`,
      'Ask the user when this text took effect and record it as valid_from; never invent a date. For what the brain had recorded at a time, read with known_as_of instead.',
      { fix: askDateFix(identity, snap.page, snap.tags, snap.revision, `When did the current text of ${identity.slug} take effect? (a date, YYYY-MM-DD)`,
        'An as_of read needs a valid_from date on the page; only the user knows when this text took effect.') });
  }
  if (excludePrivate && !row.visible) throw missing();
  if (!loaded) throw missing();
  noteReturnedPages([identity.id]);
  // #6259: a quarantined page (now, or in the chosen edition) keeps its body from a remote reader, as the plain read does.
  const quarantined = readQuarantined(ctx, loaded.current.page, false)
    ?? readQuarantined(ctx, { slug: identity.slug, source_id: identity.source_id, frontmatter: loaded.edition.frontmatter }, false);
  const verdict = verdictOf(asOf, picked);
  let { history, uncertain, why } = verdict;
  let view: Record<string, unknown> | 'gone' | null = null;
  const requested = typeof p.max_bytes === 'number' && Number.isSafeInteger(p.max_bytes) && p.max_bytes > 0 ? p.max_bytes : pin?.maxBytes ?? DEFAULT_WINDOW_BYTES;
  const quotes = (tier: string | null) => ctx.remote !== false && quotesStored(loaded.edition.type, tier);
  if (!read.pinGone && quarantined?.body_omitted !== true) view = await editionView(ctx, identity, loaded.edition, asOf, pin ? pin.offset : null, ctx.remote === false ? requested : Math.min(requested, MAX_WINDOW_BYTES), quotes(row.tier));
  if (read.pinGone || view === 'gone') { history = 'incomplete'; uncertain = true; why = 'edition_pruned'; view = null; }
  const reason = (s: string | null, tier: string | null) => {
    if (s === null || ctx.remote === false) return s;
    const clean = sanitizeRemoteBody(s);
    return quotes(tier) && clean ? fenceTranscriptText(clean, identity.slug) : clean;
  };
  const chosen = row.chosen;
  const validTime = {
    as_of: asOf, status: verdict.status,
    chosen_version_id: chosen ? row.version_id : null, chosen_is_current: chosen && row.version_id === null,
    valid_from: chosen ? row.valid_from : null, valid_until: chosen ? row.valid_until : null,
    introduced_because: chosen ? reason(row.introduced_because, row.tier) : null, replaced_because: chosen ? reason(row.reason, row.successor_tier) : null,
    history, uncertain, why, undated_versions: picked.undated, amendments_not_applied: amendments,
    recorded_since: chosen ? row.recorded_since ?? (picked.gapAt === null ? picked.createdAt : null) : null,
    ...(why === 'ambiguous_edition_dates' ? { competing_version_ids: picked.competing.map(o => o === CURRENT_ORD ? null : o) } : {}),
    ...(!chosen ? { earliest_known_valid_from: row.valid_from } : {}),
  };
  let fix: Action | undefined;
  if (why === 'ambiguous_edition_dates') {
    fix = askDateFix(identity, loaded.current.page, loaded.current.tags, loaded.current.revision,
      `Which date did this edition of ${identity.slug} take effect? Its recorded dates disagree (versions ${validTime.competing_version_ids?.map(v => v ?? 'current').join(', ')}).`,
      'A date correction, a renewal, a backfill and a withdrawn scheduled edition look alike in the page history; only the user can say which happened.');
  } else if (why !== null && why !== 'undated_editions') fix = recoveryFix(ctx, identity, asOf, why);
  const render = { transport: opTransport(ctx), isCallable: () => ctx.remote !== false, preapproved: () => false };
  const base = { slug: identity.slug, source_id: identity.source_id, valid_time: validTime, ...(quarantined ? { quarantined } : {}), ...(fix ? { fix: renderAction(fix, render) } : {}) };
  if (!view) return base;
  if (verdict.status === 'in_force') return { ...view, ...base };
  return { ...base, [chosen ? 'last_in_force' : 'earliest_known']: { ...view, valid_from: row.valid_from, valid_until: row.valid_until } };
}

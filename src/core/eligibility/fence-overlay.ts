/**
 * Fence eligibility overlay for chunks (#5575 ENG-1).
 *
 * Chunk text renders the world rows of a page's `## Facts` fence. A fence row
 * never reaches chunks above its own eligibility:
 * - held rows (a write-gate hold for the row's fingerprint on this page) and
 *   purged rows (a fact_purges tombstone; L3's import overlay already drops
 *   them from canonical markdown, this is the backstop) are omitted;
 * - GST-2891: on a read for a caller that cannot read a private row
 *   (`hideHeld`), a world cell whose fact is stored narrower (`heldRowSql`:
 *   a widening the owner has not accepted, #9196 / GST-2875) is omitted and
 *   listed in `held`. Chunks keep it, as every caller reads them; search
 *   drops it from a delivered chunk for such a caller (stamp.ts);
 * - rows whose stored tier is below the page tier are taken out of the page's
 *   chunks and emitted as separate chunks whose first line is a trust marker
 *   naming the row tier (`fenceTrustMarker`, read back by `chunkTrustMarker`).
 *
 * Chunks carry no tier column: a chunk's tier is its page's tier at read time
 * (stamp.ts), lowered to the marker tier when its text carries one. A marker
 * can only lower a label, so text that imitates one cannot raise anything.
 *
 * The split is pure (`splitFenceOverlay`); `loadFenceChunkOverlay` reads what
 * it needs for one page in one batched query. Rows the current write appends
 * have no facts row yet when chunks are prepared; the writer names them and
 * their tier with `withPendingFenceRows`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { renderFactsTable, type ParsedFact } from '../facts-fence.ts';
import { dropFactFenceRowsByNumber } from '../facts/purge-overlay.ts';
import { withdrawalFenceBlocks } from '../facts/withdrawal-overlay.ts';
import { compareTrust, isTrustTier, minTrust, TRUST_TIERS, type TrustTier } from '../trust/tier.ts';
import { compactTrustLabel } from './labels.ts';
import { activationSuppressedSql } from './sql.ts';
import { holdFingerprint } from '../write-gate-store.ts';
import { grantedPrivateFactSql, memberFactAdmitSql } from '../access/member-facts.ts';
import { worldOnlyFacts } from '../search/private-visibility.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { MANAGED_LINK_SOURCES, maskLinksFence } from '../links-fence.ts';
import { ensureWellFormed } from '../text-safe.ts';
import { holdAppliesToPageSql } from '../write-gate-binding.ts';

/** The origin slot of a fence trust marker: the chunk holds facts-fence rows, not page prose. */
export const FENCE_TRUST_ORIGIN = 'facts-fence';

export interface FenceChunkOverlay {
  /** Fence row numbers left out of chunk text entirely (held, purged). */
  omit: ReadonlySet<number>;
  /** Fence row numbers whose tier is below the page tier, with that tier. */
  demote: ReadonlyMap<number, TrustTier>;
  /** Demoted rows carrying an unconfirmed instruction-family write-gate flag (CEO-20): their marker says so. */
  unconfirmed?: ReadonlySet<number>;
  /** GST-2891: world cells held from the current caller (`hideHeld`), all of them in `omit` too. */
  held?: ReadonlySet<number>;
}

export function fenceOverlayIsEmpty(overlay: FenceChunkOverlay | null | undefined): boolean {
  return !overlay || (overlay.omit.size === 0 && overlay.demote.size === 0);
}

/**
 * The first line of a low-tier fence chunk, e.g. `[written by an agent · facts-fence]`,
 * or `[unconfirmed, agent-written · facts-fence]` when a row in it carries an
 * unconfirmed instruction-family flag.
 */
export function fenceTrustMarker(tier: TrustTier, unconfirmed = false): string {
  return compactTrustLabel({ trust_tier: tier, origin: FENCE_TRUST_ORIGIN, ...(unconfirmed ? { unconfirmed: true as const } : {}) });
}

const MARKERS: ReadonlyMap<string, { tier: TrustTier; unconfirmed: boolean }> = new Map(TRUST_TIERS.flatMap(tier =>
  [false, true].map(unconfirmed => [fenceTrustMarker(tier, unconfirmed), { tier, unconfirmed }] as const)));

/** The tier and unconfirmed state a chunk's leading fence trust marker names, or null when it carries none. */
export function chunkFenceMarker(chunkText: unknown): { tier: TrustTier; unconfirmed: boolean } | null {
  if (typeof chunkText !== 'string' || !chunkText.startsWith('[')) return null;
  const end = chunkText.indexOf('\n');
  return MARKERS.get(end === -1 ? chunkText : chunkText.slice(0, end)) ?? null;
}

/** The row tier a chunk's leading fence trust marker names, or null when the chunk carries none. */
export function chunkTrustMarker(chunkText: unknown): TrustTier | null {
  return chunkFenceMarker(chunkText)?.tier ?? null;
}

/**
 * The least trusted tier any marker line in a text names, or null. Search
 * evidence can join several chunks into one delivered text, so every line is
 * read, not just the first; a marker only ever lowers a label.
 */
export function lowestFenceTrustMarker(text: unknown): TrustTier | null {
  if (typeof text !== 'string' || !text.includes(FENCE_TRUST_ORIGIN)) return null;
  let lowest: TrustTier | null = null;
  for (const line of text.split('\n')) {
    const tier = MARKERS.get(line)?.tier;
    if (tier && (!lowest || compareTrust(tier, lowest) < 0)) lowest = tier;
  }
  return lowest;
}

/** Prefix every piece of a low-tier fence text with its marker line. */
export function markFenceChunk(tier: TrustTier, text: string, unconfirmed = false): string {
  return `${fenceTrustMarker(tier, unconfirmed)}\n${text}`;
}

/** Text with a leading marker line removed, and the marker's tier and state (for re-splitting an oversized chunk). */
export function unmarkFenceChunk(text: string): { tier: TrustTier | null; unconfirmed: boolean; body: string } {
  const marker = chunkFenceMarker(text);
  return marker ? { ...marker, body: text.slice(text.indexOf('\n') + 1) } : { tier: null, unconfirmed: false, body: text };
}

export interface FenceOverlaySplit {
  /** The text with omitted and demoted rows removed from every facts fence. */
  main: string;
  /** One rendered facts fence per demoted tier and unconfirmed state (visible world rows only), least trusted last. */
  lowTier: Array<{ tier: TrustTier; unconfirmed: boolean; body: string }>;
}

/** Pure: apply an overlay to one body. Unchanged text when the overlay is empty or the body has no facts fence. */
export function splitFenceOverlay(text: string, overlay: FenceChunkOverlay | null | undefined): FenceOverlaySplit {
  if (fenceOverlayIsEmpty(overlay) || !text.includes('gbrain:facts:begin')) return { main: text, lowTier: [] };
  const { omit, demote } = overlay!;
  const main = dropFactFenceRowsByNumber(text, row => !omit.has(row.rowNum) && !demote.has(row.rowNum));
  return { main, lowTier: renderFenceLowTier(fenceLowTierRows(text, overlay)) };
}

/** A visible world fence row of a body whose tier is below the page tier, with that tier, in body order. */
export interface FenceLowTierRow { tier: TrustTier; unconfirmed: boolean; row: ParsedFact }

/**
 * The rows `splitFenceOverlay` moves out of a body, in order. Fence blocks never cross a segment cut, so the rows of a
 * segmented body are its segments' rows concatenated, and `renderFenceLowTier` over them equals the whole-body split.
 */
export function fenceLowTierRows(text: string, overlay: FenceChunkOverlay | null | undefined): FenceLowTierRow[] {
  if (fenceOverlayIsEmpty(overlay) || !text.includes('gbrain:facts:begin')) return [];
  const { omit, demote } = overlay!;
  const flagged = overlay!.unconfirmed ?? new Set<number>();
  const rows: FenceLowTierRow[] = [];
  for (const block of withdrawalFenceBlocks(text)) {
    if (block.parsed.warnings.length) continue;
    for (const row of block.parsed.facts) {
      const tier = demote.get(row.rowNum);
      if (!tier || omit.has(row.rowNum) || row.visibility !== 'world' || row.forgotten) continue;
      rows.push({ tier, unconfirmed: flagged.has(row.rowNum), row });
    }
  }
  return rows;
}

/** One rendered facts fence per demoted tier and unconfirmed state, least trusted last (`FenceOverlaySplit.lowTier`). */
export function renderFenceLowTier(rows: readonly FenceLowTierRow[]): FenceOverlaySplit['lowTier'] {
  const groups = new Map<string, ParsedFact[]>();
  for (const { tier, unconfirmed, row } of rows) {
    const group = `${tier}|${unconfirmed}`;
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  return TRUST_TIERS.flatMap(tier => [false, true].flatMap(unconfirmed => {
    const grouped = groups.get(`${tier}|${unconfirmed}`);
    return grouped ? [{ tier, unconfirmed, body: renderFactsTable(grouped) }] : [];
  }));
}

/** World fence rows of a body, every complete block. */
export function worldFenceRows(text: string | null | undefined): ParsedFact[] {
  if (!text || !text.includes('gbrain:facts:begin')) return [];
  return withdrawalFenceBlocks(text).flatMap(block => block.parsed.warnings.length ? [] : block.parsed.facts.filter(row => row.visibility === 'world'));
}

/** `unconfirmed`: the write gate flagged the appended rows (instruction family), so their marker says unconfirmed. */
interface PendingFenceRows { sourceId: string; slug: string; rowNums: readonly number[]; tier: TrustTier; unconfirmed?: boolean }
const pendingRows = new AsyncLocalStorage<PendingFenceRows>();

/**
 * Inside `fn`, chunk preparation for (sourceId, slug) treats `rowNums` as
 * rows of tier `tier`: a fence writer appends them in the same publication,
 * so their facts rows do not exist yet when the page's chunks are prepared.
 */
export function withPendingFenceRows<T>(rows: PendingFenceRows, fn: () => Promise<T>): Promise<T> {
  return pendingRows.run(rows, fn);
}

/**
 * The tier a fence append's new rows are labeled with while chunks are
 * prepared. Fence appends (remember, extract_facts entity facts) are
 * agent-classified (trust/backfill.ts); a lower declared tier lowers it.
 */
export function fenceAppendPendingTier(declared?: TrustTier | null): TrustTier {
  return declared ? minTrust('agent_written', declared) : 'agent_written';
}

type HoldTexts = ReadonlyArray<string | null | undefined>;

/**
 * The fingerprint of a held fact: the write gate's `holdFingerprint('fact',
 * texts)` (write-gate-store.ts), so a fence row matches the hold its
 * projection created. Tests may swap it; null turns the held lookup off.
 */
const gateHoldFingerprint = (texts: HoldTexts) => holdFingerprint('fact', texts);
let factHoldFingerprint: ((texts: HoldTexts) => string) | null = gateHoldFingerprint;

/** Installs the held-row fingerprint (the write gate's `holdFingerprint('fact', …)`); null turns the held lookup off. */
export function registerFactHoldFingerprint(fingerprint: ((texts: HoldTexts) => string) | null): void {
  factHoldFingerprint = fingerprint;
}

/** Restores the write gate's fingerprint (test cleanup). */
export function resetFactHoldFingerprint(): void {
  factHoldFingerprint = gateHoldFingerprint;
}

/** The gated text fields of a fence row, in the gate's `decideFactWrite` order (fact, context, value). */
export function fenceRowHoldTexts(row: Pick<ParsedFact, 'claim' | 'context'>): HoldTexts {
  return [row.claim, row.context ?? null, null];
}

/**
 * GST-2891: SQL true when the world fence cell (`rowNum`, `claim`) of page (`sourceId`, `slug`) is held from the current
 * caller: the live facts row at that row number is narrower than world, or the claim is a live narrower fact of the page
 * that no live world fact of the page states (the restatement rule without the tier, so it also holds a restatement whose
 * own row is not stored yet), and the caller's fact reads do not admit that narrower fact (memberFactAdmitSql, or GST-2900
 * a private-facts grant, grantedPrivateFactSql, when the grant also reads every private copy a visibility proposal names
 * for that fact, so a restatement of a copy kept on a page the grant cannot read stays held). For a
 * caller that reads private facts (worldOnlyFacts false) nothing is held: callers skip the check. `partial` (an SQL
 * boolean) marks a claim cut by a chunk boundary: it then matches a fact that contains it rather than one equal to it.
 */
export function heldRowSql(sourceId: string, slug: string, rowNum: string, claim: string, partial = 'false'): string {
  const page = (a: string) => `${a}.source_id = ${sourceId} AND ${a}.source_markdown_slug = ${slug} AND ${a}.expired_at IS NULL`;
  const narrower = (a: string) => `${page(a)} AND ${a}.visibility <> 'world' AND NOT ${memberFactAdmitSql(a)} AND NOT ${grantedPrivateFactSql(a)}`;
  const states = (a: string) => `(CASE WHEN ${partial} THEN strpos(${a}.fact, ${claim}) > 0 ELSE ${a}.fact = ${claim} END)`;
  return `(EXISTS (SELECT 1 FROM facts hr WHERE ${narrower('hr')} AND hr.row_num = ${rowNum})
    OR (EXISTS (SELECT 1 FROM facts hc WHERE ${narrower('hc')} AND ${states('hc')})
      AND NOT EXISTS (SELECT 1 FROM facts hw WHERE ${page('hw')} AND hw.visibility = 'world' AND ${states('hw')})))`;
}

const OVERLAY_SQL = (held: boolean, hideHeld = false) => `WITH incoming AS MATERIALIZED (
    SELECT i.row_num, i.claim, i.visibility, i.fp FROM jsonb_to_recordset($3::text::jsonb) AS i(row_num integer, claim text, visibility text, fp text))
  SELECT incoming.row_num,
    (SELECT p.trust_tier FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL LIMIT 1) AS page_tier,
    (SELECT f.trust_tier FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.row_num=incoming.row_num
      ORDER BY f.id DESC LIMIT 1) AS row_tier,
    (SELECT ${activationSuppressedSql('facts', 'f')} FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.row_num=incoming.row_num
      ORDER BY f.id DESC LIMIT 1) AS row_flagged,
    EXISTS (SELECT 1 FROM fact_purges fp WHERE fp.source_id=$1 AND fp.visibility=incoming.visibility
      AND fp.fact_hash=gbrain_fact_fingerprint(incoming.claim) AND (fp.subject='*' OR fp.subject=$2)) AS purged,
    ${held ? `EXISTS (SELECT 1 FROM write_gate_holds h WHERE h.kind='fact' AND h.source_id=$1
      AND h.status='held' AND h.fingerprint=incoming.fp AND ${holdAppliesToPageSql('h', '(SELECT p.id FROM pages p WHERE p.source_id=$1 AND p.slug=$2)', '$2')})` : 'false'} AS held,
    ${hideHeld ? heldRowSql('$1', '$2', 'incoming.row_num', 'incoming.claim') : 'false'} AS narrower
  FROM incoming`;
const OVERLAY_SQL_WITH_HOLDS = OVERLAY_SQL(true);
const OVERLAY_SQL_WITHOUT_HOLDS = OVERLAY_SQL(false);

export interface LoadFenceOverlayOpts {
  /** Overrides the registered L2a fingerprint for this call. */
  holdFingerprint?: ((texts: HoldTexts) => string) | null;
  /** GST-2891: a read for a caller whose fact reads are world-only (worldOnlyFacts): rows held from it are omitted. */
  hideHeld?: boolean;
}

/**
 * The overlay for one page's body, one query. No query runs (and the overlay
 * is empty) when the body has no world fence rows. A row with no facts row
 * and no pending declaration is treated as the page's own tier (the import
 * that publishes it inserts it at the writer's tier, which is the page's).
 */
export async function loadFenceChunkOverlay(
  engine: Pick<BrainEngine, 'readFenceOverlayRows'>,
  page: { sourceId: string; slug: string; compiled_truth: string; timeline?: string | null },
  opts: LoadFenceOverlayOpts = {},
): Promise<FenceChunkOverlay | undefined> {
  const rows = [...worldFenceRows(page.compiled_truth), ...worldFenceRows(page.timeline)];
  if (!rows.length) return undefined;
  const fingerprint = opts.holdFingerprint === undefined ? factHoldFingerprint : opts.holdFingerprint;
  const incoming = rows.map(row => ({ row_num: row.rowNum, claim: row.claim, visibility: row.visibility,
    fp: fingerprint ? fingerprint(fenceRowHoldTexts(row)) : null }));
  const found = await engine.readFenceOverlayRows({ sourceId: page.sourceId, slug: page.slug }, incoming, { hideHeld: opts.hideHeld === true });
  const pending = pendingRows.getStore();
  const pendingHere = pending && pending.sourceId === page.sourceId && pending.slug === page.slug ? new Set(pending.rowNums) : null;
  const omit = new Set<number>();
  const demote = new Map<number, TrustTier>();
  const unconfirmed = new Set<number>();
  const held = new Set<number>();
  for (const row of found) {
    const rowNum = Number(row.row_num);
    if (row.narrower === true) held.add(rowNum);
    if (row.narrower === true || row.purged === true || row.held === true) { omit.add(rowNum); continue; }
    if (!isTrustTier(row.page_tier)) continue;
    const isPending = pendingHere?.has(rowNum) === true;
    const rowTier = isPending ? pending!.tier : isTrustTier(row.row_tier) ? row.row_tier : null;
    if (!rowTier || compareTrust(rowTier, row.page_tier) >= 0) continue;
    demote.set(rowNum, rowTier);
    if (isPending ? pending!.unconfirmed === true : row.row_flagged === true) unconfirmed.add(rowNum);
  }
  return omit.size || demote.size ? { omit, demote, ...(unconfirmed.size ? { unconfirmed } : {}), ...(held.size ? { held } : {}) } : undefined;
}

/**
 * GST-2891: the world cells of a page body (the current page, an edition or a version) held from the caller when its
 * fact reads are world-only (heldRowSql, against the facts as they stand now), as sanitizeRemoteBody's `omitRows`;
 * undefined for any other caller, who reads the body as stored.
 */
export async function heldRowsForCaller(engine: Pick<BrainEngine, 'readFenceOverlayRows'>, remote: boolean | undefined,
  page: { sourceId: string; slug: string; compiled_truth: string; timeline?: string | null }): Promise<ReadonlySet<number> | undefined> {
  return worldOnlyFacts(remote) ? (await loadFenceChunkOverlay(engine, page, { hideHeld: true }))?.held : undefined;
}

/** Link producers whose context is an excerpt of a page body (link-extraction.ts); a null source is a legacy row. */
const BODY_EXCERPT_LINK_SOURCES: readonly string[] = MANAGED_LINK_SOURCES.filter(s => s !== 'frontmatter');

/** The most origin pages whose bodies one worldLinkContexts call reads; contexts from pages past it come back empty. */
export const LINK_CONTEXT_PAGE_BOUND = 200;

/** Text holding a facts or takes fence marker, whole or near-miss: every fence row follows its opening marker. */
const holdsFenceMarker = (text: string): boolean => text.includes('gbrain:facts') || text.includes('gbrain:takes');

/** A returned edge's stored identity: its two pages and its type. */
export interface StoredEdgeRef { from: { sourceId: string; slug: string }; to: { sourceId: string; slug: string }; linkType: string }

/** The stored identity of a returned link or graph edge. */
export function storedEdge(e: { from_source_id: string; from_slug: string; to_source_id: string; to_slug: string; link_type: string }): StoredEdgeRef {
  return { from: { sourceId: e.from_source_id, slug: e.from_slug }, to: { sourceId: e.to_source_id, slug: e.to_slug }, linkType: e.link_type };
}

/**
 * GST-2957: stored link contexts as a caller whose fact reads are world-only (worldOnlyFacts) may read them. A context
 * written by a body producer is an excerpt of the body of the link's origin page (its from page when it has none), so a
 * reference in or near a facts or takes fence carries fence row text, private and held rows included, and a body edit
 * can drop the fence while the link keeps the old excerpt. Each returned context is matched to its stored link rows
 * (`edge(row)`, the same text or a read's truncation of it); the caller keeps it when one of them was supplied by a writer
 * (add_link provenances, frontmatter fields) and holds no fence marker (unify-types' preserve_notes stores a page's
 * opening as a manual context), or reads, whitespace-collapsed as the extractor collapses it, inside its origin page as
 * it is now and as get_page shows it to the caller (sanitizeRemoteBody less heldRowsForCaller). The stored rows are
 * one typed read (readLinkContextMatches) and the origin bodies another (readLinkContextOriginPages), for at most
 * LINK_CONTEXT_PAGE_BOUND pages in result order. Otherwise it is emptied, as it is when no stored row matches, the page
 * is past the bound, stored in segments or gone, or a lookup fails (fail closed).
 * Every other caller reads contexts as stored and costs no query.
 */
export async function worldLinkContexts<T extends { context?: string | null }>(
  engine: Pick<BrainEngine, 'readFenceOverlayRows' | 'readLinkContextMatches' | 'readLinkContextOriginPages'>, remote: boolean | undefined, rows: T[], edge: (row: T) => StoredEdgeRef,
): Promise<T[]> {
  if (!worldOnlyFacts(remote)) return rows;
  const asked = rows.flatMap((row, i) => (row.context ? [{ i, ref: edge(row), context: row.context }] : []));
  if (asked.length === 0) return rows;
  const kept = new Set<number>();
  try {
    const matches = await engine.readLinkContextMatches(asked.map(a => ({ i: a.i, fromSourceId: a.ref.from.sourceId, fromSlug: a.ref.from.slug,
      toSourceId: a.ref.to.sourceId, toSlug: a.ref.to.slug, linkType: a.ref.linkType, context: a.context })));
    const excerpted = matches.filter(m => m.link_source == null || BODY_EXCERPT_LINK_SOURCES.includes(m.link_source)).sort((a, b) => Number(a.i) - Number(b.i));
    for (const m of matches) if (!excerpted.includes(m) && !holdsFenceMarker(m.context)) kept.add(Number(m.i));
    const pageIds = [...new Set(excerpted.flatMap(m => (m.page_id == null ? [] : [Number(m.page_id)])))].slice(0, LINK_CONTEXT_PAGE_BOUND);
    const pages = pageIds.length ? await engine.readLinkContextOriginPages(pageIds) : [];
    const views = new Map<number, string>();
    for (const p of pages) {
      const compiled = p.compiled_truth ?? '';
      const omitRows = holdsFenceMarker(compiled + (p.timeline ?? ''))
        ? await heldRowsForCaller(engine, remote, { sourceId: p.source_id, slug: p.slug, compiled_truth: compiled, timeline: p.timeline })
        : undefined;
      const shown = sanitizeRemoteBody(compiled, { omitRows }) + '\n' + sanitizeRemoteBody(p.timeline ?? '', { omitRows });
      views.set(Number(p.id), ensureWellFormed(maskLinksFence(shown)).replace(/\s+/g, ' '));
    }
    for (const m of excerpted) if (m.page_id != null && views.get(Number(m.page_id))?.includes(m.context)) kept.add(Number(m.i));
  } catch {
    kept.clear();
  }
  return rows.map((row, i) => (!row.context || kept.has(i) ? row : { ...row, context: '' }));
}

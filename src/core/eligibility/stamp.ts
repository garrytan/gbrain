/**
 * Stamps `trust_tier` + `origin` (eligibility/labels.ts) onto page-derived
 * read rows (search/query hits, evidence, fetch results) after ranking, so
 * label mode never changes ordering (A7). A chunk's tier is its page's tier,
 * lowered to the row tier when its text carries a facts-fence trust marker
 * (fence-overlay.ts, ENG-1); a marker can only lower.
 * One batched lookup per call; a failed lookup labels the rows `unknown` /
 * `unrecorded` rather than dropping them or leaving them unlabeled.
 */
import type { BrainEngine, RowTrustLookup } from '../engine.ts';
import type { FenceRowTrust } from '../engine-sql/cli-reads-ops.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { admitsTrust, compareTrust, minTrust, storedTrustTier, type TrustTier } from '../trust/tier.ts';
import { chunkFenceMarker, FENCE_TRUST_ORIGIN, fenceTrustMarker, lowestFenceTrustMarker } from './fence-overlay.ts';
import { decodeFenceCell, isSeparatorRow, parseRowCells } from '../fence-shared.ts';
import { needsDataEnvelope, parseContested, renderTrustedText, trustFields, type Contested, type TrustFields } from './labels.ts';
import { GUEST_ORIGIN, guestView, loadGuestMarks, unattributedGuest, type GuestStamp } from '../guests/marker.ts';
import { isPrecedence } from './precedence.ts';

const withFlag = (fields: TrustFields, flagged: unknown): TrustFields => (flagged === true ? { ...fields, unconfirmed: true } : fields);

interface PageRef {
  page_id?: number | null; source_id?: string | null; slug: string; chunk_text?: string | null;
  trust_tier?: string; origin?: string; unconfirmed?: true; contested?: Contested; guest?: GuestStamp; precedence?: string;
  /** A saved-fact row (search/facts-arm.ts): labeled with the fact's own tier, not a page's. */
  fact_row?: { id: number };
}

type FenceRowExec = Pick<BrainEngine, 'listFenceRowTrust'>;
type HeldExec = Pick<BrainEngine, 'listHeldFenceCells'>;
type TrustExec = Pick<BrainEngine, 'executeRaw' | 'readPageTrustRows' | 'readRowTrustRows' | 'listHeldFenceCells' | 'listFenceRowTrust' | 'readGuestMarks'>;

const key = (source: string | null | undefined, slug: string) => `${source ?? 'default'}\u0000${slug}`;

/**
 * Trust fields per page id and per (source_id, slug). GBRA-504: a row in a guest source is decided here, per row from
 * its source's config and guest_sources (guests/marker.ts guestSourceSql), and carries origin `guest`, the external tier and its guest mark (one batched guest_marks read, only
 * when a guest row is among them; a mark that cannot be read leaves the row unattributed, never bare, and a refused read refuses the caller). The writer is
 * shown only with `guestWriter` (an owner caller); `includeDeleted` also resolves soft-deleted pages by slug.
 */
export async function loadPageTrust(engine: TrustExec, refs: readonly PageRef[], opts: { guestWriter?: boolean; includeDeleted?: boolean } = {}): Promise<{ byId: Map<number, TrustFields>; byKey: Map<string, TrustFields> }> {
  const byId = new Map<number, TrustFields>();
  const byKey = new Map<string, TrustFields>();
  const ids = [...new Set(refs.map(r => r.page_id).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)))];
  const slugRefs = refs.filter(r => typeof r.page_id !== 'number');
  const rows = ids.length || slugRefs.length ? await engine.readPageTrustRows({ ids, keys: slugRefs.map(r => ({ source_id: r.source_id ?? 'default', slug: r.slug })),
    includeDeleted: opts.includeDeleted === true }) : [];
  const marks = rows.some(r => r.guest === true) ? await loadGuestMarks(engine, rows.filter(r => r.guest === true).map(r => Number(r.id))) : null;
  for (const row of rows) {
    const labeled = withFlag(trustFields(row.trust_tier, row.write_origin), row.flagged);
    const base: TrustFields = isPrecedence(row.precedence) ? { ...labeled, precedence: row.precedence } : labeled;
    const fields: TrustFields = row.guest === true
      ? { ...base, trust_tier: minTrust(base.trust_tier, 'external_untrusted'), origin: GUEST_ORIGIN, guest: guestView(marks?.get(Number(row.id)) ?? unattributedGuest(), opts.guestWriter === true) }
      : base;
    if (row.byId) byId.set(Number(row.id), fields);
    byKey.set(key(row.source_id, row.slug), fields);
  }
  return { byId, byKey };
}

/**
 * Sets `trust_tier` and `origin` on each row in place and returns the rows a
 * floor admits. A row whose text carries a fence trust marker below its
 * page's tier is labeled with the marker tier (origin `facts-fence`) and is
 * held to the floor at that tier. The floor is already applied inside every arm's SQL; this is
 * the backstop for rows a stage adds by slug (exact lookup, alias hop, graph
 * walk), so no row below the floor leaves the operation. `pageTrust` is
 * `loadPageTrust` started early over the rows these rows were copied from.
 * `hideHeld` (worldOnlyFacts for the caller) also drops the fence rows held from the caller (`dropHeldFenceRows`).
 */
export async function stampPageTrust<T extends PageRef>(engine: TrustExec, rows: T[], floor?: TrustTier,
  pageTrust?: ReturnType<typeof loadPageTrust>, hideHeld = false): Promise<T[]> {
  if (rows.length === 0) return rows;
  if (hideHeld) rows = await dropHeldFenceRows(engine, rows);
  const factRows = rows.filter(row => typeof row.fact_row?.id === 'number');
  const factTrust = factRows.length ? await stampRowTrust(engine, 'facts', factRows, row => row.fact_row!.id) : [];
  factRows.forEach((row, i) => Object.assign(row, factTrust[i]));
  const pageRows = rows.filter(row => typeof row.fact_row?.id !== 'number');
  let found: Awaited<ReturnType<typeof loadPageTrust>> | null = null;
  try { found = pageRows.length ? await (pageTrust ?? loadPageTrust(engine, pageRows)) : null; } catch (err) { rethrowCapabilityRefusal(err); found = null; }
  for (const row of pageRows) {
    const fields = (typeof row.page_id === 'number' ? found?.byId.get(row.page_id) : undefined)
      ?? found?.byKey.get(key(row.source_id, row.slug))
      ?? { trust_tier: 'unknown' as const, origin: 'unrecorded' };
    const marked = lowestFenceTrustMarker(row.chunk_text);
    const lowered = marked !== null && compareTrust(marked, fields.trust_tier) < 0;
    row.trust_tier = lowered ? marked : fields.trust_tier;
    row.origin = fields.guest ? GUEST_ORIGIN : lowered ? FENCE_TRUST_ORIGIN : fields.origin;
    if (fields.guest) row.guest = fields.guest;
    if (fields.unconfirmed) row.unconfirmed = true;
    if (fields.precedence) row.precedence = fields.precedence;
  }
  await applyFenceRowTrust(engine, pageRows);
  return floor ? rows.filter(row => admitsTrust(row.trust_tier as TrustTier, floor)) : rows;
}

/**
 * A text's lines that read as facts-fence table rows (`| 3 | claim |…`, inside a fence or not: a chunk can start
 * mid-table), with row number and claim. A chunk boundary can also cut a row line: the first line (after a leading fence
 * trust marker line, which a low-tier fence chunk starts with) can start inside a
 * row (inside its claim: the text before the first cell break; inside or just after its row-number cell of a world row:
 * the claim cell; row number unknown) and the last can stop inside one; both are `partial`, so the claim is matched as a
 * fragment.
 */
function fenceRowLines(text: string): Array<{ line: number; rowNum: number; claim: string; partial: boolean }> {
  const out: Array<{ line: number; rowNum: number; claim: string; partial: boolean }> = [];
  const lines = text.split('\n');
  const first = chunkFenceMarker(lines[0]) ? 1 : 0;
  lines.forEach((line, i) => {
    const cells = /^\s*\|\s*\d+\s*\|/.test(line) ? parseRowCells(line) : null;
    const claim = cells?.[1];
    const cut = i === first && /\|\s*world\s*\|/.test(line) ? (line.trim().startsWith('|') ? parseRowCells(line)?.[0] : /^\s*\d+\s*\|/.test(line) ? parseRowCells('| ' + line)?.[1] : null) : null;
    if (cells && claim) out.push({ line: i, rowNum: Number(cells[0]), claim: claim.replace(/^~~([\s\S]*)~~$/, '$1').replace(/^~~/, ''), partial: i === lines.length - 1 });
    else if (cut) out.push({ line: i, rowNum: -1, claim: cut.replace(/^~~|~~$/g, ''), partial: true });
    else if (i === first && !line.trim().startsWith('|') && /[^\\]\|/.test(line)) {
      const fragment = decodeFenceCell(line.split(/(?<!\\)\|/)[0]!.trim()).replace(/^~~|~~$/g, '');
      if (fragment) out.push({ line: i, rowNum: -1, claim: fragment, partial: true });
    }
  });
  return out;
}

/** Whether a text holds anything a reader reads once fence rows are gone: not only a marker, fence markers, a table header or separator. */
function holdsText(text: string): boolean {
  return text.split('\n').some((line, i) => {
    if (!line.trim() || line.includes('gbrain:facts:') || (i === 0 && chunkFenceMarker(line))) return false;
    const cells = parseRowCells(line);
    return !(cells && (isSeparatorRow(cells) || (cells[0] === '#' && cells[1] === 'claim')));
  });
}

/**
 * GST-2891: per row, the line numbers of the facts-fence row lines of its text held from a caller whose fact reads are
 * world-only (heldRowSql: a world cell whose fact is stored narrower, a widening the owner has not accepted), whenever
 * the text was cut. One batched lookup (BrainEngine listHeldFenceCells); a failed lookup, or a row that names no source,
 * returns every fence row line (fail closed).
 */
export async function heldFenceLines(engine: HeldExec, rows: readonly PageRef[]): Promise<Array<Set<number>>> {
  const perRow = rows.map(row => typeof row.chunk_text === 'string' ? fenceRowLines(row.chunk_text) : []);
  const keys = rows.flatMap((row, i) => { const src = row.source_id; return src == null ? [] : perRow[i]!.map(l => ({ sourceId: src, slug: row.slug, rowNum: l.rowNum, claim: l.claim, partial: l.partial })); });
  let held: Set<string> | null = new Set();
  if (keys.length) try {
    const found = await engine.listHeldFenceCells(keys);
    held = new Set(found.map(f => `${f.source_id}\u0000${f.slug}\u0000${Number(f.row_num)}\u0000${f.claim}`));
  } catch { held = null; }
  return rows.map((row, i) => new Set(perRow[i]!
    .filter(l => !held || row.source_id == null || held.has(`${row.source_id}\u0000${row.slug}\u0000${l.rowNum}\u0000${l.claim}`)).map(l => l.line)));
}

/** GST-2891: removes from each row's text the fence row lines held from the caller (heldFenceLines), and drops a row left with nothing to read. */
export async function dropHeldFenceRows<T extends PageRef>(engine: HeldExec, rows: T[]): Promise<T[]> {
  const drops = await heldFenceLines(engine, rows);
  return rows.filter((row, i) => {
    const drop = drops[i]!;
    if (!drop.size) return true;
    row.chunk_text = (row.chunk_text as string).split('\n').filter((_l, n) => !drop.has(n)).join('\n');
    return holdsText(row.chunk_text);
  });
}

/** Fence row numbers in a chunk's text: table rows (`| 3 | claim |…`) after a facts fence's begin marker. */
function fenceRowNumbers(text: string | null | undefined): number[] {
  if (!text || !text.includes('gbrain:facts:begin')) return [];
  const out: number[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.includes('gbrain:facts:begin')) { inside = true; continue; }
    if (line.includes('gbrain:facts:end')) { inside = false; continue; }
    const m = inside ? /^\|\s*(\d+)\s*\|/.exec(line) : null;
    if (m) out.push(Number(m[1]));
  }
  return out;
}


/**
 * Read-time truth for chunks that carry facts-fence rows (#5575 37-1, 37-2, A5):
 * the label folds in the CURRENT state of every fence row in the chunk (its
 * stored tier, an unconfirmed instruction-family flag, a pending supersede
 * proposal), so a chunk cut before a flag, a confirmation or a tier change
 * never reads as more trusted than its rows. A chunk led by a fence trust
 * marker gets the marker rewritten to that state, and an external one has
 * its rows wrapped as data. A failed lookup keeps the stored labels; an engine that refuses the read
 * (`engine_capability_missing`) refuses the caller too.
 */
async function applyFenceRowTrust<T extends PageRef>(engine: FenceRowExec, rows: T[]): Promise<void> {
  const perRow = rows.map(row => fenceRowNumbers(row.chunk_text));
  const keys: Array<[string, string, number]> = [];
  rows.forEach((row, i) => { for (const n of perRow[i]!) keys.push([row.source_id ?? 'default', row.slug, n]); });
  if (!keys.length) return;
  let found: FenceRowTrust[];
  try { found = await engine.listFenceRowTrust(keys.map(([source_id, slug, row_num]) => ({ source_id, slug, row_num }))); } catch (err) { rethrowCapabilityRefusal(err); return; }
  const state = new Map(found.map(f => [`${f.source_id}\u0000${f.slug}\u0000${Number(f.row_num)}`, f]));
  rows.forEach((row, i) => {
    const facts = perRow[i]!.map(n => state.get(`${row.source_id ?? 'default'}\u0000${row.slug}\u0000${n}`)).filter(f => f !== undefined);
    if (!facts.length) return;
    const before = storedTrustTier(row.trust_tier);
    const tier = minTrust(before, ...facts.map(f => storedTrustTier(f.trust_tier)));
    if (compareTrust(tier, before) < 0) { row.trust_tier = tier; row.origin = FENCE_TRUST_ORIGIN; }
    const unconfirmed = facts.some(f => f.flagged === true);
    if (unconfirmed) row.unconfirmed = true;
    const contested = facts.map(f => parseContested(f.contested)).find(c => c !== undefined);
    if (contested) row.contested = contested;
    const marker = chunkFenceMarker(row.chunk_text);
    if (!marker || typeof row.chunk_text !== 'string') return;
    const body = row.chunk_text.slice(row.chunk_text.indexOf('\n') + 1);
    const shown = storedTrustTier(row.trust_tier);
    row.chunk_text = `${fenceTrustMarker(shown, unconfirmed || marker.unconfirmed)}\n${needsDataEnvelope(shown) ? renderTrustedText(body, { trust_tier: shown, origin: FENCE_TRUST_ORIGIN }) : body}`;
  });
}

type RowTrustExec = Pick<BrainEngine, 'readRowTrustRows'>;

/**
 * Sets `trust_tier` + `origin` on fact, take or timeline rows by id (one
 * batched typed read, `readRowTrustRows`). Rows whose tier cannot be read are
 * labeled `unknown` / `unrecorded`, never left looking confirmed. A database
 * error reads as that label; an engine that refuses the read
 * (`engine_capability_missing`) refuses the caller too, so a brain that cannot
 * read row trust never answers as if every row were unrecorded.
 */
export async function stampRowTrust<T extends object>(
  engine: RowTrustExec, table: RowTrustLookup['table'], rows: T[], idOf: (row: T) => number | string,
): Promise<Array<T & TrustFields>> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map(r => Number(idOf(r))).filter(Number.isFinite))];
  const byId = new Map<number, TrustFields>();
  try {
    for (const row of await engine.readRowTrustRows({ table, ids })) {
      const labeled = withFlag(trustFields(row.trust_tier, row.write_origin), row.flagged);
      const fields: TrustFields = isPrecedence(row.precedence) ? { ...labeled, precedence: row.precedence } : labeled;
      const c = parseContested(row.contested);
      byId.set(Number(row.id), c ? { ...fields, contested: c } : fields);
    }
  } catch (err) {
    rethrowCapabilityRefusal(err); /* otherwise labeled unknown below */
  }
  return rows.map(row => ({ ...row, ...(byId.get(Number(idOf(row))) ?? { trust_tier: 'unknown' as const, origin: 'unrecorded' }) }));
}

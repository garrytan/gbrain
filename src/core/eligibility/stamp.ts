/**
 * Stamps `trust_tier` + `origin` (eligibility/labels.ts) onto page-derived
 * read rows (search/query hits, evidence, fetch results) after ranking, so
 * label mode never changes ordering (A7). A chunk's tier is its page's tier,
 * lowered to the row tier when its text carries a facts-fence trust marker
 * (fence-overlay.ts, ENG-1); a marker can only lower.
 * One batched lookup per call; a failed lookup labels the rows `unknown` /
 * `unrecorded` rather than dropping them or leaving them unlabeled.
 */
import type { BrainEngine } from '../engine.ts';
import { admitsTrust, compareTrust, minTrust, storedTrustTier, type TrustTier } from '../trust/tier.ts';
import { chunkFenceMarker, FENCE_TRUST_ORIGIN, fenceTrustMarker, lowestFenceTrustMarker } from './fence-overlay.ts';
import { needsDataEnvelope, parseContested, renderTrustedText, trustFields, type Contested, type TrustFields } from './labels.ts';
import { activationSuppressedSql, contestedRefSql } from './sql.ts';

const withFlag = (fields: TrustFields, flagged: unknown): TrustFields => (flagged === true ? { ...fields, unconfirmed: true } : fields);

interface PageRef {
  page_id?: number | null; source_id?: string | null; slug: string; chunk_text?: string | null;
  trust_tier?: string; origin?: string; unconfirmed?: true; contested?: Contested;
}

type Exec = Pick<BrainEngine, 'executeRaw'>;

const key = (source: string | null | undefined, slug: string) => `${source ?? 'default'}\u0000${slug}`;

/** Trust fields per page id and per (source_id, slug). */
export async function loadPageTrust(engine: Exec, refs: readonly PageRef[]): Promise<{ byId: Map<number, TrustFields>; byKey: Map<string, TrustFields> }> {
  const byId = new Map<number, TrustFields>();
  const byKey = new Map<string, TrustFields>();
  const ids = [...new Set(refs.map(r => r.page_id).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)))];
  const slugRefs = refs.filter(r => typeof r.page_id !== 'number');
  if (ids.length) {
    const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; trust_tier: string; write_origin: unknown; flagged: boolean }>(
      `SELECT id, source_id, slug, trust_tier, write_origin, ${activationSuppressedSql('pages', 'pages')} AS flagged FROM pages WHERE id = ANY($1::int[])`, [ids]);
    for (const row of rows) {
      const fields = withFlag(trustFields(row.trust_tier, row.write_origin), row.flagged);
      byId.set(Number(row.id), fields);
      byKey.set(key(row.source_id, row.slug), fields);
    }
  }
  if (slugRefs.length) {
    const rows = await engine.executeRaw<{ source_id: string; slug: string; trust_tier: string; write_origin: unknown; flagged: boolean }>(
      `SELECT source_id, slug, trust_tier, write_origin, ${activationSuppressedSql('pages', 'pages')} AS flagged FROM pages
        WHERE deleted_at IS NULL AND (source_id, slug) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [slugRefs.map(r => r.source_id ?? 'default'), slugRefs.map(r => r.slug)]);
    for (const row of rows) byKey.set(key(row.source_id, row.slug), withFlag(trustFields(row.trust_tier, row.write_origin), row.flagged));
  }
  return { byId, byKey };
}

/**
 * Sets `trust_tier` and `origin` on each row in place and returns the rows a
 * floor admits. A row whose text carries a fence trust marker below its
 * page's tier is labeled with the marker tier (origin `facts-fence`) and is
 * held to the floor at that tier. The floor is already applied inside every arm's SQL; this is
 * the backstop for rows a stage adds by slug (exact lookup, alias hop, graph
 * walk), so no row below the floor leaves the operation.
 */
export async function stampPageTrust<T extends PageRef>(engine: Exec, rows: T[], floor?: TrustTier): Promise<T[]> {
  if (rows.length === 0) return rows;
  let found: Awaited<ReturnType<typeof loadPageTrust>> | null = null;
  try { found = await loadPageTrust(engine, rows); } catch { found = null; }
  for (const row of rows) {
    const fields = (typeof row.page_id === 'number' ? found?.byId.get(row.page_id) : undefined)
      ?? found?.byKey.get(key(row.source_id, row.slug))
      ?? { trust_tier: 'unknown' as const, origin: 'unrecorded' };
    const marked = lowestFenceTrustMarker(row.chunk_text);
    const lowered = marked !== null && compareTrust(marked, fields.trust_tier) < 0;
    row.trust_tier = lowered ? marked : fields.trust_tier;
    row.origin = lowered ? FENCE_TRUST_ORIGIN : fields.origin;
    if (fields.unconfirmed) row.unconfirmed = true;
  }
  await applyFenceRowTrust(engine, rows);
  return floor ? rows.filter(row => admitsTrust(row.trust_tier as TrustTier, floor)) : rows;
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

const FENCE_ROW_SQL = `SELECT DISTINCT ON (f.source_id, f.source_markdown_slug, f.row_num)
    f.source_id, f.source_markdown_slug AS slug, f.row_num, f.trust_tier, ${activationSuppressedSql('facts', 'f')} AS flagged, ${contestedRefSql('facts', 'f')} AS contested
  FROM facts f JOIN unnest($1::text[], $2::text[], $3::int[]) AS k(source_id, slug, row_num)
    ON f.source_id = k.source_id AND f.source_markdown_slug = k.slug AND f.row_num = k.row_num
  WHERE f.expired_at IS NULL
  ORDER BY f.source_id, f.source_markdown_slug, f.row_num, f.id DESC`;

/**
 * Read-time truth for chunks that carry facts-fence rows (#5575 37-1, 37-2, A5):
 * the label folds in the CURRENT state of every fence row in the chunk (its
 * stored tier, an unconfirmed instruction-family flag, a pending supersede
 * proposal), so a chunk cut before a flag, a confirmation or a tier change
 * never reads as more trusted than its rows. A chunk led by a fence trust
 * marker gets the marker rewritten to that state, and an external one has
 * its rows wrapped as data. A failed lookup keeps the stored labels.
 */
async function applyFenceRowTrust<T extends PageRef>(engine: Exec, rows: T[]): Promise<void> {
  const perRow = rows.map(row => fenceRowNumbers(row.chunk_text));
  const keys: Array<[string, string, number]> = [];
  rows.forEach((row, i) => { for (const n of perRow[i]!) keys.push([row.source_id ?? 'default', row.slug, n]); });
  if (!keys.length) return;
  let found: Array<{ source_id: string; slug: string; row_num: number; trust_tier: string; flagged: boolean; contested: string | null }>;
  try { found = await engine.executeRaw(FENCE_ROW_SQL, [keys.map(k => k[0]), keys.map(k => k[1]), keys.map(k => k[2])]); } catch { return; }
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

const ROW_TABLES = { facts: 'facts', takes: 'takes', timeline_entries: 'timeline_entries' } as const;

/**
 * Sets `trust_tier` + `origin` on fact, take or timeline rows by id (one
 * batched read). Rows whose tier cannot be read are labeled `unknown` /
 * `unrecorded`, never left looking confirmed.
 */
export async function stampRowTrust<T extends object>(
  engine: Exec, table: keyof typeof ROW_TABLES, rows: T[], idOf: (row: T) => number | string,
): Promise<Array<T & TrustFields>> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map(r => Number(idOf(r))).filter(Number.isFinite))];
  const byId = new Map<number, TrustFields>();
  try {
    const contested = table === 'timeline_entries' ? 'NULL' : contestedRefSql(table, 'r');
    const found = await engine.executeRaw<{ id: number | string; trust_tier: string; write_origin: unknown; flagged: boolean; contested: string | null }>(
      `SELECT r.id, r.trust_tier, r.write_origin, ${activationSuppressedSql(table, 'r')} AS flagged, ${contested} AS contested FROM ${ROW_TABLES[table]} r WHERE r.id = ANY($1::bigint[])`, [ids]);
    for (const row of found) {
      const fields = withFlag(trustFields(row.trust_tier, row.write_origin), row.flagged);
      const c = parseContested(row.contested);
      byId.set(Number(row.id), c ? { ...fields, contested: c } : fields);
    }
  } catch { /* labeled unknown below */ }
  return rows.map(row => ({ ...row, ...(byId.get(Number(idOf(row))) ?? { trust_tier: 'unknown' as const, origin: 'unrecorded' }) }));
}

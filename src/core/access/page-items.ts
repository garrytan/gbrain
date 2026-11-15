/**
 * The page-item walker room marks (access/room.ts, GBRA-498) and guest marks (guests/stamp.ts, GBRA-504) share: it
 * finds the objects in an op's output that carry a page (by slug or page id), a link (its from page, gated by its
 * target and origin), a timeline event, a fact row or a think answer's evidence, so one walk decides which item a
 * mark lands on. Room marking uses the per-op extractors in room.ts; guest marking walks every op's whole output
 * (collectPageItems), so an op added later is covered without code of its own.
 */

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export type PageRef = { kind: 'page'; source_id: string; slug: string } | { kind: 'page_id'; id: number };
export type FactRef = { kind: 'fact'; id: number };
export type Ref = PageRef | FactRef;
/**
 * One marked item: its own ref, plus the other pages that gate it (a timeline event's page, a link's target and origin).
 * `unknown` marks it unknown whatever its refs decide (a think answer built partly from takes, which carry no page or fact id here).
 */
export interface Slot { holder: Record<string, unknown>; ref: Ref | null; also?: Ref[]; unknown?: 'not_identified' }

/** What a think answer was built from: every page, take and fact its synthesis retrieved (the trust taint refs). */
export type RoomEvidence = ReadonlyArray<{ table: 'pages'; sourceId: string; slug: string } | { table: string; id: number }>;
const ROOM_EVIDENCE = Symbol('gbrain.room_evidence');
/**
 * Keeps a think answer's evidence on its result for room marking. Symbol-keyed, so object spread keeps it while JSON
 * and structuredClone drop it: it never reaches a response, a stored write or a log.
 */
export function keepRoomEvidence<T extends object>(result: T, evidence: RoomEvidence | undefined): T {
  if (evidence) (result as Record<symbol, unknown>)[ROOM_EVIDENCE] = evidence;
  return result;
}
/** A think answer is marked at the strictest class of all its evidence; without recorded evidence, or with a take, it is unknown. */
export function thinkSlot(r: unknown, original: unknown): Slot | null {
  if (!isObj(r)) return null;
  const evidence = isObj(original) ? (original as Record<symbol, unknown>)[ROOM_EVIDENCE] : undefined;
  if (!Array.isArray(evidence) || evidence.length === 0) return { holder: r, ref: null };
  const refs: Ref[] = [];
  let takes = false;
  for (const e of evidence as RoomEvidence) {
    if (e.table === 'pages' && 'slug' in e) refs.push({ kind: 'page', source_id: e.sourceId, slug: e.slug });
    else if (e.table === 'facts' && 'id' in e) refs.push({ kind: 'fact', id: e.id });
    else takes = true;
  }
  return { holder: r, ref: refs[0] ?? null, also: refs.slice(1), ...(takes ? { unknown: 'not_identified' as const } : {}) };
}

export const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
export const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export function pageSlot(o: unknown, src: string): Slot | null {
  if (!isObj(o)) return null;
  return { holder: o, ref: typeof o.slug === 'string' ? { kind: 'page', source_id: str(o.source_id) ?? src, slug: o.slug } : null };
}
export function pageIdSlot(o: unknown): Slot | null {
  if (!isObj(o)) return null;
  return { holder: o, ref: typeof o.page_id === 'number' ? { kind: 'page_id', id: o.page_id } : null };
}
export function factSlot(o: unknown): Slot | null {
  if (!isObj(o)) return null;
  const id = typeof o.id === 'number' ? o.id : typeof o.id === 'string' && /^\d+$/.test(o.id) ? Number(o.id) : null;
  return { holder: o, ref: id === null ? null : { kind: 'fact', id } };
}
export function timelineSlot(o: unknown): Slot | null {
  const s = pageIdSlot(o);
  if (s && typeof s.holder.event_page_id === 'number') s.also = [{ kind: 'page_id', id: s.holder.event_page_id }];
  return s;
}
export function linkSlot(o: unknown, src: string): Slot | null {
  if (!isObj(o) || typeof o.from_slug !== 'string') return pageSlot(o, src);
  const also: Ref[] = [];
  if (typeof o.to_slug === 'string') also.push({ kind: 'page', source_id: str(o.to_source_id) ?? src, slug: o.to_slug });
  if (typeof o.origin_slug === 'string') also.push({ kind: 'page', source_id: str(o.origin_source_id) ?? src, slug: o.origin_slug });
  return { holder: o, ref: { kind: 'page', source_id: str(o.from_source_id) ?? src, slug: o.from_slug }, also };
}
export function listOf(r: unknown): unknown[] {
  if (Array.isArray(r)) return r;
  if (isObj(r)) return Array.isArray(r.pages) ? r.pages : Array.isArray(r.results) ? r.results : Array.isArray(r.rows) ? r.rows : [];
  return [];
}
const SKIP_KEYS = new Set(['next', 'arguments', 'fix', 'verify', 'coverage', '_meta', 'room_access', 'guest']);
/** entity and other composites: every object naming a page by slug, and every fact row in a `facts` list. */
export function walk(v: unknown, src: string, out: Slot[], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(v)) { for (const x of v) walk(x, src, out, depth + 1); return; }
  if (!isObj(v)) return;
  // A nested row without its own source_id belongs to the nearest enclosing object that names one (entity cards span sources).
  src = str(v.source_id) ?? (isObj(v.entity) ? str(v.entity.source_id) : undefined) ?? src;
  if (typeof v.slug === 'string') out.push(pageSlot(v, src)!);
  for (const [k, x] of Object.entries(v)) {
    if (SKIP_KEYS.has(k)) continue;
    if ((k === 'facts' || k === 'recent_facts') && Array.isArray(x)) { for (const f of x) { const s = factSlot(f); if (s) out.push(s); } continue; }
    walk(x, src, out, depth + 1);
  }
}

export const refKey = (r: Ref) => r.kind === 'page' ? `p:${r.source_id}:${r.slug}` : r.kind === 'page_id' ? `i:${r.id}` : `f:${r.id}`;
export const refOut = (r: Ref) => r.kind === 'page' ? { source_id: r.source_id, slug: r.slug } : r.kind === 'page_id' ? { page_id: r.id } : { fact_id: r.id };

/**
 * Every page-bearing item anywhere in `v`: objects naming a page by slug, entity cards by their entity's page, link rows
 * by their from page, and rows that carry only a page id (chunks, timeline entries). Fact rows are not page items. Used where an op has no extractor.
 */
/** fetch rows name their page only by deepResearchPageUrl. */
const PAGE_URL = 'gbrain://page/';
export function collectPageItems(v: unknown, src: string, out: Slot[] = [], depth = 0): Slot[] {
  if (depth > 8) return out;
  if (Array.isArray(v)) { for (const x of v) collectPageItems(x, src, out, depth + 1); return out; }
  if (!isObj(v)) return out;
  src = str(v.source_id) ?? (isObj(v.entity) ? str(v.entity.source_id) : undefined) ?? src;
  if (typeof v.slug === 'string') out.push(pageSlot(v, src)!);
  else if (isObj(v.entity) && typeof v.entity.slug === 'string') out.push({ holder: v, ref: { kind: 'page', source_id: src, slug: v.entity.slug } });
  else if (typeof v.from_slug === 'string') out.push(linkSlot(v, src)!);
  else if (typeof v.page_id === 'number') out.push(timelineSlot(v)!);
  else if (typeof v.url === 'string' && v.url.startsWith(PAGE_URL)) {
    const [source, ...slug] = v.url.slice(PAGE_URL.length).split('/').map(decodeURIComponent);
    if (source && slug.length > 0) out.push({ holder: v, ref: { kind: 'page', source_id: source, slug: slug.join('/') } });
  }
  for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k)) collectPageItems(x, src, out, depth + 1);
  return out;
}

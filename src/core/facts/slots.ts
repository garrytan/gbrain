/**
 * GBRA-574 B2: conversation fact slots. A second call after extraction (slot-tagging.ts) may tag a fact with one slot,
 * a (dimension, value) pair on the ontology columns facts already has, from a closed vocabulary of single-valued
 * dimensions. The query facts block derives each value's validity window at read time from the slot's chronology
 * (deriveSlotEnds), so re-extracting pages in any order yields the same windows. GST-3170: the conversation publication
 * also stores those closes (valid_until, superseded_by; never expired_at) on the rows it touches, recomputed in the same
 * transaction on every publish and clear (conversation-publication.ts storeSlotCloses), so other readers see the change;
 * the publication, its dedup and relink, and the facts block read a stored close as open (slotCloseLinkSql, slotCloseEndSql).
 */
import { normalizeDimension } from '../chronicle/ontology.ts';
import { CONVERSATION_FACTS_SOURCE_PREFIX } from './audit-sources.ts';

/** The dimensions a conversation fact may carry, after normalizeDimension's aliases. Each holds one value at a time. */
export const SLOT_DIMENSIONS: ReadonlySet<string> = new Set(['location', 'employer', 'role']);
export const MAX_SLOT_VALUE_CHARS = 80;

/** The slot a fact keeps, or null: a dimension outside the vocabulary, an empty or over-long value, or no entity. */
export function normalizeSlot(dimension: unknown, value: unknown, entity: string | null | undefined): { dimension: string; value: string } | null {
  if (!entity || typeof dimension !== 'string' || typeof value !== 'string') return null;
  const d = normalizeDimension(dimension);
  const v = value.trim();
  return SLOT_DIMENSIONS.has(d) && v && v.length <= MAX_SLOT_VALUE_CHARS ? { dimension: d, value: v } : null;
}

/**
 * G4 (GBRA-108): across source pages, a newer value ends the one before it only when its fact states the change in
 * plain English; otherwise both stay open.
 */
export const CHANGE_CUE = /\b(?:moved|relocated|left|quit|joined|switched|transferred|promoted|resigned|retired|now (?:works|lives|is based|based)|started (?:at|as|working)|took over|stepped down|became|no longer|used to|formerly)\b/i;

export interface SlotRow {
  id: number; source_id: string; entity_slug: string; dimension: string; value_hash: string;
  valid_from: Date | string; source_markdown_slug: string | null; fact: string;
}

/**
 * Derived ends by fact id. Rows of one (source, entity, dimension) are walked in valid_from order; consecutive rows of
 * one value are one stint (a restatement continues it). A stint ends where the next distinct value starts when that
 * value's first row is on a page one of the stint's rows came from, or its fact matches CHANGE_CUE, and only when it
 * starts later than the stint. Callers pass only rows the reader may see.
 */
export function deriveSlotEnds(rows: readonly SlotRow[]): Map<number, Date> {
  return new Map([...deriveSlotCloses(rows)].map(([id, close]) => [id, close.end]));
}

/** deriveSlotEnds with the row that ends each stint: the first row of the next value. */
export function deriveSlotCloses(rows: readonly SlotRow[]): Map<number, { end: Date; by: number }> {
  const ends = new Map<number, { end: Date; by: number }>();
  const groups = new Map<string, SlotRow[]>();
  for (const r of rows) {
    const key = [r.source_id, r.entity_slug, r.dimension].join('\u0000');
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  const time = (r: SlotRow) => new Date(r.valid_from).getTime();
  for (const group of groups.values()) {
    group.sort((a, b) => time(a) - time(b) || a.value_hash.localeCompare(b.value_hash) || Number(a.id) - Number(b.id));
    const stints: SlotRow[][] = [];
    for (const r of group) {
      const last = stints.at(-1);
      if (last && last[0]!.value_hash === r.value_hash) last.push(r);
      else stints.push([r]);
    }
    for (let i = 0; i + 1 < stints.length; i++) {
      const stint = stints[i]!;
      const next = stints[i + 1]![0]!;
      if (time(next) <= time(stint[0]!)) continue;
      const samePage = next.source_markdown_slug != null && stint.some(r => r.source_markdown_slug === next.source_markdown_slug);
      if (!samePage && !CHANGE_CUE.test(next.fact)) continue;
      for (const r of stint) ends.set(Number(r.id), { end: new Date(next.valid_from), by: Number(next.id) });
    }
  }
  return ends;
}

const conversationRow = (a: string) => `COALESCE(${a}.source, '') LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%'`;
const linked = (a: string, end: boolean) => `(${a}.superseded_by IS NOT NULL AND ${a}.expired_at IS NULL AND ${a}.dimension IS NOT NULL AND ${conversationRow(a)}
  AND EXISTS (SELECT 1 FROM facts sc WHERE sc.id = ${a}.superseded_by AND sc.source_id = ${a}.source_id AND ${conversationRow('sc')}${end ? ` AND sc.valid_from = ${a}.valid_until` : ''}))`;

/**
 * GST-3170: row `a` (an alias or the table name) is an unexpired conversation slot row whose superseded_by names a
 * conversation row of its source: a close storeSlotCloses stored. No other writer links an unexpired conversation row
 * (supersessions also expire; mergeOntologyFact skips conversation rows; remember's successor is not a conversation row).
 */
export const slotCloseLinkSql = (a: string) => linked(a, false);
/** slotCloseLinkSql, and `a`'s valid_until is still that close's end (the successor's valid_from), not another writer's. */
export const slotCloseEndSql = (a: string) => linked(a, true);

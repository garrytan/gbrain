/**
 * GBRA-574 B2: conversation fact slots. A second call after extraction (slot-tagging.ts) may tag a fact with one slot,
 * a (dimension, value) pair on the ontology columns facts already has, from a closed vocabulary of single-valued
 * dimensions. Nothing closes
 * a slot value in storage: the query facts block derives each value's validity window at read time from the slot's
 * chronology (deriveSlotEnds), so re-extracting pages in any order yields the same windows.
 */
import { normalizeDimension } from '../chronicle/ontology.ts';

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
  valid_from: Date | string | null; source_markdown_slug: string | null; fact: string;
}

/**
 * Derived ends by fact id. Rows of one (source, entity, dimension) are walked in valid_from order; consecutive rows of
 * one value are one stint (a restatement continues it). A stint ends where the next distinct value starts when that
 * value's first row is on a page one of the stint's rows came from, or its fact matches CHANGE_CUE, and only when it
 * starts later than the stint. A row with no event date (#10288) has no place in the walk and is skipped. Callers pass
 * only rows the reader may see.
 */
export function deriveSlotEnds(rows: readonly SlotRow[]): Map<number, Date> {
  const ends = new Map<number, Date>();
  const groups = new Map<string, SlotRow[]>();
  for (const r of rows) {
    if (r.valid_from == null) continue;
    const key = [r.source_id, r.entity_slug, r.dimension].join('\u0000');
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  const time = (r: SlotRow) => new Date(r.valid_from!).getTime();
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
      for (const r of stint) ends.set(Number(r.id), new Date(next.valid_from!));
    }
  }
  return ends;
}

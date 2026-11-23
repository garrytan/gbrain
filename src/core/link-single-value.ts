/**
 * Declared single-value relations: a schema pack marks a state relation
 * `cardinality: one_per_from` (e.g. a pack where `works_at` means the one
 * current employer). When a page then holds several live relationships of
 * that type, the declaration itself is the verdict that they cannot all hold,
 * so no model is asked; `closeContradiction` (link-validity.ts) still supplies
 * every date. Closures land through the edge_contradictions apply path, as one
 * reversible timeline line on the subject page.
 *
 * The chain rule orders a group's live relationships by their latest dated
 * start and closes each one at the next one's start, so an out-of-order import
 * (A from January, B from March, then C from February) ends A in February and
 * C in March. Undated relationships and equal start dates are left open as
 * conflicts.
 */
import type { BrainEngine } from './engine.ts';
import { closeContradiction, dateKey, parseMultirange, RELATION_SEMANTICS, type Stint } from './link-validity.ts';

export interface SingleValueMember {
  to_page_id: number;
  lastStart: string | null;
  stints: Stint[];
  recordedAt: string | Date | null;
}

export interface SingleValueClosure { ending: number; successor: number; closeDate: string; bornClosed: boolean }

export interface SingleValuePlan {
  closures: SingleValueClosure[];
  undated: number[];
  sameDate: Array<[number, number]>;
}

export function planSingleValueClosures(members: readonly SingleValueMember[]): SingleValuePlan {
  const undated = members.filter(m => !dateKey(m.lastStart)).map(m => m.to_page_id);
  const dated = members.filter(m => dateKey(m.lastStart))
    .sort((a, b) => dateKey(a.lastStart)!.localeCompare(dateKey(b.lastStart)!) || a.to_page_id - b.to_page_id);
  const closures: SingleValueClosure[] = [];
  const sameDate: Array<[number, number]> = [];
  for (let i = 0; i + 1 < dated.length; i++) {
    const older = dated[i]!, newer = dated[i + 1]!;
    const outcome = closeContradiction(older, newer);
    if (outcome.action === 'close') {
      closures.push({ ending: older.to_page_id, successor: newer.to_page_id, closeDate: outcome.closeDate, bornClosed: outcome.bornClosed });
    } else if (outcome.reason === 'ambiguous_same_date') {
      sameDate.push([older.to_page_id, newer.to_page_id]);
    }
  }
  return { closures, undated, sameDate };
}

/** State relations the source's resolved schema pack declares single-valued. Fail-open to none. */
export async function declaredSingleValueTypes(engine: BrainEngine, sourceId: string): Promise<Set<string>> {
  try {
    const { loadActivePackForEngine } = await import('./schema-pack/engine-resolution.ts');
    const pack = await loadActivePackForEngine(engine, { sourceId, remote: false });
    return new Set(pack.manifest.link_types
      .filter(lt => lt.cardinality === 'one_per_from' && (lt.temporal ?? RELATION_SEMANTICS[lt.name]) === 'state')
      .map(lt => lt.name));
  } catch {
    return new Set();
  }
}

export interface SingleValuePreviewGroup {
  source_id: string;
  subject: string;
  link_type: string;
  live: Array<{ target: string; since: string | null }>;
  would_close: Array<{ target: string; close_date: string; superseded_by: string }>;
  undated: string[];
  same_date: Array<[string, string]>;
}

/**
 * Read-only: per declared single-value relation, every page with more than one
 * live relationship of that type, and what the chain rule would close or leave
 * open. `sourceId` narrows to one source.
 */
export async function previewSingleValue(engine: BrainEngine, sourceId?: string): Promise<{ declared: Record<string, string[]>; groups: SingleValuePreviewGroup[] }> {
  const sources = sourceId ? [sourceId]
    : await engine.listSourceIds();
  const declared: Record<string, string[]> = {};
  const groups: SingleValuePreviewGroup[] = [];
  for (const source of sources) {
    const types = [...await declaredSingleValueTypes(engine, source)].sort();
    if (!types.length) continue;
    declared[source] = types;
    const rows = await engine.executeRaw<{ subject: string; link_type: string; to_page_id: number; target: string; last_start: unknown; valid_ranges: string; recorded_at: unknown }>(
      `WITH live AS (
         SELECT lr.* FROM link_relationships lr
          WHERE lr.scope = 'all' AND lr.source_id = $1 AND lr.link_type = ANY($2::text[]) AND lr.valid_ranges @> CURRENT_DATE
       ), multi AS (
         SELECT from_page_id, link_type FROM live GROUP BY 1, 2 HAVING count(DISTINCT to_page_id) >= 2
       )
       SELECT f.slug AS subject, l.link_type, l.to_page_id, t.slug AS target, l.last_start, l.valid_ranges::text AS valid_ranges, l.recorded_at
         FROM live l JOIN multi m USING (from_page_id, link_type)
         JOIN pages f ON f.id = l.from_page_id AND f.deleted_at IS NULL
         JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
        ORDER BY f.slug COLLATE "C", l.link_type COLLATE "C", t.slug COLLATE "C"`,
      [source, types]);
    const bySubject = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.subject}\0${r.link_type}`;
      bySubject.set(key, [...(bySubject.get(key) ?? []), r]);
    }
    for (const members of bySubject.values()) {
      const slugOf = new Map(members.map(m => [Number(m.to_page_id), m.target]));
      const plan = planSingleValueClosures(members.map(m => ({
        to_page_id: Number(m.to_page_id), lastStart: dateKey(m.last_start), stints: parseMultirange(m.valid_ranges),
        recordedAt: m.recorded_at instanceof Date ? m.recorded_at : m.recorded_at == null ? null : String(m.recorded_at),
      })));
      groups.push({
        source_id: source, subject: members[0]!.subject, link_type: members[0]!.link_type,
        live: members.map(m => ({ target: m.target, since: dateKey(m.last_start) })),
        would_close: plan.closures.map(c => ({ target: slugOf.get(c.ending)!, close_date: c.closeDate, superseded_by: slugOf.get(c.successor)! })),
        undated: plan.undated.map(id => slugOf.get(id)!),
        same_date: plan.sameDate.map(([a, b]) => [slugOf.get(a)!, slugOf.get(b)!] as [string, string]),
      });
    }
  }
  return { declared, groups };
}

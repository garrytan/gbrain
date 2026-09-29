/**
 * `gbrain repair visibility` (#5525): tighten-only backfill that stamps an
 * explicit `visibility` on extracted atoms and synthesized concepts.
 *
 *   atom     origin page -> effectiveVisibility(origin); transcript or missing origin -> private
 *   concept  strictest visibility of its input atoms (provenance edges + atoms' `concepts:`);
 *            a member without a provenance edge counts as private
 *
 * An item is only ever made stricter than it is now: explicit `private` stays,
 * explicit `world` becomes `private` when its origin is stricter, and a missing
 * field (read as private) is stamped with the origin's value. A concept with no
 * recoverable lineage is left unchanged and counted. Atoms are applied before
 * concepts so a concept is judged against its repaired inputs.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { effectiveVisibility, strictestVisibility, type Visibility } from '../search/private-visibility.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairScope, type RepairCursor } from './core.ts';

interface DerivedRow { id: number; source_id: string; slug: string; type: string; visibility: string | null; chars: number }
interface AtomRow extends DerivedRow { source_slug: string | null; origin_id: number | null; origin_type: string | null; origin_frontmatter: Record<string, unknown> | null }
interface InputRow { concept_id: number; atom_id: number; linked: boolean }

export interface VisibilityChange { id: number; source_id: string; slug: string; phase: 0 | 1; from: string | null; to: Visibility }

/** Tighten-only: never loosen an explicit value; stamp a missing one. */
function tightened(current: string | null, target: Visibility): Visibility | null {
  if (current === 'private') return null;
  if (current === 'world') return target === 'private' ? 'private' : null;
  return target;
}

/**
 * Every atom / synthesized concept in scope whose stored visibility should
 * change. `only` narrows the plan to one page (and, for a concept, its inputs)
 * so an item is re-decided against current state just before it is applied.
 */
export async function planVisibilityRepair(engine: BrainEngine, sourceIds: string[], only?: number) {
  const [kind] = only === undefined ? [] : await engine.executeRaw<{ type: string }>('SELECT type FROM pages WHERE id=$1', [only]);
  const conceptIds = only === undefined ? null : kind?.type === 'concept' ? [only] : [];
  const concepts = await engine.executeRaw<DerivedRow>(`SELECT c.id,c.source_id,c.slug,c.type,c.frontmatter->>'visibility' AS visibility,
      length(c.compiled_truth) AS chars
    FROM pages c WHERE c.type='concept' AND c.frontmatter->>'synthesized_by' IS NOT NULL AND c.deleted_at IS NULL
      AND c.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR c.id=ANY($2::integer[])) ORDER BY c.id`, [sourceIds, conceptIds]);
  // A member recovered only from an atom's `concepts:` list has no provenance
  // edge, so a later private flip could not reach the concept: it stays private.
  const inputs = concepts.length ? await engine.executeRaw<InputRow>(`SELECT c.id AS concept_id,a.id AS atom_id,
      EXISTS (SELECT 1 FROM links l WHERE l.from_page_id=c.id AND l.to_page_id=a.id
        AND l.link_source='concept-provenance' AND l.link_type='synthesized_from') AS linked
    FROM pages c JOIN pages a ON a.source_id=c.source_id AND a.type='atom' AND a.deleted_at IS NULL
    WHERE c.id=ANY($1::integer[]) AND (
      EXISTS (SELECT 1 FROM links l WHERE l.from_page_id=c.id AND l.to_page_id=a.id
        AND l.link_source='concept-provenance' AND l.link_type='synthesized_from')
      OR (jsonb_typeof(a.frontmatter->'concepts')='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.frontmatter->'concepts') ref
        WHERE regexp_replace(ref,'^.*/','')=regexp_replace(c.slug,'^concepts/',''))))`, [concepts.map(c => Number(c.id))]) : [];
  const atomIds = only === undefined ? null : kind?.type === 'atom' ? [only] : inputs.map(row => Number(row.atom_id));
  const atoms = await engine.executeRaw<AtomRow>(`SELECT a.id,a.source_id,a.slug,a.type,a.frontmatter->>'visibility' AS visibility,
      length(a.compiled_truth) AS chars, a.frontmatter->>'source_slug' AS source_slug,
      o.id AS origin_id,o.type AS origin_type,o.frontmatter AS origin_frontmatter
    FROM pages a LEFT JOIN pages o ON o.source_id=a.source_id AND o.slug=a.frontmatter->>'source_slug' AND o.deleted_at IS NULL
    WHERE a.type='atom' AND a.deleted_at IS NULL AND a.source_id=ANY($1::text[])
      AND ($2::integer[] IS NULL OR a.id=ANY($2::integer[])) ORDER BY a.id`, [sourceIds, atomIds]);

  const changes: VisibilityChange[] = [];
  const atomVisibility = new Map<number, Visibility>();
  let originGone = 0;
  for (const atom of atoms) {
    const origin = atom.source_slug ? { kind: 'page' as const, page: atom.origin_id == null ? null : { type: atom.origin_type, frontmatter: atom.origin_frontmatter } }
      : { kind: 'transcript' as const };
    const target = effectiveVisibility(origin);
    const next = tightened(atom.visibility, target);
    if (next && origin.kind === 'page' && !origin.page) originGone++;
    const effective = next ?? (atom.visibility === 'world' ? 'world' : 'private');
    atomVisibility.set(Number(atom.id), effective);
    if (next) changes.push({ id: Number(atom.id), source_id: atom.source_id, slug: atom.slug, phase: 0, from: atom.visibility, to: next });
  }
  let noLineage = 0;
  for (const concept of concepts) {
    const rows = inputs.filter(row => Number(row.concept_id) === Number(concept.id));
    if (!rows.length) { noLineage++; continue; }
    const members = rows.map(row => row.linked ? atomVisibility.get(Number(row.atom_id)) ?? 'private' : 'private');
    const next = tightened(concept.visibility, strictestVisibility(members));
    if (next) changes.push({ id: Number(concept.id), source_id: concept.source_id, slug: concept.slug, phase: 1, from: concept.visibility, to: next });
  }
  const chars = new Map([...atoms, ...concepts].map(row => [Number(row.id), Number(row.chars)]));
  return { changes, chars, residuals: { atoms_origin_gone_to_private: originGone, concepts_without_lineage: noLineage } };
}

export const visibilityRepair: RepairHandler = {
  kind: 'visibility',
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null) {
    const { changes, chars, residuals } = await planVisibilityRepair(engine, scope.source_ids);
    const items: RepairItem[] = changes.map(change => ({ cursor: { phase: change.phase, id: change.id }, source_id: change.source_id,
      slug: change.slug, chars: chars.get(change.id) ?? 0, action: `visibility ${change.from ?? '(none)'} -> ${change.to}`,
      change: { from: change.from, to: change.to } }))
      .filter(item => afterCursor(item.cursor, after));
    return { items, residuals };
  },
  async apply(ctx, item) {
    const snapshot = await ctx.engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
    if (!snapshot || !item.change) return false;
    // Re-decide against current origins and inputs; a changed decision waits for the next run.
    const fresh = (await planVisibilityRepair(ctx.engine, [item.source_id], snapshot.page.id)).changes.find(c => c.id === snapshot.page.id);
    if (!fresh || fresh.from !== item.change.from || fresh.to !== item.change.to) return false;
    const page = { ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, visibility: item.change.to } };
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: item.slug, source_id: item.source_id,
      content: serializePageToMarkdown(page, snapshot.tags), expected_revision: snapshot.revision,
      request_id: await repairRequestId(ctx, 'visibility', item, snapshot.revision) } });
    return true;
  },
};

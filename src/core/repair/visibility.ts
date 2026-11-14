/**
 * `gbrain repair visibility` (#5525): tighten-only backfill that stamps an
 * explicit `visibility` on extracted atoms and synthesized concepts.
 *
 *   atom     origin page -> effectiveVisibility(origin); transcript or missing origin -> private;
 *            a private page a rename moved its origin to (slug_rename_history, GST-2687) -> private
 *   concept  strictest visibility of its input atoms (provenance edges + atoms' `concepts:`);
 *            a member without a provenance edge counts as private
 *
 *   event    a Life Chronicle event whose meeting/conversation origin is private now (by its
 *            `visibility`, lineage or a privacy alias) becomes private; a missing origin is
 *            left unchanged and counted (remote reads already hide it)
 *   alias    a page that carries a privacy alias (`access: private`, ...) but no `visibility`
 *            is stamped `visibility: private`
 *   fact     an active world fact held in or extracted from such a private page becomes
 *            private: in its page's facts fence when fenced, in place when database-only
 *
 * An item is only ever made stricter than it is now: explicit `private` stays,
 * explicit `world` becomes `private` when its origin is stricter, and a missing
 * field (read as private) is stamped with the origin's value. A concept with no
 * recoverable lineage is counted; a missing value on it is stamped private and an explicit one is left unchanged. Atoms are applied before
 * concepts so a concept is judged against its repaired inputs.
 *
 * The preview plans one class at a time (`--class facts|events|aliases|lineage`, default all), in the
 * order remote callers are exposed: facts (remotely readable ones first), chronicle events, alias-only
 * pages, then atoms and concepts. Only the lineage class reads concept-provenance links. It lists one
 * bounded window (`--limit`, default VISIBILITY_WINDOW items) and prints `--apply --expect <hash>`,
 * which applies exactly that window (resumable: a stopped apply continues after its last item). A
 * class past a full window is not read; apply the window and preview again for the next one. Each
 * plan statement runs under PLAN_STATEMENT_MS; a class that overruns it is reported and skipped.
 * Progress goes to stderr. A bare `--apply` (`--all`, the remediation plan) applies every class.
 *
 * `--slug <page>` (repeatable, GST-2468) replaces the classes with the named pages (class `pages`): each is made
 * private, tighten-only, preview-bound (a bare `--apply` refuses). It is the operator's single-page label change.
 * Every item writes through the label-only door (repair/label-write.ts): the page keeps its trust tier, files no
 * lower_page proposal and its file changes only on the visibility line (a fact item: its fence row).
 *
 * `--readers <list>` with `--slug` or `--slugs-file` (GST-2476, repair/readers.ts) sets the named pages' readable_by through
 * the same door instead. A managed page with no file in its checkout outside a declared storage.db_only path is held
 * `canonical_file_missing` with nothing written: a database-only label there would put the database ahead of Git.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { derivationPrivateSql, effectiveVisibility, folderRestrictedSql, privacyAliasSql, privateSnapshotFilterFragment, strictestVisibility, type Visibility } from '../search/private-visibility.ts';
import { strikeFenceRow } from '../facts/forget.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import { digest } from '../persistence/digest.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, publishMaintenancePages, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { CANONICAL_FILE_MISSING } from '../persistence/publication-failure.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { atomMovedOriginPrivateSql, atomOriginSlugSql } from '../persistence/atom-origin.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairPlanOptions, type RepairScope, type RepairSettlement, type RepairCursor } from './core.ts';
import { openTwins, openTwinsLines, openTwinsWarning, type OpenTwins } from '../access/open-twins.ts';
import { ownerMemberId } from '../access/owner.ts';
import { filesInCheckout, labelFileRefusal, writeLabelFile, writeLabelPage, type LabelFileRefusal } from './label-write.ts';
import { applyReaders, planReaders, raiseGuardOnly, raiseReadersGuard, readersBatch, readersGitCounts, readersGuardOnly, readersOutcome, readersWrite, retireReaders, READERS_PHASE, type ReadersItem, type ReadersWrite } from './readers.ts';
import type { LabelEdit } from '../persistence/label-edit.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { loadApprovedSet, previewChangedError, previewHash, retireAfterLastItem, saveApprovedSet } from '../persistence/preview-approval.ts';
import { createProgress, startHeartbeat } from '../progress.ts';
import { cliOptsToProgressOptions, getCliOptions } from '../cli-options.ts';

interface DerivedRow { id: number; source_id: string; slug: string; type: string; visibility: string | null; chars: number }
interface AtomRow extends DerivedRow { source_slug: string | null; origin_id: number | null; origin_type: string | null; origin_frontmatter: Record<string, unknown> | null; origin_folder_restricted: boolean; origin_moved_private: boolean }
interface InputRow { concept_id: number; atom_id: number; linked: boolean }

interface EventRow extends DerivedRow { origin_id: number | null; origin_type: string | null; origin_frontmatter: Record<string, unknown> | null; origin_folder_restricted: boolean }

export interface VisibilityChange { id: number; source_id: string; slug: string; phase: 0 | 1 | 2 | 3 | 5; from: string | null; to: Visibility }

/** Tighten-only: never loosen an explicit value; stamp a missing one. */
function tightened(current: string | null, target: Visibility): Visibility | null {
  if (current === 'private') return null;
  if (current === 'world') return target === 'private' ? 'private' : null;
  return target;
}

/** Each plan statement's bound (Postgres; PGLite has no other session to wait on). */
export const PLAN_STATEMENT_MS = 120_000;
const bounded = { timeoutMs: PLAN_STATEMENT_MS };

/** Extracted atoms and synthesized concepts: the only class that reads concept-provenance links. */
async function planLineage(engine: BrainEngine, sourceIds: string[], only?: { id: number; type: string }) {
  const conceptIds = only === undefined ? null : only.type === 'concept' ? [only.id] : [];
  const concepts = conceptIds?.length === 0 ? [] : await engine.executeRaw<DerivedRow>(`SELECT c.id,c.source_id,c.slug,c.type,c.frontmatter->>'visibility' AS visibility,
      length(c.compiled_truth) AS chars
    FROM pages c WHERE c.type='concept' AND c.frontmatter->>'synthesized_by' IS NOT NULL AND c.deleted_at IS NULL
      AND c.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR c.id=ANY($2::integer[])) ORDER BY c.id`, [sourceIds, conceptIds], bounded);
  // A member recovered only from an atom's `concepts:` list has no provenance
  // edge, so a later private flip could not reach the concept: it stays private.
  // Set-based: provenance edges by page id, `concepts:` references by a hash join on the concept name.
  const inputs = concepts.length ? await engine.executeRaw<InputRow>(`WITH c AS MATERIALIZED (
      SELECT id,source_id,regexp_replace(slug,'^concepts/','') AS name FROM pages WHERE id=ANY($1::integer[])),
    refs AS MATERIALIZED (
      SELECT a.id AS atom_id,a.source_id,regexp_replace(ref,'^.*/','') AS name FROM pages a
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.frontmatter->'concepts')='array' THEN a.frontmatter->'concepts' ELSE '[]'::jsonb END) ref
        WHERE a.type='atom' AND a.deleted_at IS NULL AND a.source_id IN (SELECT source_id FROM c)),
    members AS (
      SELECT l.from_page_id AS concept_id,l.to_page_id AS atom_id,true AS linked FROM links l
        JOIN c ON c.id=l.from_page_id JOIN pages a ON a.id=l.to_page_id AND a.source_id=c.source_id AND a.type='atom' AND a.deleted_at IS NULL
        WHERE l.link_source='concept-provenance' AND l.link_type='synthesized_from'
      UNION ALL
      SELECT c.id,r.atom_id,false FROM refs r JOIN c ON c.source_id=r.source_id AND c.name=r.name)
    SELECT concept_id,atom_id,bool_or(linked) AS linked FROM members GROUP BY concept_id,atom_id`, [concepts.map(c => Number(c.id))], bounded) : [];
  const inputsByConcept = new Map<number, InputRow[]>();
  for (const row of inputs) {
    const list = inputsByConcept.get(Number(row.concept_id));
    if (list) list.push(row); else inputsByConcept.set(Number(row.concept_id), [row]);
  }
  const atomIds = only === undefined ? null : only.type === 'atom' ? [only.id] : inputs.map(row => Number(row.atom_id));
  const atoms = atomIds?.length === 0 ? [] : await engine.executeRaw<AtomRow>(`SELECT a.id,a.source_id,a.slug,a.type,a.frontmatter->>'visibility' AS visibility,
      length(a.compiled_truth) AS chars, a.frontmatter->>'source_slug' AS source_slug,
      o.id AS origin_id,o.type AS origin_type,o.frontmatter AS origin_frontmatter,
      (o.id IS NOT NULL AND ${folderRestrictedSql('o')}) AS origin_folder_restricted, ${atomMovedOriginPrivateSql('a')} AS origin_moved_private
    FROM pages a LEFT JOIN pages o ON o.source_id=a.source_id AND o.slug=${atomOriginSlugSql('a')} AND o.deleted_at IS NULL
    WHERE a.type='atom' AND a.deleted_at IS NULL AND a.source_id=ANY($1::text[])
      AND ($2::integer[] IS NULL OR a.id=ANY($2::integer[])) ORDER BY a.id`, [sourceIds, atomIds], bounded);

  const changes: VisibilityChange[] = [];
  const atomVisibility = new Map<number, Visibility>();
  let originGone = 0;
  for (const atom of atoms) {
    const origin = atom.source_slug ? { kind: 'page' as const, page: atom.origin_id == null ? null : { type: atom.origin_type, frontmatter: atom.origin_frontmatter, folder_restricted: atom.origin_folder_restricted } }
      : { kind: 'transcript' as const };
    const target = atom.origin_moved_private ? 'private' : effectiveVisibility(origin);
    const next = tightened(atom.visibility, target);
    if (next && origin.kind === 'page' && !origin.page) originGone++;
    const effective = next ?? (atom.visibility === 'world' ? 'world' : 'private');
    atomVisibility.set(Number(atom.id), effective);
    if (next) changes.push({ id: Number(atom.id), source_id: atom.source_id, slug: atom.slug, phase: 0, from: atom.visibility, to: next });
  }
  let noLineage = 0;
  for (const concept of concepts) {
    const rows = inputsByConcept.get(Number(concept.id)) ?? [];
    if (!rows.length) noLineage++;
    if (!rows.length && concept.visibility === 'world') continue;
    const members = rows.map(row => row.linked ? atomVisibility.get(Number(row.atom_id)) ?? 'private' : 'private');
    const next = tightened(concept.visibility, rows.length ? strictestVisibility(members) : 'private');
    if (next) changes.push({ id: Number(concept.id), source_id: concept.source_id, slug: concept.slug, phase: 1, from: concept.visibility, to: next });
  }
  return { changes, rows: [...atoms, ...concepts], residuals: { atoms_origin_gone_to_private: originGone, concepts_without_lineage: noLineage } };
}

/** Life Chronicle events whose origin is private now. */
async function planEvents(engine: BrainEngine, sourceIds: string[], only?: number) {
  const events = await engine.executeRaw<EventRow>(`SELECT e.id,e.source_id,e.slug,e.type,e.frontmatter->>'visibility' AS visibility,
      length(e.compiled_truth) AS chars,o.id AS origin_id,o.type AS origin_type,o.frontmatter AS origin_frontmatter,
      (o.id IS NOT NULL AND ${folderRestrictedSql('o')}) AS origin_folder_restricted
    FROM pages e LEFT JOIN pages o ON o.source_id=e.source_id AND o.slug=e.frontmatter->'event'->>'depth' AND o.deleted_at IS NULL
    WHERE e.type='event' AND e.frontmatter->>'captured_via' LIKE 'life-chronicle:%' AND e.deleted_at IS NULL
      AND COALESCE(e.frontmatter->>'visibility','world')<>'private'
      AND e.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR e.id=ANY($2::integer[])) ORDER BY e.id`, [sourceIds, only === undefined ? null : [only]], bounded);
  const changes: VisibilityChange[] = [];
  let originGone = 0;
  for (const event of events) {
    if (event.origin_id == null) { originGone++; continue; }
    if (effectiveVisibility({ kind: 'page', page: { type: event.origin_type, frontmatter: event.origin_frontmatter, folder_restricted: event.origin_folder_restricted } }) !== 'private') continue;
    changes.push({ id: Number(event.id), source_id: event.source_id, slug: event.slug, phase: 2, from: event.visibility, to: 'private' });
  }
  return { changes, rows: events, residuals: { events_origin_gone: originGone } };
}

/** Pages marked private by a privacy alias alone. */
async function planAliases(engine: BrainEngine, sourceIds: string[], only?: number) {
  const rows = await engine.executeRaw<DerivedRow>(`SELECT p.id,p.source_id,p.slug,p.type,NULL::text AS visibility,length(p.compiled_truth) AS chars
    FROM pages p WHERE ${aliasOnlyPagesSql('p')} AND p.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR p.id=ANY($2::integer[])) ORDER BY p.id`,
  [sourceIds, only === undefined ? null : [only]], bounded);
  return { changes: rows.map(page => ({ id: Number(page.id), source_id: page.source_id, slug: page.slug, phase: 3 as const, from: null, to: 'private' as const })), rows, residuals: {} };
}

/**
 * GST-2468: the pages an operator named with --slug, made private (tighten-only: an explicit private stays). The
 * operator's own single-page label change, which a put_page would rate as an agent edit (trust/channel.ts). GST-2521: an
 * already-private page with no label guard (an upgrade, a rebuild from a clone) is listed private -> private, to raise
 * the guard without a write.
 */
async function planNamed(engine: BrainEngine, sourceIds: string[], slugs: string[]) {
  const rows = await engine.executeRaw<DerivedRow & { guarded: boolean }>(`SELECT p.id,p.source_id,p.slug,p.type,p.frontmatter->>'visibility' AS visibility,COALESCE(p.body_bytes, 0) AS chars,
      EXISTS (SELECT 1 FROM page_label_guards g WHERE g.page_id = p.id) AS guarded
    FROM pages p WHERE p.deleted_at IS NULL AND p.source_id=ANY($1::text[]) AND p.slug=ANY($2::text[]) ORDER BY p.id`, [sourceIds, slugs], bounded);
  const changes = rows.flatMap(page => {
    const next = tightened(page.visibility, 'private') ?? (page.visibility === 'private' && !page.guarded ? 'private' : null);
    return next ? [{ id: Number(page.id), source_id: page.source_id, slug: page.slug, phase: 5 as const, from: page.visibility, to: next }] : [];
  });
  const found = new Set(rows.map(row => row.slug));
  return { changes, rows, residuals: { named_already_private: rows.length - changes.length, named_not_found: slugs.filter(slug => !found.has(slug)).length } };
}

/**
 * Every atom / synthesized concept / chronicle event / alias-only page in scope
 * whose stored visibility should change. `only` narrows the plan to one page
 * (and, for a concept, its inputs) so an item is re-decided against current
 * state just before it is applied; only an atom or concept reads links.
 */
export async function planVisibilityRepair(engine: BrainEngine, sourceIds: string[], only?: number) {
  const [kind] = only === undefined ? [] : await engine.executeRaw<{ type: string }>('SELECT type FROM pages WHERE id=$1', [only]);
  if (only !== undefined && !kind) return { changes: [], chars: new Map<number, number>(), residuals: {} };
  const lineage = only === undefined || kind!.type === 'atom' || kind!.type === 'concept'
    ? await planLineage(engine, sourceIds, only === undefined ? undefined : { id: only, type: kind!.type }) : null;
  const events = await planEvents(engine, sourceIds, only);
  const aliased = await planAliases(engine, sourceIds, only);
  const parts = [...(lineage ? [lineage] : []), events, aliased];
  return { changes: parts.flatMap(part => part.changes), chars: new Map(parts.flatMap(part => part.rows).map(row => [Number(row.id), Number(row.chars)])),
    residuals: Object.assign({}, ...parts.map(part => part.residuals)) as Record<string, number> };
}

/**
 * The page a fact says it came from (not the page holding it): the page-write
 * session (`put_page:<slug>`, `sync:<slug>`), else the slug a page-write or
 * extract_facts lane records first in `context`.
 */
function factProvenanceSlugSql(f: string): string {
  return `regexp_replace(COALESCE(
    CASE WHEN ${f}.source_session ~ '^(put_page|sync):' THEN regexp_replace(${f}.source_session, '^(put_page|sync):', '') END,
    CASE WHEN ${f}.source IN ('mcp:put_page','sync:import','file_upload','code_import','hook:writeback','mcp:extract_facts')
      THEN NULLIF(split_part(btrim(COALESCE(${f}.context,'')), ' ', 1), '') END), '\\.md$', '')`;
}

/**
 * Active `world` facts held in, or extracted from, a page that is private by
 * its `visibility`, its declared lineage or a privacy alias. `readable` says a
 * remote caller can recall the row today: its holding page does not hide it
 * through the provenance filter.
 */
export async function worldFactsFromPrivateSources(engine: BrainEngine, sourceIds: string[], ids?: number[]) {
  return engine.executeRaw<{ id: number; source_id: string; row_num: number | null; source_markdown_slug: string | null; entity_slug: string | null; readable: boolean }>(
    `SELECT f.id,f.source_id,f.row_num,f.source_markdown_slug,f.entity_slug,
      (f.source_markdown_slug IS NULL OR h.id IS NULL OR ${privateSnapshotFilterFragment('h')}) AS readable
    FROM facts f
      LEFT JOIN pages h ON h.source_id=f.source_id AND h.slug=f.source_markdown_slug
      LEFT JOIN pages o ON o.source_id=f.source_id AND o.slug=${factProvenanceSlugSql('f')} AND o.deleted_at IS NULL
    WHERE f.visibility='world' AND f.expired_at IS NULL AND f.source_id=ANY($1::text[]) AND ($2::bigint[] IS NULL OR f.id=ANY($2::bigint[]))
      AND ((h.id IS NOT NULL AND h.deleted_at IS NULL AND ${derivationPrivateSql('h')}) OR (o.id IS NOT NULL AND ${derivationPrivateSql('o')}))
    ORDER BY f.id`, [sourceIds, ids ?? null]);
}

/** Pages that carry a privacy alias but no `visibility` (derived atoms, concepts and chronicle events have their own phases). */
export function aliasOnlyPagesSql(p: string): string {
  return `(${p}.deleted_at IS NULL AND ${p}.frontmatter->>'visibility' IS NULL AND ${privacyAliasSql(p)}
    AND ${p}.type <> 'atom' AND NOT (${p}.type = 'concept' AND ${p}.frontmatter->>'synthesized_by' IS NOT NULL)
    AND NOT (${p}.type = 'event' AND ${p}.frontmatter->>'captured_via' LIKE 'life-chronicle:%'))`;
}

export const FACT_VISIBILITY_INTENT = 'managed_maintenance_tighten_fact_visibility';

/** Database-only rows still world and unfenced become private; the compare runs in the UPDATE, which locks the row. */
const tightenDatabaseFacts = (tx: BrainEngine, sourceId: string, ids: number[]) => tx.executeRaw<{ id: number | string }>(
  `UPDATE facts SET visibility='private' WHERE source_id=$1 AND id=ANY($2::bigint[]) AND visibility='world' AND row_num IS NULL AND expired_at IS NULL RETURNING id`,
  [sourceId, ids]);

/** Preparer for `managed_maintenance_tighten_fact_visibility`: makes the named database-only world facts private. */
export async function prepareFactVisibilityTighten(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const ids = (row.intent as { fact_ids?: unknown } | null)?.fact_ids;
  if (!Array.isArray(ids) || !ids.every(id => Number.isSafeInteger(id))) {
    throw opError('invalid_params', 'The fact visibility intent does not name its facts.',
      `Request ${row.request_id} in source ${row.source_id} does not name the facts to make private, so nothing changed. Preview gbrain repair visibility again and apply it after the user approves.`);
  }
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  return { observedRevision: snapshot?.revision ?? null, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => ({ status: 'completed', tightened: (await tightenDatabaseFacts(tx, row.source_id, ids as number[])).map(r => Number(r.id)) }) };
}

/**
 * One fact item: a fenced row gets `private` in its page's `## Facts` fence by a
 * revision-bound label write (labelWrite; the projection then stores it private, and a
 * more trusted row turns private in place, trust/fence-guard.ts); a database-only row is
 * updated in place (a database-only maintenance request on a managed brain). On a brain
 * without managed persistence the page import does not re-project the fence, so the fenced
 * row is made private in place there too, keeping its id and tier (GST-2487). A page stored
 * in segments is left for the owner. A fenced row that stays world and live is reported,
 * never as done: `fact_left_readable` when remote callers can read it now, `fact_left_world`
 * when only its page's privacy hides it (worldFactsFromPrivateSources `readable`).
 */
const leftWorld = (fact: { id: number; readable: boolean }, why: string): RepairItemOutcome => fact.readable
  ? { applied: false, outcome: 'fact_left_readable', detail: { fact_id: Number(fact.id) }, reason: `${why}; the fact row is still world, so remote callers can still read it` }
  : { applied: false, outcome: 'fact_left_world', detail: { fact_id: Number(fact.id) },
    reason: `${why}; the fact row is still world, and only its page's privacy keeps remote callers from reading it` };
async function applyFactItem(ctx: Parameters<RepairHandler['apply']>[0], item: RepairItem, factId: number): Promise<boolean | RepairItemOutcome> {
  const [fact] = await worldFactsFromPrivateSources(ctx.engine, [item.source_id], [factId]);
  if (!fact) return false;
  if (fact.row_num === null) {
    if (!await managedPersistenceEnabled(ctx.engine)) {
      return (await maintenanceTransaction(ctx.engine, tx => tightenDatabaseFacts(tx, item.source_id, [factId]))).length > 0;
    }
    const authority = (await maintenancePreflight(ctx.engine, item.source_id))!;
    const holder = await ctx.engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
    const h = digest(['fact-visibility-v1', item.source_id, item.slug, factId, holder?.revision ?? null]);
    const receipt = await submitDatabaseMaintenanceIntent(ctx.engine, authority, item.slug,
      { kind: FACT_VISIBILITY_INTENT, expected_revision: holder?.revision ?? null, fact_ids: [factId] },
      `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`);
    return ((receipt.tightened as number[] | undefined) ?? []).includes(factId);
  }
  const snapshot = fact.source_markdown_slug ? await ctx.engine.readPageSnapshot(fact.source_markdown_slug, { sourceId: item.source_id }) : null;
  if (!snapshot) return false;
  if (isSegmentedPage(snapshot.page)) return leftWorld(fact, 'its page is stored in segments, which this repair does not rewrite');
  const body = strikeFenceRow(snapshot.page.compiled_truth ?? '', fact.row_num, row => ({ ...row, visibility: 'private' }));
  if (body === null) return leftWorld(fact, 'its row was not found in the page\'s facts fence');
  const held = await labelWrite(ctx, item, snapshot, serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags), { set: {}, remove: [] });
  if (held) return held;
  const [stored] = await ctx.engine.executeRaw<{ visibility: string; live: boolean }>('SELECT visibility, expired_at IS NULL AS live FROM facts WHERE id=$1', [factId]);
  if (!stored || stored.visibility === 'private' || !stored.live) return true;
  if (!await managedPersistenceEnabled(ctx.engine) && (await maintenanceTransaction(ctx.engine, tx => tx.executeRaw(
    `UPDATE facts SET visibility='private' WHERE source_id=$1 AND id=$2 AND row_num=$3 AND visibility='world' AND expired_at IS NULL RETURNING id`,
    [item.source_id, factId, fact.row_num]))).length > 0) return true;
  return leftWorld(fact, 'its fence row was written private, but the original row is more trusted than the repair and was kept beside it');
}

/**
 * The held outcome of a managed page whose canonical file is missing outside any declared storage.db_only path (the
 * maintenance door refused it before admission, nothing written); any other error is rethrown.
 */
function missingFileHeld(item: Pick<RepairItem, 'source_id' | 'slug'>, error: unknown): RepairItemOutcome {
  if (!(error instanceof OperationError) || error.detail !== CANONICAL_FILE_MISSING) throw error;
  return { applied: false, outcome: CANONICAL_FILE_MISSING, detail: { path: `${item.slug}.md` },
    reason: `${item.source_id}:${item.slug} has no file in its source's checkout and is not under a declared storage.db_only path, so a label write would put the `
      + `database ahead of Git; nothing was written. If the page belongs in the database only, declare its folder under storage.db_only in gbrain.yml, commit it `
      + `and preview again; if its file was removed by mistake, restore it (gbrain repair ghost-pages --source ${item.source_id} lists pages whose file is gone).` };
}

/**
 * GST-2468: one item's page write is a label-only maintenance write (repair/label-write.ts): it keeps the page's trust
 * tier, files no lower_page proposal and changes only the label lines of the page's file (a fact item: its fence row).
 * On a brain without managed persistence a page whose file sits in its source's checkout gets the same splice in that
 * file (label-write.ts writeLabelFile). Null once written; the held outcome for a page stored in segments, a file the
 * repair cannot write, or a managed page whose canonical file is missing (`canonical_file_missing`: never written, or gone
 * outside gbrain, outside any declared storage.db_only path). A page that moved since it was read throws
 * `revision_conflict`, which the apply counts as skipped.
 */
async function labelWrite(ctx: Parameters<RepairHandler['apply']>[0], item: RepairItem, snapshot: PageSnapshot, content: string, edit: LabelEdit, batch?: string): Promise<RepairItemOutcome | null> {
  if (isSegmentedPage(snapshot.page)) return { applied: false, outcome: 'segmented_page', reason: 'The page body is stored in segments; edit it by hand on the brain host.' };
  const path = (await filesInCheckout(ctx.engine, [Number(snapshot.page.id)])).get(Number(snapshot.page.id));
  // GST-2603: a managed page whose file took a change the label edit cannot be spliced over since the preview declines here, before admission.
  if (!path) {
    const refusal = await labelFileRefusal(ctx.engine, snapshot, content, edit);
    if (refusal?.reason === 'label_edit_refused') throw refusal.error;
  }
  const write = { revision: snapshot.revision, content, edit, embed: true, preview: 'gbrain repair visibility', ...(batch ? { batch } : {}) };
  let written: Awaited<ReturnType<typeof writeLabelFile>>;
  try {
    written = path ? await writeLabelFile(ctx.engine, item, { ...write, path })
      : await writeLabelPage(ctx, item, { ...write, requestId: await repairRequestId(ctx, 'visibility', item, snapshot.revision) });
  } catch (error) {
    return missingFileHeld(item, error);
  }
  if (written === null) throw opError('revision_conflict', `${item.source_id}:${item.slug} changed after it was read, so it was not written.`,
    'Preview gbrain repair visibility again; the page is listed with its current state.');
  return typeof written === 'string' ? null : written;
}

/** A page item's label write: the page rendered with its new visibility, and the one label line that changes in its file. */
function visibilityWrite(snapshot: PageSnapshot, to: string): { content: string; edit: LabelEdit } {
  return { content: serializePageToMarkdown({ ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, visibility: to } }, snapshot.tags), edit: { set: { visibility: to }, remove: [] } };
}

/** GST-2603: a previewed page whose label write its file would refuse now; listed as held, outside the preview hash and the approved set. */
interface HeldVisibility { item: string; reason: LabelFileRefusal['reason']; keys: string[]; next: string }
/** The preview's check of one page item against its file's current bytes, as the apply's write compares them (repair/label-write.ts labelFileRefusal). */
async function heldPage(engine: BrainEngine, item: VisibilityItem): Promise<HeldVisibility | null> {
  if (item.target.phase === 4 || !item.change || item.change.from === item.change.to) return null;
  const snapshot = await engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
  if (!snapshot || Number(snapshot.page.id) !== item.target.id || isSegmentedPage(snapshot.page)) return null;
  const write = visibilityWrite(snapshot, item.change.to);
  const refusal = await labelFileRefusal(engine, snapshot, write.content, write.edit);
  return refusal && { item: `${item.source_id}:${item.slug}`, reason: refusal.reason, keys: refusal.keys, next: refusal.next };
}

export type VisibilityClass = 'facts' | 'events' | 'aliases' | 'lineage' | 'pages';
/** Plan order: what a remote caller can read first; only `lineage` reads concept-provenance links. */
export const VISIBILITY_CLASSES: readonly VisibilityClass[] = ['facts', 'events', 'aliases', 'lineage'];
/** Items one preview lists and one `--apply --expect` applies (`--limit` sets it, up to VISIBILITY_WINDOW_MAX). */
export const VISIBILITY_WINDOW = 1000;
export const VISIBILITY_WINDOW_MAX = 10_000;
const CLASS_OF_PHASE: Record<number, VisibilityClass> = { 0: 'lineage', 1: 'lineage', 2: 'events', 3: 'aliases', 4: 'facts', 5: 'pages' };

/** One planned change; `target` is the page (phases 0-3, 5) or fact (phase 4) it changes. */
interface VisibilityItem extends RepairItem { target: RepairCursor; hash?: string; last?: boolean }
interface ApprovedVisibility { target: RepairCursor; source_id: string; slug: string; chars: number; action: string; change: { from: string | null; to: string }; selection: Selection }
/** `slugs` (GST-2468): the pages an operator named with --slug, the whole selection when present. */
interface Selection { source_ids: string[]; class: VisibilityClass | null; slugs?: string[] }

const visibilityPreviewCommand = (scope: RepairScope, selection: Selection, sourceFlag?: boolean) =>
  `gbrain repair visibility${sourceFlag && scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}${selection.class ? ` --class ${selection.class}` : ''}${(selection.slugs ?? []).map(slug => ` --slug ${slug}`).join('')}`;

function selectedClass(opts?: RepairPlanOptions): VisibilityClass | null {
  const value = opts?.driftClass;
  if (value === undefined) return null;
  if ((VISIBILITY_CLASSES as readonly string[]).includes(value)) return value as VisibilityClass;
  throw opError('invalid_params', `--class for gbrain repair visibility takes ${VISIBILITY_CLASSES.join(', ')} (got "${value}").`,
    'Preview every class with gbrain repair visibility, or one with e.g. gbrain repair visibility --class facts.');
}

const isStatementTimeout = (error: unknown) => (error as { code?: string } | null)?.code === '57014';

/** Every planned change of one class, as items in their stable (phase, id) cursor order. */
async function planClass(engine: BrainEngine, sourceIds: string[], cls: VisibilityClass, slugs?: string[]): Promise<{ items: VisibilityItem[]; residuals: Record<string, number> }> {
  const toItems = (part: { changes: VisibilityChange[]; rows: DerivedRow[] }) => {
    const chars = new Map(part.rows.map(row => [Number(row.id), Number(row.chars)]));
    return part.changes.map(change => ({ cursor: { phase: change.phase, id: change.id }, target: { phase: change.phase, id: change.id }, source_id: change.source_id,
      slug: change.slug, chars: chars.get(change.id) ?? 0, action: change.from === change.to ? `visibility ${change.to} kept, label guard raised` : `visibility ${change.from ?? '(none)'} -> ${change.to}`, change: { from: change.from, to: change.to } }))
      .sort((a, b) => a.cursor.phase - b.cursor.phase || a.cursor.id - b.cursor.id);
  };
  if (cls === 'facts') {
    const facts = await worldFactsFromPrivateSources(engine, sourceIds);
    const items = facts.map(fact => ({ cursor: { phase: 4, id: Number(fact.id) }, target: { phase: 4, id: Number(fact.id) }, source_id: fact.source_id,
      slug: fact.source_markdown_slug ?? fact.entity_slug ?? 'memory/unattributed', chars: 0, readable: fact.readable,
      action: `fact ${fact.id} visibility world -> private${fact.readable ? ' (remotely readable now)' : ''}`, change: { from: 'world', to: 'private' } }));
    return { items, residuals: { world_facts_remotely_readable: facts.filter(fact => fact.readable).length } };
  }
  const part = cls === 'pages' ? await planNamed(engine, sourceIds, slugs ?? []) : cls === 'events' ? await planEvents(engine, sourceIds) : cls === 'aliases' ? await planAliases(engine, sourceIds) : await planLineage(engine, sourceIds);
  return { items: toItems(part), residuals: part.residuals };
}

export const visibilityRepair: RepairHandler = {
  kind: 'visibility',
  /** A --readers apply lists every page's outcome (--json outcome_items). */
  outcomeItemsLimit: VISIBILITY_WINDOW_MAX,
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null, opts?: RepairPlanOptions): Promise<RepairPlan> {
    if (opts?.readers) return planReaders(engine, scope, after, { ...opts, readers: opts.readers });
    const named = [...new Set(opts?.slugs ?? [])].sort();
    if (named.length && opts?.driftClass !== undefined) throw opError('invalid_params', 'gbrain repair visibility takes --slug or --class, not both.',
      'Name pages with --slug to make exactly them private, or preview a class with --class.');
    const selection: Selection = { source_ids: scope.source_ids, class: selectedClass(opts), ...(named.length ? { slugs: named } : {}) };
    const classes: readonly VisibilityClass[] = named.length ? ['pages'] : selection.class ? [selection.class] : VISIBILITY_CLASSES;
    const command = visibilityPreviewCommand(scope, selection, true);
    if (named.length && opts?.apply && !opts.expect) throw opError('invalid_params', 'gbrain repair visibility --slug applies only the set a preview printed.',
      `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`);
    if (opts?.apply && opts.expect) {
      const approved = await loadApprovedSet<ApprovedVisibility>(engine, { command: 'visibility', hash: opts.expect, previewCommand: command,
        emptyHash: async () => previewHash(hashParts(scope, selection, [])) });
      if (approved.items.some(entry => (entry.selection.class ?? null) !== selection.class || JSON.stringify(entry.selection.source_ids) !== JSON.stringify(selection.source_ids)
        || JSON.stringify(entry.selection.slugs ?? []) !== JSON.stringify(named))) {
        throw previewChangedError(opts.expect, command);
      }
      const items: VisibilityItem[] = approved.items.map(({ selection: _selection, ...entry }, index) => ({ ...entry, cursor: { phase: 0, id: index },
        hash: opts.expect, last: index === approved.items.length - 1 }));
      return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
    }
    if (opts?.apply) {
      // A bare --apply (--all, the remediation plan) applies every planned change in (phase, id) order, resumable by that cursor.
      const planned = await Promise.all(classes.map(cls => planClass(engine, scope.source_ids, cls, named)));
      return { items: planned.flatMap(part => part.items).sort((a, b) => a.cursor.phase - b.cursor.phase || a.cursor.id - b.cursor.id)
        .filter(item => afterCursor(item.cursor, after)), residuals: Object.assign({}, ...planned.map(part => part.residuals)) };
    }
    const size = Math.min(Math.max(1, opts?.limit ?? VISIBILITY_WINDOW), VISIBILITY_WINDOW_MAX);
    const progress = opts?.remote === false ? createProgress(cliOptsToProgressOptions(getCliOptions())) : null;
    progress?.start('repair.visibility.plan', classes.length);
    const window: VisibilityItem[] = [];
    const residuals: Record<string, number> = {};
    const pending: Partial<Record<VisibilityClass, number>> = {};
    const notRead: VisibilityClass[] = [];
    const timedOut: VisibilityClass[] = [];
    let pendingPastWindow = 0;
    for (const cls of classes) {
      if (window.length >= size) { notRead.push(cls); progress?.heartbeat(`${cls}: not read (window full)`); progress?.tick(1); continue; }
      const started = Date.now();
      progress?.heartbeat(`reading ${cls}`);
      const stopHeartbeat = progress ? startHeartbeat(progress, `still reading ${cls}`, 10_000) : () => {};
      let planned: Awaited<ReturnType<typeof planClass>>;
      try { planned = await planClass(engine, scope.source_ids, cls, named); } catch (error) {
        if (!isStatementTimeout(error)) throw error;
        timedOut.push(cls); progress?.heartbeat(`${cls}: over the ${PLAN_STATEMENT_MS} ms statement bound, skipped`); progress?.tick(1); continue;
      } finally { stopHeartbeat(); }
      const ordered = cls === 'facts' ? [...planned.items.filter(item => (item as { readable?: boolean }).readable), ...planned.items.filter(item => !(item as { readable?: boolean }).readable)] : planned.items;
      const taken = ordered.slice(0, size - window.length);
      window.push(...taken);
      pendingPastWindow += ordered.length - taken.length;
      pending[cls] = ordered.length;
      Object.assign(residuals, planned.residuals);
      progress?.heartbeat(`${cls}: ${ordered.length} to repair${cls === 'facts' ? ` (${planned.residuals.world_facts_remotely_readable} remotely readable)` : ''} in ${Date.now() - started} ms`);
      progress?.tick(1);
    }
    // GST-2603: each page item is checked against its file as its write would be; one the write would refuse is held.
    progress?.heartbeat(`checking ${window.length} item(s) against their files`);
    const held: HeldVisibility[] = [];
    const items: VisibilityItem[] = [];
    for (const { readable: _readable, ...item } of window as Array<VisibilityItem & { readable?: boolean }>) {
      const hold = await heldPage(engine, item as VisibilityItem);
      if (hold) held.push(hold); else items.push(item as VisibilityItem);
    }
    progress?.finish();
    if (held.length) Object.assign(residuals, { held_file_drift: held.filter(hold => hold.reason === 'file_database_drift').length, held_label_edit: held.filter(hold => hold.reason === 'label_edit_refused').length });
    const hash = previewHash(hashParts(scope, selection, items));
    const owner = await ownerMemberId(engine);
    const twins = await openTwins(engine, items.filter(item => item.target.phase !== 4 && item.change?.to === 'private'), owner ? [owner] : [],
      (source, slugs) => `gbrain repair visibility --source ${source}${slugs.map(slug => ` --slug ${slug}`).join('')}`);
    if (twins.count) residuals.open_twins = twins.count;
    if (items.length) await saveApprovedSet<ApprovedVisibility>(engine, { command: 'visibility', hash },
      items.map(item => ({ target: item.target, source_id: item.source_id, slug: item.slug, chars: item.chars, action: item.action, change: item.change!, selection })));
    const next = visibilityPreviewCommand(scope, selection, true);
    const warnings = [
      ...(pendingPastWindow || notRead.length ? [`This preview lists one window of ${items.length} item(s)${pendingPastWindow ? `; ${pendingPastWindow} more found past it` : ''}${notRead.length ? `; not read: ${notRead.join(', ')}` : ''}. `
        + `Apply this window (or decide not to), then preview again for the next one: ${next}`] : []),
      ...timedOut.map(cls => `Class ${cls} did not finish within the ${PLAN_STATEMENT_MS} ms statement bound and is not listed; the other classes are. `
        + `Preview the others with --class, or run gbrain doctor --only derived_visibility for the counts.`),
      ...openTwinsWarning(twins),
      ...(held.length ? [`${held.length} page(s) are held and not in this preview's set: their files would refuse the label write now. details.held names what differs for each and the step that clears it; preview again after it.`] : []),
    ];
    return { warnings, items: items.map((item, index) => ({ ...item, cursor: { phase: 0, id: index } })), preview_hash: hash,
      residuals,
      listing: items.map(item => ({ item: `${item.source_id}:${item.slug}`, class: CLASS_OF_PHASE[item.target.phase]!, detail: item.action })),
      details: { window: { size, listed: items.length, pending, pending_past_window: pendingPastWindow, not_read: notRead, timed_out: timedOut, next_preview: next }, ...(held.length ? { held } : {}), ...(twins.count ? { open_twins: twins } : {}) } };
  },
  /** A --readers apply: how its managed writes reached Git (`details.git`, effect states; readers.ts readersGitCounts). */
  async report(ctx, scope, result, opts) {
    return opts.readers && result.mode === 'apply' && opts.expect ? { details: { ...result.details, git: await readersGitCounts(ctx.engine, scope, opts.expect) } } : {};
  },
  render(details) {
    const git = details.git as Record<string, number> | undefined;
    const held = (details.held as HeldVisibility[] | undefined) ?? [];
    return [...(git ? [`  git: ${Object.entries(git).map(([key, value]) => `${key}=${value}`).join(', ')} (file(s) by Git effect state; queued files commit together, up to 100 per commit)`] : []),
      ...openTwinsLines(details.open_twins as OpenTwins | undefined),
      ...held.map(hold => `  held ${hold.item} (${hold.reason}${hold.keys.length ? `: ${hold.keys.join(', ')}` : ''}); next: ${hold.next}`)];
  },
  /**
   * GST-2476: a run of readers items of one managed source at once. Each page is re-checked as apply does; the pages are
   * admitted together under the run's maintenance batch (publishMaintenancePages; Postgres publishes them in groups of up to
   * 8), so the Git effect commits their ready files together (up to 100 per commit), each page its own fate. Other classes, a source
   * without managed persistence, and a run of one apply item by item (no settlement leaves an item to apply).
   */
  async applyBatch(ctx, entries) {
    const items = entries as ReadersItem[];
    const sourceId = items[0]?.source_id;
    const end = items.findIndex(item => (item.target ?? item.cursor).phase !== READERS_PHASE || item.source_id !== sourceId || !item.hash);
    const run = end < 0 ? items : items.slice(0, end);
    if (run.length < 2) return [];
    const authority = await maintenancePreflight(ctx.engine, sourceId!);
    if (!authority) return [];
    const out: RepairSettlement[] = [];
    const pages: Array<{ index: number; item: ReadersItem; ready: ReadersWrite; requestId: string }> = [];
    try {
      for (const [index, item] of run.entries()) {
        if (readersGuardOnly(item)) { out[index] = await raiseReadersGuard(ctx.engine, item).then(value => ({ value }), (error: unknown) => ({ error })); continue; }
        const ready = await readersWrite(ctx.engine, item).catch((error: unknown) => ({ error }));
        if (ready !== false && 'snapshot' in ready) pages.push({ index, item, ready, requestId: await repairRequestId(ctx, 'visibility', { ...item, cursor: item.target }, ready.snapshot.revision) });
        else out[index] = ready !== false && 'error' in ready ? { error: ready.error } : { value: ready };
      }
      if (!pages.length) return out;
      const published = await publishMaintenancePages(ctx.engine, authority, pages.map(({ item, ready, requestId }) => ({ slug: item.slug, content: ready.content,
        expectedRevision: ready.snapshot.revision, requestId, keepTrust: true as const, labelEdit: ready.edit })), { batch: readersBatch(run[0]!.hash!, sourceId!) });
      pages.forEach(({ index, item }, position) => {
        const settled = published[position]!;
        if (!('error' in settled)) { out[index] = { value: readersOutcome(item) }; return; }
        try { out[index] = { value: missingFileHeld(item, settled.error) }; } catch (error) { out[index] = { error }; }
      });
      return out;
    } finally {
      await retireReaders(ctx.engine, run);
    }
  },
  async apply(ctx, entry) {
    const item = entry as VisibilityItem;
    const target = item.target ?? item.cursor;
    if (target.phase === READERS_PHASE) return applyReaders(ctx.engine, item as ReadersItem, (snapshot, content, edit, batch) => labelWrite(ctx, { ...item, cursor: target }, snapshot, content, edit, batch));
    return retireAfterLastItem(ctx.engine, 'visibility', item.hash, !!item.last, async () => {
      if (target.phase === 4) return await applyFactItem(ctx, item, target.id);
      const snapshot = await ctx.engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
      if (!snapshot || !item.change || Number(snapshot.page.id) !== target.id) return false;
      // Re-decide against current origins and inputs (a named page: its current visibility); a changed decision waits for the next run.
      const fresh = (target.phase === 5 ? await planNamed(ctx.engine, [item.source_id], [item.slug]) : await planVisibilityRepair(ctx.engine, [item.source_id], target.id))
        .changes.find(c => c.id === target.id);
      if (!fresh || fresh.from !== item.change.from || fresh.to !== item.change.to) return false;
      if (item.change.from === item.change.to) return await raiseGuardOnly(ctx.engine, { ...item, target }, frontmatter => frontmatter.visibility === item.change!.to);
      const write = visibilityWrite(snapshot, item.change.to);
      return await labelWrite(ctx, item, snapshot, write.content, write.edit) ?? true;
    });
  },
};

const hashParts = (scope: RepairScope, selection: Selection, items: VisibilityItem[]) => ({ kind: 'visibility-v2', brain_id: scope.brain_id, selection,
  items: items.map(item => ({ target: item.target, source_id: item.source_id, slug: item.slug, change: item.change })) });

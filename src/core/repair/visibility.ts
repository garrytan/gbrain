/**
 * `gbrain repair visibility` (#5525): tighten-only backfill that stamps an
 * explicit `visibility` on extracted atoms and synthesized concepts.
 *
 *   atom     origin page -> effectiveVisibility(origin); transcript or missing origin -> private
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
 * recoverable lineage is left unchanged and counted. Atoms are applied before
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
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { derivationPrivateSql, effectiveVisibility, folderRestrictedSql, privacyAliasSql, privateSnapshotFilterFragment, strictestVisibility, type Visibility } from '../search/private-visibility.ts';
import { strikeFenceRow } from '../facts/forget.ts';
import { opError } from '../ops/contract.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import { digest } from '../persistence/digest.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairPlan, type RepairPlanOptions, type RepairScope, type RepairCursor } from './core.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { createProgress, startHeartbeat } from '../progress.ts';
import { cliOptsToProgressOptions, getCliOptions } from '../cli-options.ts';

interface DerivedRow { id: number; source_id: string; slug: string; type: string; visibility: string | null; chars: number }
interface AtomRow extends DerivedRow { source_slug: string | null; origin_id: number | null; origin_type: string | null; origin_frontmatter: Record<string, unknown> | null; origin_folder_restricted: boolean }
interface InputRow { concept_id: number; atom_id: number; linked: boolean }

interface EventRow extends DerivedRow { origin_id: number | null; origin_type: string | null; origin_frontmatter: Record<string, unknown> | null; origin_folder_restricted: boolean }

export interface VisibilityChange { id: number; source_id: string; slug: string; phase: 0 | 1 | 2 | 3; from: string | null; to: Visibility }

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
      (o.id IS NOT NULL AND ${folderRestrictedSql('o')}) AS origin_folder_restricted
    FROM pages a LEFT JOIN pages o ON o.source_id=a.source_id AND o.slug=a.frontmatter->>'source_slug' AND o.deleted_at IS NULL
    WHERE a.type='atom' AND a.deleted_at IS NULL AND a.source_id=ANY($1::text[])
      AND ($2::integer[] IS NULL OR a.id=ANY($2::integer[])) ORDER BY a.id`, [sourceIds, atomIds], bounded);

  const changes: VisibilityChange[] = [];
  const atomVisibility = new Map<number, Visibility>();
  let originGone = 0;
  for (const atom of atoms) {
    const origin = atom.source_slug ? { kind: 'page' as const, page: atom.origin_id == null ? null : { type: atom.origin_type, frontmatter: atom.origin_frontmatter, folder_restricted: atom.origin_folder_restricted } }
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
    const rows = inputsByConcept.get(Number(concept.id)) ?? [];
    if (!rows.length) { noLineage++; continue; }
    const members = rows.map(row => row.linked ? atomVisibility.get(Number(row.atom_id)) ?? 'private' : 'private');
    const next = tightened(concept.visibility, strictestVisibility(members));
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
 * revision-bound put_page (the projection then stores it private); a
 * database-only row is updated in place (a database-only maintenance request
 * on a managed brain). A page stored in segments is left for the owner.
 */
async function applyFactItem(ctx: Parameters<RepairHandler['apply']>[0], item: RepairItem, factId: number): Promise<boolean> {
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
  if (!snapshot || isSegmentedPage(snapshot.page)) return false;
  const body = strikeFenceRow(snapshot.page.compiled_truth ?? '', fact.row_num, row => ({ ...row, visibility: 'private' }));
  if (body === null) return false;
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: snapshot.page.slug, source_id: item.source_id,
    content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags), expected_revision: snapshot.revision,
    request_id: await repairRequestId(ctx, 'visibility', item, snapshot.revision) } });
  const [stored] = await ctx.engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id=$1', [factId]);
  return stored?.visibility === 'private';
}

export type VisibilityClass = 'facts' | 'events' | 'aliases' | 'lineage';
/** Plan order: what a remote caller can read first; only `lineage` reads concept-provenance links. */
export const VISIBILITY_CLASSES: readonly VisibilityClass[] = ['facts', 'events', 'aliases', 'lineage'];
/** Items one preview lists and one `--apply --expect` applies (`--limit` sets it, up to VISIBILITY_WINDOW_MAX). */
export const VISIBILITY_WINDOW = 1000;
export const VISIBILITY_WINDOW_MAX = 10_000;
const CLASS_OF_PHASE: Record<number, VisibilityClass> = { 0: 'lineage', 1: 'lineage', 2: 'events', 3: 'aliases', 4: 'facts' };

/** One planned change; `target` is the page (phases 0-3) or fact (phase 4) it changes. */
interface VisibilityItem extends RepairItem { target: RepairCursor; hash?: string; last?: boolean }
interface ApprovedVisibility { target: RepairCursor; source_id: string; slug: string; chars: number; action: string; change: { from: string | null; to: string }; selection: Selection }
interface Selection { source_ids: string[]; class: VisibilityClass | null }

const visibilityPreviewCommand = (scope: RepairScope, selection: Selection, sourceFlag?: boolean) =>
  `gbrain repair visibility${sourceFlag && scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}${selection.class ? ` --class ${selection.class}` : ''}`;

function selectedClass(opts?: RepairPlanOptions): VisibilityClass | null {
  const value = opts?.driftClass;
  if (value === undefined) return null;
  if ((VISIBILITY_CLASSES as readonly string[]).includes(value)) return value as VisibilityClass;
  throw opError('invalid_params', `--class for gbrain repair visibility takes ${VISIBILITY_CLASSES.join(', ')} (got "${value}").`,
    'Preview every class with gbrain repair visibility, or one with e.g. gbrain repair visibility --class facts.');
}

const isStatementTimeout = (error: unknown) => (error as { code?: string } | null)?.code === '57014';

/** Every planned change of one class, as items in their stable (phase, id) cursor order. */
async function planClass(engine: BrainEngine, sourceIds: string[], cls: VisibilityClass): Promise<{ items: VisibilityItem[]; residuals: Record<string, number> }> {
  const toItems = (part: { changes: VisibilityChange[]; rows: DerivedRow[] }) => {
    const chars = new Map(part.rows.map(row => [Number(row.id), Number(row.chars)]));
    return part.changes.map(change => ({ cursor: { phase: change.phase, id: change.id }, target: { phase: change.phase, id: change.id }, source_id: change.source_id,
      slug: change.slug, chars: chars.get(change.id) ?? 0, action: `visibility ${change.from ?? '(none)'} -> ${change.to}`, change: { from: change.from, to: change.to } }))
      .sort((a, b) => a.cursor.phase - b.cursor.phase || a.cursor.id - b.cursor.id);
  };
  if (cls === 'facts') {
    const facts = await worldFactsFromPrivateSources(engine, sourceIds);
    const items = facts.map(fact => ({ cursor: { phase: 4, id: Number(fact.id) }, target: { phase: 4, id: Number(fact.id) }, source_id: fact.source_id,
      slug: fact.source_markdown_slug ?? fact.entity_slug ?? 'memory/unattributed', chars: 0, readable: fact.readable,
      action: `fact ${fact.id} visibility world -> private${fact.readable ? ' (remotely readable now)' : ''}`, change: { from: 'world', to: 'private' } }));
    return { items, residuals: { world_facts_remotely_readable: facts.filter(fact => fact.readable).length } };
  }
  const part = cls === 'events' ? await planEvents(engine, sourceIds) : cls === 'aliases' ? await planAliases(engine, sourceIds) : await planLineage(engine, sourceIds);
  return { items: toItems(part), residuals: part.residuals };
}

export const visibilityRepair: RepairHandler = {
  kind: 'visibility',
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null, opts?: RepairPlanOptions): Promise<RepairPlan> {
    const selection: Selection = { source_ids: scope.source_ids, class: selectedClass(opts) };
    const classes = selection.class ? [selection.class] : VISIBILITY_CLASSES;
    const command = visibilityPreviewCommand(scope, selection, true);
    if (opts?.apply && opts.expect) {
      const approved = await loadApprovedSet<ApprovedVisibility>(engine, { command: 'visibility', hash: opts.expect, previewCommand: command,
        emptyHash: async () => previewHash(hashParts(scope, selection, [])) });
      if (approved.items.some(entry => (entry.selection.class ?? null) !== selection.class || JSON.stringify(entry.selection.source_ids) !== JSON.stringify(selection.source_ids))) {
        throw previewChangedError(opts.expect, command);
      }
      const items: VisibilityItem[] = approved.items.map(({ selection: _selection, ...entry }, index) => ({ ...entry, cursor: { phase: 0, id: index },
        hash: opts.expect, last: index === approved.items.length - 1 }));
      return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
    }
    if (opts?.apply) {
      // A bare --apply (--all, the remediation plan) applies every planned change in (phase, id) order, resumable by that cursor.
      const planned = await Promise.all(classes.map(cls => planClass(engine, scope.source_ids, cls)));
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
      try { planned = await planClass(engine, scope.source_ids, cls); } catch (error) {
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
    progress?.finish();
    const items = window.map(({ readable: _readable, ...item }: VisibilityItem & { readable?: boolean }) => item as VisibilityItem);
    const hash = previewHash(hashParts(scope, selection, items));
    if (items.length) await saveApprovedSet<ApprovedVisibility>(engine, { command: 'visibility', hash },
      items.map(item => ({ target: item.target, source_id: item.source_id, slug: item.slug, chars: item.chars, action: item.action, change: item.change!, selection })));
    const next = visibilityPreviewCommand(scope, selection, true);
    const warnings = [
      ...(pendingPastWindow || notRead.length ? [`This preview lists one window of ${items.length} item(s)${pendingPastWindow ? `; ${pendingPastWindow} more found past it` : ''}${notRead.length ? `; not read: ${notRead.join(', ')}` : ''}. `
        + `Apply this window (or decide not to), then preview again for the next one: ${next}`] : []),
      ...timedOut.map(cls => `Class ${cls} did not finish within the ${PLAN_STATEMENT_MS} ms statement bound and is not listed; the other classes are. `
        + `Preview the others with --class, or run gbrain doctor --only derived_visibility for the counts.`),
    ];
    return { warnings, items: items.map((item, index) => ({ ...item, cursor: { phase: 0, id: index } })), preview_hash: hash,
      residuals,
      listing: items.map(item => ({ item: `${item.source_id}:${item.slug}`, class: CLASS_OF_PHASE[item.target.phase]!, detail: item.action })),
      details: { window: { size, listed: items.length, pending, pending_past_window: pendingPastWindow, not_read: notRead, timed_out: timedOut, next_preview: next } } };
  },
  async apply(ctx, entry) {
    const item = entry as VisibilityItem;
    const target = item.target ?? item.cursor;
    try {
      if (target.phase === 4) return await applyFactItem(ctx, item, target.id);
      const snapshot = await ctx.engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
      if (!snapshot || !item.change || Number(snapshot.page.id) !== target.id) return false;
      // Re-decide against current origins and inputs; a changed decision waits for the next run.
      const fresh = (await planVisibilityRepair(ctx.engine, [item.source_id], target.id)).changes.find(c => c.id === target.id);
      if (!fresh || fresh.from !== item.change.from || fresh.to !== item.change.to) return false;
      const page = { ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, visibility: item.change.to } };
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: item.slug, source_id: item.source_id,
        content: serializePageToMarkdown(page, snapshot.tags), expected_revision: snapshot.revision,
        request_id: await repairRequestId(ctx, 'visibility', item, snapshot.revision) } });
      return true;
    } finally {
      if (item.last && item.hash) await clearApprovedSet(ctx.engine, { command: 'visibility', hash: item.hash });
    }
  },
};

const hashParts = (scope: RepairScope, selection: Selection, items: VisibilityItem[]) => ({ kind: 'visibility-v2', brain_id: scope.brain_id, selection,
  items: items.map(item => ({ target: item.target, source_id: item.source_id, slug: item.slug, change: item.change })) });

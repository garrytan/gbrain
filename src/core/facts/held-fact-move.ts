/**
 * GST-2492: on a strict git-canonical source, a fact for an entity that has no page is held as a row of a holding page
 * whose `entity` cell names the entity (memory-mutations.ts planRememberTarget, and every other fact writer through
 * `holdingHome`), so Git has it before the database does: the shared memory/unattributed, or, for an entity under a folder
 * access rule, the holding page of the entity's own folder (`<folder>/memory/unattributed`, which every prefix rule
 * covering the entity covers too). Once the entity has a page, the extract_facts phase moves the held rows there: one
 * maintenance publication per entity appends them to the entity page's Facts fence and strikes their holding rows, and
 * the facts rows move in place (ids, embeddings and provenance kept; the belief ledger transfers their stream). A held row
 * on the shared page whose entity a folder rule now covers is moved to its folder's holding page the same way (the rule's
 * own apply step runs this, so a narrowing reaches held rows at once). A row that cannot move stays held, active and
 * searchable, and is reported as `held_fact_unmovable`.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { folderHoldingSlug, holdingSlugSql, isHoldingSlug, UNATTRIBUTED_MEMORY_SLUG } from '../facts-fence.ts';
import { maintenancePreflight, planHeldRowDrop, submitMaintenanceIntent, submitPlannedFactFenceAdoption, type HeldDrop } from '../persistence/prepared-maintenance.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { assertStrictGitHome } from '../persistence/git-declared.ts';
import { isStatementTimeout, PreparationDeadlineError } from '../persistence/bounded-reads.ts';
import { transientDatabaseFailure, transientInterruption } from '../persistence/transient-retry.ts';
import { registerEngineView } from '../persistence/switches.ts';
import { syncPreparationBudgetMs } from '../persistence/sync-waivers.ts';
import { requestConfigValue } from '../config-snapshot.ts';
import { isFenceHold, pageHasFile, planManagedPage, type UnfencedFactRow } from './unfenced-facts.ts';

export interface HeldFactMoveOutcome {
  moved: number;
  moved_slugs: string[];
  /** Held rows moved from memory/unattributed to the holding page of their entity's folder, now under a folder rule. */
  rehomed: number;
  /** Held rows that stay on their holding page this run, with the reason (the entity page's fence, a duplicate claim, a refusal). */
  unmovable: Array<{ code: 'held_fact_unmovable'; slug: string; fact_ids: number[]; reason: string }>;
  /** #8568: entities whose move threw (I/O, database), as opposed to holds the next run settles. */
  write_errors: number;
  /** GST-2492 (B): saved versions of a holding page stored in segments, which the move could not edit (the most any one move counted). */
  segmented_versions_not_edited: number;
  /** The same, per holding page the rows left. */
  segmented_pages: Array<{ slug: string; versions: number }>;
  /** Moves accepted and still pending when the write wait ended: not moved yet, named by their request. */
  pending: Array<{ slug: string; from: string; request_id: string }>;
}

/**
 * Where a fact for `entity` (null: no entity) that has no page of its own is held on this source. Null when it is not
 * held: the source is not strict, write-through is off, or the entity's page is soft-deleted (it may be private, and its
 * purge would not reach a holding row). Otherwise the shared memory/unattributed, or, when a folder rule or pending folder
 * coverage covers the entity, its folder's holding page. An exact page rule on the entity's own slug, and an access state
 * this database role cannot read, are refused: no holding page carries their readers.
 */
export async function holdingHome(engine: BrainEngine, sourceId: string, entity: string | null):
  Promise<{ slug: string } | { refused: 'page_rule' | 'access_unreadable' } | null> {
  if ((await getWorktreeBinding(engine, sourceId))?.canonical_git !== true) return null;
  if (/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true')) return null;
  if (entity !== null && entity !== UNATTRIBUTED_MEMORY_SLUG
    && (await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL', [sourceId, entity])).length) return null;
  return holdingPageFor(engine, sourceId, entity);
}

/** The holding page holdingHome classifies `entity` to by its access rules alone, whether or not a writer holds rows now. */
export async function holdingPageFor(engine: BrainEngine, sourceId: string, entity: string | null):
  Promise<{ slug: string } | { refused: 'page_rule' | 'access_unreadable' }> {
  if (entity === null || entity === UNATTRIBUTED_MEMORY_SLUG) return { slug: UNATTRIBUTED_MEMORY_SLUG };
  const access = await engine.executeRaw<{ unreadable: boolean; page_rule: boolean; restricted: boolean }>(
    `SELECT gbrain_access_state_unreadable() AS unreadable,
       (EXISTS (SELECT 1 FROM access_rules r WHERE r.source_id=$1 AND r.prefix=$2)
         OR EXISTS (SELECT 1 FROM access_pending_coverage c WHERE c.source_id=$1 AND c.prefix=$2)) AS page_rule,
       (gbrain_access_folder_rules($1, $2) IS NOT NULL OR gbrain_access_pending_covers($1, $2)) AS restricted`, [sourceId, entity]).catch((error: unknown) => {
    // GST-2667: an error the persistence consumer prepares again (a cancel, a stale plan, contention, a lost connection) is rethrown, never a refusal.
    if (error instanceof PreparationDeadlineError || transientDatabaseFailure(error) || transientInterruption(error)) throw error;
    return null;
  });
  const row = access?.[0];
  if (!row || row.unreadable) return { refused: 'access_unreadable' };
  if (row.page_rule) return { refused: 'page_rule' };
  return { slug: row.restricted ? folderHoldingSlug(entity) : UNATTRIBUTED_MEMORY_SLUG };
}

/**
 * The page a held row keyed `key` moves to: the page at that slug, else, for a key with no folder (remember keys a new
 * name that way), the one page `remember` itself would resolve the name to. Two or more such pages: the row stays held and
 * the candidates are named. Null: no page yet.
 */
export async function heldFactTarget(engine: BrainEngine, sourceId: string, key: string): Promise<{ slug: string } | { ambiguous: string[] } | null> {
  if ((await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, key])).length) return { slug: key };
  if (key.includes('/')) return null;
  const { entityReferenceCandidates, resolveStrictEntityReference } = await import('../entities/resolve.ts');
  const strict = await resolveStrictEntityReference(engine, sourceId, key, { sameName: true });
  if (strict.slug !== null) return { slug: strict.slug };
  return strict.miss === 'ambiguous' ? { ambiguous: await entityReferenceCandidates(engine, sourceId, key) } : null;
}

/**
 * The refusal of every fact writer for an entity holdingHome refused to hold (remember, and GST-2635 the managed facts
 * writer's attribute fallback), before anything is written: an exact page rule on a strict source refuses
 * `git_home_required` naming the entity's page to create; otherwise the access state cannot be read, so retry.
 */
export async function refuseUnheldFact(engine: BrainEngine, sourceId: string, entity: string, refused: 'page_rule' | 'access_unreadable', remote: boolean): Promise<never> {
  if (refused === 'page_rule') await assertStrictGitHome(engine, { source_id: sourceId, slug: entity }, remote);
  throw accessStateUnreadable(sourceId, entity);
}

/** holdingHome's `access_unreadable`: the folder rules covering the entity cannot be read now, so nothing was written; retry. */
function accessStateUnreadable(sourceId: string, entity: string): OperationError {
  return opError('access_policy_pending', `The folder access rules of source ${sourceId} that cover ${entity} cannot be read right now, so gbrain cannot tell which holding page keeps this fact to its entity's readers; nothing was written.`,
    'Retry the same request shortly; if it keeps failing, the brain host checks the folder access tables (gbrain doctor names the check).',
    { docs: 'docs/guides/write-refusals.md#access_policy_pending', fix: { argv: ['gbrain', 'access', 'rule', 'status', '--source', sourceId, '--json'], consent: [], actor: 'provider',
      requires_exclusive: false, why: 'Shows the folder rules and anything pending; changes nothing. The write succeeds once the rules read again.' } });
}

export const ambiguousHeldReason = (candidates: string[]) => `entity_ambiguous: candidates ${candidates.join(', ')}`;

/**
 * Creates `slug` through the write door when it has no page yet: maintenance publishes only to a page that exists. A
 * holding page is the empty note the first held fact creates (titled Unattributed memory); an entity page is created for
 * an entity an exact page rule names, whose held rows only its own page can carry.
 */
export async function ensurePageForHeldRows(engine: BrainEngine, sourceId: string, slug: string, ctx?: OperationContext): Promise<void> {
  if (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true })) return;
  const { submitPageMutation } = await import('../persistence/page-mutations.ts');
  const { repairRequestId } = await import('../repair/core.ts');
  const local = { ...(ctx ?? { engine, config: { engine: engine.kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } }), remote: false, sourceId } as OperationContext;
  const title = isHoldingSlug(slug) ? 'Unattributed memory' : slug.slice(slug.lastIndexOf('/') + 1);
  await submitPageMutation(local, { operation: 'put_page', params: { slug,
    request_id: await repairRequestId(local, 'facts-home', { source_id: sourceId, slug }, 'holding-page'),
    content: `---\ntype: note\ntitle: ${JSON.stringify(title)}\n---\n` } });
}

type HeldRow = UnfencedFactRow & { from_slug: string };
export type HoldingHome = Awaited<ReturnType<typeof holdingHome>>;

/**
 * GST-2492 (C4): where moveHeldFacts puts the held rows keyed `key` on holding page `from`, the one resolution the rule
 * preview and the move share: the page the key resolves to (a bare name moves to the page it names), else the page an
 * exact page rule names (created for the rows), else, off the shared page, the holding page `home` gives (the rules in
 * force; a preview passes its desired rules). Null: the rows stay where they are.
 */
export async function heldRowDestination(engine: BrainEngine, sourceId: string, key: string, from: string,
  home: (key: string) => Promise<HoldingHome> = k => holdingHome(engine, sourceId, k)):
  Promise<{ slug: string; kind: 'page' | 'create' | 'rehome' } | { unmovable: string } | null> {
  const target = await heldFactTarget(engine, sourceId, key);
  if (target && 'ambiguous' in target) return { unmovable: ambiguousHeldReason(target.ambiguous) };
  if (target) return { slug: target.slug, kind: 'page' };
  const h = await home(key);
  if (h && 'refused' in h) return h.refused === 'access_unreadable' ? { unmovable: 'access_unreadable' } : { slug: key, kind: 'create' };
  return h && h.slug !== from && from === UNATTRIBUTED_MEMORY_SLUG ? { slug: h.slug, kind: 'rehome' } : null;
}

/** One entity's held rows on one holding page, and where the move takes them (`drop`: only struck rows, removed in place). */
export interface HeldMoveGroup {
  slug: string; kind: 'page' | 'create' | 'rehome' | 'drop'; from: string; key: string; group: HeldRow[];
  /** The holding row's note: `moved` removes the rows from the holding page and its saved versions. */
  note: string;
  /** Struck rows of the entity, removed with its live rows when the note is `moved` (empty otherwise). */
  struck: HeldDrop[];
}

/**
 * GST-2492: the held-fact move's plan, read-only, the one enumeration the move and the rule preview share: every held row
 * and every struck held row on every holding page, grouped by page and entity in the order the move runs them. `home`
 * decides a page-less entity's holding page (a preview passes its desired rules); `hidden` names pages the change makes
 * unreadable to some reader (a preview's desired rules), so their note is `moved`.
 */
export async function planHeldMoves(engine: BrainEngine, sourceId: string, opts: { home?: (key: string) => Promise<HoldingHome>; hidden?: (slug: string) => boolean } = {}):
  Promise<{ groups: HeldMoveGroup[]; unmovable: HeldFactMoveOutcome['unmovable'] }> {
  const onHolding = `f.source_id = $1 AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = $1 AND ${holdingSlugSql('hp.slug')})
    AND f.row_num IS NOT NULL AND f.dimension IS NULL AND f.entity_slug IS NOT NULL AND NOT ${holdingSlugSql('f.entity_slug')}`;
  const rows = await engine.executeRaw<HeldRow>(
    `SELECT id, source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to, true AS page_exists, source_markdown_slug AS from_slug
       FROM facts f WHERE ${onHolding} AND f.expired_at IS NULL ORDER BY f.source_markdown_slug, f.entity_slug, f.id`, [sourceId]);
  // A struck row keeps its facts row (expired) at its row number; one an active fact reuses is not struck.
  const struck = await engine.executeRaw<{ from_slug: string; entity_slug: string; row_num: number; fact: string }>(
    `SELECT DISTINCT ON (f.source_markdown_slug, f.row_num) f.source_markdown_slug AS from_slug, f.entity_slug, f.row_num, f.fact FROM facts f
      WHERE ${onHolding} AND f.expired_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM facts a WHERE a.source_id = f.source_id
        AND a.source_markdown_slug = f.source_markdown_slug AND a.row_num = f.row_num AND a.expired_at IS NULL)
      ORDER BY f.source_markdown_slug, f.row_num, f.id DESC`, [sourceId]);
  const keys = new Map<string, { from: string; key: string; group: HeldRow[]; struck: HeldDrop[] }>();
  const at = (from: string, key: string) => keys.get(`${from}\0${key}`) ?? keys.set(`${from}\0${key}`, { from, key, group: [], struck: [] }).get(`${from}\0${key}`)!;
  for (const row of rows) at(row.from_slug, row.entity_slug!).group.push(row);
  for (const s of struck) at(s.from_slug, s.entity_slug).struck.push({ row_num: Number(s.row_num), entity: s.entity_slug, claim: s.fact });
  const plan: Awaited<ReturnType<typeof planHeldMoves>> = { groups: [], unmovable: [] };
  for (const { from, key, group, struck: withdrawn } of keys.values()) {
    const dest = await heldRowDestination(engine, sourceId, key, from, opts.home);
    if (!dest) continue;
    if ('unmovable' in dest) {
      if (group.length) plan.unmovable.push({ code: 'held_fact_unmovable', slug: key, fact_ids: group.map(r => Number(r.id)), reason: dest.unmovable });
      continue;
    }
    // A fact moved into a page not every reader of the source can read, or off a folder's holding page, leaves the
    // holding page with no trace of where it went.
    const [page] = dest.kind === 'page' && from === UNATTRIBUTED_MEMORY_SLUG && !opts.hidden?.(dest.slug) ? await engine.executeRaw<{ visible: boolean }>(
      `SELECT ${privatePagesFilterFragment('p')} AS visible FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`, [sourceId, dest.slug]) : [];
    const note = page?.visible === true ? `moved to ${dest.slug}` : 'moved';
    if (group.length) plan.groups.push({ slug: dest.slug, kind: dest.kind, from, key, group, note, struck: note === 'moved' ? withdrawn : [] });
    else if (note === 'moved') plan.groups.push({ slug: from, kind: 'drop', from, key, group, note, struck: withdrawn });
  }
  return plan;
}

/** The words for what a held-fact move left incomplete: each holding page whose segmented saved versions it could not edit, each move still pending. */
export function heldMoveIncomplete(held: Pick<HeldFactMoveOutcome, 'segmented_pages' | 'pending'>): Array<{ code: 'HELD_VERSIONS_NOT_EDITED' | 'HELD_FACT_PENDING'; text: string }> {
  return [...held.segmented_pages.map(p => ({ code: 'HELD_VERSIONS_NOT_EDITED' as const,
    text: `${p.versions} saved version(s) of ${p.slug} are stored in segments and were not edited; readers of its saved versions can still read the moved rows in up to ${p.versions} of them.` })),
  ...held.pending.map(p => ({ code: 'HELD_FACT_PENDING' as const,
    text: `the move of held facts off ${p.from} to ${p.slug} is accepted and still pending (request ${p.request_id}; gbrain write-request ${p.request_id} shows it), so until it commits they read as they did on ${p.from}.` }))];
}

/**
 * GST-2492 (B2): after a sync releases its lease, the held facts a rule it applied narrows below their holding page's
 * readers (a folder rule over the shared page, an exact page rule over a folder's holding page, or a pending narrowing)
 * leave that page at once instead of at the next maintenance cycle (still the fallback after a crash). Null when none is due:
 * every rule covering a held row's entity also covers its holding page (a rule over the holding page alone narrows nothing).
 * A lock another session holds never keeps the sync past its preparation budget (#6318): the due check and the plan share
 * one deadline (planningView), and the move's own page reads each end at the budget. A plan cut off there rejects, a group
 * cut off in its move stays unmovable, and maintenance moves them later.
 */
export async function moveRuledSharedHeld(engine: BrainEngine, sourceId: string): Promise<HeldFactMoveOutcome | null> {
  const budget = await syncPreparationBudgetMs(engine);
  const planning = planningView(engine, Date.now() + budget);
  const [due] = await planning.executeRaw<{ due: boolean }>(`SELECT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $1
      AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = $1 AND ${holdingSlugSql('hp.slug')})
      AND f.row_num IS NOT NULL AND f.dimension IS NULL AND f.entity_slug IS NOT NULL AND NOT ${holdingSlugSql('f.entity_slug')}
      AND (NOT COALESCE(gbrain_access_folder_rules(f.source_id, f.entity_slug), '{}') <@ COALESCE(gbrain_access_folder_rules(f.source_id, f.source_markdown_slug), '{}')
        OR (gbrain_access_pending_covers(f.source_id, f.entity_slug) AND NOT gbrain_access_pending_covers(f.source_id, f.source_markdown_slug)))) AS due`, [sourceId]);
  return due?.due ? moveHeldFacts(engine, sourceId, { planning, timeoutMs: budget }) : null;
}

/**
 * The engine the sync path plans a held move on: every raw read through it, the bare-name resolver's alias read and
 * holdingHome's config read included, ends on the server at `deadlineAt`, and one ended there rejects as a
 * PreparationDeadlineError. PGLite plans on the engine.
 */
function planningView(engine: BrainEngine, deadlineAt: number): BrainEngine {
  if (engine.kind !== 'postgres') return engine;
  const view: BrainEngine = registerEngineView(new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[], opts?: Parameters<BrainEngine['executeRaw']>[2]) => {
      if (Date.now() >= deadlineAt) throw new PreparationDeadlineError('held_move_plan', null);
      try { return await target.executeRaw(sql, params, { ...opts, timeoutMs: Math.max(1, deadlineAt - Date.now()) }); } catch (error) {
        if (isStatementTimeout(error)) throw new PreparationDeadlineError('held_move_plan', error.code, error);
        throw error;
      }
    };
    const value = Reflect.get(target, key, target);
    // The alias read runs on the engine's own executeRaw: bound to the view, it takes the deadline too.
    if (key === 'resolveAliases') return value.bind(view);
    if (key === 'getConfig') return async (name: string) => {
      const held = await requestConfigValue(target, name);
      if (held !== undefined) return held;
      const [row] = await view.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [name]);
      return row?.value ?? null;
    };
    return typeof value === 'function' ? value.bind(target) : value;
  } }), engine);
  return view;
}

export async function moveHeldFacts(engine: BrainEngine, sourceId: string, bound: { planning?: BrainEngine; timeoutMs?: number } = {}): Promise<HeldFactMoveOutcome> {
  const outcome: HeldFactMoveOutcome = { moved: 0, moved_slugs: [], rehomed: 0, unmovable: [], write_errors: 0, segmented_versions_not_edited: 0, segmented_pages: [], pending: [] };
  const plan = await planHeldMoves(bound.planning ?? engine, sourceId);
  const reads = { timeoutMs: bound.timeoutMs };
  outcome.unmovable.push(...plan.unmovable);
  if (plan.groups.length === 0) return outcome;
  const authority = await maintenancePreflight(engine, sourceId);
  if (!authority) return outcome;
  const unmovable = (slug: string, ids: Array<string | number>, reason: string) => {
    if (ids.length) outcome.unmovable.push({ code: 'held_fact_unmovable', slug, fact_ids: ids.map(Number), reason });
  };
  // A row keyed by a bare name moves to the page that name now resolves to, which re-keys it to that page; a row of an
  // entity with no page whose folder a rule now covers moves to that folder's holding page.
  for (const { slug, kind, from, key, group, note, struck } of plan.groups) {
    let requestId: string | undefined;
    try {
      if (kind === 'drop') {
        const snapshot = await engine.readPageSnapshot(from, { sourceId });
        if (!snapshot) continue;
        const drop = planHeldRowDrop(authority, from, snapshot.revision, struck);
        requestId = drop.requestId;
        await submitMaintenanceIntent(engine, authority, from, drop.intent, drop.requestId);
      } else {
        if (kind === 'create') {
          // An exact page rule on the entity: only its own page carries those readers, so the page is created for its rows.
          try { await ensurePageForHeldRows(engine, sourceId, key); } catch (error) {
            unmovable(key, group.map(r => r.id), (error instanceof Error ? error.message : String(error)).slice(0, 300));
            continue;
          }
        }
        if (kind === 'rehome') await ensurePageForHeldRows(engine, sourceId, slug);
        const [page] = await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>(
          'SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug], reads);
        if (!page) { unmovable(slug, group.map(r => r.id), kind === 'rehome' ? 'holding_page_deleted' : 'entity_page_deleted'); continue; }
        // A held row in Git moved into a page kept out of Git would be struck there with no file holding the fact; a row
        // re-homed because a folder rule now covers it moves whatever the folder's storage class (the rule applies at once).
        const [held] = await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>(
          'SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, from], reads);
        if (kind !== 'rehome' && held && await pageHasFile(engine, sourceId, from, held) && !await pageHasFile(engine, sourceId, slug, page)) {
          unmovable(slug, group.map(r => r.id), 'entity_page_database_only'); continue;
        }
        const plan = await planManagedPage(engine, authority, sourceId, slug, group, { note, ...(kind === 'rehome' || slug === key ? {} : { from_entity: key }),
          ...(from === UNATTRIBUTED_MEMORY_SLUG ? {} : { from_slug: from }), ...(struck.length ? { drop: struck } : {}) });
        if (plan.kind === 'no_page') continue;
        if (plan.kind === 'warnings') { unmovable(slug, group.map(r => r.id), `entity_fence_malformed: ${plan.warnings.join('; ')}`); continue; }
        const rejected = plan.kind === 'unadoptable' ? plan.records : plan.fence.rejected;
        for (const reason of new Set(rejected.map(r => r.class))) unmovable(slug, rejected.filter(r => r.class === reason).map(r => r.fact_id), reason);
        if (plan.kind === 'unadoptable') continue;
        requestId = plan.request.requestId;
        await submitPlannedFactFenceAdoption(engine, authority, slug, plan.request, true);
        if (kind === 'rehome') outcome.rehomed += plan.fence.assignments.length;
        else { outcome.moved += plan.fence.assignments.length; outcome.moved_slugs.push(slug); }
      }
      const [edited] = await engine.executeRaw<{ n: number | null }>(`SELECT (outcome->'held_versions_edited'->>'segmented_versions_not_edited')::int AS n
        FROM persistence_requests WHERE request_id = $1::uuid`, [requestId]);
      const n = Number(edited?.n ?? 0), seen = outcome.segmented_pages.find(p => p.slug === from);
      if (n && seen) seen.versions = Math.max(seen.versions, n);
      else if (n) outcome.segmented_pages.push({ slug: from, versions: n });
      outcome.segmented_versions_not_edited = Math.max(outcome.segmented_versions_not_edited, n);
    } catch (error) {
      // An accepted publication still pending is neither moved nor failed: the receipt names it until it commits.
      if (requestId && error instanceof OperationError && error.code === 'write_pending') { outcome.pending.push({ slug, from, request_id: requestId }); continue; }
      unmovable(slug, group.map(r => r.id), (error instanceof Error ? error.message : String(error)).slice(0, 300));
      if (!isFenceHold(error)) outcome.write_errors += 1;
    }
  }
  return outcome;
}

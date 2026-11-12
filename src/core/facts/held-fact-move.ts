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
import { opError, type OperationContext, type OperationError } from '../ops/contract.ts';
import { folderHoldingSlug, holdingSlugSql, isHoldingSlug, UNATTRIBUTED_MEMORY_SLUG } from '../facts-fence.ts';
import { maintenancePreflight, submitPlannedFactFenceAdoption } from '../persistence/prepared-maintenance.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
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
  if (entity === null || entity === UNATTRIBUTED_MEMORY_SLUG) return { slug: UNATTRIBUTED_MEMORY_SLUG };
  if ((await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL', [sourceId, entity])).length) return null;
  const access = await engine.executeRaw<{ unreadable: boolean; page_rule: boolean; restricted: boolean }>(
    `SELECT gbrain_access_state_unreadable() AS unreadable,
       (EXISTS (SELECT 1 FROM access_rules r WHERE r.source_id=$1 AND r.prefix=$2)
         OR EXISTS (SELECT 1 FROM access_pending_coverage c WHERE c.source_id=$1 AND c.prefix=$2)) AS page_rule,
       (gbrain_access_folder_rules($1, $2) IS NOT NULL OR gbrain_access_pending_covers($1, $2)) AS restricted`, [sourceId, entity]).catch(() => null);
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

/** holdingHome's `access_unreadable`: the folder rules covering the entity cannot be read now, so nothing was written; retry. */
export function accessStateUnreadable(sourceId: string): OperationError {
  return opError('access_policy_pending', `The folder access rules of source ${sourceId} cannot be read right now, so gbrain cannot tell which holding page keeps this fact to its entity's readers; nothing was written.`,
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

export async function moveHeldFacts(engine: BrainEngine, sourceId: string): Promise<HeldFactMoveOutcome> {
  const outcome: HeldFactMoveOutcome = { moved: 0, moved_slugs: [], rehomed: 0, unmovable: [], write_errors: 0 };
  const rows = await engine.executeRaw<HeldRow>(
    `SELECT id, source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to, true AS page_exists, source_markdown_slug AS from_slug
       FROM facts f
      WHERE f.source_id = $1 AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = $1 AND ${holdingSlugSql('hp.slug')}) AND f.row_num IS NOT NULL AND f.expired_at IS NULL AND f.dimension IS NULL
        AND f.entity_slug IS NOT NULL AND NOT ${holdingSlugSql('f.entity_slug')}
      ORDER BY f.source_markdown_slug, f.entity_slug, f.id`, [sourceId]);
  if (rows.length === 0) return outcome;
  const unmovable = (slug: string, ids: Array<string | number>, reason: string) => {
    if (ids.length) outcome.unmovable.push({ code: 'held_fact_unmovable', slug, fact_ids: ids.map(Number), reason });
  };
  const keys = new Map<string, HeldRow[]>();
  for (const row of rows) keys.set(`${row.from_slug}\0${row.entity_slug}`, [...keys.get(`${row.from_slug}\0${row.entity_slug}`) ?? [], row]);
  // A row keyed by a bare name moves to the page that name now resolves to, which re-keys it to that page; a row of an
  // entity with no page whose folder a rule now covers moves to that folder's holding page.
  const groups: Array<{ slug: string; from: string; fromEntity?: string; group: HeldRow[]; rehome: boolean }> = [];
  let authority: Awaited<ReturnType<typeof maintenancePreflight>> | undefined;
  for (const [, group] of keys) {
    const { from_slug: from, entity_slug: key } = group[0]!;
    let target = await heldFactTarget(engine, sourceId, key!);
    const home = target ? null : await holdingHome(engine, sourceId, key!);
    if (home && 'refused' in home && home.refused === 'access_unreadable') { unmovable(key!, group.map(r => r.id), 'access_unreadable'); continue; }
    if (home && 'refused' in home) {
      // An exact page rule on the entity: only its own page carries those readers, so the page is created for its rows.
      authority ??= await maintenancePreflight(engine, sourceId);
      if (!authority) return outcome;
      try { await ensurePageForHeldRows(engine, sourceId, key!); } catch (error) {
        unmovable(key!, group.map(r => r.id), (error instanceof Error ? error.message : String(error)).slice(0, 300));
        continue;
      }
      target = { slug: key! };
    }
    if (target && 'ambiguous' in target) unmovable(key!, group.map(r => r.id), ambiguousHeldReason(target.ambiguous));
    else if (target) groups.push({ slug: target.slug, from, ...(target.slug === key ? {} : { fromEntity: key! }), group, rehome: false });
    else if (home && 'slug' in home && home.slug !== from && from === UNATTRIBUTED_MEMORY_SLUG) groups.push({ slug: home.slug, from, group, rehome: true });
  }
  if (groups.length === 0) return outcome;
  authority ??= await maintenancePreflight(engine, sourceId);
  if (!authority) return outcome;
  for (const { slug, from, fromEntity, group, rehome } of groups) {
    try {
      if (rehome) await ensurePageForHeldRows(engine, sourceId, slug);
      const [page] = await engine.executeRaw<{ source_path: string | null; source_uri: string | null; visible: boolean }>(
        `SELECT p.source_path, p.source_uri, ${privatePagesFilterFragment('p')} AS visible FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`, [sourceId, slug]);
      if (!page) { unmovable(slug, group.map(r => r.id), rehome ? 'holding_page_deleted' : 'entity_page_deleted'); continue; }
      // A held row in Git moved into a page kept out of Git would be struck there with no file holding the fact; a row
      // re-homed because a folder rule now covers it moves whatever the folder's storage class (the rule applies at once).
      const [held] = await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>(
        'SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, from]);
      if (!rehome && held && await pageHasFile(engine, sourceId, from, held) && !await pageHasFile(engine, sourceId, slug, page)) {
        unmovable(slug, group.map(r => r.id), 'entity_page_database_only'); continue;
      }
      // A fact moved into a page not every reader of the source can read, or off a folder's holding page, leaves the
      // holding page with no trace of where it went.
      const note = !rehome && from === UNATTRIBUTED_MEMORY_SLUG && page.visible === true ? `moved to ${slug}` : 'moved';
      const plan = await planManagedPage(engine, authority, sourceId, slug, group,
        { note, ...(fromEntity ? { from_entity: fromEntity } : {}), ...(from === UNATTRIBUTED_MEMORY_SLUG ? {} : { from_slug: from }) });
      if (plan.kind === 'no_page') continue;
      if (plan.kind === 'warnings') { unmovable(slug, group.map(r => r.id), `entity_fence_malformed: ${plan.warnings.join('; ')}`); continue; }
      const rejected = plan.kind === 'unadoptable' ? plan.records : plan.fence.rejected;
      for (const reason of new Set(rejected.map(r => r.class))) unmovable(slug, rejected.filter(r => r.class === reason).map(r => r.fact_id), reason);
      if (plan.kind === 'unadoptable') continue;
      await submitPlannedFactFenceAdoption(engine, authority, slug, plan.request, true);
      if (rehome) outcome.rehomed += plan.fence.assignments.length;
      else { outcome.moved += plan.fence.assignments.length; outcome.moved_slugs.push(slug); }
    } catch (error) {
      unmovable(slug, group.map(r => r.id), (error instanceof Error ? error.message : String(error)).slice(0, 300));
      if (!isFenceHold(error)) outcome.write_errors += 1;
    }
  }
  return outcome;
}

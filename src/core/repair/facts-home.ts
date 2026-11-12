/**
 * `gbrain repair facts-home --source <id> [--apply --expect <hash>]` (GST-2492 PR 2): give the facts of a strict source
 * that live in the database alone a home in Git. The preview (facts/facts-home.ts `scanFactsHome`) lists every such fact
 * by group and writes nothing: a fact with no entity, or for an entity with no page, is what the apply writes to
 * memory/unattributed (a held row names its entity, so the upkeep move takes it to the entity's page once that page
 * exists); a fact whose entity has a page is left to that upkeep step; a fact the Facts table cannot render, one for an
 * entity under a folder access rule, a held row its page cannot take, and a held row older than 30 days (with the nearest
 * existing page the resolver finds) are listed and left alone. `--apply --expect <hash>` writes exactly the previewed set
 * in one maintenance publication through the write door; the facts rows move in place (ids, vectors and provenance kept).
 * A source that isn't strict lists nothing and says so (its database keeps such facts by design), so the bare preview a
 * remediation plan prints runs as pasted. Runs only when named; never on upgrade.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { UNATTRIBUTED_MEMORY_SLUG } from '../facts-fence.ts';
import { digest } from '../persistence/digest.ts';
import { maintenancePreflight, planFactFenceAdoption, readFacts, submitPlannedFactFenceAdoption } from '../persistence/prepared-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { FACTS_HOME_DOCS, factsHomePreviewCommand, scanFactsHome, type FactsHomeRow, type FactsHomeScan } from '../facts/facts-home.ts';
import { planPageFence } from '../facts/unfenced-facts.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

interface ApprovedFact { id: number; value: string }
interface HomeItem extends RepairItem { facts: ApprovedFact[]; hash: string }

/** At most this many facts are written per preview, in one publication; the preview after an apply lists the rest. */
const MAX_PER_APPLY = 500;

const previewArgv = (sourceId: string) => ['gbrain', 'repair', 'facts-home', '--source', sourceId, '--json'];
const gitGapArgv = (sourceId: string) => ['gbrain', 'sources', 'git-gap', sourceId, '--json'];

function previewChanged(hash: string, sourceId: string): OperationError {
  const command = factsHomePreviewCommand(sourceId);
  return opError('preview_changed', `The preview changed since ${hash}; re-run ${command} and use the new hash.`, `Re-run the preview: ${command}`,
    { fix: { ...readFix('Previews the facts that have no Git home again; writes nothing.', { argv: previewArgv(sourceId) }),
      verify: { argv: gitGapArgv(sourceId) } }, docs: FACTS_HOME_DOCS });
}

const DETAIL: Record<FactsHomeRow['group'], (row: FactsHomeRow) => string> = {
  entity_page_exists: row => `${row.entity_slug} has a page; the extract_facts upkeep step moves this fact there (gbrain dream --phase extract_facts runs it now)`,
  entity_page_missing: row => `${row.entity_slug} has no page; the apply writes it to ${UNATTRIBUTED_MEMORY_SLUG} as a held row naming ${row.entity_slug}`,
  no_entity: () => `no entity; the apply writes it to ${UNATTRIBUTED_MEMORY_SLUG}`,
  cannot_render: row => `the Facts table cannot render it as it stands (${row.reason}); it stays database-only, active and searchable`,
  folder_restricted: row => `${row.entity_slug} is under a folder access rule, so it is not named on the world-readable holding page; it stays database-only`,
  entity_page_deleted: row => `${row.entity_slug} is deleted (it may be private, and its purge would not reach the holding page); restore the page (gbrain restore ${row.entity_slug}) or purge it; the fact stays database-only`,
  held_fact_unmovable: row => `held for ${row.entity_slug}, whose page cannot take it (${row.reason}); edit the row, or forget the duplicate`,
  held_over_30_days: row => `held for ${row.entity_slug} since ${row.held_since} and the page still does not exist; ${row.nearest ? `the nearest existing page is ${row.nearest}` : 'no existing page resolves to it'}`,
  fenced_page_missing: row => `a row of ${row.reason}, which was deleted; restore the page (gbrain restore ${row.reason}) or purge it`,
  ontology_observation: row => `an ontology observation (${row.reason}) of ${row.entity_slug}; it has no row on any page's Facts table, so it stays`,
};

const hashParts = (scope: RepairScope, scan: FactsHomeScan, approved: ApprovedFact[]) =>
  ({ kind: 'facts-home-v1', brain_id: scope.brain_id, source_id: scan.source_id, approved: approved.map(f => [f.id, f.value]),
    listed: scan.rows.map(row => [row.id, row.group, row.reason ?? null, row.nearest ?? null]) });

/** The previewed facts with the digest of each stored row, as the apply re-checks them. */
async function approvedFacts(engine: BrainEngine, scan: FactsHomeScan): Promise<ApprovedFact[]> {
  const ids = scan.homeable.slice(0, MAX_PER_APPLY).map(row => Number(row.id));
  return (await readFacts(engine, scan.source_id, ids)).map(fact => ({ id: fact.id, value: digest(fact.value) })).sort((a, b) => a.id - b.id);
}

export const factsHomeRepair: RepairHandler = {
  kind: 'facts-home',
  embeds: false,
  outcomeItemsLimit: 1000,
  async plan(engine, scope, _after, opts): Promise<RepairPlan> {
    if (scope.source_ids.length !== 1) {
      throw opError('invalid_params', 'gbrain repair facts-home needs --source <id>.', 'Name one strict source, e.g. gbrain repair facts-home --source default.',
        { fix: readFix('Lists the registered sources.', { argv: ['gbrain', 'sources', 'list', '--json'] }), docs: FACTS_HOME_DOCS });
    }
    const sourceId = scope.source_ids[0]!;
    const scan = await scanFactsHome(engine, sourceId);
    if (!scan.strict) {
      return { items: [], preview_hash: previewHash(hashParts(scope, scan, [])), residuals: {},
        warnings: [`Source ${sourceId} is not strict (its pages are not canonical in Git), so the database keeps its facts by design and none is a gap; nothing is listed.`],
        details: { docs: FACTS_HOME_DOCS, strict: false, verify: gitGapArgv(sourceId).join(' ') } };
    }
    const approved = await approvedFacts(engine, scan);
    const hash = previewHash(hashParts(scope, scan, approved));
    const item = (facts: ApprovedFact[], key: string): HomeItem[] => facts.length
      ? [{ cursor: { phase: 0, id: 1 }, source_id: sourceId, slug: UNATTRIBUTED_MEMORY_SLUG, chars: 0, action: `hold ${facts.length} fact(s)`, facts, hash: key }] : [];
    if (opts?.apply) {
      if (!opts.expect) {
        throw opError('invalid_params', 'gbrain repair facts-home --apply writes only the set a preview printed.',
          `Preview first: ${factsHomePreviewCommand(sourceId)}, then run the apply command it prints with --expect <preview-hash>.`,
          { fix: readFix('Previews the facts that have no Git home; writes nothing.', { argv: previewArgv(sourceId) }), docs: FACTS_HOME_DOCS });
      }
      const saved = await loadApprovedSet<ApprovedFact>(engine, { command: 'facts-home', hash: opts.expect, previewCommand: factsHomePreviewCommand(sourceId),
        emptyHash: async () => approved.length ? '' : hash }).catch(error => { throw error instanceof OperationError && error.code === 'preview_changed' ? previewChanged(opts.expect!, sourceId) : error; });
      return { items: item(saved.items, opts.expect), preview_hash: opts.expect, residuals: { ...scan.counts } };
    }
    if (approved.length) await saveApprovedSet<ApprovedFact>(engine, { command: 'facts-home', hash }, approved);
    const more = scan.homeable.length - approved.length;
    return { items: item(approved, hash), preview_hash: hash, residuals: { ...scan.counts },
      ...(more > 0 ? { warnings: [`${more} more fact(s) can be written than one apply takes (${MAX_PER_APPLY}); apply this set, then preview again for the rest.`] } : {}),
      listing: scan.rows.map(row => ({ item: `${sourceId}:fact ${row.id}`, class: row.group, detail: DETAIL[row.group](row) })),
      details: { docs: FACTS_HOME_DOCS, counts: scan.counts, verify: gitGapArgv(sourceId).join(' ') } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { facts, hash, source_id: sourceId } = entry as HomeItem;
    try {
      return await homeFacts(ctx, sourceId, facts);
    } finally {
      await clearApprovedSet(ctx.engine, { command: 'facts-home', hash });
    }
  },
  render(details) {
    return [`  each written fact moves in place onto ${UNATTRIBUTED_MEMORY_SLUG} in one commit; check afterwards with ${details.verify}; guide: ${details.docs}`];
  },
};

const changed = (reason: string, detail: Record<string, unknown> = {}): RepairItemOutcome =>
  ({ applied: false, outcome: 'changed_since_preview', reason, detail: { ...detail, next: 'run gbrain repair facts-home again for a new preview' } });

async function homeFacts(ctx: OperationContext, sourceId: string, approved: ApprovedFact[]): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const scan = await scanFactsHome(engine, sourceId);
  const current = new Map((await approvedFacts(engine, scan)).map(fact => [fact.id, fact.value]));
  if (approved.some(fact => current.get(fact.id) !== fact.value)) return changed('facts_changed');
  const rows = scan.homeable.filter(row => approved.some(fact => fact.id === Number(row.id)));
  const authority = await maintenancePreflight(engine, sourceId);
  if (!authority) return { applied: false, outcome: 'skipped', reason: 'no_maintenance_authority' };
  // Maintenance publishes only to a page that exists, so a source with no holding page yet gets the empty one first,
  // as the first fact saved with no entity creates it (a note titled Unattributed memory).
  if (!await engine.readPageSnapshot(UNATTRIBUTED_MEMORY_SLUG, { sourceId, includeDeleted: true })) {
    const local = { ...ctx, remote: false, sourceId } as OperationContext;
    await submitPageMutation(local, { operation: 'put_page', params: { slug: UNATTRIBUTED_MEMORY_SLUG,
      request_id: await repairRequestId(local, 'facts-home', { source_id: sourceId, slug: UNATTRIBUTED_MEMORY_SLUG }, 'holding-page'),
      content: '---\ntype: note\ntitle: Unattributed memory\n---\n' } });
  }
  const planned = await planPageFence(engine, sourceId, UNATTRIBUTED_MEMORY_SLUG, rows);
  if (!planned) return changed('holding_page_deleted');
  const { snapshot, fence } = planned;
  if ('warnings' in fence) return { applied: false, outcome: 'skipped', reason: 'holding_fence_malformed', detail: { warnings: fence.warnings } };
  if (fence.rejected.length) return changed('fence_rejected', { rejected: fence.rejected.map(r => ({ fact_id: r.fact_id, class: r.class })) });
  const plan = await planFactFenceAdoption(engine, authority, UNATTRIBUTED_MEMORY_SLUG, { content: fence.body, expectedRevision: snapshot.revision,
    assignments: fence.assignments.map(a => ({ id: Number(a.id), row_num: a.row_num })) });
  if (plan.kind === 'suppressed') return { applied: false, outcome: 'skipped', reason: 'refused_recently', detail: { request_id: plan.prior.request_id, error_code: plan.prior.error_code } };
  const receipt = await submitPlannedFactFenceAdoption(engine, authority, UNATTRIBUTED_MEMORY_SLUG, plan, true);
  return { applied: true, outcome: 'held', detail: { facts: fence.assignments.length, request_id: plan.requestId, receipt } };
}

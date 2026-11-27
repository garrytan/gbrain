/**
 * #6764: `gbrain facts relink --conversation`, the free relink of the
 * conversation extractor's derived rows (`cli:extract-conversation-facts*`)
 * that were stored without an entity. `gbrain facts relink` never examines
 * them (they are row-numbered rows of the conversation page), and before
 * write-time inference (conversation-subject-infer.ts) every such row was
 * stored unlinked.
 *
 * Per page, each unlinked derived row runs `inferConversationSubject`
 * (`inferFactSubject` in `write` mode, visibility-filtered, withdrawn claims
 * skipped); no model is called. A page's proven links are one write: a
 * managed brain publishes one database-only `managed_maintenance_conversation_relink`
 * request holding the page's key (the coordinator transaction carries the
 * receipt), an unmanaged brain one maintenance transaction at the page's
 * derived tier. The write sets `entity_slug` and appends the
 * `entity relinked from <tier>` note only on rows still exactly as planned
 * (same claim, still unlinked and active, target page live); the row stays a
 * derived row of the conversation page, and a `linked` attempt row records
 * it. A row inference cannot resolve gets a `conversation_unresolved` memo in
 * `fact_relink_attempts` (operational, like relink's model verdict memos), so
 * doctor `unlinked_facts` offers it the paid re-extraction fallback instead
 * of this relink again; conversation-memo.ts says which misses a new page
 * re-arms and how the paid attempt is remembered. A row the assistant or a
 * third party said is never linked (#7270): it is counted, left unlinked, and
 * never picks a page for a run. Trusted local CLI only.
 *
 * GBRA-574 C1, `--unbacked`: the same write re-keys a derived row stored on an
 * unbacked name key (facts.unbacked_entity_keys: a bare slug with no live page,
 * withdrawal-schema.ts unbackedEntitySql) onto the page that name now resolves
 * to through resolveStrictEntityReference (exact slug, unique basename, unique
 * alias, or the same name ignoring corporate suffixes; a retired page answers
 * through its superseded_by target), private pages excluded for a world row.
 * A key that resolves to no page, or to two, keeps its rows; no memo is written.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';
import { isTerminal } from '../persistence/model.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { authorizeStoredRequest, authorizeWrite } from '../persistence/authority.ts';
import { waitForWrite, writeResponse } from '../persistence/service.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { writeDerivedFacts } from '../persistence/derived-facts.ts';
import { CONVERSATION_UNRESOLVED } from './relink-reasons.ts';
import { appendContextNote } from './subject-infer.ts';
import { entityLinkable } from './attribution.ts';
import { inferConversationSubject } from './conversation-subject-infer.ts';
import { UNBACKED_FACT_SQL, derivedConversationRow } from '../engine-sql/fact-relink-writes.ts';
import { hasRelinkAttemptsTable } from './conversation-memo.ts';
import { resolveStrictEntityReference } from '../entities/resolve.ts';
import { dropRekeyDuplicates } from './ontology-rekey.ts';

export const CONVERSATION_RELINK_INTENT = 'managed_maintenance_conversation_relink';
/** The request slug: a dot-led segment no page can hold; the page's own key is locked with it. */
export const CONVERSATION_RELINK_ANCHOR = '.maintenance/conversation-relink';
/** Pages one run relinks when no `--slugs` are named. */
export const CONVERSATION_RELINK_PAGES = 50;
// The derived-row predicate and the live, unlinked and unbacked row tests live with the relink writer (engine-sql/fact-relink-writes.ts),
// so the planner here and the guarded link read the same text.
export { derivedConversationRow };
/** GBRA-574: a derived row on an unbacked name key (`--unbacked`). */
const UNBACKED = UNBACKED_FACT_SQL;

/** A planned link; `from` is the unbacked name key a `--unbacked` row moves off (absent: a row with no entity). */
export interface ConversationRelinkRow { id: number; fact: string; entity_slug: string; context: string; from?: string }
interface PagePlan { slug: string; link: ConversationRelinkRow[]; misses: Array<{ id: number; reason: string }>; notUserAttributed: number }
export interface ConversationRelinkReport {
  source_id: string;
  dry_run: boolean;
  /** GBRA-574: a `--unbacked` run (rows on a name key re-keyed onto the page the name resolves to). */
  unbacked?: boolean;
  pages: Array<{ slug: string; linked: number; unresolved: number; changed: number; not_user_attributed: number }>;
  linked: number;
  unresolved: number;
  /** #7270: rows the assistant or a third party said, left unlinked (never attached to an entity page). */
  not_user_attributed: number;
  /** Planned links whose row moved before the write (left for the next run). */
  changed: number;
  /** Pages still holding unresolved rows: the paid re-extraction fallback names them. */
  reextract_slugs: string[];
}

/** The pages with the most unlinked derived rows not yet tried by this relink, up to `limit`. */
export async function conversationRelinkPages(engine: BrainEngine, sourceId: string, limit = CONVERSATION_RELINK_PAGES, unbacked = false): Promise<string[]> {
  return engine.listConversationRelinkPages(sourceId, { limit, unbacked, skipTried: !unbacked && await hasRelinkAttemptsTable(engine) });
}

/** GBRA-574 C1: each page's rows on an unbacked name key, linked when the key now resolves to exactly one readable page. */
async function planUnbackedPages(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<PagePlan[]> {
  const rows = await engine.listUnbackedConversationRows(sourceId, slugs);
  const targets = new Map<string, string | null>();
  const pages = new Map<string, PagePlan>();
  for (const row of rows) {
    const page = pages.get(row.slug) ?? { slug: row.slug, link: [], misses: [], notUserAttributed: 0 };
    pages.set(row.slug, page);
    if (!entityLinkable(row.attributed_to)) { page.notUserAttributed++; continue; }
    const cacheKey = `${row.entity_slug}\u0000${row.visibility}`;
    if (!targets.has(cacheKey)) targets.set(cacheKey, (await resolveStrictEntityReference(engine, sourceId, row.entity_slug.replace(/-/g, ' '),
      { sameName: true, excludePrivate: row.visibility === 'world' })).slug);
    const target = targets.get(cacheKey);
    if (!target) page.misses.push({ id: Number(row.id), reason: 'no_page' });
    else page.link.push({ id: Number(row.id), fact: row.fact, entity_slug: target, from: row.entity_slug, context: appendContextNote(row.context, 'entity relinked from unbacked') });
  }
  return slugs.flatMap(slug => pages.get(slug) ?? []);
}

async function planPages(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<PagePlan[]> {
  const rows = await engine.listUnlinkedConversationRows(sourceId, slugs);
  const pages = new Map<string, PagePlan>();
  for (const row of rows) {
    const page = pages.get(row.slug) ?? { slug: row.slug, link: [], misses: [], notUserAttributed: 0 };
    pages.set(row.slug, page);
    if (!entityLinkable(row.attributed_to)) { page.notUserAttributed++; continue; }
    const inferred = await inferConversationSubject(engine, sourceId, row.visibility, row.fact);
    if (inferred.slug === null) page.misses.push({ id: Number(row.id), reason: inferred.reason });
    else page.link.push({ id: Number(row.id), fact: row.fact, entity_slug: inferred.slug, context: appendContextNote(row.context, `entity relinked from ${inferred.via}`) });
  }
  return slugs.flatMap(slug => pages.get(slug) ?? []);
}

/** Under the page's lock: link the planned rows still exactly as planned, recording each link. */
async function linkRows(tx: BrainEngine, sourceId: string, slug: string, rows: ConversationRelinkRow[]): Promise<number[]> {
  const linked: number[] = [];
  const attempts = await hasRelinkAttemptsTable(tx);
  for (const row of rows) {
    // A re-keyed row's slot gives way to one its target already holds on the page (facts/ontology-rekey.ts), so the move never collides.
    if (row.from) await dropRekeyDuplicates(tx, sourceId, { where: `f.id = $2::bigint AND ${UNBACKED}`, entity: '$3::text', sms: 'f.source_markdown_slug',
      params: [row.id, row.entity_slug] });
    const done = await tx.linkConversationFact(sourceId,
      { factId: row.id, pageSlug: slug, fact: row.fact, entitySlug: row.entity_slug, context: row.context, from: row.from ?? null });
    if (!done) continue;
    linked.push(row.id);
    const tier = row.from ? 'unbacked' : 'mention';
    if (attempts) await tx.upsertFactRelinkAttempt(sourceId,
      { factId: row.id, outcome: 'linked', reason: null, tier, model: null, targetSlug: row.entity_slug, runId: null });
  }
  return linked;
}

function requestIdFor(sourceId: string, slug: string, rows: ConversationRelinkRow[], attempt: number): string {
  const h = digest(['conversation-relink-v1', sourceId, slug, rows.map(r => [r.id, r.entity_slug, r.context, ...(r.from ? [r.from] : [])]), attempt]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function publishManaged(engine: BrainEngine, config: GBrainConfig, authority: NonNullable<Awaited<ReturnType<typeof maintenancePreflight>>>,
  sourceId: string, page: PagePlan): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    const requestId = requestIdFor(sourceId, page.slug, page.link, attempt);
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (prior && isTerminal(prior) && prior.state !== 'committed') continue;
    let receipt: Record<string, unknown>;
    if (prior) {
      await authorizeStoredRequest(engine, prior);
      receipt = writeResponse(await waitForWrite(engine, prior, config));
    } else {
      receipt = await submitDatabaseMaintenanceIntent(engine, authority, CONVERSATION_RELINK_ANCHOR,
        { kind: CONVERSATION_RELINK_INTENT, expected_revision: null, page: page.slug, rows: page.link }, requestId);
    }
    return (receipt.linked as number[] | undefined) ?? [];
  }
}

export async function runConversationRelink(engine: BrainEngine, config: GBrainConfig,
  opts: { sourceId: string; slugs?: string[]; dryRun?: boolean; unbacked?: boolean }): Promise<ConversationRelinkReport> {
  const slugs = opts.slugs?.length ? opts.slugs : await conversationRelinkPages(engine, opts.sourceId, CONVERSATION_RELINK_PAGES, opts.unbacked);
  const plans = await (opts.unbacked ? planUnbackedPages : planPages)(engine, opts.sourceId, slugs);
  const report: ConversationRelinkReport = { source_id: opts.sourceId, dry_run: !!opts.dryRun, ...(opts.unbacked ? { unbacked: true } : {}),
    pages: [], linked: 0, unresolved: 0, not_user_attributed: 0, changed: 0, reextract_slugs: [] };
  const authority = opts.dryRun ? null : await maintenancePreflight(engine, opts.sourceId);
  const memo = !opts.dryRun && !opts.unbacked && await hasRelinkAttemptsTable(engine);
  for (const page of plans) {
    let linked = page.link.length;
    if (!opts.dryRun && page.link.length) {
      linked = (authority ? await publishManaged(engine, config, authority, opts.sourceId, page)
        : await writeDerivedFacts(engine, opts.sourceId, page.slug, db => linkRows(db, opts.sourceId, page.slug, page.link))).length;
    }
    if (memo) for (const miss of page.misses) await engine.upsertFactRelinkAttempt(opts.sourceId,
      { factId: miss.id, outcome: CONVERSATION_UNRESOLVED, reason: miss.reason, tier: 'mention', model: null, targetSlug: null, runId: null });
    const changed = page.link.length - linked;
    report.pages.push({ slug: page.slug, linked, unresolved: page.misses.length, changed, not_user_attributed: page.notUserAttributed });
    report.linked += linked;
    report.unresolved += page.misses.length;
    report.not_user_attributed += page.notUserAttributed;
    report.changed += changed;
    if (page.misses.length) report.reextract_slugs.push(page.slug);
  }
  return report;
}

/** Preparer for `managed_maintenance_conversation_relink`: one page's links, database-only, holding the page's key. */
export async function prepareConversationRelink(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const intent = row.intent as { page?: unknown; rows?: ConversationRelinkRow[] } | null;
  const page = intent?.page;
  const rows = intent?.rows;
  if (row.slug !== CONVERSATION_RELINK_ANCHOR || typeof page !== 'string' || !Array.isArray(rows) || !rows.length
    || rows.some(r => !Number.isSafeInteger(r?.id) || typeof r.fact !== 'string' || typeof r.entity_slug !== 'string' || typeof r.context !== 'string'
      || (r.from !== undefined && typeof r.from !== 'string'))) {
    throw opError('invalid_params', 'The conversation relink intent does not name its page and rows.',
      `Request ${row.request_id} in source ${row.source_id} does not name the conversation page and the rows it links, so nothing changed. Preview the relink again with gbrain facts relink --conversation --source ${row.source_id} --dry-run.`);
  }
  const authorize = async (db: BrainEngine) => {
    await authorizeWrite(db, row.authority, 'submit_job', row.slug);
    await authorizeWrite(db, row.authority, 'submit_job', page);
  };
  await authorize(engine);
  return { observedRevision: null, noop: true, additionalPageKeys: [{ sourceId: row.source_id, slug: page }], validate: authorize,
    apply: async tx => ({ status: 'completed', page, linked: await linkRows(tx, row.source_id, page, rows) }) };
}

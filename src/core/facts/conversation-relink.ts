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
 * re-arms and how the paid attempt is remembered. Trusted local CLI only.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { FactVisibility } from './visibility.ts';
import { opError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';
import { isTerminal } from '../persistence/model.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { authorizeStoredRequest, authorizeWrite } from '../persistence/authority.ts';
import { waitForWrite, writeResponse } from '../persistence/service.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { writeDerivedFacts } from '../persistence/derived-facts.ts';
import { AUDIT_ROW_SOURCES } from './audit-sources.ts';
import { CONVERSATION_UNRESOLVED } from './relink-reasons.ts';
import { conversationTriedSql } from './conversation-memo.ts';
import { appendContextNote } from './subject-infer.ts';
import { inferConversationSubject } from './conversation-subject-infer.ts';

export const CONVERSATION_RELINK_INTENT = 'managed_maintenance_conversation_relink';
/** The request slug: a dot-led segment no page can hold; the page's own key is locked with it. */
export const CONVERSATION_RELINK_ANCHOR = '.maintenance/conversation-relink';
/** Pages one run relinks when no `--slugs` are named. */
export const CONVERSATION_RELINK_PAGES = 50;
/** The SQL predicate (on alias `f`, audit sources as `$audit`) of a conversation extractor's derived fact row. */
export const derivedConversationRow = (audit: string) => `f.source LIKE 'cli:extract-conversation-facts%' AND f.source <> ALL(${audit}::text[])`;
const ACTIVE = 'f.entity_slug IS NULL AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())';

export interface ConversationRelinkRow { id: number; fact: string; entity_slug: string; context: string }
interface PagePlan { slug: string; link: ConversationRelinkRow[]; misses: Array<{ id: number; reason: string }> }
export interface ConversationRelinkReport {
  source_id: string;
  dry_run: boolean;
  pages: Array<{ slug: string; linked: number; unresolved: number; changed: number }>;
  linked: number;
  unresolved: number;
  /** Planned links whose row moved before the write (left for the next run). */
  changed: number;
  /** Pages still holding unresolved rows: the paid re-extraction fallback names them. */
  reextract_slugs: string[];
}

async function hasAttemptsTable(engine: BrainEngine): Promise<boolean> {
  const [row] = await engine.executeRaw<{ t: string | null }>(`SELECT to_regclass('fact_relink_attempts')::text AS t`);
  return !!row?.t;
}

/** The pages with the most unlinked derived rows not yet tried by this relink, up to `limit`. */
export async function conversationRelinkPages(engine: BrainEngine, sourceId: string, limit = CONVERSATION_RELINK_PAGES): Promise<string[]> {
  const untried = await hasAttemptsTable(engine)
    ? `AND NOT ${conversationTriedSql}` : '';
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT f.source_markdown_slug AS slug FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug IS NOT NULL AND ${ACTIVE}
        AND ${derivedConversationRow('$2')} ${untried}
      GROUP BY f.source_markdown_slug ORDER BY COUNT(*) DESC, f.source_markdown_slug LIMIT $3`, [sourceId, [...AUDIT_ROW_SOURCES], limit]);
  return rows.map(r => r.slug);
}

async function planPages(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<PagePlan[]> {
  const rows = await engine.executeRaw<{ id: number | string; fact: string; context: string | null; visibility: FactVisibility; slug: string }>(
    `SELECT f.id, f.fact, f.context, f.visibility, f.source_markdown_slug AS slug FROM facts f
      WHERE f.source_id = $1 AND f.source_markdown_slug = ANY($2::text[]) AND ${ACTIVE} AND ${derivedConversationRow('$3')}
      ORDER BY f.source_markdown_slug, f.id`, [sourceId, slugs, [...AUDIT_ROW_SOURCES]]);
  const pages = new Map<string, PagePlan>();
  for (const row of rows) {
    const page = pages.get(row.slug) ?? { slug: row.slug, link: [], misses: [] };
    pages.set(row.slug, page);
    const inferred = await inferConversationSubject(engine, sourceId, row.visibility, row.fact);
    if (inferred.slug === null) page.misses.push({ id: Number(row.id), reason: inferred.reason });
    else page.link.push({ id: Number(row.id), fact: row.fact, entity_slug: inferred.slug, context: appendContextNote(row.context, `entity relinked from ${inferred.via}`) });
  }
  return slugs.flatMap(slug => pages.get(slug) ?? []);
}

/** Under the page's lock: link the planned rows still exactly as planned, recording each link. */
async function linkRows(tx: BrainEngine, sourceId: string, slug: string, rows: ConversationRelinkRow[]): Promise<number[]> {
  const linked: number[] = [];
  const attempts = await hasAttemptsTable(tx);
  for (const row of rows) {
    const done = await tx.executeRaw<{ id: number | string }>(
      `UPDATE facts f SET entity_slug = $4, context = $5 WHERE f.source_id = $1 AND f.id = $2 AND f.source_markdown_slug = $3 AND f.fact = $6
          AND ${ACTIVE} AND ${derivedConversationRow('$7')}
          AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $4 AND p.deleted_at IS NULL) RETURNING f.id`,
      [sourceId, row.id, slug, row.entity_slug, row.context, row.fact, [...AUDIT_ROW_SOURCES]]);
    if (!done.length) continue;
    linked.push(row.id);
    if (attempts) await tx.executeRaw(
      `INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, model, target_slug, run_id, attempted_at)
       VALUES ($1, $2, 'linked', NULL, 'mention', NULL, $3, NULL, now())
       ON CONFLICT (source_id, fact_id) DO UPDATE SET outcome = 'linked', reason = NULL, tier = 'mention', model = NULL,
         target_slug = EXCLUDED.target_slug, run_id = NULL, attempted_at = EXCLUDED.attempted_at`, [sourceId, row.id, row.entity_slug]);
  }
  return linked;
}

function requestIdFor(sourceId: string, slug: string, rows: ConversationRelinkRow[], attempt: number): string {
  const h = digest(['conversation-relink-v1', sourceId, slug, rows.map(r => [r.id, r.entity_slug, r.context]), attempt]);
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
  opts: { sourceId: string; slugs?: string[]; dryRun?: boolean }): Promise<ConversationRelinkReport> {
  const slugs = opts.slugs?.length ? opts.slugs : await conversationRelinkPages(engine, opts.sourceId);
  const plans = await planPages(engine, opts.sourceId, slugs);
  const report: ConversationRelinkReport = { source_id: opts.sourceId, dry_run: !!opts.dryRun, pages: [], linked: 0, unresolved: 0, changed: 0, reextract_slugs: [] };
  const authority = opts.dryRun ? null : await maintenancePreflight(engine, opts.sourceId);
  const memo = !opts.dryRun && await hasAttemptsTable(engine);
  for (const page of plans) {
    let linked = page.link.length;
    if (!opts.dryRun && page.link.length) {
      linked = (authority ? await publishManaged(engine, config, authority, opts.sourceId, page)
        : await writeDerivedFacts(engine, opts.sourceId, page.slug, db => linkRows(db, opts.sourceId, page.slug, page.link))).length;
    }
    if (memo) for (const miss of page.misses) await engine.executeRaw(
      `INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, model, target_slug, run_id, attempted_at)
       VALUES ($1, $2, $3, $4, 'mention', NULL, NULL, NULL, now())
       ON CONFLICT (source_id, fact_id) DO UPDATE SET outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, tier = 'mention',
         model = NULL, target_slug = NULL, run_id = NULL, attempted_at = EXCLUDED.attempted_at`, [opts.sourceId, miss.id, CONVERSATION_UNRESOLVED, miss.reason]);
    const changed = page.link.length - linked;
    report.pages.push({ slug: page.slug, linked, unresolved: page.misses.length, changed });
    report.linked += linked;
    report.unresolved += page.misses.length;
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
    || rows.some(r => !Number.isSafeInteger(r?.id) || typeof r.fact !== 'string' || typeof r.entity_slug !== 'string' || typeof r.context !== 'string')) {
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

/**
 * Roadmap PR 3: the value card (gbrain value, MCP value, read scope). What this brain holds and has done for the
 * caller, as rows that are each measured, off (naming the command that turns it on) or unavailable (with a code and a
 * cause, never a 0 standing in for a number that could not be read).
 *
 * Visibility. Pages, links, facts, conversations and nightly items are counted through the caller's own read policy
 * and source scope, so a member's numbers never move when pages it cannot read are added. Lookups served, pages
 * brought up on their own, pages later retrieved and the brain score are brain-wide (search_telemetry has no member
 * column; context_volunteer_events and page_retrievals are brain-wide), so only the owner and the trusted local CLI
 * see them; anyone else gets the row as unavailable with code owner_only and no number.
 *
 * Errors. A row whose read fails is unavailable (query_failed) and the card is degraded; owner_only and out_of_scope
 * rows and off rows are not failures. When every attempted row fails, the card throws value_unavailable.
 * Nothing here runs on the session-start path; the card is read only on request.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError, type OperationContext } from '../ops/contract.ts';
import { sourceScopeOpts } from '../ops/context.ts';
import { callerIsInstallOwner } from '../ops/onboarding.ts';
import { factVisibilitySql, withdrawalCoversFactSql } from '../access/member-facts.ts';
import { privateFactFilterForReader, privatePagesFilterForCaller, resolveExcludePrivatePages, worldOnlyFacts } from '../search/private-visibility.ts';
import { remoteReadPolicySql } from '../persistence/page-visibility.ts';
import { outcomeMarkerSql } from '../facts/audit-sources.ts';
import { EMPTY_RESULT_MODE, RECALL_TELEMETRY_MODE, RERANK_GATE_TELEMETRY_MODE } from '../search/telemetry.ts';

export const VALUE_SCHEMA = 'gbrain.value';
export const VALUE_SCHEMA_VERSION = 1;
export const VALUE_WINDOW_DAYS = 30;
export const BEST_EFFORT_NOTE = 'best effort, may undercount';

export type ValueRowId = 'conversations_archived' | 'pages' | 'links' | 'facts' | 'lookups_served' | 'pages_brought_up'
  | 'pages_later_retrieved' | 'nightly_items' | 'brain_score';
export type ValueRowStatus = 'measured' | 'off' | 'unavailable';

export interface ValueRow {
  id: ValueRowId;
  label: string;
  status: ValueRowStatus;
  value?: Record<string, unknown>;
  window_days?: number;
  note?: string;
  turn_on?: { argv: string[]; why: string };
  code?: string;
  cause?: string;
}

export interface ValueCard {
  schema: typeof VALUE_SCHEMA;
  schema_version: typeof VALUE_SCHEMA_VERSION;
  generated_at: string;
  window_days: number;
  /** owner: the trusted local CLI or the install's owner, who sees brain-wide activity; member: everyone else. */
  view: 'owner' | 'member';
  /** degraded: at least one row could not be read; its other rows are still measured. */
  state: 'complete' | 'degraded';
  rows: ValueRow[];
}

/** Codes of rows left out on purpose (the caller's view or scope), which never make a card degraded. */
const EXCLUDED_CODES = new Set(['owner_only', 'out_of_scope']);

const LABELS: Record<ValueRowId, string> = {
  conversations_archived: 'Conversations archived',
  pages: 'Pages',
  links: 'Links',
  facts: 'Facts kept',
  lookups_served: 'Lookups served',
  pages_brought_up: 'Pages brought up on their own',
  pages_later_retrieved: 'Of those, later retrieved',
  nightly_items: 'Nightly items',
  brain_score: 'Brain score',
};

type Measure = Omit<ValueRow, 'id' | 'label'>;

const measured = (value: Record<string, unknown>, extra: Partial<Measure> = {}): Measure => ({ status: 'measured', value, ...extra });
const off = (argv: string[], why: string): Measure => ({ status: 'off', turn_on: { argv, why } });
const unavailable = (code: string, cause: string): Measure => ({ status: 'unavailable', code, cause });
const OWNER_ONLY = unavailable('owner_only', 'Brain-wide activity is shown only to the brain owner and the local CLI; this connection is not bound to the owner.');

interface Reader {
  engine: BrainEngine;
  ctx: OperationContext;
  ownerView: boolean;
  /** The sources the caller reads; null for the trusted local CLI, which reads the whole brain. */
  sources: string[] | null;
  /** The caller's page read policy over a page alias ('TRUE' when nothing is hidden from it). */
  pagePolicy(alias: string): Promise<string>;
  since: Date;
}

const n = (v: unknown): number => Number(v ?? 0);
const sourceIn = (col: string, param: number) => '(' + '$' + param + '::text[] IS NULL OR ' + col + ' = ANY(' + '$' + param + '::text[]))';

async function pagesRow(r: Reader): Promise<Measure> {
  const rows = await r.engine.executeRaw<{ type: string | null; n: number | string }>(
    'SELECT p.type, count(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND ' + sourceIn('p.source_id', 1) + ' AND ' + await r.pagePolicy('p') + ' GROUP BY p.type',
    [r.sources]);
  const byKind: Record<string, number> = {};
  for (const row of rows) byKind[row.type ?? 'untyped'] = n(row.n);
  return measured({ total: Object.values(byKind).reduce((a, b) => a + b, 0), by_kind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b))) });
}

async function linksRow(r: Reader): Promise<Measure> {
  const [row] = await r.engine.executeRaw<{ n: number | string }>(
    'SELECT count(*)::int AS n FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id'
    + ' WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL AND ' + sourceIn('f.source_id', 1) + ' AND ' + sourceIn('t.source_id', 1)
    + ' AND ' + await r.pagePolicy('f') + ' AND ' + await r.pagePolicy('t')
    + ' AND (l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages lo WHERE lo.id = l.origin_page_id AND ' + await r.pagePolicy('lo') + '))',
    [r.sources]);
  return measured({ total: n(row?.n) });
}

async function factsRow(r: Reader): Promise<Measure> {
  const remote = r.ctx.remote !== false;
  const gates = ['NOT ' + outcomeMarkerSql('f'), sourceIn('f.source_id', 1)];
  if (worldOnlyFacts(r.ctx.remote)) gates.push(factVisibilitySql('f', ['world']));
  if (await resolveExcludePrivatePages(r.engine, r.ctx.remote)) gates.push(privateFactFilterForReader('f'));
  else if (remote) gates.push('NOT EXISTS (SELECT 1 FROM pages fp WHERE fp.source_id = f.source_id AND fp.slug = f.source_markdown_slug AND NOT ' + await r.pagePolicy('fp') + ')');
  const withdrawn = 'EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility'
    + ' AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact)) AND ' + withdrawalCoversFactSql('w', 'f') + ')';
  const [row] = await r.engine.executeRaw<{ active: number | string; superseded: number | string; withdrawn: number | string }>(
    'SELECT count(*) FILTER (WHERE NOT wd AND superseded_by IS NULL AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()))::int AS active,'
    + ' count(*) FILTER (WHERE NOT wd AND superseded_by IS NOT NULL)::int AS superseded, count(*) FILTER (WHERE wd)::int AS withdrawn'
    + ' FROM (SELECT f.superseded_by, f.expired_at, f.valid_until, ' + withdrawn + ' AS wd FROM facts f WHERE ' + gates.join(' AND ') + ') x',
    [r.sources]);
  return measured({ active: n(row?.active), superseded: n(row?.superseded), withdrawn: n(row?.withdrawn) });
}

async function conversationsRow(r: Reader): Promise<Measure> {
  const archive = await import('../transcripts/archive.ts');
  const configured = await archive.configuredSource(r.engine);
  const ids = [configured, configured + '-owner'].filter(id => r.sources === null || r.sources.includes(id));
  if (!ids.length) return unavailable('out_of_scope', 'The conversation archive is kept in source ' + configured + ', which this connection does not read.');
  const units = (await Promise.all(ids.map(id => archive.readArchiveLedger(r.engine, id)))).flat().filter(e => e.hash && !e.held);
  let published = units;
  if (r.ctx.remote !== false && units.length) {
    const readable = new Set((await r.engine.executeRaw<{ source_id: string; slug: string }>(
      'SELECT p.source_id, p.slug FROM pages p WHERE p.deleted_at IS NULL AND p.source_id = ANY($1::text[]) AND p.slug = ANY($2::text[]) AND ' + await r.pagePolicy('p'),
      [ids, units.map(u => u.slug ?? '')])).map(p => p.source_id + '\u0000' + p.slug));
    published = units.filter(u => readable.has(u.source_id + '\u0000' + u.slug));
  }
  if (!published.length && !await archive.archiveEnabled(r.engine)) {
    return off(['gbrain', 'transcripts', 'archive', 'on'], 'Archives one redacted page per conversation per day from your agent sessions.');
  }
  return measured({
    conversations: new Set(published.map(u => u.source_id + '\u0000' + u.harness + '\u0000' + u.conversation_key_hash)).size,
    days: new Set(published.map(u => u.day)).size,
    units: published.length,
  });
}

async function lookupsRow(r: Reader): Promise<Measure> {
  if (!r.ownerView) return OWNER_ONLY;
  const rows = await r.engine.executeRaw<{ mode: string; n: number | string }>(
    'SELECT mode, SUM(count)::int AS n FROM search_telemetry WHERE date >= $1 AND mode NOT IN ($2, $3) GROUP BY mode',
    [r.since.toISOString().slice(0, 10), EMPTY_RESULT_MODE, RERANK_GATE_TELEMETRY_MODE]);
  const recalls = rows.filter(x => x.mode === RECALL_TELEMETRY_MODE).reduce((a, x) => a + n(x.n), 0);
  const searches = rows.filter(x => x.mode !== RECALL_TELEMETRY_MODE).reduce((a, x) => a + n(x.n), 0);
  return measured({ total: searches + recalls, searches, recalls }, { window_days: VALUE_WINDOW_DAYS, note: BEST_EFFORT_NOTE });
}

const VOLUNTEERED = 'SELECT v.source_id, v.slug, min(v.volunteered_at) AS first_at FROM context_volunteer_events v WHERE v.volunteered_at >= $1 AND ' + sourceIn('v.source_id', 2) + ' GROUP BY v.source_id, v.slug';

async function broughtUpRow(r: Reader): Promise<Measure> {
  if (!r.ownerView) return OWNER_ONLY;
  const [row] = await r.engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM (' + VOLUNTEERED + ') x', [r.since.toISOString(), r.sources]);
  return measured({ pages: n(row?.n) }, { window_days: VALUE_WINDOW_DAYS, note: BEST_EFFORT_NOTE });
}

async function laterRetrievedRow(r: Reader): Promise<Measure> {
  if (!r.ownerView) return OWNER_ONLY;
  const tracking = ((await r.engine.getConfig('search.track_retrieval')) ?? '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(tracking)) {
    return off(['gbrain', 'config', 'set', 'search.track_retrieval', 'true'], 'Records when a search or read surfaces a page, so a page brought up on its own can be seen being used later.');
  }
  const [row] = await r.engine.executeRaw<{ n: number | string }>(
    'SELECT count(*)::int AS n FROM (' + VOLUNTEERED + ') x JOIN pages p ON p.source_id = x.source_id AND p.slug = x.slug'
    + ' LEFT JOIN page_retrievals pr ON pr.page_id = p.id WHERE GREATEST(p.last_retrieved_at, pr.last_retrieved_at) > x.first_at',
    [r.since.toISOString(), r.sources]);
  return measured({ pages: n(row?.n) }, { window_days: VALUE_WINDOW_DAYS, note: BEST_EFFORT_NOTE });
}

async function nightlyRow(r: Reader): Promise<Measure> {
  const { learningTablePresent } = await import('../learning/kinds.ts');
  if (!await learningTablePresent(r.engine)) return unavailable('migrations_pending', 'This brain has no learning ledger yet: its schema is older than the learned view. Run gbrain apply-migrations --yes on the brain host.');
  const { callerFilters, liveItems, LEARNED_MAX_LIMIT } = await import('../learning/read.ts');
  const items = await liveItems(r.engine, r.ctx, await callerFilters(r.engine, r.ctx), { sourceIds: r.sources, since: r.since, unseenOnly: false, limit: LEARNED_MAX_LIMIT });
  const counted = items.filter(i => i.kind !== 'you_wrote');
  return measured({ items: counted.length, ...(items.length >= LEARNED_MAX_LIMIT ? { at_least: true } : {}) }, { window_days: VALUE_WINDOW_DAYS });
}

async function brainScoreRow(r: Reader): Promise<Measure> {
  if (!r.ownerView) return OWNER_ONLY;
  const { classifyChecks, maxReachableScore } = await import('../brain-score-recommendations.ts');
  const { loadRecommendationContext } = await import('../remediation/context.ts');
  const { SYNTHETIC_CHECK_NAMES } = await import('../remediation/plan.ts');
  const health = await r.engine.getHealth();
  const rec = await loadRecommendationContext(r.engine);
  const reachable = maxReachableScore(health, classifyChecks(SYNTHETIC_CHECK_NAMES.map(name => ({ name, status: 'ok' as const })), rec));
  return measured({ score: health.brain_score, reachable, max: 100, keyless: rec.embeddingsDisabled === true || rec.embeddingProviderConfigured !== true });
}

const ROWS: ReadonlyArray<[ValueRowId, (r: Reader) => Promise<Measure>]> = [
  ['conversations_archived', conversationsRow],
  ['pages', pagesRow],
  ['links', linksRow],
  ['facts', factsRow],
  ['lookups_served', lookupsRow],
  ['pages_brought_up', broughtUpRow],
  ['pages_later_retrieved', laterRetrievedRow],
  ['nightly_items', nightlyRow],
  ['brain_score', brainScoreRow],
];

function failed(err: unknown): Measure {
  if (err instanceof OperationError) return unavailable(err.code, err.message);
  const message = err instanceof Error ? err.message : String(err);
  return unavailable('query_failed', message.length > 300 ? message.slice(0, 297) + '...' : message);
}

async function readerFor(ctx: OperationContext, now: Date): Promise<Reader> {
  const engine = ctx.engine;
  let sources: string[] | null = null;
  if (ctx.remote !== false) {
    const scope = sourceScopeOpts(ctx);
    sources = scope.sourceIds?.length ? [...new Set(scope.sourceIds)] : scope.sourceId ? [scope.sourceId] : null;
    if (!sources) throw opError('permission_denied', 'value: this connection has no resolved source scope, so nothing was counted.', 'Connect with a credential that grants a source, then ask again.');
  }
  const excludePrivate = await resolveExcludePrivatePages(engine, ctx.remote);
  const ownerView = ctx.remote === false ? !ctx.applyRemoteReadPolicy && !ctx.accessIdentity : await callerIsInstallOwner(ctx);
  return {
    engine, ctx, ownerView, sources,
    pagePolicy: async (alias) => ctx.remote !== false ? remoteReadPolicySql(engine, alias) : excludePrivate ? privatePagesFilterForCaller(alias) : 'TRUE',
    since: new Date(now.getTime() - VALUE_WINDOW_DAYS * 86_400_000),
  };
}

export async function buildValueCard(ctx: OperationContext, opts: { now?: Date } = {}): Promise<ValueCard> {
  const now = opts.now ?? new Date();
  const reader = await readerFor(ctx, now);
  const rows: ValueRow[] = [];
  for (const [id, read] of ROWS) {
    const m = await read(reader).catch(failed);
    rows.push({ id, label: LABELS[id], ...m });
  }
  const attempted = rows.filter(r => r.status !== 'off' && !EXCLUDED_CODES.has(r.code ?? ''));
  const failures = attempted.filter(r => r.status === 'unavailable');
  if (attempted.length > 0 && failures.length === attempted.length) {
    throw opError('value_unavailable', 'Every count on the value card failed to read, so nothing was counted: ' + failures.map(f => f.id + ' (' + f.code + ')').join(', ') + '.',
      'Run gbrain doctor --json on the brain host to see why the brain cannot be read.');
  }
  return {
    schema: VALUE_SCHEMA, schema_version: VALUE_SCHEMA_VERSION, generated_at: now.toISOString(), window_days: VALUE_WINDOW_DAYS,
    view: reader.ownerView ? 'owner' : 'member', state: failures.length ? 'degraded' : 'complete', rows,
  };
}

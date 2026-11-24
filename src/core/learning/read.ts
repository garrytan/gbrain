/**
 * Nightly learning PR 1: the learned read view. Each ledger pointer is rendered from its live target under the
 * caller's filters, the ones extraction_pending's review lists use (review-lists.ts): fact visibility by
 * worldOnlyFacts, the provenance policy, the deleted-page projection, and the page read policy for pages and loop
 * evidence. A target that was forgotten, purged, deleted or relabelled out of the caller's reach is hidden. Text below
 * the caller's tier comes back quoted as source material (quoteFacts). Showing an item stamps its shown_at.
 */

import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { deletedPageProjectionHiddenSql } from '../eligibility/sql.ts';
import { ownerMemberId } from '../access/owner.ts';
import { callerIsOwner, currentCallerAccess, privatePagesFilterForCaller, privateProvenanceFilterUnderPolicy, resolveExcludePrivatePages, worldOnlyFacts } from '../search/private-visibility.ts';
import { remoteReadPolicySql } from '../persistence/page-visibility.ts';
import { quoteFacts } from '../search/transcript-quote.ts';
import { CHANGE_KINDS, CONFLICT_BACKLOG_SQL, QUESTION_KINDS, type LearningKind } from './kinds.ts';

export const LEARNED_DEFAULT_LIMIT = 15;
export const LEARNED_MAX_LIMIT = 100;
export const LEARNED_WINDOW_DAYS = 7;
/** Kind priority: questions first, then what changed, then the owner's own fence rows. */
export const KIND_ORDER: readonly LearningKind[] = ['conflict_found', 'promise_found', 'fact_added', 'page_filled', 'you_wrote'];

export interface LearnedEvidence { slug?: string; source_id: string; fact_id?: string; loop_id?: string; proposal_id?: string; version_id?: string; prior_revision?: string; thread_id?: string; read?: string[] }
export interface LearnedItem {
  id: string;
  n: number;
  kind: LearningKind;
  family: 'change' | 'question' | 'informational';
  state: string;
  created_at: string;
  shown_at: string | null;
  source_id: string;
  subject: string | null;
  text: string;
  quoted?: 'transcript';
  evidence: LearnedEvidence[];
}

/**
 * The live filters for one caller, resolved once per read: whether facts are world-only, whether the provenance policy
 * applies, the page read policy over the two page aliases the queries use, and whether the caller reads the whole
 * ledger (a trusted local caller or the brain owner), which decides whether counts may include what it cannot read.
 */
export interface CallerFilters { worldOnly: boolean; excludePrivate: boolean; pages: { p: string; lp: string }; full: boolean }

export async function callerFilters(engine: BrainEngine, ctx: OperationContext): Promise<CallerFilters> {
  const excludePrivate = await resolveExcludePrivatePages(engine, ctx.remote);
  const policy = async (alias: string) => ctx.remote !== false ? await remoteReadPolicySql(engine, alias) : excludePrivate ? privatePagesFilterForCaller(alias) : 'TRUE';
  return { worldOnly: worldOnlyFacts(ctx.remote), excludePrivate, pages: { p: await policy('p'), lp: await policy('lp') }, full: ctx.remote === false || callerIsOwner() };
}

const iso = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const ITEM_COLUMNS = `li.id, li.kind, li.state, li.source_id, li.subject_slug, li.prior_revision, ${iso('li.created_at')} AS created_at, ${iso('li.shown_at')} AS shown_at`;

function liveFactSql(a: string, f: CallerFilters): string {
  const visibility = f.worldOnly ? ` AND ${a}.visibility = 'world'` : '';
  const provenance = f.excludePrivate ? ` AND ${privateProvenanceFilterUnderPolicy(a)}` : '';
  return `${a}.expired_at IS NULL AND (${a}.valid_until IS NULL OR ${a}.valid_until > now())${visibility}${provenance}
    AND ${deletedPageProjectionHiddenSql('facts', a)}`;
}

/** Window: $1 source ids (null: every source), $2 start, $3 unseen pending only, $4 row cap. */
const WINDOW_SQL = `($1::text[] IS NULL OR li.source_id = ANY($1::text[])) AND li.created_at >= $2::timestamptz
  AND ($3::boolean = false OR (li.state = 'pending' AND li.shown_at IS NULL))`;

type Row = Record<string, unknown> & { id: number | string; kind: LearningKind; state: string; source_id: string; subject_slug: string | null; prior_revision: string | null; created_at: string; shown_at: string | null };

function queries(f: CallerFilters): Array<{ kinds: LearningKind[]; sql: string }> {
  return [
    { kinds: ['fact_added', 'you_wrote'], sql: `SELECT ${ITEM_COLUMNS}, f.id AS fact_id, f.fact, f.source, f.entity_slug, f.source_markdown_slug
        FROM learning_items li JOIN facts f ON f.id = li.target_id
       WHERE li.kind IN ('fact_added', 'you_wrote') AND li.target_table = 'facts' AND ${WINDOW_SQL} AND ${liveFactSql('f', f)}
       ORDER BY li.created_at DESC, li.id DESC LIMIT $4` },
    { kinds: ['conflict_found'], sql: `SELECT ${ITEM_COLUMNS}, d.id AS proposal_id, n.id AS new_id, n.fact AS new_fact, n.source AS new_source,
             o.id AS old_id, o.fact AS old_fact, o.source AS old_source, n.entity_slug, COALESCE(n.source_markdown_slug, o.source_markdown_slug) AS slug
        FROM learning_items li JOIN decide_proposals d ON d.id = li.target_id
        JOIN facts n ON n.id = d.new_fact_id AND n.source_id = d.source_id JOIN facts o ON o.id = d.old_fact_id AND o.source_id = d.source_id
       WHERE li.kind = 'conflict_found' AND li.target_table = 'decide_proposals' AND d.status = 'pending' AND ${WINDOW_SQL}
         AND ${liveFactSql('n', f)} AND ${liveFactSql('o', f)}
       ORDER BY li.created_at DESC, li.id DESC LIMIT $4` },
    { kinds: ['promise_found'], sql: `SELECT ${ITEM_COLUMNS}, l.id AS loop_id, l.summary, l.counterparty_slug, l.page_slug, l.thread_id
        FROM learning_items li JOIN open_loops l ON l.id = li.target_id
       WHERE li.kind = 'promise_found' AND li.target_table = 'open_loops' AND l.status = 'open' AND ${WINDOW_SQL}
         AND (l.page_slug IS NULL OR NOT EXISTS (SELECT 1 FROM pages lp WHERE lp.source_id = l.source_id AND lp.slug = l.page_slug
              AND (lp.deleted_at IS NOT NULL OR NOT ${f.pages.lp})))
       ORDER BY li.created_at DESC, li.id DESC LIMIT $4` },
    { kinds: ['page_filled'], sql: `SELECT ${ITEM_COLUMNS}, v.id AS version_id, p.slug, p.title
        FROM learning_items li JOIN page_versions v ON v.id = li.target_id JOIN pages p ON p.id = v.page_id
       WHERE li.kind = 'page_filled' AND li.target_table = 'page_versions' AND p.deleted_at IS NULL AND ${WINDOW_SQL} AND ${f.pages.p}
       ORDER BY li.created_at DESC, li.id DESC LIMIT $4` },
  ];
}

const familyOf = (kind: LearningKind): LearnedItem['family'] =>
  CHANGE_KINDS.includes(kind) ? 'change' : QUESTION_KINDS.includes(kind) ? 'question' : 'informational';
const read = (slug: unknown) => (typeof slug === 'string' && slug ? ['gbrain', 'get', slug] : undefined);

/** The pointers in the window whose live target the caller can read, rendered, best first. */
export async function liveItems(engine: BrainEngine, ctx: OperationContext, f: CallerFilters,
  window: { sourceIds: string[] | null; since: Date; unseenOnly: boolean; limit: number }): Promise<LearnedItem[]> {
  const params = [window.sourceIds, window.since.toISOString(), window.unseenOnly, window.limit];
  const rows = (await Promise.all(queries(f).map(q => engine.executeRaw<Row>(q.sql, params)))).flat();
  const facts = rows.filter(r => r.kind === 'fact_added' || r.kind === 'you_wrote').map(r => ({ id: Number(r.fact_id), fact: String(r.fact), source: r.source as string | null }));
  const conflictFacts = rows.filter(r => r.kind === 'conflict_found').flatMap(r => [
    { id: Number(r.new_id), fact: String(r.new_fact), source: r.new_source as string | null },
    { id: Number(r.old_id), fact: String(r.old_fact), source: r.old_source as string | null }]);
  const quoted = new Map((await quoteFacts(engine, [...facts, ...conflictFacts], ctx.remote !== false)).map(q => [q.id, q]));
  const items = rows.map((r): Omit<LearnedItem, 'n'> => {
    const base = { id: String(r.id), kind: r.kind, family: familyOf(r.kind), state: r.state, created_at: r.created_at, shown_at: r.shown_at, source_id: r.source_id };
    if (r.kind === 'conflict_found') {
      const [newer, older] = [quoted.get(Number(r.new_id)), quoted.get(Number(r.old_id))];
      return { ...base, subject: (r.entity_slug as string | null) ?? null, text: `Newer: ${newer?.fact ?? r.new_fact}\nOlder: ${older?.fact ?? r.old_fact}`,
        ...(newer?.quoted || older?.quoted ? { quoted: 'transcript' as const } : {}),
        evidence: [{ source_id: r.source_id, proposal_id: String(r.proposal_id), fact_id: String(r.new_id), ...(r.slug ? { slug: String(r.slug), read: read(r.slug) } : {}) },
          { source_id: r.source_id, fact_id: String(r.old_id) }] };
    }
    if (r.kind === 'promise_found') {
      return { ...base, subject: (r.counterparty_slug as string | null) ?? null, text: String(r.summary),
        evidence: [{ source_id: r.source_id, loop_id: String(r.loop_id), ...(r.page_slug ? { slug: String(r.page_slug), read: read(r.page_slug) } : {}),
          ...(r.thread_id && ctx.remote === false ? { thread_id: String(r.thread_id) } : {}) }] };
    }
    if (r.kind === 'page_filled') {
      return { ...base, subject: String(r.slug), text: `Filled in the thin page ${String(r.title)}`,
        evidence: [{ source_id: r.source_id, slug: String(r.slug), version_id: String(r.version_id), ...(r.prior_revision ? { prior_revision: String(r.prior_revision) } : {}), read: read(r.slug) }] };
    }
    const fact = quoted.get(Number(r.fact_id));
    const slug = (r.source_markdown_slug ?? r.entity_slug) as string | null;
    return { ...base, subject: (r.entity_slug as string | null) ?? null, text: fact?.fact ?? String(r.fact), ...(fact?.quoted ? { quoted: fact.quoted } : {}),
      evidence: [{ source_id: r.source_id, fact_id: String(r.fact_id), ...(slug ? { slug, read: read(slug) } : {}) }] };
  });
  const rank = (k: LearningKind) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };
  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || b.created_at.localeCompare(a.created_at) || Number(b.id) - Number(a.id))
    .slice(0, window.limit).map((item, i) => ({ ...item, n: i + 1 }));
}

export interface LearnedView {
  window: { since: string; default: boolean };
  count: number;
  items: LearnedItem[];
  conflict_backlog: { count: number; command: string[] } | null;
}

/**
 * The note: unseen pending items of the last seven days by default, or every item since `since`. Stamps shown_at on
 * what it returns, only for a caller that reads the whole ledger (local, or the owner's token) or the unbound stdio pipe
 * of a brain with no owner (the user's own agent), and never for a local `--as` preview, so a narrower reader never
 * uses up the owner's unseen view.
 */
export async function readLearned(engine: BrainEngine, ctx: OperationContext,
  opts: { sourceIds: string[] | null; since?: Date; limit: number; now?: Date }): Promise<LearnedView> {
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - LEARNED_WINDOW_DAYS * 86_400_000);
  const f = await callerFilters(engine, ctx);
  const items = await liveItems(engine, ctx, f, { sourceIds: opts.sourceIds, since, unseenOnly: opts.since === undefined, limit: opts.limit });
  const singleUserPipe = ctx.transport === 'stdio' && !ctx.auth && currentCallerAccess().identity.length === 0 && !(await ownerMemberId(engine));
  if (!ctx.dryRun && items.length && (f.full || singleUserPipe) && !ctx.applyRemoteReadPolicy && !ctx.accessIdentity) {
    await engine.executeRaw(`UPDATE learning_items SET shown_at = now(), member_id = COALESCE(member_id, $2) WHERE id = ANY($1::bigint[]) AND shown_at IS NULL`,
      [items.map(i => i.id), ctx.auth?.member?.id ?? null]);
  }
  const backlog = f.full ? Number((await engine.executeRaw<{ n: number | string }>(CONFLICT_BACKLOG_SQL, [opts.sourceIds]))[0]?.n ?? 0) : 0;
  return {
    window: { since: since.toISOString(), default: opts.since === undefined },
    count: items.length, items,
    conflict_backlog: backlog > 0 ? { count: backlog, command: ['gbrain', 'decide', 'proposals', 'list'] } : null,
  };
}

const KIND_HEADINGS: Record<string, string> = {
  conflict_found: 'Facts that disagree (which one is right?)',
  promise_found: 'Promises people made to you',
  fact_added: 'New facts',
  page_filled: 'Thin pages filled in',
  you_wrote: 'You wrote (from your own Facts fences; not counted)',
};

/** The CLI's text form: every returned item (the ones the read stamped) grouped by kind, each number bound to its stable item id. */
export function formatLearned(view: LearnedView): string {
  const shown = view.items;
  if (!shown.length && !view.conflict_backlog) return `Nothing new learned since ${view.window.since.slice(0, 10)}.\n`;
  const lines = [`What I learned since ${view.window.since.slice(0, 16).replace('T', ' ')} UTC (${shown.length} item${shown.length === 1 ? '' : 's'}):`];
  for (const kind of KIND_ORDER) {
    const group = shown.filter(i => i.kind === kind);
    if (!group.length) continue;
    lines.push('', KIND_HEADINGS[kind] ?? kind);
    for (const item of group) {
      const [first, ...rest] = item.text.split('\n');
      lines.push(`  ${item.n}. ${first}`, ...rest.map(l => `     ${l}`));
      const slug = item.evidence.find(e => e.slug)?.slug;
      lines.push(`     [item ${item.id}]${slug ? ` from ${slug}` : ''}`);
    }
  }
  if (view.conflict_backlog) lines.push('', `${view.conflict_backlog.count} older pair(s) of disagreeing facts are waiting; review them with: ${view.conflict_backlog.command.join(' ')}`);
  return lines.join('\n') + '\n';
}

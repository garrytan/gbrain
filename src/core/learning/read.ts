/**
 * Nightly learning PR 1: the learned read view. Each ledger pointer is rendered from its live target under the
 * caller's filters, the ones extraction_pending's review lists use (review-lists.ts): fact visibility by
 * worldOnlyFacts, the provenance policy, the deleted-page projection, and the page read policy for pages and loop
 * evidence. A target that was forgotten, purged, deleted or relabelled out of the caller's reach is hidden. Text below
 * the caller's tier comes back quoted as source material (quoteFacts). Showing an item stamps its shown_at.
 */

import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { ownerMemberId } from '../access/owner.ts';
import { callerIsOwner, currentCallerAccess, privatePagesFilterForCaller, privateProvenanceFilterUnderPolicy, resolveExcludePrivatePages, worldOnlyFacts } from '../search/private-visibility.ts';
import { remoteReadPolicySql } from '../persistence/page-visibility.ts';
import { quoteFacts } from '../search/transcript-quote.ts';
import { CHANGE_KINDS, CONFLICT_BACKLOG_SQL, KEYLESS_THIN_CONTACTS_KEY, QUESTION_KINDS, type LearningKind } from './kinds.ts';
import { isAvailable } from '../ai/gateway.ts';
import type { LiveDuplicate } from './duplicates.ts';

export const LEARNED_DEFAULT_LIMIT = 15;
export const LEARNED_MAX_LIMIT = 100;
export const LEARNED_WINDOW_DAYS = 7;
/** Kind priority: questions first, then what changed, then the owner's own fence rows. */
export const KIND_ORDER: readonly LearningKind[] = ['conflict_found', 'duplicate_to_confirm', 'promise_found', 'fact_added', 'page_filled', 'you_wrote'];

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
  /** duplicate_to_confirm: the gbrain dedupe commands that answer it (trusted-local; a remote caller gets the text only). */
  commands?: { confirm?: string[]; reject: string[] };
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
    AND ${projectionEligibleSql('facts', a, undefined)}`;
}

/** Window: $1 source ids (null: every source), $2 start, $3 unseen pending only, $4 row cap. */
const WINDOW_SQL = `($1::text[] IS NULL OR li.source_id = ANY($1::text[])) AND li.created_at >= $2::timestamptz
  AND ($3::boolean = false OR (li.state = 'pending' AND li.shown_at IS NULL))`;

/**
 * Duplicate questions hold one of the five open slots until they are answered, so the default note keeps showing a
 * pending one whether or not it was shown or is older than the window; `since` still bounds them by date.
 */
const QUESTION_WINDOW_SQL = `($1::text[] IS NULL OR li.source_id = ANY($1::text[]))
  AND (CASE WHEN $3::boolean THEN li.state = 'pending' ELSE li.created_at >= $2::timestamptz END)`;

/**
 * The window's pointers of the given kinds, picked first; each target is then a keyed LATERAL lookup, so a stale row
 * estimate (a bulk insert with no ANALYZE since) cannot turn the target joins into a scan of every fact and proposal.
 */
const windowed = (kinds: string, table: string) => `WITH li AS MATERIALIZED (SELECT * FROM learning_items li WHERE li.kind IN (${kinds}) AND li.target_table = '${table}' AND ${WINDOW_SQL})`;

type Row = Record<string, unknown> & { id: number | string; kind: LearningKind; state: string; source_id: string; subject_slug: string | null; prior_revision: string | null; created_at: string; shown_at: string | null };

function queries(f: CallerFilters): Array<{ kinds: LearningKind[]; sql: string }> {
  return [
    { kinds: ['fact_added', 'you_wrote'], sql: `${windowed("'fact_added', 'you_wrote'", 'facts')} SELECT ${ITEM_COLUMNS}, f.id AS fact_id, f.fact, f.source, f.entity_slug, f.source_markdown_slug
        FROM li JOIN LATERAL (SELECT * FROM facts f WHERE f.id = li.target_id OFFSET 0) f ON TRUE
       WHERE ${liveFactSql('f', f)}
       ORDER BY li.created_at DESC, li.id DESC LIMIT $4` },
    { kinds: ['conflict_found'], sql: `${windowed("'conflict_found'", 'decide_proposals')} SELECT ${ITEM_COLUMNS}, d.id AS proposal_id, n.id AS new_id, n.fact AS new_fact, n.source AS new_source,
             o.id AS old_id, o.fact AS old_fact, o.source AS old_source, n.entity_slug, COALESCE(n.source_markdown_slug, o.source_markdown_slug) AS slug
        FROM li JOIN LATERAL (SELECT * FROM decide_proposals d WHERE d.id = li.target_id OFFSET 0) d ON TRUE
        JOIN LATERAL (SELECT * FROM facts n WHERE n.id = d.new_fact_id AND n.source_id = d.source_id OFFSET 0) n ON TRUE
        JOIN LATERAL (SELECT * FROM facts o WHERE o.id = d.old_fact_id AND o.source_id = d.source_id OFFSET 0) o ON TRUE
       WHERE d.status = 'pending'
         AND ${liveFactSql('n', f)} AND ${liveFactSql('o', f)}
       ORDER BY li.created_at DESC, li.id DESC LIMIT $4` },
    { kinds: ['promise_found'], sql: `${windowed("'promise_found'", 'open_loops')} SELECT ${ITEM_COLUMNS}, l.id AS loop_id, l.summary, l.counterparty_slug, l.page_slug, l.thread_id
        FROM li JOIN LATERAL (SELECT * FROM open_loops l WHERE l.id = li.target_id OFFSET 0) l ON TRUE
       WHERE l.status = 'open'
         AND (l.page_slug IS NULL OR NOT EXISTS (SELECT 1 FROM pages lp WHERE lp.source_id = l.source_id AND lp.slug = l.page_slug
              AND (lp.deleted_at IS NOT NULL OR NOT ${f.pages.lp})))
       ORDER BY li.created_at DESC, li.id DESC LIMIT $4` },
    { kinds: ['page_filled'], sql: `${windowed("'page_filled'", 'page_versions')} SELECT ${ITEM_COLUMNS}, v.id AS version_id, p.slug, p.title
        FROM li JOIN LATERAL (SELECT v.id, v.page_id FROM page_versions v WHERE v.id = li.target_id OFFSET 0) v ON TRUE
        JOIN pages p ON p.id = v.page_id
       WHERE p.deleted_at IS NULL AND ${f.pages.p}
       ORDER BY li.created_at DESC, li.id DESC LIMIT $4` },
    { kinds: ['duplicate_to_confirm'], sql: `WITH li AS MATERIALIZED (SELECT * FROM learning_items li WHERE li.kind = 'duplicate_to_confirm' AND li.target_table = 'pages' AND ${QUESTION_WINDOW_SQL})
      SELECT ${ITEM_COLUMNS}, li.target_id AS anchor_id
        FROM li ORDER BY li.id ASC LIMIT GREATEST($4::int, ${DUPLICATE_ROWS_READ})` },
  ];
}

/** Duplicate rows read before the live check drops answered groups, so answered rows never crowd out open ones under the limit. */
const DUPLICATE_ROWS_READ = 500;

/**
 * Keeps a duplicate_to_confirm row only while the preview still holds a group anchored at its page and the caller can
 * read every member page (the page read policy), in its own sources when remote; the row then carries that group. The preview is read
 * only when the window holds such a row.
 */
async function withLiveDuplicates(engine: BrainEngine, f: CallerFilters, sourceIds: string[] | null, remote: boolean, rows: Row[]): Promise<Row[]> {
  const anchors = rows.filter(r => r.kind === 'duplicate_to_confirm').map(r => Number(r.anchor_id));
  if (!anchors.length) return rows;
  const { liveDuplicateGroups } = await import('./duplicates.ts');
  const live = await liveDuplicateGroups(engine, anchors);
  const pageIds = [...live.values()].flatMap(g => g.members.map(m => m.page_id));
  const readable = new Set((await engine.executeRaw<{ id: number | string }>(`SELECT p.id FROM pages p WHERE p.id = ANY($1::bigint[]) AND p.deleted_at IS NULL AND ${f.pages.p}`, [pageIds])).map(r => Number(r.id)));
  return rows.flatMap(r => {
    if (r.kind !== 'duplicate_to_confirm') return [r];
    const g = live.get(Number(r.anchor_id));
    const visible = g?.members.every(m => readable.has(m.page_id) && (!remote || !sourceIds || sourceIds.includes(m.source_id)));
    return visible ? [{ ...r, duplicate: g }] : [];
  });
}

const familyOf = (kind: LearningKind): LearnedItem['family'] =>
  CHANGE_KINDS.includes(kind) ? 'change' : QUESTION_KINDS.includes(kind) ? 'question' : 'informational';
const read = (slug: unknown) => (typeof slug === 'string' && slug ? ['gbrain', 'get', slug] : undefined);

/** The pointers in the window whose live target the caller can read, rendered, best first. */
export async function liveItems(engine: BrainEngine, ctx: OperationContext, f: CallerFilters,
  window: { sourceIds: string[] | null; since: Date; unseenOnly: boolean; limit: number }): Promise<LearnedItem[]> {
  const params = [window.sourceIds, window.since.toISOString(), window.unseenOnly, window.limit];
  const rows = await withLiveDuplicates(engine, f, window.sourceIds, ctx.remote !== false, (await Promise.all(queries(f).map(q => engine.executeRaw<Row>(q.sql, params)))).flat());
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
    if (r.kind === 'duplicate_to_confirm') {
      const live = r.duplicate as LiveDuplicate;
      return { ...base, subject: r.subject_slug, text: `Same person? ${live.members.map(m => `${m.title} (${m.source_id}:${m.slug})`).join(', ')}`,
        commands: live.commands, evidence: live.members.map(m => ({ source_id: m.source_id, slug: m.slug, read: read(m.slug) })) };
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
  const within = (a: Omit<LearnedItem, 'n'>, b: Omit<LearnedItem, 'n'>) => a.kind === 'duplicate_to_confirm'
    ? Number(a.id) - Number(b.id)
    : b.created_at.localeCompare(a.created_at) || Number(b.id) - Number(a.id);
  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || within(a, b))
    .slice(0, window.limit).map((item, i) => ({ ...item, n: i + 1 }));
}

export interface LearnedView {
  window: { since: string; default: boolean };
  count: number;
  items: LearnedItem[];
  conflict_backlog: { count: number; command: string[] } | null;
  /** Keyless brains, owner and local callers only: thin pages of people the owner is in touch with that a chat key would fill. */
  thin_contacts: ThinContactsLine | null;
}

export interface ThinContactsLine { count: number; text: string; commands: string[][]; cost: { usd: number; basis: 'daily_cap' | 'per_page_estimate' } }

/** The keyless line from the last learning_derive count; nothing once a chat model is configured or the count is stale. */
async function thinContactsLine(engine: BrainEngine, now: Date): Promise<ThinContactsLine | null> {
  if (isAvailable('chat')) return null;
  const raw = await engine.getConfig(KEYLESS_THIN_CONTACTS_KEY);
  if (!raw) return null;
  let stored: { count?: unknown; cost_usd?: unknown; cost_basis?: unknown; recorded_at?: unknown };
  try { stored = JSON.parse(raw); } catch { return null; }
  const count = Number(stored.count);
  const age = now.getTime() - Date.parse(String(stored.recorded_at));
  if (!Number.isInteger(count) || count <= 0 || !(age <= LEARNED_WINDOW_DAYS * 86_400_000)) return null;
  return {
    count,
    text: count === 1 ? '1 close contact has a thin page; a chat key would fill it.' : count + ' close contacts have thin pages; a chat key would fill them.',
    commands: [['export', 'ANTHROPIC_API_KEY=<your key>'], ['gbrain', 'config', 'set', 'cycle.enrich_thin.enabled', 'true']],
    cost: { usd: Number(stored.cost_usd), basis: stored.cost_basis === 'daily_cap' ? 'daily_cap' : 'per_page_estimate' },
  };
}

/**
 * The note: unseen pending items of the last seven days by default (plus every open duplicate question), or every item since `since`. Stamps shown_at on
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
    thin_contacts: f.full ? await thinContactsLine(engine, now) : null,
  };
}

const KIND_HEADINGS: Record<string, string> = {
  conflict_found: 'Facts that disagree (which one is right?)',
  duplicate_to_confirm: 'People who may be the same person (confirm or reject)',
  promise_found: 'Promises people made to you',
  fact_added: 'New facts',
  page_filled: 'Thin pages filled in',
  you_wrote: 'You wrote (from your own Facts fences; not counted)',
};

/** The CLI's text form: every returned item (the ones the read stamped) grouped by kind, each number bound to its stable item id. */
export function formatLearned(view: LearnedView): string {
  const shown = view.items;
  if (!shown.length && !view.conflict_backlog && !view.thin_contacts) return `Nothing new learned since ${view.window.since.slice(0, 10)}.\n`;
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
      if (item.commands?.confirm) lines.push(`     same person: ${item.commands.confirm.join(' ')}`);
      if (item.commands) lines.push(`     different people: ${item.commands.reject.join(' ')}`);
    }
  }
  const thin = view.thin_contacts;
  if (thin) {
    const cost = thin.cost.basis === 'daily_cap' ? 'at most $' + thin.cost.usd.toFixed(2) + ' a day (your daily cap)' : 'about $' + thin.cost.usd.toFixed(2) + ' (estimate)';
    lines.push('', thin.text + ' Filling them costs ' + cost + '. To turn it on:', ...thin.commands.map(c => '  ' + c.join(' ')));
  }
  if (view.conflict_backlog) lines.push('', `${view.conflict_backlog.count} older pair(s) of disagreeing facts are waiting; review them with: ${view.conflict_backlog.command.join(' ')}`);
  return lines.join('\n') + '\n';
}

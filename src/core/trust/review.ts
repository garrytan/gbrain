/**
 * The owner review queue and `trust explain` (#5575: CEO-2, DX-7, DX-10,
 * DX-14, DX-16, ENG-22). One read-only view over existing state, with the
 * complete command for every decision:
 *
 * - pending trust proposals of every action (`tp<id>`): guarded
 *   supersessions, guarded forgets, and pages an agent edit lowered (CEO-12);
 * - unconfirmed standing preferences: facts of kind preference/commitment at
 *   agent_written or lower that the write gate flagged `standing_instruction`;
 * - write-gate holds (`h<id>`);
 * - the owner's active allow rules (`a<id>`) and the kill-switch state.
 *
 * Items are grouped by day and page (many agent edits to one page are one
 * item, ENG-22). `gbrain quarantine list` and `gbrain decide proposals` keep
 * listing their own items. No content leaves this host: the CLI and the
 * resident owner's IPC administration are the only callers.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { currentHoldStore, trustKillSwitchState } from './owner-actions.ts';
import { getTrustProposal, listTrustProposals, pendingTrustProposalsFor, trustProposalRef, type TrustProposalAction, type TrustProposalRow } from './proposals.ts';
import { lowerPageState, readPageTrustState } from './page-handlers.ts';
import { formatTrustRef, pageRef, parseTrustRef, resolvePageRef } from './refs.ts';
import { compareTrust, OWNER_TIER_FLOOR, storedTrustTier, trustLabel, USER_SAID_ORIGIN_MARKER, type TrustTier } from './tier.ts';
import { isUserSaid, trustFields, trustLabelWords } from '../eligibility/labels.ts';
import { ACTIVATION_REASON_FAMILIES, ACTIVATION_TIER_CEILING } from '../eligibility/sql.ts';
import { claimPendingSql, TRUST_CLAIM_RESUME_COMMAND } from './claim-state.ts';
import { listTrustAllowRules, type TrustAllowRule } from './allow-rules.ts';
import { isQuarantined } from '../quarantine.ts';

export const TRUST_REVIEW_KINDS = ['proposal', 'lowered_page', 'preference', 'hold'] as const;
export type TrustReviewKind = typeof TRUST_REVIEW_KINDS[number];

export interface TrustReviewItem {
  ref: string;
  kind: TrustReviewKind;
  /** The proposal action, `preference`/`commitment`, or the held row kind. */
  detail: string;
  source_id: string;
  /** `p:<source>/<slug>` of the page the item belongs to, or null. */
  page: string | null;
  /** UTC day the item was created or last seen (YYYY-MM-DD). */
  day: string;
  created_at: string;
  tier: TrustTier;
  label: string;
  summary: string;
  /** Complete argv per decision (DX-7). Tier-raising ones are the user's to run on a TTY (DX-3). */
  commands: Partial<Record<'confirm' | 'drop' | 'release' | 'revert' | 'explain', string[]>>;
}

export interface TrustReviewFilter {
  /** `--from <source>` */
  sourceId?: string;
  /** `--kind`: a review kind or a proposal action. */
  kind?: string;
  /** `--since` */
  since?: Date;
}

export interface TrustReview {
  schema_version: 1;
  items: TrustReviewItem[];
  groups: Array<{ day: string; page: string | null; refs: string[] }>;
  allow_rules: Array<TrustAllowRule & { remove: string[] }>;
  kill_switch: { state: 'disabled' | 'enabled' | null; at: string | null; undo: string[] | null };
  counts: Record<TrustReviewKind, number>;
}

const PROPOSAL_ACTIONS: readonly string[] = ['supersede_fact', 'supersede_take', 'forget', 'lower_page', 'confirm'];
const day = (iso: string): string => iso.slice(0, 10);
const snippet = (text: unknown, max = 80): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};
const trust = (...args: string[]): string[] => ['gbrain', 'trust', ...args];
const rowRef = (table: string | null, id: number | null): string => id === null ? '' : `${table === 'facts' ? 'f' : table === 'takes' ? 't' : table === 'pages' ? 'page ' : ''}${id}`;

export function parseTrustReviewKind(value: string): string {
  if ((TRUST_REVIEW_KINDS as readonly string[]).includes(value) || PROPOSAL_ACTIONS.includes(value)) return value;
  throw opError('invalid_params', `--kind must be one of ${[...TRUST_REVIEW_KINDS, ...PROPOSAL_ACTIONS].join(', ')}.`,
    `Pass --kind with one of: ${[...TRUST_REVIEW_KINDS, ...PROPOSAL_ACTIONS].join(', ')}.`);
}

/** `--since` as an ISO date/time or a relative duration (`7d`, `12h`). */
export function parseTrustSince(value: string, now = Date.now()): Date {
  const rel = /^(\d{1,4})([dh])$/.exec(value);
  if (rel) return new Date(now - Number(rel[1]) * (rel[2] === 'd' ? 86_400_000 : 3_600_000));
  const at = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(at.getTime())) {
    throw opError('invalid_params', `--since must be a date (2026-10-01) or a duration (7d, 12h); got ${JSON.stringify(value)}.`, 'Pass --since 7d or --since 2026-10-01.');
  }
  return at;
}

const wants = (filter: TrustReviewFilter, kind: TrustReviewKind, action?: string): boolean =>
  !filter.kind || filter.kind === kind || (action !== undefined && filter.kind === action);

async function pageOf(engine: BrainEngine, p: TrustProposalRow): Promise<string | null> {
  if (p.target_table === 'pages') {
    const slug = typeof p.before_state.slug === 'string' ? p.before_state.slug
      : (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE id = $1', [p.target_id]))[0]?.slug;
    return slug ? pageRef(p.source_id, slug) : null;
  }
  if (p.target_table === 'facts') {
    const [f] = await engine.executeRaw<{ slug: string | null }>('SELECT source_markdown_slug AS slug FROM facts WHERE id = $1', [p.target_id]);
    return f?.slug ? pageRef(p.source_id, f.slug) : null;
  }
  if (p.target_table === 'takes') {
    const [t] = await engine.executeRaw<{ slug: string }>('SELECT p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = $1', [p.target_id]);
    return t ? pageRef(p.source_id, t.slug) : null;
  }
  return null;
}

function proposalItem(p: TrustProposalRow, page: string | null): TrustReviewItem {
  const ref = trustProposalRef(p.id);
  if (p.action === 'lower_page') {
    const s = lowerPageState(p);
    return {
      ref, kind: 'lowered_page', detail: p.action, source_id: p.source_id, page, day: day(p.updated_at), created_at: p.created_at,
      tier: s.edited_tier, label: trustLabel(s.edited_tier),
      summary: `An agent edit lowered ${page ?? `page ${p.target_id}`} from "${trustLabel(s.prior_tier)}" to "${trustLabel(s.edited_tier)}"`,
      commands: { confirm: trust('confirm', ref), ...(s.version_id !== null ? { revert: trust('revert', ref) } : {}), drop: trust('drop', ref), explain: trust('explain', ref) },
    };
  }
  const tier = storedTrustTier(p.after_state.tier ?? p.before_state.related_tier ?? p.before_state.new_tier);
  const target = rowRef(p.target_table, p.target_id);
  const related = rowRef(p.related_table, p.related_id);
  const what = p.action === 'forget' ? `An agent asked to forget ${target}`
    : `${related || 'A lower-trust write'} would ${p.action === 'confirm' ? 'confirm' : 'supersede'} ${target}`;
  return {
    ref, kind: 'proposal', detail: p.action, source_id: p.source_id, page, day: day(p.created_at), created_at: p.created_at,
    tier, label: trustLabel(tier), summary: `${what} (${p.proposer})`,
    commands: { confirm: trust('confirm', ref), drop: trust('drop', ref), explain: trust('explain', ref) },
  };
}

// The standing-preference flag lives in write_gate_receipts (the write gate); read when the table exists.
async function standingPreferences(engine: BrainEngine, filter: TrustReviewFilter): Promise<TrustReviewItem[]> {
  const [table] = await engine.executeRaw<{ t: string | null }>(`SELECT to_regclass('write_gate_receipts')::text AS t`);
  if (!table?.t) return [];
  const rows = await engine.executeRaw<{ id: number; source_id: string; kind: string; fact: string; trust_tier: string; slug: string | null; created_at: string }>(
    `SELECT f.id, f.source_id, f.kind, f.fact, f.trust_tier, f.source_markdown_slug AS slug, f.created_at FROM facts f
      WHERE f.kind IN ('preference', 'commitment') AND f.trust_tier IN ('agent_written', 'unknown', 'external_untrusted') AND f.expired_at IS NULL
        AND NOT (f.trust_tier = 'unknown' AND EXISTS (SELECT 1 FROM sources cs WHERE cs.id = f.source_id AND ${claimPendingSql('cs')}))
        AND ($1::text IS NULL OR f.source_id = $1) AND ($2::timestamptz IS NULL OR f.created_at >= $2)
        AND EXISTS (SELECT 1 FROM write_gate_receipts r WHERE r.target_table = 'facts' AND r.target_id = f.id::text
                      AND r.verdict = 'flag' AND 'standing_instruction' = ANY(r.reason_families))
      ORDER BY f.created_at, f.id LIMIT 1000`, [filter.sourceId ?? null, filter.since?.toISOString() ?? null]);
  return rows.map(r => {
    const ref = `f${Number(r.id)}`;
    const tier = storedTrustTier(r.trust_tier);
    const created = new Date(r.created_at).toISOString();
    return {
      ref, kind: 'preference' as const, detail: r.kind, source_id: r.source_id, page: r.slug ? pageRef(r.source_id, r.slug) : null,
      day: day(created), created_at: created, tier, label: trustLabel(tier),
      summary: `Unconfirmed standing ${r.kind}: "${snippet(r.fact)}" (not used proactively until you confirm it)`,
      commands: { confirm: trust('confirm', ref), explain: trust('explain', ref) },
    };
  });
}

async function holds(engine: BrainEngine, filter: TrustReviewFilter): Promise<TrustReviewItem[]> {
  return (await currentHoldStore().list(engine, { sourceId: filter.sourceId, since: filter.since })).map(h => ({
    ref: `h${h.id}`, kind: 'hold' as const, detail: h.kind, source_id: h.source_id, page: h.slug ? pageRef(h.source_id, h.slug) : null,
    day: day(h.last_seen_at), created_at: h.last_seen_at, tier: h.tier, label: trustLabel(h.tier),
    summary: `Held ${h.kind} "${snippet(h.payload.fact ?? h.payload.claim)}" (${h.reason_families.join(', ') || 'detector error'})`,
    commands: { release: trust('release', `h${h.id}`), drop: trust('drop', `h${h.id}`), explain: trust('explain', `h${h.id}`) },
  }));
}

/** The review queue, filtered. Read-only. */
export async function buildTrustReview(engine: BrainEngine, filter: TrustReviewFilter = {}): Promise<TrustReview> {
  const items: TrustReviewItem[] = [];
  if (wants(filter, 'proposal') || wants(filter, 'lowered_page') || (filter.kind && PROPOSAL_ACTIONS.includes(filter.kind))) {
    const action = filter.kind && PROPOSAL_ACTIONS.includes(filter.kind) ? filter.kind as TrustProposalAction
      : filter.kind === 'lowered_page' ? 'lower_page' : undefined;
    for (const p of await listTrustProposals(engine, { status: 'pending', sourceId: filter.sourceId, action, since: filter.since, limit: 1000 })) {
      if (filter.kind === 'proposal' && p.action === 'lower_page') continue;
      items.push(proposalItem(p, await pageOf(engine, p)));
    }
  }
  if (wants(filter, 'preference')) items.push(...await standingPreferences(engine, filter));
  if (wants(filter, 'hold')) items.push(...await holds(engine, filter));
  items.sort((a, b) => a.day.localeCompare(b.day) || (a.page ?? '').localeCompare(b.page ?? '') || a.created_at.localeCompare(b.created_at) || a.ref.localeCompare(b.ref));
  const groups: TrustReview['groups'] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.day === item.day && last.page === item.page) last.refs.push(item.ref);
    else groups.push({ day: item.day, page: item.page, refs: [item.ref] });
  }
  const rules = await listTrustAllowRules(engine, filter.sourceId ? { sourceIds: [filter.sourceId] } : {});
  const killSwitch = (await trustKillSwitchState(engine)).receipt;
  const counts = Object.fromEntries(TRUST_REVIEW_KINDS.map(kind => [kind, items.filter(i => i.kind === kind).length])) as Record<TrustReviewKind, number>;
  return {
    schema_version: 1, items, groups, counts,
    allow_rules: rules.map(rule => ({ ...rule, remove: trust('allow', '--remove', rule.ref) })),
    kill_switch: { state: killSwitch?.state ?? null, at: killSwitch?.at ?? null, undo: killSwitch?.state === 'disabled' ? trust('disable', '--all', '--undo') : null },
  };
}

const shellWord = (arg: string): string => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
export const renderArgv = (argv: readonly string[]): string => argv.map(shellWord).join(' ');

/** The human listing (pinned by the DX-16 snapshot test). */
export function renderTrustReview(review: TrustReview): string {
  const lines: string[] = [];
  if (review.kill_switch.state === 'disabled') {
    lines.push(`Memory trust protections are OFF (gbrain trust disable --all, ${review.kill_switch.at}). Turn them back on: ${renderArgv(review.kill_switch.undo!)}`, '');
  }
  if (review.items.length === 0) lines.push('Nothing is waiting for your review.');
  const byRef = new Map(review.items.map(item => [item.ref, item]));
  for (const group of review.groups) {
    lines.push(`${group.day}  ${group.page ?? '(no page)'}`);
    for (const ref of group.refs) {
      const item = byRef.get(ref)!;
      lines.push(`  ${item.ref.padEnd(6)} ${item.summary} [${item.label}]`);
      for (const [name, argv] of Object.entries(item.commands)) if (name !== 'explain') lines.push(`         ${name.padEnd(7)} ${renderArgv(argv!)}`);
    }
  }
  if (review.allow_rules.length) {
    lines.push('', 'Allow rules (instruction-like content from these is not held):');
    for (const rule of review.allow_rules) {
      lines.push(`  ${rule.ref.padEnd(6)} source ${rule.source_id}${rule.uri_prefix ? `, uri prefix ${rule.uri_prefix}` : ''}${rule.reason_family ? `, ${rule.reason_family} only` : ''}; added ${day(rule.created_at)} by ${rule.created_by}${rule.reason ? ` (${rule.reason})` : ''}`);
      lines.push(`         remove  ${renderArgv(rule.remove)}`);
    }
  }
  const c = review.counts;
  if (review.items.length) {
    lines.push('', `${review.items.length} item(s): ${c.proposal} proposal(s), ${c.lowered_page} lowered page(s), ${c.preference} unconfirmed preference(s), ${c.hold} held write(s).`,
      'Confirming or releasing raises trust: run the command yourself in a terminal and type the token it asks for. Explain any item: gbrain trust explain <ref>.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// explain (DX-10)
// ---------------------------------------------------------------------------

export interface TrustExplanation {
  ref: string;
  kind: 'fact' | 'take' | 'page' | 'hold' | 'proposal';
  source_id: string;
  tier: TrustTier;
  label: string;
  write_origin: Record<string, unknown> | null;
  /** Receipts from write_gate_receipts (the write gate), when the table exists. */
  gate: { verdict: 'flag' | 'quarantine' | 'none' | 'unavailable'; receipts: Array<{ id: number; verdict: string; reason_families: string[]; detector_version: number; last_seen_at: string }> };
  quarantined?: boolean;
  pending_proposals: Array<{ ref: string; action: string; commands: string[][] }>;
  activation: string;
  text?: string;
  /** The row is still `unknown` in a source the owner claimed whose lift has not finished: shown as owner tier. */
  claimed_source?: 'lift_pending';
  /** The owner's confirm command for a row the user told their agent (labeled USER_SAID_TRUST_LABEL). */
  confirm?: string[];
}

/**
 * A legacy `unknown` row in a claimed source whose lift has not finished is
 * labeled and explained as owner tier: the lift makes it so (or lower, by its
 * own signals; `gbrain trust claim-sources --resume` finishes it).
 */
async function claimView(engine: BrainEngine, sourceId: string, tier: TrustTier, writeOrigin: unknown, gate: TrustExplanation['gate']):
  Promise<{ tier: TrustTier; label: string; claimed_source?: 'lift_pending'; user_said?: true }> {
  // A flagged row reads "unconfirmed, …" (a user_said origin never softens it); a relayed user statement reads USER_SAID_TRUST_LABEL.
  const unconfirmed = compareTrust(tier, ACTIVATION_TIER_CEILING) <= 0 && gate.receipts.some(r => r.verdict === 'flag' && r.reason_families.some(f => ACTIVATION_FAMILIES.includes(f)));
  const fields = trustFields(tier, writeOrigin);
  if (tier !== 'unknown') return { tier, label: trustLabelWords(fields, { unconfirmed }), ...(isUserSaid(fields) && !unconfirmed ? { user_said: true as const } : {}) };
  const [pending] = await engine.executeRaw<{ id: string }>(`SELECT s.id FROM sources s WHERE s.id = $1 AND ${claimPendingSql('s')}`, [sourceId]);
  return pending
    ? { tier: OWNER_TIER_FLOOR, label: `${trustLabel(OWNER_TIER_FLOOR)} (claimed source; finish with ${TRUST_CLAIM_RESUME_COMMAND.join(' ')})`, claimed_source: 'lift_pending' }
    : { tier, label: trustLabelWords(fields, { unconfirmed }) };
}

// The write gate receipts for one row (write_gate_receipts), newest first.
async function gateReceipts(engine: BrainEngine, table: string, id: number): Promise<TrustExplanation['gate']> {
  const [exists] = await engine.executeRaw<{ t: string | null }>(`SELECT to_regclass('write_gate_receipts')::text AS t`);
  if (!exists?.t) return { verdict: 'unavailable', receipts: [] };
  const rows = await engine.executeRaw<{ id: number; verdict: string; reason_families: string[]; detector_version: number; last_seen_at: string }>(
    `SELECT id, verdict, reason_families, detector_version, last_seen_at FROM write_gate_receipts WHERE target_table = $1 AND target_id = $2 ORDER BY last_seen_at DESC LIMIT 5`,
    [table, String(id)]);
  const receipts = rows.map(r => ({ id: Number(r.id), verdict: r.verdict, reason_families: r.reason_families ?? [], detector_version: Number(r.detector_version), last_seen_at: new Date(r.last_seen_at).toISOString() }));
  return { verdict: (receipts[0]?.verdict as 'flag' | 'quarantine' | undefined) ?? 'none', receipts };
}

const ACTIVATION_FAMILIES: readonly string[] = ACTIVATION_REASON_FAMILIES;

/** CEO-20, per surface: where this row is used. */
async function activationNote(engine: BrainEngine, tier: TrustTier, gate: TrustExplanation['gate'], quarantined: boolean, label: string): Promise<string> {
  if (quarantined) return 'Quarantined: hidden from search, recall and every proactive surface until released.';
  const flagged = gate.receipts.some(r => r.verdict === 'flag' && r.reason_families.some(f => ACTIVATION_FAMILIES.includes(f)));
  const lowTier = !['user_confirmed', 'operator_curated', 'tool_observed'].includes(tier);
  const mode = await engine.getConfig('trust.agent_activation') ?? 'allow';
  if (lowTier && flagged && mode !== 'allow') {
    return `Withheld from proactive surfaces (hook user-prompt context, context engine, context_pack, volunteer) until you confirm it; returned on explicit query, search, recall and get_page labeled "${label}".`;
  }
  return `Used on every surface, labeled "${label}"${lowTier ? ' (text below "tool data" is wrapped as data, not instructions)' : ''}.`;
}

async function proposalsFor(engine: BrainEngine, table: 'facts' | 'takes' | 'pages', id: number): Promise<TrustExplanation['pending_proposals']> {
  return (await pendingTrustProposalsFor(engine, table, id)).map(p => {
    const ref = trustProposalRef(p.id);
    return { ref, action: p.action, commands: [trust('confirm', ref), trust('drop', ref), ...(p.action === 'lower_page' ? [trust('revert', ref)] : [])] };
  });
}

const originOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? value as Record<string, unknown> : typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : null;

/** Explains one ref (or every page and fact matching a query). Read-only. */
export async function explainTrust(engine: BrainEngine, refOrQuery: string, opts: { source?: string | null } = {}): Promise<TrustExplanation[]> {
  let ref;
  try { ref = parseTrustRef(refOrQuery); } catch { ref = null; }
  if (!ref || (ref.kind === 'page' && !ref.sourceId && /\s/.test(refOrQuery))) return explainQuery(engine, refOrQuery);
  switch (ref.kind) {
    case 'fact':
    case 'take': {
      const sql = ref.kind === 'fact'
        ? 'SELECT id, source_id, trust_tier, write_origin, fact AS text FROM facts WHERE id = $1'
        : 'SELECT t.id, p.source_id, t.trust_tier, t.write_origin, t.claim AS text FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = $1';
      const [row] = await engine.executeRaw<{ source_id: string; trust_tier: string; write_origin: unknown; text: string }>(sql, [ref.id]);
      if (!row) throw opError('not_found', `No ${ref.kind} ${formatTrustRef(ref)}.`, 'Check the ref; gbrain trust review lists items.');
      const tier = storedTrustTier(row.trust_tier);
      const table = ref.kind === 'fact' ? 'facts' : 'takes';
      const gate = await gateReceipts(engine, table, ref.id);
      const view = await claimView(engine, row.source_id, tier, row.write_origin, gate);
      return [{ ref: formatTrustRef(ref), kind: ref.kind, source_id: row.source_id, tier, label: view.label, write_origin: originOf(row.write_origin),
        gate, pending_proposals: await proposalsFor(engine, table, ref.id), activation: await activationNote(engine, view.tier, gate, false, view.label), text: snippet(row.text, 200),
        ...(view.claimed_source ? { claimed_source: view.claimed_source } : {}), ...(view.user_said ? { confirm: trust('confirm', formatTrustRef(ref)) } : {}) }];
    }
    case 'page': {
      let resolved;
      try { resolved = await resolvePageRef(engine, ref, opts.source); }
      catch (error) { if (!ref.sourceId && (error as { code?: string }).code === 'page_not_found') return explainQuery(engine, refOrQuery); throw error; }
      const { sourceId, slug } = resolved;
      const state = await readPageTrustState(engine, sourceId, slug);
      if (!state) throw opError('page_not_found', `No live page ${pageRef(sourceId, slug)}.`, 'Check the slug and --source.');
      const [row] = await engine.executeRaw<{ write_origin: unknown }>('SELECT write_origin FROM pages WHERE id = $1', [state.pageId]);
      const gate = await gateReceipts(engine, 'pages', state.pageId);
      const quarantined = isQuarantined(state.snapshot.page.frontmatter);
      const view = await claimView(engine, sourceId, state.tier, row?.write_origin, gate);
      return [{ ref: pageRef(sourceId, slug), kind: 'page', source_id: sourceId, tier: state.tier, label: view.label, write_origin: originOf(row?.write_origin),
        gate, quarantined, pending_proposals: await proposalsFor(engine, 'pages', state.pageId), activation: await activationNote(engine, view.tier, gate, quarantined, view.label),
        ...(view.claimed_source ? { claimed_source: view.claimed_source } : {}), ...(view.user_said ? { confirm: trust('confirm', pageRef(sourceId, slug)) } : {}) }];
    }
    case 'hold': {
      const hold = await currentHoldStore().get(engine, ref.id);
      if (!hold) throw opError('not_found', `No held write h${ref.id}.`, 'gbrain trust review lists held writes.');
      return [{ ref: `h${hold.id}`, kind: 'hold', source_id: hold.source_id, tier: hold.tier, label: trustLabel(hold.tier), write_origin: null,
        gate: { verdict: 'quarantine', receipts: [] }, pending_proposals: [], text: snippet(hold.payload.fact ?? hold.payload.claim, 200),
        activation: hold.status === 'held' ? 'Held by the write gate: not in memory at all until you release it.' : `Decided: ${hold.status}.` }];
    }
    case 'proposal': {
      const p = await getTrustProposal(engine, ref.id);
      if (!p) throw opError('not_found', `No trust proposal tp${ref.id}.`, 'gbrain trust review lists pending proposals.');
      const item = proposalItem(p, await pageOf(engine, p));
      return [{ ref: item.ref, kind: 'proposal', source_id: p.source_id, tier: item.tier, label: item.label, write_origin: { proposer: p.proposer, status: p.status, before: p.before_state, after: p.after_state },
        gate: { verdict: 'none', receipts: [] }, pending_proposals: p.status === 'pending' ? [{ ref: item.ref, action: p.action, commands: Object.entries(item.commands).filter(([k]) => k !== 'explain').map(([, v]) => v!) }] : [],
        activation: item.summary }];
    }
    default:
      throw opError('invalid_params', `trust explain does not take ${formatTrustRef(ref)}.`, 'Pass a fact (f12), take (t3), held write (h4), trust proposal (tp7), a page (p:default/notes/alice-example) or a search phrase.');
  }
}

async function explainQuery(engine: BrainEngine, query: string): Promise<TrustExplanation[]> {
  const like = `%${query.replace(/[\\%_]/g, m => `\\${m}`)}%`;
  const pages = await engine.executeRaw<{ source_id: string; slug: string }>(
    `SELECT source_id, slug FROM pages WHERE deleted_at IS NULL AND (slug = $1 OR title ILIKE $2) ORDER BY updated_at DESC, id LIMIT 5`, [query, like]);
  const facts = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE expired_at IS NULL AND fact ILIKE $1 ORDER BY id DESC LIMIT 5`, [like]);
  const out: TrustExplanation[] = [];
  for (const p of pages) out.push(...await explainTrust(engine, pageRef(p.source_id, p.slug)));
  for (const f of facts) out.push(...await explainTrust(engine, `f${Number(f.id)}`));
  return out;
}

export function renderTrustExplanation(items: readonly TrustExplanation[]): string {
  if (items.length === 0) return 'No page or fact matches; pass a ref (f<id>, t<id>, h<id>, tp<id>, p:<source>/<slug>) or another phrase.';
  const lines: string[] = [];
  for (const e of items) {
    lines.push(`${e.ref} (${e.kind}, source ${e.source_id}): ${e.label} [${e.tier}]`);
    if (e.text) lines.push(`  text: ${e.text}`);
    const o = e.write_origin;
    if (o) {
      lines.push(`  origin: ${typeof o.channel === 'string' ? o.channel : JSON.stringify(o)}${e.tier === 'agent_written' && o.content_origin === USER_SAID_ORIGIN_MARKER ? ` (content_origin ${USER_SAID_ORIGIN_MARKER})` : ''}${typeof o.source_uri === 'string' ? ` from ${o.source_uri}` : ''}${typeof o.request_id === 'string' ? ` (request ${o.request_id})` : ''}`);
      const inputs = Array.isArray(o.taint_inputs) ? o.taint_inputs as Array<{ table: string; id: unknown; tier: TrustTier }> : [];
      if (inputs.length) lines.push(`  derived from: ${inputs.map(i => `${i.table}:${String(i.id)} (${trustLabel(i.tier)})`).join(', ')}${o.taint_inputs_truncated ? ` and more (${String(o.taint_input_count)} inputs)` : ''}`);
      const decision = o.owner_decision as Record<string, unknown> | undefined;
      if (decision) lines.push(`  owner decision: ${String(decision.action ?? 'set')} to ${String(decision.tier)} at ${String(decision.at)} (${String(decision.via ?? '')})`);
    } else lines.push('  origin: not recorded (written before trust tiers, or by a writer that declares none)');
    lines.push(`  write gate: ${e.gate.verdict === 'unavailable' ? 'no receipts on this brain' : e.gate.verdict}${e.gate.receipts.length ? ` (${e.gate.receipts.map(r => `receipt ${r.id}: ${r.verdict} ${r.reason_families.join(',')}`).join('; ')})` : ''}`);
    for (const p of e.pending_proposals) lines.push(`  pending ${p.ref} (${p.action}): ${p.commands.map(renderArgv).join(' | ')}`);
    lines.push(`  activation: ${e.activation}`);
    if (e.confirm) lines.push(`  confirm: ${renderArgv(e.confirm)}`);
  }
  return lines.join('\n');
}

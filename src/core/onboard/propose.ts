/**
 * propose.ts: onboarding job proposals (agent platform lane 5, O2). Five keyless detectors over data already in the
 * brain, each turned into one job the user's agent could take on: a count, the pages it rests on, and a sentence.
 *
 *   - waiting_on_you   open loops where the user promised something or owes a decision (open_loops)
 *   - owe_reply        email threads the user owes a reply on (open_loops, unanswered_inbound)
 *   - meeting_prep     calendar series seen at least twice in the window with no prep page (meeting pages)
 *   - bulk_senders     senders of several threads, or of promotions, social or forum mail, the user never wrote to
 *   - repeat_question  the same question the user asked in two harnesses (the conversation archive)
 *
 * Nothing here calls a model or any provider. The sentences carry counts only, never page text, names or subjects,
 * and no dollar figure (cut W: money appears only when read from the user's own records, and no detector reads any).
 * The skill that does a job is named through the skill resolver's existing word match on a fixed label per signal,
 * never the job's own text, with skill vectors and the model picker off whatever the settings say (d14); every job
 * keeps its core command as the fallback. Accept and decline answers live in the first-session record
 * (onboarding.first_session, first-session.ts), and the top undecided job rides that section once a Google source has
 * synced. Repo-less and git-backed brains behave the same: every read is database rows.
 */
import type { BrainEngine } from '../engine.ts';
import { BULK_CATEGORY_LABELS } from '../google/gmail-categories.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { decideProposal, firstSessionStatus, proposalDecisions, readProposalCache, writeProposalCache, type ProposalDecision, type ProposalState, type StoppedBy } from './first-session.ts';

export const PROPOSE_SIGNALS = ['waiting_on_you', 'owe_reply', 'meeting_prep', 'repeat_question', 'bulk_senders'] as const;
export type ProposeSignal = typeof PROPOSE_SIGNALS[number];
export const PROPOSE_DEFAULT_DAYS = 7;
export const PROPOSE_MAX_DAYS = 90;
export const PROPOSE_MAX_CITES = 5;
const ROW_CAP = 2000;
const CONVERSATION_CAP = 400;
const MEETING_SERIES_CAP = 20;
const BULK_MIN_THREADS = 3;
const BULK_CANDIDATE_CAP = 200;

/** The fixed text each signal sends to the skill resolver (d14): never the job's own text. */
export const SIGNAL_LABEL: Record<ProposeSignal, string> = {
  waiting_on_you: 'follow up on promises and decisions people are waiting on me for',
  owe_reply: 'reply to email threads I owe an answer',
  meeting_prep: 'prepare a brief before a recurring meeting',
  repeat_question: 'save an answer once so every agent can recall it',
  bulk_senders: 'unsubscribe or filter bulk email senders',
};

/** The core command that does each job when no installed skill matches. */
export const CORE_COMMAND: Record<ProposeSignal, string> = {
  waiting_on_you: 'gbrain waiting',
  owe_reply: 'gbrain loops list --type unanswered_inbound',
  meeting_prep: 'gbrain query "what do I need before <meeting title>"',
  repeat_question: 'gbrain remember "<the answer>" --provenance "<where it was answered>"',
  bulk_senders: 'gbrain loops mute sender <email> --dry-run',
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
function sentenceFor(signal: ProposeSignal, n: number, days: number): string {
  switch (signal) {
    case 'waiting_on_you': return `${n} ${plural(n, 'person is', 'people are')} waiting on you for something you promised or a decision you owe.`;
    case 'owe_reply': return `You owe a reply on ${n} email ${plural(n, 'thread', 'threads')}.`;
    case 'meeting_prep': return `${n} recurring ${plural(n, 'meeting has', 'meetings have')} no prep page.`;
    case 'repeat_question': return `You asked ${n} ${plural(n, 'question', 'questions')} in more than one agent; saving the answer once lets every agent recall it.`;
    case 'bulk_senders': return `${n} bulk ${plural(n, 'sender', 'senders')} mailed you in the last ${days} ${plural(days, 'day', 'days')}, and you have never written to ${plural(n, 'it', 'them')}.`;
  }
}

export interface Cite { source_id: string; slug: string }
export type HandledBy = { kind: 'skill'; id: string; name: string; catalog: string } | { kind: 'command'; command: string };
export interface ProposedJob {
  signal: ProposeSignal;
  count: number;
  sentence: string;
  cites: Cite[];
  handled_by: HandledBy;
  fallback_command: string;
  decision: ProposalDecision | null;
}
export interface ProposeResult {
  version: 1;
  days: number;
  as_of: string;
  jobs: ProposedJob[];
  /** Signals that found nothing in the window. */
  quiet: ProposeSignal[];
  resolver: { label: 'fixed'; providers: 'off'; error?: string };
}

interface Found { count: number; cites: Cite[] }
type Scope = string[] | null;
/** The page read filter: everything for the owner's local lanes, the caller's own read policy for a remote call. */
type Vis = ((alias: string) => string) | null;
const visSql = (vis: Vis, alias: string) => (vis ? vis(alias) : 'TRUE');

const srcSql = (alias: string, n: number) => `($${n}::text IS NULL OR ${alias}.source_id = ANY(string_to_array($${n}::text, ',')))
  AND NOT EXISTS (SELECT 1 FROM sources sa WHERE sa.id = ${alias}.source_id AND sa.archived IS TRUE)`;
const srcParam = (s: Scope) => (s && s.length ? s.join(',') : null);

function addCite(cites: Cite[], c: Cite) {
  if (cites.length < PROPOSE_MAX_CITES && !cites.some(x => x.slug === c.slug && x.source_id === c.source_id)) cites.push(c);
}

async function loopSignal(engine: BrainEngine, scope: Scope, vis: Vis, since: Date, types: string[], key: (r: LoopRow) => string): Promise<Found> {
  const gate = vis ? `EXISTS (SELECT 1 FROM pages vp WHERE vp.source_id = l.source_id AND vp.slug = l.page_slug AND vp.deleted_at IS NULL AND ${vis('vp')})` : 'TRUE';
  const rows = await engine.executeRaw<LoopRow>(
    `SELECT l.source_id, l.loop_type, l.counterparty_email, l.counterparty_slug, l.thread_id, l.page_slug, l.id
       FROM open_loops l
      WHERE l.status = 'open' AND l.loop_type = ANY(string_to_array($2::text, ',')) AND l.last_activity_at >= $3::timestamptz AND ${srcSql('l', 1)} AND ${gate}
      ORDER BY l.last_activity_at DESC, l.id LIMIT ${ROW_CAP}`, [srcParam(scope), types.join(','), since.toISOString()]);
  const keys = new Set<string>();
  const cites: Cite[] = [];
  for (const r of rows) {
    keys.add(key(r));
    if (r.page_slug) addCite(cites, { source_id: r.source_id, slug: r.page_slug });
  }
  return { count: keys.size, cites };
}
interface LoopRow { source_id: string; loop_type: string; counterparty_email: string | null; counterparty_slug: string | null; thread_id: string | null; page_slug: string | null; id: number }

const normTitle = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const likeEscape = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m);

async function meetingPrep(engine: BrainEngine, scope: Scope, vis: Vis, now: Date, days: number): Promise<Found> {
  const from = new Date(now.getTime() - 4 * days * 86_400_000);
  const to = new Date(now.getTime() + days * 86_400_000);
  const rows = await engine.executeRaw<{ source_id: string; slug: string; title: string; start: string | null }>(
    `SELECT p.source_id, p.slug, p.title, p.frontmatter->>'start' AS start
       FROM pages p
      WHERE p.type = 'meeting' AND p.deleted_at IS NULL AND ${srcSql('p', 1)} AND ${visSql(vis, 'p')}
        AND p.frontmatter->>'start' >= $2 AND p.frontmatter->>'start' <= $3
      ORDER BY p.frontmatter->>'start' DESC, p.slug LIMIT ${ROW_CAP}`,
    [srcParam(scope), new Date(from.getTime() - 86_400_000).toISOString().slice(0, 10), new Date(to.getTime() + 86_400_000).toISOString().slice(0, 10) + 'T~']);
  const series = new Map<string, { title: string; pages: Cite[] }>();
  for (const r of rows) {
    const at = Date.parse(r.start ?? '');
    const title = normTitle(r.title ?? '');
    if (!Number.isFinite(at) || at < from.getTime() || at > to.getTime() || title.length < 4) continue;
    const s = series.get(title) ?? { title, pages: [] };
    s.pages.push({ source_id: r.source_id, slug: r.slug });
    series.set(title, s);
  }
  let count = 0;
  const cites: Cite[] = [];
  for (const s of [...series.values()].filter(s => s.pages.length >= 2).slice(0, MEETING_SERIES_CAP)) {
    const prep = await engine.executeRaw<{ one: number }>(
      `SELECT 1 AS one FROM pages q
        WHERE q.deleted_at IS NULL AND q.type NOT IN ('meeting', 'email', 'conversation') AND ${srcSql('q', 1)} AND ${visSql(vis, 'q')}
          AND lower(q.title) LIKE '%' || $2 || '%' ESCAPE '\\'
       UNION ALL
       SELECT 1 AS one FROM links k JOIN pages f ON f.id = k.from_page_id JOIN pages t ON t.id = k.to_page_id
        WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL AND f.type NOT IN ('meeting', 'email', 'conversation') AND ${srcSql('f', 1)} AND ${visSql(vis, 'f')}
          AND (t.source_id || '/' || t.slug) = ANY(string_to_array($3::text, ','))
       LIMIT 1`, [srcParam(scope), likeEscape(s.title), s.pages.map(p => `${p.source_id}/${p.slug}`).join(',')]);
    if (prep.length) continue;
    count++;
    addCite(cites, s.pages[0]!);
  }
  return { count, cites };
}

const asList = (v: unknown): string[] => {
  const raw = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return []; } })() : v; // silent-read-ok: a malformed list reads as empty
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').map(x => x.toLowerCase().trim()) : [];
};

async function bulkSenders(engine: BrainEngine, scope: Scope, vis: Vis, since: Date): Promise<Found> {
  const mail = await engine.executeRaw<{ source_id: string; slug: string; senders: unknown; labels: unknown; account: string | null }>(
    `SELECT p.source_id, p.slug, p.frontmatter->'senders' AS senders, p.frontmatter->'labels' AS labels, p.frontmatter->>'account' AS account
       FROM pages p
      WHERE p.type = 'email' AND p.deleted_at IS NULL AND ${srcSql('p', 1)} AND ${visSql(vis, 'p')} AND p.frontmatter->>'date' >= $2
      ORDER BY p.frontmatter->>'date' DESC, p.slug LIMIT ${ROW_CAP}`, [srcParam(scope), since.toISOString()]);
  const bulkLabels = new Set(BULK_CATEGORY_LABELS);
  const senders = new Map<string, { threads: number; bulk: boolean; cite: Cite }>();
  for (const r of mail) {
    const labels = asList(r.labels).map(l => l.toUpperCase());
    if (labels.includes('SENT')) continue;
    const account = (r.account ?? '').toLowerCase().trim();
    for (const s of asList(r.senders)) {
      if (!s || s === account || s.includes(',')) continue;
      const cur = senders.get(s) ?? { threads: 0, bulk: false, cite: { source_id: r.source_id, slug: r.slug } };
      cur.threads++;
      cur.bulk ||= labels.some(l => bulkLabels.has(l));
      senders.set(s, cur);
    }
  }
  const candidates = [...senders.entries()].filter(([, s]) => s.bulk || s.threads >= BULK_MIN_THREADS).slice(0, BULK_CANDIDATE_CAP);
  // Never wrote to: no SENT thread at any time lists the sender as a participant, checked per candidate (no capped scan).
  const wrote = candidates.length ? await engine.executeRaw<{ addr: string }>(
    `SELECT c.addr FROM unnest(string_to_array($2::text, ',')) AS c(addr)
      WHERE EXISTS (SELECT 1 FROM pages p, jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.frontmatter->'participants') = 'array' THEN p.frontmatter->'participants' ELSE '[]'::jsonb END) AS e(v)
                     WHERE p.type = 'email' AND p.deleted_at IS NULL AND ${srcSql('p', 1)} AND ${visSql(vis, 'p')} AND (p.frontmatter->'labels') @> '["SENT"]'::jsonb
                       AND lower(trim(e.v)) = c.addr)`, [srcParam(scope), candidates.map(([a]) => a).join(',')]) : [];
  const writtenTo = new Set(wrote.map(r => r.addr));
  const hits = candidates.filter(([a]) => !writtenTo.has(a)).map(([, s]) => s);
  const cites: Cite[] = [];
  for (const h of hits) addCite(cites, h.cite);
  return { count: hits.length, cites };
}

const STOP = new Set(['the', 'and', 'for', 'you', 'can', 'how', 'what', 'where', 'when', 'why', 'who', 'does', 'did', 'this', 'that', 'with', 'are', 'was', 'our', 'your', 'one', 'quick', 'please', 'there', 'have', 'has', 'should', 'would', 'could', 'which', 'any', 'into', 'from', 'about', 'tell']);
const ANCHOR = /^\*\*([^*\n]{1,80})\*\* \([^)\n]{0,40}\): (.*)$/;

/** The owner's questions in one archived conversation, each as a normalized word key (order-free, stop words out). */
export function questionKeys(body: string, ownerLabel: string | null): string[] {
  const keys = new Set<string>();
  for (const line of body.split('\n')) {
    const m = ANCHOR.exec(line.trim());
    if (!m || m[1]!.trim() !== (ownerLabel ?? 'User')) continue;
    for (const sentence of m[2]!.split(/(?<=[.!?])\s+/)) {
      if (!sentence.endsWith('?') || sentence.length < 12 || sentence.length > 300) continue;
      const words = [...new Set(sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(w => w.length >= 3 && !STOP.has(w)))].sort();
      if (words.length >= 3) keys.add(words.join(' '));
    }
  }
  return [...keys];
}

async function repeatQuestions(engine: BrainEngine, scope: Scope, vis: Vis, since: Date): Promise<Found> {
  const rows = await engine.executeRaw<{ source_id: string; slug: string; harness: string | null; owner_label: string | null; body: string }>(
    `SELECT p.source_id, p.slug, p.frontmatter->'transcript_archive'->>'harness' AS harness,
            p.frontmatter->'speaker_owner'->>'label' AS owner_label, ${boundedBodyPrefixSql('p')} AS body
       FROM pages p
      WHERE p.type = 'conversation' AND p.deleted_at IS NULL AND ${srcSql('p', 1)} AND ${visSql(vis, 'p')}
        AND p.frontmatter->'transcript_archive'->>'day' >= $2
      ORDER BY p.frontmatter->'transcript_archive'->>'day' DESC, p.slug LIMIT ${CONVERSATION_CAP}`, [srcParam(scope), since.toISOString().slice(0, 10)]);
  const asked = new Map<string, { harnesses: Set<string>; pages: Cite[] }>();
  for (const r of rows) {
    if (!r.harness) continue;
    for (const k of questionKeys(r.body ?? '', r.owner_label)) {
      const a = asked.get(k) ?? { harnesses: new Set<string>(), pages: [] };
      a.harnesses.add(r.harness);
      a.pages.push({ source_id: r.source_id, slug: r.slug });
      asked.set(k, a);
    }
  }
  const hits = [...asked.values()].filter(a => a.harnesses.size >= 2);
  const cites: Cite[] = [];
  for (const h of hits) for (const p of h.pages) addCite(cites, p);
  return { count: hits.length, cites };
}

/** One detector, by signal. `scope` null reads every source (the owner's own lanes); else the caller's sources. */
async function detect(engine: BrainEngine, signal: ProposeSignal, scope: Scope, now: Date, days: number, vis: Vis = null): Promise<Found> {
  const since = new Date(now.getTime() - days * 86_400_000);
  switch (signal) {
    case 'waiting_on_you': return loopSignal(engine, scope, vis, since, ['commitment_owed_by_me', 'decision_pending'], r => r.counterparty_email ?? r.counterparty_slug ?? `loop:${r.id}`);
    case 'owe_reply': return loopSignal(engine, scope, vis, since, ['unanswered_inbound'], r => r.thread_id ?? r.page_slug ?? `loop:${r.id}`);
    case 'meeting_prep': return meetingPrep(engine, scope, vis, now, days);
    case 'repeat_question': return repeatQuestions(engine, scope, vis, since);
    case 'bulk_senders': return bulkSenders(engine, scope, vis, since);
  }
}

export function clampDays(days: unknown): number {
  const n = typeof days === 'number' ? days : Number(days);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, PROPOSE_MAX_DAYS) : PROPOSE_DEFAULT_DAYS;
}

export interface ResolverOpts { home?: string; env?: NodeJS.ProcessEnv }

/** The installed skill for one signal through the resolver's word match, or null; never a provider call (d14). */
async function skillFor(signal: ProposeSignal, opts: ResolverOpts): Promise<{ skill: HandledBy & { kind: 'skill' } | null; error?: string }> {
  const { resolveSkills } = await import('../skills/resolver/index.ts');
  const r = await resolveSkills({ message: SIGNAL_LABEL[signal], top_k: 1 }, { ...opts, offline: true, router: false, failOpen: true, deadlineMs: 2000 });
  const top = r.output.suggestions[0];
  return { skill: top ? { kind: 'skill', id: top.id, name: top.name, catalog: top.catalog } : null, ...(r.output.error ? { error: r.output.error.code } : {}) };
}

/** Every job with something to propose, in signal order, plus the signals that found nothing. */
export async function proposeJobs(engine: BrainEngine, opts: { days?: number; now?: Date; sourceIds?: string[] | null; resolver?: ResolverOpts; forCaller?: boolean } = {}): Promise<ProposeResult> {
  const now = opts.now ?? new Date();
  const days = clampDays(opts.days ?? PROPOSE_DEFAULT_DAYS);
  const scope = opts.sourceIds ?? null;
  const decisions = await proposalDecisions(engine);
  const vis: Vis = opts.forCaller ? privatePagesFilterForCaller : null;
  const found = await Promise.all(PROPOSE_SIGNALS.map(s => detect(engine, s, scope, now, days, vis)));
  const jobs: ProposedJob[] = [];
  const quiet: ProposeSignal[] = [];
  let resolverError: string | undefined;
  for (const [i, signal] of PROPOSE_SIGNALS.entries()) {
    const f = found[i]!;
    if (f.count === 0) { quiet.push(signal); continue; }
    const named = await skillFor(signal, opts.resolver ?? {});
    resolverError ??= named.error;
    jobs.push({
      signal, count: f.count, sentence: sentenceFor(signal, f.count, days), cites: f.cites,
      handled_by: named.skill ?? { kind: 'command', command: CORE_COMMAND[signal] }, fallback_command: CORE_COMMAND[signal],
      decision: decisions[signal]?.decision ?? null,
    });
  }
  return { version: 1, days, as_of: now.toISOString(), jobs, quiet, resolver: { label: 'fixed', providers: 'off', ...(resolverError ? { error: resolverError } : {}) } };
}

/** Whether a Google source has finished a sync (its first sync stamps last_sync_at). */
async function googleSynced(engine: BrainEngine): Promise<boolean> {
  const rows = await engine.executeRaw<{ config: unknown }>(`SELECT config FROM sources WHERE archived IS NOT TRUE AND last_sync_at IS NOT NULL`, []);
  return rows.some(r => {
    const c = typeof r.config === 'string' ? (() => { try { return JSON.parse(r.config as string); } catch { return {}; } })() : r.config; // silent-read-ok: a malformed config is not a google source
    return (c as { kind?: unknown } | null)?.kind === 'google';
  });
}

/** How long a cached top job stays fresh enough to offer at session start. */
export const PROPOSAL_CACHE_MAX_AGE_MS = 3 * 86_400_000;

/**
 * Recompute the first-session section's job and cache it in the first-session record: the first signal, in signal
 * order, with something found (over every source, the default window) and no answer from the owner yet. Runs only
 * while the suggestion is armed, off the session-start path: after a Google sync, and on `gbrain propose`, which
 * passes the jobs it already found. Only the signal and its count-only sentence are stored.
 */
export async function refreshProposalCache(engine: BrainEngine, opts: { now?: Date; jobs?: ProposedJob[] } = {}): Promise<{ signal: ProposeSignal; sentence: string } | null | 'not_armed'> {
  const now = opts.now ?? new Date();
  if ((await firstSessionStatus(engine, { now })).state !== 'armed') return 'not_armed';
  const decisions = await proposalDecisions(engine);
  const jobs: Array<{ signal: ProposeSignal; sentence: string }> = [];
  if (opts.jobs) {
    for (const j of opts.jobs) if (!decisions[j.signal]) jobs.push({ signal: j.signal, sentence: j.sentence });
  } else {
    for (const signal of PROPOSE_SIGNALS) {
      if (decisions[signal]) continue;
      const f = await detect(engine, signal, null, now, PROPOSE_DEFAULT_DAYS);
      if (f.count > 0) jobs.push({ signal, sentence: sentenceFor(signal, f.count, PROPOSE_DEFAULT_DAYS) });
    }
  }
  await writeProposalCache(engine, jobs, now);
  return jobs[0] ?? null;
}

/** The session-start read: the first cached job still unanswered, if the cache is fresh and a Google source has synced. No detector runs. */
export async function cachedProposalForFirstSession(engine: BrainEngine, opts: { now?: Date } = {}): Promise<{ signal: string; sentence: string } | null> {
  const cached = await readProposalCache(engine);
  const now = (opts.now ?? new Date()).getTime();
  if (!cached || !(now - Date.parse(cached.at) <= PROPOSAL_CACHE_MAX_AGE_MS)) return null;
  const decisions = await proposalDecisions(engine);
  const job = cached.jobs.find(j => isProposeSignal(j.signal) && !decisions[j.signal]);
  if (!job || !await googleSynced(engine)) return null;
  return { signal: job.signal, sentence: job.sentence };
}

export function isProposeSignal(s: unknown): s is ProposeSignal {
  return typeof s === 'string' && (PROPOSE_SIGNALS as readonly string[]).includes(s);
}

/** Record the owner's accept or decline for one signal in the first-session record, read back before it is reported. */
export async function setProposalDecision(engine: BrainEngine, opts: { signal: ProposeSignal; decision: ProposalDecision; by: StoppedBy; now?: Date }) {
  return decideProposal(engine, opts);
}

export type { ProposalDecision, ProposalState };

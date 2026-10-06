/**
 * Onboarding coaching for the owner's stdio MCP pipe (agent operator
 * contract v1). The counts behind init's nudge live in one shared collector;
 * a per-brain cache (6 h TTL, persisted under GBRAIN_HOME, refreshed in the
 * background only while no dispatch is in flight) turns them into one
 * coaching notice per opportunity class. Each class attaches only to a call
 * whose result shows the limitation (`ONBOARD_CALL_AFFINITY` plus a result
 * predicate), so the agent hears about thin link coverage on a backlinks
 * call, not on a write. Init's first-run decisions ride the second
 * successful call of a session. HTTP gets none of it: the counts are
 * brain-wide and every remedy runs on the brain host.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action, Notice, RenderContext } from '../agent-output.ts';
import { gbrainPath, type GBrainConfig } from '../config.ts';
import { configReadiness } from '../readiness.ts';
import { recallStagesFor } from '../interop-notices.ts';

export const LINK_COVERAGE_MIN = 0.7;
export const TIMELINE_COVERAGE_MIN = 0.9;
const TTL_MS = 6 * 60 * 60 * 1000;
const REFRESH_BUDGET_MS = 3000;
const IDLE_POLL_MS = 250;
const ENTITY_TYPES: ReadonlySet<string> = new Set(['person', 'company', 'organization', 'entity']);

/** The six counts init's nudge reports; null when that probe failed or hit the budget. */
export interface OnboardCounts {
  staleChunks: number | null;
  entities: number | null;
  linkedEntities: number | null;
  timelineEntities: number | null;
  takes: number | null;
  pages: number | null;
  linkCoverage: number | null;
  timelineCoverage: number | null;
  partial: boolean;
  checksRan: number;
  checksAttempted: number;
}

const COUNT_SQL = [
  `SELECT COUNT(*) AS count FROM content_chunks WHERE embedding IS NULL`,
  `SELECT COUNT(*) AS count FROM pages
           WHERE type IN ('person', 'company', 'organization', 'entity')
             AND deleted_at IS NULL`,
  `SELECT COUNT(*) AS count FROM pages p
           WHERE p.type IN ('person', 'company', 'organization', 'entity')
             AND p.deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)`,
  `SELECT COUNT(*) AS count FROM pages p
           WHERE p.type IN ('person', 'company', 'organization', 'entity')
             AND p.deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id)`,
  `SELECT COUNT(*) AS count FROM takes`,
  `SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL`,
] as const;

/**
 * Run the six counts. Parallel by default (init); with `between`, one at a
 * time with `between()` awaited before each (the background refresh yields
 * the single PGLite connection between counts).
 */
export async function collectOnboardOpportunities(
  engine: BrainEngine, signal: AbortSignal, between?: () => Promise<void>,
): Promise<OnboardCounts> {
  const run = (sql: string) => engine.executeRaw<{ count: string | number }>(sql, [], { signal });
  let results: PromiseSettledResult<{ count: string | number }[]>[];
  if (between) {
    results = [];
    for (const sql of COUNT_SQL) {
      await between();
      results.push(signal.aborted
        ? { status: 'rejected', reason: new Error('onboard count budget exceeded') }
        : await run(sql).then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason })));
    }
  } else {
    results = await Promise.allSettled(COUNT_SQL.map(run));
  }
  const n = results.map(r => (r.status === 'fulfilled' ? (r.value.length > 0 ? Number(r.value[0].count) : 0) : null));
  const [staleChunks, entities, linkedEntities, timelineEntities, takes, pages] = n;
  const coverage = (part: number | null) => (entities === null || part === null ? null : entities > 0 ? part / entities : 1);
  const checksRan = n.filter(v => v !== null).length;
  return {
    staleChunks, entities, linkedEntities, timelineEntities, takes, pages,
    linkCoverage: coverage(linkedEntities), timelineCoverage: coverage(timelineEntities),
    partial: checksRan < results.length, checksRan, checksAttempted: results.length,
  };
}

export type OnboardClass = 'stale_chunks' | 'link_coverage' | 'timeline_coverage' | 'no_takes';

/** The calls each class may attach to. Every name is a catalogue op; each class reaches the verbs and starter surfaces. */
export const ONBOARD_CALL_AFFINITY: Readonly<Record<OnboardClass, readonly string[]>> = {
  stale_chunks: ['search', 'query', 'recall', 'context_pack'],
  link_coverage: ['get_backlinks', 'traverse_graph', 'entity'],
  timeline_coverage: ['get_timeline', 'entity', 'get_page'],
  no_takes: ['think', 'takes_list', 'recall', 'context_pack'],
};

/** `features_auto_fix` rides link-graph calls only; the embedding gap is `onboard_stale_chunks`. */
export const FEATURES_CALL_AFFINITY: readonly string[] = ['get_backlinks', 'traverse_graph'];

/** Brain-wide gaps by init's thresholds; a failed count never reads as a gap, and an empty brain has none. */
export function onboardGaps(c: OnboardCounts): Record<OnboardClass, boolean> {
  const brain = c.pages !== 0;
  return {
    stale_chunks: brain && (c.staleChunks ?? 0) > 0,
    link_coverage: brain && (c.entities ?? 0) > 0 && c.linkCoverage !== null && c.linkCoverage < LINK_COVERAGE_MIN,
    timeline_coverage: brain && (c.entities ?? 0) > 0 && c.timelineCoverage !== null && c.timelineCoverage < TIMELINE_COVERAGE_MIN,
    no_takes: brain && c.takes === 0,
  };
}

// ── cache ───────────────────────────────────────────────────────────────────

/** A pitchable `gbrain features` recommendation (the fields the auto-fix notice reads). */
export interface CachedFeature { id: string; priority: 1 | 2; title: string; pitch: string; command: string; auto_fixable: boolean }

interface OnboardSnapshot {
  at: number;
  counts: OnboardCounts;
  stale_usd: number | null;
  features: CachedFeature[];
}

interface OnboardState {
  snapshot: OnboardSnapshot | null;
  firstRun: Notice[] | null;
  calls: number;
  started: boolean;
  refreshing: Promise<void> | null;
  idle: () => boolean;
  now: () => number;
}

const fresh = (): OnboardState => ({ snapshot: null, firstRun: null, calls: 0, started: false, refreshing: null, idle: () => true, now: Date.now });
let st: OnboardState = fresh();

const optedOut = () => process.env.GBRAIN_NO_ONBOARD_NUDGE === '1';

async function cachePath(): Promise<string> {
  const { resolveBrainId } = await import('../brain-resolver.ts');
  const { getCliOptions } = await import('../cli-options.ts');
  let brainId = 'host';
  try { brainId = resolveBrainId(getCliOptions().brain); } catch { /* host */ }
  // gbrain-allow-ascii-class: filesystem-safe filename fragment, not a displayed slug
  return gbrainPath(`onboard-counts-${brainId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

async function readPersisted(): Promise<OnboardSnapshot | null> {
  try {
    const raw = JSON.parse(readFileSync(await cachePath(), 'utf8')) as Partial<OnboardSnapshot>;
    if (typeof raw.at !== 'number' || !raw.counts || st.now() - raw.at > TTL_MS) return null;
    return { at: raw.at, counts: raw.counts, stale_usd: raw.stale_usd ?? null, features: Array.isArray(raw.features) ? raw.features : [] };
  } catch {
    return null;
  }
}

async function persist(snapshot: OnboardSnapshot): Promise<void> {
  try {
    const path = await cachePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* the cache is an optimization */ }
}

const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/** The first-run decisions an MCP-only agent can relay: writeback and the skills scaffold (no search mode, no harness wiring). */
export async function mcpFirstRunNotices(engine: BrainEngine): Promise<Notice[]> {
  const { writebackAskApplies } = await import('./writeback-nudge.ts');
  const { initSkillsScaffold } = await import('../skillpack/post-install-advisory.ts');
  const { buildInitFirstRunNotices } = await import('../../commands/init-first-run.ts');
  return buildInitFirstRunNotices({ writeback: await writebackAskApplies(engine), skillsScaffold: initSkillsScaffold() });
}

/**
 * Doctor and `gbrain onboard --check`: first-run decisions that are still
 * open while the user muted `first_run_decisions`, with the unmute command.
 */
export async function mutedFirstRunDecisionsNotice(engine: BrainEngine): Promise<Notice | null> {
  const { mutedNoticeCodes } = await import('../notice-ledger.ts');
  if (!mutedNoticeCodes('stdio').has('first_run_decisions')) return null;
  const open = (await mcpFirstRunNotices(engine)).flatMap(n => n.decisions ?? []).map(d => d.id);
  if (open.length === 0) return null;
  return {
    code: 'first_run_decisions_muted', kind: 'info',
    why: `First-run decisions are still open (${open.join(', ')}), but first_run_decisions is muted, so agents no longer relay them.`,
    user_message: `Some gbrain setup choices are still open (${open.join(', ')}) and their reminder is muted. Want to see them again?`,
    fix: {
      argv: ['gbrain', 'notices', 'unmute', 'first_run_decisions'], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Shows the first-run decisions to agents again; the user muted them, so unmuting is their call.',
    },
  };
}

async function refresh(engine: BrainEngine, counts: boolean): Promise<void> {
  try {
    if (!st.firstRun) st.firstRun = await mcpFirstRunNotices(engine).catch(() => []);
    if (!counts) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_BUDGET_MS);
    timer.unref?.();
    const c = await collectOnboardOpportunities(engine, controller.signal, yieldTurn).finally(() => clearTimeout(timer));
    await yieldTurn();
    let staleUsd: number | null = null;
    if ((c.staleChunks ?? 0) > 0) {
      const { estimateEmbedBackfillUsd } = await import('../embed-consent.ts');
      staleUsd = await estimateEmbedBackfillUsd(engine, {});
    }
    await yieldTurn();
    let features: CachedFeature[] = [];
    try {
      const { pitchableFeatures } = await import('../../commands/features.ts');
      features = await pitchableFeatures(engine);
    } catch { /* features coaching is optional */ }
    const snapshot: OnboardSnapshot = { at: st.now(), counts: c, stale_usd: staleUsd, features };
    st.snapshot = snapshot;
    if (!c.partial) await persist(snapshot);
  } catch { /* coaching never breaks serve */ }
}

function needsCounts(): boolean {
  return !st.snapshot || st.now() - st.snapshot.at > TTL_MS;
}

function scheduleRefresh(engine: BrainEngine): void {
  if (st.refreshing || (!needsCounts() && st.firstRun)) return;
  const counts = needsCounts();
  st.refreshing = new Promise<void>(resolve => {
    const tick = () => {
      if (!st.idle()) { setTimeout(tick, IDLE_POLL_MS).unref?.(); return; }
      void refresh(engine, counts).finally(() => { st.refreshing = null; resolve(); });
    };
    setTimeout(tick, 0).unref?.();
  });
}

/**
 * Start the stdio serve's onboarding cache: load the persisted counts, then
 * refresh in the background when stale. `idle` reports whether no dispatch
 * is in flight; the refresh starts only then (PGLite has one connection).
 */
export async function startOnboardingRefresher(engine: BrainEngine, opts: { idle: () => boolean }): Promise<void> {
  if (optedOut() || st.started) return;
  st.started = true;
  st.idle = opts.idle;
  st.snapshot ??= await readPersisted();
  scheduleRefresh(engine);
}

// ── notices ─────────────────────────────────────────────────────────────────

const LOCK_NOTE = 'CLI commands take the brain lock this server holds, so run them after this session ends or through the running server.';

function previewFix(): Action {
  return {
    argv: ['gbrain', 'onboard', '--check'], mcp: { tool: 'get_health', arguments: {} },
    consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Read-only: shows the brain\'s coverage numbers (gbrain onboard --check also lists each remedy with its command).',
  };
}

function dismissal(code: string, render: RenderContext): string {
  return render.isCallable('mute_notice')
    ? ` To stop this notice, call mute_notice {"code":"${code}"}.`
    : ` To stop this notice, the user runs \`gbrain notices mute ${code}\`.`;
}

const pct = (v: number | null) => `${Math.round((v ?? 0) * 100)}%`;

function classNotice(cls: OnboardClass, s: OnboardSnapshot, render: RenderContext): Notice {
  const c = s.counts;
  const code = `onboard_${cls}`;
  const tail = ` Preview: the fix below (read-only). ${LOCK_NOTE}${dismissal(code, render)}`;
  const parts: Record<OnboardClass, { why: string; user_message: string }> = {
    stale_chunks: {
      why: `${c.staleChunks} chunk(s) in this brain have no embedding, so the semantic part of this search cannot match them. `
        + `Remedy: an embedding backfill (\`gbrain embed --stale\`${s.stale_usd !== null ? `, estimated $${s.stale_usd.toFixed(2)}` : ''}); `
        + 'it sends page text to the embedding provider and costs money, so ask the user first.',
      user_message: `${c.staleChunks} piece(s) of your notes are not indexed for meaning-based search, so searches can miss them. `
        + `Indexing them sends the text to your embedding provider${s.stale_usd !== null ? ` and costs about $${s.stale_usd.toFixed(2)}` : ' and costs a little money'}. Want me to run it after this session?`,
    },
    link_coverage: {
      why: `Only ${pct(c.linkCoverage)} of this brain's ${c.entities} people/company pages have an incoming link, so backlinks and graph answers come back thin. `
        + 'Remedy: link extraction (`gbrain extract links`, local, no paid calls).',
      user_message: 'Many of your people and company pages are not linked to the notes that mention them, so "who is connected to X" answers are thin. Want me to run gbrain\'s link extraction (free, local) after this session?',
    },
    timeline_coverage: {
      why: `Only ${pct(c.timelineCoverage)} of this brain's ${c.entities} people/company pages have timeline entries, so "when did X happen" answers come back thin. `
        + 'Remedy: timeline extraction (`gbrain extract timeline`, local, no paid calls).',
      user_message: 'Many of your people and company pages have no dated timeline entries, so "when did X happen" answers are thin. Want me to run gbrain\'s timeline extraction (free, local) after this session?',
    },
    no_takes: {
      why: 'This brain holds no takes (the user\'s recorded opinions and judgments), so think and recall cannot cite the user\'s own views. '
        + 'Remedy: record takes as they come up (`gbrain takes add`), or extract them from existing pages (`gbrain takes extract --from-pages`, which calls the chat model and costs money, so ask the user first).',
      user_message: 'Your brain has no recorded opinions yet, so I cannot cite your own views. Want me to extract them from your existing notes (uses the AI model, small cost) after this session?',
    },
  };
  return { code, kind: 'coaching', why: parts[cls].why + tail, user_message: parts[cls].user_message, fix: previewFix() };
}

const VECTOR_MISS_STAGES: ReadonlySet<string> = new Set(['embed_unavailable', 'keyword_only_no_embedding_provider', 'embed_timeout', 'vector_arm_failed']);

async function pageLacksTimeline(engine: BrainEngine, result: Record<string, unknown>): Promise<boolean> {
  if (!ENTITY_TYPES.has(String(result.type ?? ''))) return false;
  if (Array.isArray(result.timeline_entries)) return result.timeline_entries.length === 0;
  if (typeof result.id !== 'number' && typeof result.id !== 'string') return false;
  const rows = await engine.executeRaw(`SELECT 1 FROM timeline_entries WHERE page_id = $1 LIMIT 1`, [result.id]);
  return rows.length === 0;
}

interface CallEvidence {
  engine: BrainEngine;
  op: string;
  result: unknown;
  meta: Record<string, unknown>;
  config?: GBrainConfig | null;
}

/** The per-class result predicate: the call's own result must show the limitation. */
async function evidenceFor(cls: OnboardClass, e: CallEvidence): Promise<boolean> {
  const r = (e.result && typeof e.result === 'object' ? e.result : {}) as Record<string, unknown>;
  const card = (r.card ?? {}) as { entity?: { type?: string | null }; last_touched?: { last_timeline_date?: string | null }; backlink_count?: number };
  switch (cls) {
    case 'stale_chunks': {
      const embeddings = e.config ? configReadiness(e.config, { transport: 'stdio' }).entries.find(x => x.capability === 'embeddings') : undefined;
      if (embeddings?.state !== 'ok') return false;
      return !recallStagesFor(e.op, e.result, e.meta, e.config).some(stage => VECTOR_MISS_STAGES.has(stage));
    }
    case 'link_coverage':
      return e.op !== 'entity' || (r.found === true && card.backlink_count === 0);
    case 'timeline_coverage':
      if (e.op === 'get_timeline') return Array.isArray(e.result) && e.result.length === 0;
      if (e.op === 'entity') return r.found === true && ENTITY_TYPES.has(String(card.entity?.type ?? '')) && !card.last_touched?.last_timeline_date;
      return pageLacksTimeline(e.engine, r);
    case 'no_takes':
      return true;
  }
}

function firstRunForMcp(bundle: Notice[], render: RenderContext): Notice[] {
  return bundle.map(n => ({
    ...n,
    why: `${n.why} Finish the user's current request, then ask. Each option's argv applies it on the brain host; ${LOCK_NOTE}${dismissal(n.code, render)}`,
  }));
}

/**
 * Dispatch's one producer call on the stdio success path: the first-run
 * bundle from the second successful call on, plus the opportunity and
 * features notices whose class this call shows. A cold cache yields only
 * the bundle; the caller's ledger applies dedupe, budget and mutes. Never throws.
 */
export async function mcpOnboardingNotices(
  e: CallEvidence & { render: RenderContext },
): Promise<Notice[]> {
  try {
    if (optedOut()) return [];
    st.calls++;
    if (st.started) scheduleRefresh(e.engine);
    const out: Notice[] = [];
    if (st.calls >= 2 && st.firstRun?.length) out.push(...firstRunForMcp(st.firstRun, e.render));
    const s = st.snapshot;
    if (!s) return out;
    const gaps = onboardGaps(s.counts);
    for (const cls of Object.keys(ONBOARD_CALL_AFFINITY) as OnboardClass[]) {
      if (gaps[cls] && ONBOARD_CALL_AFFINITY[cls].includes(e.op) && await evidenceFor(cls, e)) out.push(classNotice(cls, s, e.render));
    }
    if (FEATURES_CALL_AFFINITY.includes(e.op) && s.features.some(f => f.id === 'zero-links' && f.auto_fixable)) {
      const { featuresAutoFixNotice } = await import('../../commands/features.ts');
      const notice = featuresAutoFixNotice(s.features);
      if (notice) out.push(notice);
    }
    return out;
  } catch {
    return [];
  }
}

/** Test seam: fill the cache now (ignores the idle gate and the TTL). */
export async function __warmOnboardingCacheForTests(engine: BrainEngine): Promise<void> {
  st.started = true;
  await refresh(engine, true);
}

/** Test seam: wait for a scheduled background refresh to settle. */
export async function __awaitOnboardingRefreshForTests(): Promise<void> {
  await st.refreshing;
}

/** Test seam: a fresh process state, optionally with an injected clock. */
export function __resetMcpOnboardingForTests(now: () => number = Date.now): void {
  st = { ...fresh(), now };
}

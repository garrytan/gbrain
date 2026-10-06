/**
 * Dream phase `edge_contradictions`: an LLM flags which live state
 * relationships of one subject cannot both hold now ("works_at acme-example"
 * vs "works_at widget-co"); deterministic date arithmetic (`closeContradiction`
 * in src/core/link-validity.ts) decides which one ended and when. The model
 * never supplies dates.
 *
 * Modes (`dream.edge_contradictions.mode`):
 *   propose  record a proposal; `gbrain edge-proposals accept <id>` applies it
 *   apply    apply automatically (default only for certified models)
 *   off      do nothing
 * Applying writes one timeline line on the subject page through the
 * coordinated add_timeline_entry mutation:
 *   - **2025-03-01** | gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)
 * then re-derives that page's links, so the closure lands through the
 * deterministic extractor (transition producer 'dream'). Deleting the line
 * reopens the relationship; the proposal is then marked reverted_by_user and
 * never re-proposed until the evidence changes.
 *
 * Candidates: subjects with ≥2 live relationships of the same state type to
 * different targets whose combined evidence hash has no proposal yet.
 * Bounded by max_subjects and the cycle budget meter (max_usd).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { BudgetMeter, loadAllowUnpriced, loadPricingOverrides, parseBudgetUsd } from './budget-meter.ts';
import { resolveModel } from '../model-config.ts';
import { closeContradiction, parseMultirange, utcToday, dateKey, type Stint } from '../link-validity.ts';
import { declaredSingleValueTypes, planSingleValueClosures } from '../link-single-value.ts';

export interface EdgeContradictionsResult {
  name: 'edge_contradictions';
  status: 'complete' | 'partial' | 'failed' | 'skipped';
  detail: string;
  totals?: Record<string, number>;
  duration_ms: number;
}

export interface JudgeRelationship {
  index: number;
  link_type: string;
  target: string;
  target_title: string;
  since: string | null;
  contexts: string[];
}

export interface JudgePair { a: number; b: number; conflict: boolean; confidence: number }

export type EdgeJudgeFn = (input: {
  subject: { slug: string; title: string };
  relationships: JudgeRelationship[];
  modelHint?: string;
  maxOutputTokens?: number;
}) => Promise<JudgePair[] | null>;

export type EdgeContradictionsMode = 'propose' | 'apply' | 'off';

export interface EdgeContradictionsConfig {
  mode: EdgeContradictionsMode;
  modeExplicit: boolean;
  maxSubjects: number;
  budgetUsd: number;
  allowUnpriced: boolean;
}

export interface EdgeContradictionsOpts {
  dryRun?: boolean;
  judge?: EdgeJudgeFn;
  /** Apply a proposal (tests inject; default appends the timeline line via the coordinated op path). */
  applier?: (engine: BrainEngine, proposalId: number) => Promise<ApplyOutcome>;
  /** Treat the chat model as available (tests). */
  assumeChatAvailable?: boolean;
  auditPath?: string;
}

/**
 * Models whose sealed held-out run met the certification bar (wrong closures
 * ≤ 1% on every run and as-of +10 points over the deterministic arm): E2 on
 * set C, 3 runs each, 0 wrong closures (docs/eval/decisions/p1-e2-2026-10-05).
 * With no explicit mode, a certified model defaults to `apply`; every other
 * configured model defaults to `propose`. Matched without the provider prefix
 * and dated snapshot suffix ("anthropic:claude-haiku-4-5-20251001").
 */
export const CERTIFIED_APPLY_MODELS: readonly string[] = [
  'claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'gpt-6.1-sol',
];

export function isCertifiedApplyModel(model: string): boolean {
  const id = model.trim().toLowerCase().replace(/^[a-z0-9_-]+:/, '').replace(/-\d{8}$/, '');
  return CERTIFIED_APPLY_MODELS.includes(id);
}

const DEFAULT_MAX_SUBJECTS = 200;
const DEFAULT_BUDGET_USD = 1.0;
const MAX_RELATIONSHIPS_PER_SUBJECT = 8;
const JUDGE_MAX_OUTPUT_TOKENS = 600;
export const DREAM_TIMELINE_SOURCE = 'gbrain-dream (inferred)';

export async function loadEdgeContradictionsConfig(engine: BrainEngine, model: string): Promise<EdgeContradictionsConfig> {
  const raw = (await engine.getConfig('dream.edge_contradictions.mode'))?.trim().toLowerCase();
  const explicit = raw === 'propose' || raw === 'apply' || raw === 'off';
  const mode: EdgeContradictionsMode = explicit ? raw as EdgeContradictionsMode
    : isCertifiedApplyModel(model) ? 'apply' : 'propose';
  const subjects = Number.parseInt((await engine.getConfig('dream.edge_contradictions.max_subjects')) ?? '', 10);
  return {
    mode,
    modeExplicit: explicit,
    maxSubjects: Number.isFinite(subjects) && subjects > 0 ? subjects : DEFAULT_MAX_SUBJECTS,
    budgetUsd: parseBudgetUsd(await engine.getConfig('dream.edge_contradictions.max_usd'), DEFAULT_BUDGET_USD),
    allowUnpriced: await loadAllowUnpriced(engine),
  };
}

export const EDGE_JUDGE_PROMPT = `You check a person's or organization's current relationships in a personal knowledge base.
Each numbered relationship below is currently recorded as true. Decide, for each pair of relationships
of the SAME type, whether they can both be true at the same time right now.

Examples: two full-time works_at relationships at different companies usually cannot both hold
(someone moved jobs) unless the evidence says the person holds both roles; advising two companies,
working at a company while advising another, and board seats can all hold at once.

Do not guess dates. Judge only whether both can be true now, from the evidence shown.

Output ONLY one JSON object:
{"pairs": [{"a": <index>, "b": <index>, "conflict": true|false, "confidence": <0..1>}]}
List every same-type pair once.

SUBJECT: {SUBJECT}

RELATIONSHIPS:
{RELATIONSHIPS}
`;

export function buildEdgeJudgePrompt(subject: { slug: string; title: string }, relationships: JudgeRelationship[]): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').slice(0, 240);
  const lines = relationships.map(r => `${r.index}. ${r.link_type} → ${clean(r.target_title || r.target)} (${r.target})` +
    `${r.since ? `, recorded since ${r.since}` : ', start date unknown'}` +
    `${r.contexts.length ? `\n   evidence: ${r.contexts.map(c => `"${clean(c)}"`).join(' | ')}` : ''}`);
  return EDGE_JUDGE_PROMPT.replace('{SUBJECT}', `${clean(subject.title)} (${subject.slug})`).replace('{RELATIONSHIPS}', lines.join('\n'));
}

/** Parse the judge's JSON; null on anything malformed (refusals, prose, unknown shapes). */
export function parseEdgeJudgeOutput(text: string, maxIndex: number): JudgePair[] | null {
  const match = /\{[\s\S]*\}/.exec(text ?? '');
  if (!match) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  const pairs = (parsed as { pairs?: unknown })?.pairs;
  if (!Array.isArray(pairs)) return null;
  const out: JudgePair[] = [];
  for (const p of pairs) {
    const a = Number((p as JudgePair).a), b = Number((p as JudgePair).b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || a < 1 || b < 1 || a > maxIndex || b > maxIndex) return null;
    if (typeof (p as JudgePair).conflict !== 'boolean') return null;
    const confidence = Number((p as JudgePair).confidence);
    out.push({ a, b, conflict: (p as JudgePair).conflict, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5 });
  }
  return out;
}

export async function defaultEdgeJudge(input: Parameters<EdgeJudgeFn>[0]): Promise<JudgePair[] | null> {
  const { chat } = await import('../ai/gateway.ts');
  const result = await chat({
    messages: [{ role: 'user', content: buildEdgeJudgePrompt(input.subject, input.relationships) }],
    ...(input.modelHint ? { model: input.modelHint } : {}),
    maxTokens: input.maxOutputTokens ?? JUDGE_MAX_OUTPUT_TOKENS,
    allowFallback: false,
  });
  return parseEdgeJudgeOutput(result.text, input.relationships.length);
}

interface CandidateRow {
  source_id: string; from_page_id: number; to_page_id: number; link_type: string;
  valid_ranges: string; last_start: unknown; recorded_at: unknown; evidence_hash: string;
  subject_slug: string; subject_title: string | null; target_slug: string; target_title: string | null;
}

interface SubjectGroup { sourceId: string; fromId: number; slug: string; title: string; linkType: string; rels: CandidateRow[] }

async function findCandidateGroups(engine: BrainEngine, maxSubjects: number): Promise<SubjectGroup[]> {
  const today = utcToday();
  const rows = await engine.executeRaw<CandidateRow>(
    `WITH live AS (
       SELECT lr.* FROM link_relationships lr
        WHERE lr.scope = 'all' AND lr.semantics = 'state' AND lr.valid_ranges @> $1::date
     ), multi AS (
       SELECT source_id, from_page_id, link_type FROM live
        GROUP BY 1, 2, 3 HAVING count(DISTINCT to_page_id) >= 2
        ORDER BY max(refreshed_at) DESC LIMIT $2
     )
     SELECT l.source_id, l.from_page_id, l.to_page_id, l.link_type, l.valid_ranges::text AS valid_ranges,
            l.last_start, l.recorded_at, l.evidence_hash,
            f.slug AS subject_slug, f.title AS subject_title, t.slug AS target_slug, t.title AS target_title
       FROM live l JOIN multi m USING (source_id, from_page_id, link_type)
       JOIN pages f ON f.id = l.from_page_id AND f.deleted_at IS NULL
       JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
      ORDER BY l.from_page_id, l.link_type, l.last_start NULLS FIRST, t.slug`,
    [today, maxSubjects]);
  const groups = new Map<string, SubjectGroup>();
  for (const r of rows) {
    const key = `${r.from_page_id}\0${r.link_type}`;
    let g = groups.get(key);
    if (!g) { g = { sourceId: r.source_id, fromId: Number(r.from_page_id), slug: r.subject_slug, title: r.subject_title ?? r.subject_slug, linkType: r.link_type, rels: [] }; groups.set(key, g); }
    if (g.rels.length < MAX_RELATIONSHIPS_PER_SUBJECT) g.rels.push(r);
  }
  return [...groups.values()];
}

const pairHash = (a: CandidateRow, b: CandidateRow) =>
  createHash('sha256').update([a.evidence_hash, b.evidence_hash].sort().join(':')).digest('hex').slice(0, 32);
const ordered = (a: CandidateRow, b: CandidateRow): [CandidateRow, CandidateRow] => (Number(a.to_page_id) < Number(b.to_page_id) ? [a, b] : [b, a]);

/** The timeline line an applied proposal writes. */
export function dreamClosureLine(linkType: string, endingSlug: string, otherSlug: string): string {
  return `Ended ${linkType} [[${endingSlug}]] (superseded by ${linkType} ${otherSlug})`;
}

export async function runPhaseEdgeContradictions(engine: BrainEngine, opts: EdgeContradictionsOpts = {}): Promise<EdgeContradictionsResult> {
  const start = Date.now();
  const done = (status: EdgeContradictionsResult['status'], detail: string, totals?: Record<string, number>): EdgeContradictionsResult =>
    ({ name: 'edge_contradictions', status, detail, totals, duration_ms: Date.now() - start });

  const model = await resolveModel(engine, { configKey: 'models.dream.edge_contradictions', tier: 'utility', fallback: 'haiku' });
  const config = await loadEdgeContradictionsConfig(engine, model);
  const declaredMode = await loadSingleValueMode(engine);
  if (config.mode === 'off' && declaredMode === 'off') return done('skipped', 'mode off (dream.edge_contradictions.mode, dream.single_value.mode)');

  const reverted = await markRevertedProposals(engine);
  const allGroups = await findCandidateGroups(engine, config.maxSubjects);
  if (allGroups.length === 0) return done('complete', `no subjects with competing live relationships${reverted ? `; ${reverted} reverted by user` : ''}`, { subjects: 0, reverted });
  if (opts.dryRun) return done('skipped', `dry-run: ${allGroups.length} subject(s) would be judged`, { subjects: allGroups.length });

  const declared = await runDeclaredSingleValue(engine, allGroups, declaredMode, opts);
  const groups = allGroups.filter(g => !declared.handled.has(g));
  const declaredDetail = declared.handled.size
    ? `; declared single-value: ${declared.totals.proposed} closure(s), ${declared.totals.applied} applied, ${declared.totals.undated_unresolved} undated, ${declared.totals.ambiguous_same_date} same-date`
    : '';
  const withDeclared = (t: Record<string, number>) => ({ ...t, ...Object.fromEntries(Object.entries(declared.totals).map(([k, v]) => [`declared_${k}`, v])) });
  if (groups.length === 0) return done('complete', `no subjects left for the judge${declaredDetail}`, withDeclared({ subjects: allGroups.length, reverted }));
  if (config.mode === 'off') return done(declared.handled.size ? 'complete' : 'skipped', `mode off (dream.edge_contradictions.mode)${declaredDetail}`, withDeclared({ subjects: allGroups.length, reverted }));
  if (!opts.judge && !opts.assumeChatAvailable) {
    const { isAvailable } = await import('../ai/gateway.ts');
    if (!isAvailable('chat', model)) {
      return done(declared.handled.size ? 'complete' : 'skipped', `no chat model available (${model}); configure one (gbrain models) to have relationship contradictions proposed${declaredDetail}`, withDeclared({ subjects: allGroups.length, reverted }));
    }
  }

  const meter = new BudgetMeter({
    budgetUsd: config.budgetUsd, allowUnpriced: config.allowUnpriced,
    pricingOverrides: await loadPricingOverrides(engine), phase: 'edge_contradictions', auditPath: opts.auditPath,
  });
  const judge = opts.judge ?? defaultEdgeJudge;
  const totals = { subjects: groups.length, judged: 0, proposed: 0, applied: 0, born_closed: 0, undated_unresolved: 0, ambiguous_same_date: 0, compatible: 0, errors: 0, skipped_known: 0, reverted };
  let budgetExhausted = false;

  for (const g of groups) {
    // Skip subjects whose every pair already has a proposal for this evidence.
    const pairs: Array<[CandidateRow, CandidateRow]> = [];
    for (let i = 0; i < g.rels.length; i++) for (let j = i + 1; j < g.rels.length; j++) pairs.push(ordered(g.rels[i], g.rels[j]));
    const known = new Set((await engine.executeRaw<{ a: number; b: number }>(
      `SELECT a_to_page_id AS a, b_to_page_id AS b FROM link_edge_proposals
        WHERE from_page_id = $1 AND link_type = $2 AND evidence_hash = ANY($3::text[])`,
      [g.fromId, g.linkType, pairs.map(([a, b]) => pairHash(a, b))])).map(r => `${r.a}:${r.b}`));
    const fresh = pairs.filter(([a, b]) => !known.has(`${a.to_page_id}:${b.to_page_id}`));
    if (fresh.length === 0) { totals.skipped_known++; continue; }

    const relationships: JudgeRelationship[] = await Promise.all(g.rels.map(async (r, i) => ({
      index: i + 1, link_type: r.link_type, target: r.target_slug, target_title: r.target_title ?? r.target_slug,
      since: dateKey(r.last_start),
      contexts: (await engine.executeRaw<{ context: string }>(
        `SELECT DISTINCT context FROM links WHERE from_page_id = $1 AND to_page_id = $2 AND link_type = $3 AND context <> '' LIMIT 3`,
        [r.from_page_id, r.to_page_id, r.link_type])).map(c => c.context),
    })));
    const prompt = buildEdgeJudgePrompt(g, relationships);
    const check = meter.check({ modelId: model, estimatedInputTokens: Math.ceil(prompt.length / 4), maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS, label: `edge_contradictions:${g.slug}` });
    if (!check.allowed) { budgetExhausted = true; break; }

    let verdict: JudgePair[] | null = null;
    try { verdict = await judge({ subject: g, relationships, modelHint: model, maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS }); }
    catch (e) { process.stderr.write(`[edge_contradictions] judge failed for ${g.slug}: ${(e as Error).message}\n`); }
    totals.judged++;
    for (const [a, b] of fresh) {
      const hash = pairHash(a, b);
      const ia = g.rels.indexOf(a) + 1, ib = g.rels.indexOf(b) + 1;
      if (!verdict) {
        await recordProposal(engine, g, a, b, hash, { status: 'error', model, detail: 'judge output missing or malformed' });
        totals.errors++;
        continue;
      }
      const v = verdict.find(p => (p.a === ia && p.b === ib) || (p.a === ib && p.b === ia));
      if (!v || !v.conflict) {
        await recordProposal(engine, g, a, b, hash, { status: 'compatible', model, confidence: v?.confidence ?? null });
        totals.compatible++;
        continue;
      }
      const side = (r: CandidateRow) => ({ lastStart: dateKey(r.last_start), stints: parseMultirange(r.valid_ranges) as Stint[], recordedAt: r.recorded_at instanceof Date ? r.recorded_at : String(r.recorded_at) });
      const outcome = closeContradiction(side(a), side(b));
      if (outcome.action === 'none') {
        const status = outcome.reason === 'already_disjoint' ? 'compatible' : outcome.reason;
        await recordProposal(engine, g, a, b, hash, { status, model, confidence: v.confidence });
        totals[status === 'compatible' ? 'compatible' : status]++;
        continue;
      }
      const ending = outcome.side === 'a' ? a : b;
      const other = outcome.side === 'a' ? b : a;
      const id = await recordProposal(engine, g, a, b, hash, {
        status: 'proposed', model, confidence: v.confidence, endingTo: Number(ending.to_page_id), closeDate: outcome.closeDate,
        bornClosed: outcome.bornClosed, line: dreamClosureLine(g.linkType, ending.target_slug, other.target_slug),
      });
      totals.proposed++;
      if (outcome.bornClosed) totals.born_closed++;
      if (config.mode === 'apply' && id !== null) {
        const applied = await (opts.applier ?? applyEdgeProposal)(engine, id);
        if (applied.status === 'applied') totals.applied++;
      }
    }
  }

  const detail = `judged ${totals.judged}/${groups.length} subject(s): ${totals.proposed} proposal(s)` +
    (config.mode === 'apply' ? `, ${totals.applied} applied` : ' (mode propose: review with gbrain edge-proposals list)') +
    `, ${totals.compatible} compatible, ${totals.undated_unresolved} undated, ${totals.ambiguous_same_date} same-date` +
    (totals.errors ? `, ${totals.errors} judge error(s)` : '') + (budgetExhausted ? ' (budget exhausted)' : '') +
    `. Cost: $${meter.totalSpent.toFixed(4)} / $${config.budgetUsd.toFixed(2)} with ${model}${declaredDetail}`;
  const status = budgetExhausted || totals.errors ? (totals.judged ? 'partial' : 'failed') : 'complete';
  return done(status, detail, withDeclared(totals));
}

export type SingleValueMode = 'apply' | 'propose' | 'off';
export const SINGLE_VALUE_MODEL = 'schema-pack:cardinality';

async function loadSingleValueMode(engine: BrainEngine): Promise<SingleValueMode> {
  const raw = (await engine.getConfig('dream.single_value.mode'))?.trim().toLowerCase();
  return raw === 'apply' || raw === 'off' ? raw : 'propose';
}

/**
 * Groups whose relation the source's pack declares `cardinality: one_per_from`
 * are closed by the chain rule (link-single-value.ts) without a model: each
 * live relationship ends at the next one's dated start. Undated and same-date
 * members are recorded as open conflicts. Handled groups never reach the judge.
 */
async function runDeclaredSingleValue(
  engine: BrainEngine, groups: SubjectGroup[], mode: SingleValueMode, opts: EdgeContradictionsOpts,
): Promise<{ handled: Set<SubjectGroup>; totals: Record<string, number> }> {
  const totals = { groups: 0, proposed: 0, applied: 0, undated_unresolved: 0, ambiguous_same_date: 0 };
  const handled = new Set<SubjectGroup>();
  if (mode === 'off') return { handled, totals };
  const declaredBySource = new Map<string, Set<string>>();
  for (const g of groups) {
    if (!declaredBySource.has(g.sourceId)) declaredBySource.set(g.sourceId, await declaredSingleValueTypes(engine, g.sourceId));
    if (!declaredBySource.get(g.sourceId)!.has(g.linkType)) continue;
    handled.add(g);
    totals.groups++;
    const byTo = new Map(g.rels.map(r => [Number(r.to_page_id), r]));
    const plan = planSingleValueClosures(g.rels.map(r => ({
      to_page_id: Number(r.to_page_id), lastStart: dateKey(r.last_start), stints: parseMultirange(r.valid_ranges) as Stint[],
      recordedAt: r.recorded_at instanceof Date ? r.recorded_at : r.recorded_at == null ? null : String(r.recorded_at),
    })));
    const record = async (a: CandidateRow, b: CandidateRow, p: Parameters<typeof recordProposal>[5]) => {
      const [x, y] = ordered(a, b);
      return recordProposal(engine, g, x, y, pairHash(x, y), p);
    };
    for (const c of plan.closures) {
      const ending = byTo.get(c.ending)!, successor = byTo.get(c.successor)!;
      const id = await record(ending, successor, {
        status: 'proposed', model: SINGLE_VALUE_MODEL, confidence: 1, endingTo: c.ending, closeDate: c.closeDate,
        bornClosed: c.bornClosed, line: dreamClosureLine(g.linkType, ending.target_slug, successor.target_slug),
      });
      if (id === null) continue;
      totals.proposed++;
      if (mode === 'apply' && (await (opts.applier ?? applyEdgeProposal)(engine, id)).status === 'applied') totals.applied++;
    }
    const dated = g.rels.filter(r => dateKey(r.last_start));
    for (const to of plan.undated) {
      const a = byTo.get(to)!;
      const b = dated[dated.length - 1] ?? g.rels.find(r => r !== a)!;
      if (await record(a, b, { status: 'undated_unresolved', model: SINGLE_VALUE_MODEL, detail: 'declared single-value relation without a dated start' }) !== null) totals.undated_unresolved++;
    }
    for (const [x, y] of plan.sameDate) {
      if (await record(byTo.get(x)!, byTo.get(y)!, { status: 'ambiguous_same_date', model: SINGLE_VALUE_MODEL, detail: 'declared single-value relation with two starts on the same date' }) !== null) totals.ambiguous_same_date++;
    }
  }
  return { handled, totals };
}

async function recordProposal(
  engine: BrainEngine, g: SubjectGroup, a: CandidateRow, b: CandidateRow, hash: string,
  p: { status: string; model: string; confidence?: number | null; endingTo?: number; closeDate?: string; bornClosed?: boolean; line?: string; detail?: string },
): Promise<number | null> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO link_edge_proposals (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, status,
       ending_to_page_id, close_date, born_closed, model, confidence, generated_line, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13, $14)
     ON CONFLICT (from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash) DO NOTHING
     RETURNING id`,
    [g.sourceId, g.fromId, Number(a.to_page_id), Number(b.to_page_id), g.linkType, hash, p.status,
      p.endingTo ?? null, p.closeDate ?? null, p.bornClosed ?? false, p.model, p.confidence ?? null, p.line ?? null, p.detail ?? null]);
  return rows[0] ? Number(rows[0].id) : null;
}

// ─── Apply / undo / revert detection ─────────────────────────────────────

/** Cycle adapter: maps the phase outcome onto the cycle's PhaseResult (duration filled by the caller). */
export async function edgeContradictionsCyclePhase(engine: BrainEngine | null, dryRun: boolean): Promise<PhaseResult> {
  if (!engine) return { phase: 'edge_contradictions', status: 'skipped', duration_ms: 0, summary: 'no database connected', details: { reason: 'no_database' } };
  const r = await runPhaseEdgeContradictions(engine, { dryRun });
  const status: PhaseResult['status'] = r.status === 'complete' ? 'ok' : r.status === 'partial' ? 'warn' : r.status === 'failed' ? 'fail' : 'skipped';
  return { phase: 'edge_contradictions', status, duration_ms: 0, summary: r.detail, details: { ...(r.totals ?? {}) } };
}

export type ApplyOutcome = { status: 'applied' | 'stale' | 'not_found' | 'refused' | 'undone' | 'rejected'; reason?: string };

interface ProposalRow {
  id: number; source_id: string; status: string; from_page_id: number; ending_to_page_id: number | null;
  link_type: string; close_date: unknown; generated_line: string | null; subject_slug: string; ending_slug: string | null;
}

async function loadProposal(engine: BrainEngine, id: number): Promise<ProposalRow | null> {
  const [row] = await engine.executeRaw<ProposalRow>(
    `SELECT p.id, p.source_id, p.status, p.from_page_id, p.ending_to_page_id, p.link_type, p.close_date::text AS close_date,
            p.generated_line, f.slug AS subject_slug, t.slug AS ending_slug
       FROM link_edge_proposals p JOIN pages f ON f.id = p.from_page_id LEFT JOIN pages t ON t.id = p.ending_to_page_id
      WHERE p.id = $1`, [id]);
  return row ?? null;
}

/** Does the subject page carry this proposal's closure (a dream transition on the ending relationship at the close date)? */
async function closureLanded(engine: BrainEngine, p: ProposalRow): Promise<boolean> {
  const rows = await engine.executeRaw(
    `SELECT 1 FROM link_transitions WHERE origin_page_id = $1 AND from_page_id = $1 AND to_page_id = $2 AND link_type = $3
        AND kind = 'end' AND producer = 'dream' AND occurred_on = $4::date LIMIT 1`,
    [p.from_page_id, p.ending_to_page_id, p.link_type, dateKey(p.close_date)]);
  return rows.length > 0;
}

/**
 * Apply one proposal: append the closure line to the subject page through the
 * coordinated add_timeline_entry mutation, re-derive that page's links (so the
 * closure lands as a 'dream' transition), then mark the proposal applied.
 * Refuses when the relationships changed since the judgment (stale).
 * Idempotent: replaying an applied proposal changes nothing.
 */
export async function applyEdgeProposal(engine: BrainEngine, id: number): Promise<ApplyOutcome> {
  const p = await loadProposal(engine, id);
  if (!p) return { status: 'not_found' };
  if (p.status === 'applied') return { status: 'applied', reason: 'already applied' };
  if (p.status !== 'proposed') return { status: 'refused', reason: `proposal is ${p.status}` };
  if (!p.ending_slug || !p.generated_line) return { status: 'refused', reason: 'proposal has no closure to apply' };
  const [current] = await engine.executeRaw<{ a: string; b: string }>(
    `SELECT la.evidence_hash AS a, lb.evidence_hash AS b FROM link_edge_proposals pr
       JOIN link_relationships la ON la.from_page_id = pr.from_page_id AND la.to_page_id = pr.a_to_page_id AND la.link_type = pr.link_type AND la.scope = 'all'
       JOIN link_relationships lb ON lb.from_page_id = pr.from_page_id AND lb.to_page_id = pr.b_to_page_id AND lb.link_type = pr.link_type AND lb.scope = 'all'
      WHERE pr.id = $1`, [id]);
  const [stored] = await engine.executeRaw<{ evidence_hash: string }>(`SELECT evidence_hash FROM link_edge_proposals WHERE id = $1`, [id]);
  const hashNow = current ? createHash('sha256').update([current.a, current.b].sort().join(':')).digest('hex').slice(0, 32) : null;
  if (hashNow !== stored?.evidence_hash) {
    await engine.executeRaw(`UPDATE link_edge_proposals SET status = 'stale', updated_at = now() WHERE id = $1`, [id]);
    return { status: 'stale', reason: 'the relationships changed since the judgment; the next dream cycle re-judges them' };
  }
  await appendTimelineLine(engine, p.source_id, p.subject_slug, String(dateKey(p.close_date)), p.generated_line);
  await rederivePage(engine, p.source_id, p.subject_slug);
  const landed = await closureLanded(engine, p);
  await engine.executeRaw(`UPDATE link_edge_proposals SET status = $2, updated_at = now() WHERE id = $1`, [id, landed ? 'applied' : 'proposed']);
  return landed ? { status: 'applied' } : { status: 'refused', reason: 'the closure line was written but did not re-derive; run gbrain extract --stale and re-check' };
}

/** Reject a proposal (it will not be applied; a later evidence change re-judges the pair). */
export async function rejectEdgeProposal(engine: BrainEngine, id: number): Promise<ApplyOutcome> {
  const rows = await engine.executeRaw(`UPDATE link_edge_proposals SET status = 'rejected', updated_at = now() WHERE id = $1 AND status IN ('proposed','undated_unresolved','ambiguous_same_date') RETURNING 1`, [id]);
  return rows.length ? { status: 'rejected' } : { status: 'refused', reason: 'only open proposals can be rejected' };
}

/** Undo an applied proposal: remove its exact closure line, re-derive, mark undone. */
export async function undoEdgeProposal(engine: BrainEngine, id: number): Promise<ApplyOutcome> {
  const p = await loadProposal(engine, id);
  if (!p) return { status: 'not_found' };
  if (p.status !== 'applied' || !p.generated_line) return { status: 'refused', reason: `proposal is ${p.status}` };
  const removed = await removeTimelineLine(engine, p.source_id, p.subject_slug, String(dateKey(p.close_date)), p.generated_line);
  await rederivePage(engine, p.source_id, p.subject_slug);
  await engine.executeRaw(`UPDATE link_edge_proposals SET status = 'undone', updated_at = now() WHERE id = $1`, [id]);
  return { status: 'undone', ...(removed ? {} : { reason: 'the closure line was already gone' }) };
}

/** Applied proposals whose closure line the user deleted become reverted_by_user (never re-proposed for that evidence). */
async function markRevertedProposals(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE link_edge_proposals p SET status = 'reverted_by_user', updated_at = now()
      WHERE p.status = 'applied' AND p.updated_at < now() AND NOT EXISTS (
        SELECT 1 FROM link_transitions t WHERE t.origin_page_id = p.from_page_id AND t.from_page_id = p.from_page_id
          AND t.to_page_id = p.ending_to_page_id AND t.link_type = p.link_type AND t.kind = 'end' AND t.producer = 'dream'
          AND t.occurred_on = p.close_date)
      RETURNING p.id`);
  return rows.length;
}

async function trustedCtx(engine: BrainEngine, sourceId: string) {
  return {
    engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as import('../operations.ts').OperationContext;
}

async function appendTimelineLine(engine: BrainEngine, sourceId: string, slug: string, date: string, summary: string): Promise<void> {
  const { operations } = await import('../operations.ts');
  const op = operations.find(o => o.name === 'add_timeline_entry')!;
  await op.handler(await trustedCtx(engine, sourceId), { slug, date, summary, source: DREAM_TIMELINE_SOURCE });
}

async function removeTimelineLine(engine: BrainEngine, sourceId: string, slug: string, date: string, summary: string): Promise<boolean> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return false;
  const needle = `- **${date}** | ${DREAM_TIMELINE_SOURCE} — ${summary}`;
  const strip = (text: string) => text.split('\n').filter(l => l.trim() !== needle).join('\n');
  const page = snapshot.page;
  const compiled = strip(page.compiled_truth ?? ''), timeline = strip(page.timeline ?? '');
  if (compiled === (page.compiled_truth ?? '') && timeline === (page.timeline ?? '')) return false;
  const { serializeMarkdown } = await import('../markdown.ts');
  const { operations } = await import('../operations.ts');
  const put = operations.find(o => o.name === 'put_page')!;
  const content = serializeMarkdown((page.frontmatter ?? {}) as Record<string, unknown>, compiled, timeline,
    { type: page.type, title: page.title, tags: snapshot.tags });
  await put.handler(await trustedCtx(engine, sourceId), { slug, content, expected_revision: snapshot.revision });
  return true;
}

/** Re-derive one page's links + temporal evidence from its current content (zero LLM). */
async function rederivePage(engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  const { autoLinkWrittenPage } = await import('../ops/pages.ts');
  await autoLinkWrittenPage(engine, slug, { sourceId });
}

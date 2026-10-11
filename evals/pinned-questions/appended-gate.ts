/**
 * B5 benefit gate, appended-corrections workload (run 2). Notes accumulate the
 * way real notes do: a correction is a new dated note and the old one stays as
 * written. Each entity gets 12 write batches (13 writes):
 *
 *   batch 0   the entity page, with a first city
 *   batch 4   two conflicting notes the same week; the later one corrects the earlier
 *   batch 6   the update arrives through `remember` (a facts-fence row on the entity page)
 *   batch 7   that remembered fact is withdrawn with `forget`; the answer reverts
 *   batch 10  the newest note is made private (no new value)
 *   others    one dated update note each
 *
 * The gold answer after each batch is the newest value that is still standing.
 * Arms: pinned (one per refresh model); query + reader and anchored retrieval +
 * reader (the exact evidence pinned refresh retrieves, no maintained answer),
 * each at the pinned answer's delivered-token budget and at full evidence; and
 * on-demand think. Each arm reads once per state
 * (entity x batch). A read is deterministic in cost for a given state, so reads
 * per write of 1, 10 and 100 weight those measured reads, while the pinned
 * refresh schedule (the standing_questions phase after every batch) does not
 * depend on reads. After the visibility change, a restricted MCP grant probes
 * search, get_page, context_pack and questions_status for leaks every batch.
 *
 *   bun evals/pinned-questions/appended-gate.ts --plan
 *   bun evals/pinned-questions/appended-gate.ts --offline --json
 *   bun evals/pinned-questions/appended-gate.ts --run --yes --max-usd 10 --reader-model anthropic:claude-sonnet-5-5 \
 *     --refresh-models anthropic:claude-opus-4-7,anthropic:claude-sonnet-5-5 --json
 *
 * Run 3 adds --seeds 42,7,1234, --embeddings voyage:voyage-4 (embed after every batch) and --partial <file>
 * (per-seed results written as each seed finishes); every run reports the anchored-retrieval and
 * full-evidence reader arms and the preregistered decision.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { normalizeModelId } from '../../src/core/model-id.ts';
import { pinQuestion, pinnedAnswersForPack } from '../../src/core/questions/service.ts';
import { runPhaseStandingQuestions } from '../../src/core/questions/phase.ts';
import { retrieveEvidence } from '../../src/core/questions/refresh.ts';
import { listPins } from '../../src/core/questions/store.ts';
import { CITIES, SpendGuard, correctFor, offlineArms, paidArms, priced, readerAnswer, staleFor, tokens, type GateOpts } from './benefit-gate.ts';

export const RATIOS = [1, 10, 100] as const;
export const BATCHES = 12;
const DAY = 86_400_000;

type EventKind = 'create' | 'note' | 'conflict_a' | 'conflict_b' | 'remember' | 'forget' | 'make_private';
export interface AppendedEvent { kind: EventKind; entity: string; batch: number; city?: string; date: string }
export interface AppendedWorkload {
  seed: number;
  entities: Array<{ slug: string; name: string }>;
  batches: AppendedEvent[][];
  /** gold[entity][batch]: the standing value after that batch. */
  gold: Record<string, string[]>;
  /** Every value an entity has ever had (for stale-wrong detection). */
  history: Record<string, string[]>;
}

export function generateAppendedWorkload(seed: number, entityCount = 6): AppendedWorkload {
  let state = seed >>> 0;
  const rand = () => { state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return state / 2 ** 32; };
  const entities = Array.from({ length: entityCount }, (_, i) => ({ slug: `companies/example-${i + 1}`, name: `example-${i + 1}` }));
  const batches: AppendedEvent[][] = Array.from({ length: BATCHES }, () => []);
  const gold: Record<string, string[]> = {};
  const history: Record<string, string[]> = {};
  const date = (b: number, extraDays = 0) => new Date(Date.UTC(2026, 0, 1) + (b * 15 + extraDays) * DAY).toISOString().slice(0, 10);
  for (const e of entities) {
    const pick = (avoid: string[]) => { const options = CITIES.filter(c => !avoid.includes(c)); return options[Math.floor(rand() * options.length)]!; };
    let current = pick([]);
    let beforeRemember = current;
    const seen = [current];
    gold[e.slug] = [];
    for (let b = 0; b < BATCHES; b++) {
      const ev = (kind: EventKind, city?: string, extraDays = 0) => batches[b]!.push({ kind, entity: e.slug, batch: b, ...(city ? { city } : {}), date: date(b, extraDays) });
      if (b === 0) ev('create', current);
      else if (b === 4) {
        const wrong = pick([current]);
        const right = pick([current, wrong]);
        ev('conflict_a', wrong); ev('conflict_b', right, 1);
        seen.push(wrong, right); current = right;
      } else if (b === 6) {
        beforeRemember = current;
        current = pick([current]); seen.push(current); ev('remember', current);
      } else if (b === 7) { ev('forget'); current = beforeRemember; }
      else if (b === 10) ev('make_private');
      else { current = pick([current]); seen.push(current); ev('note', current); }
      gold[e.slug]!.push(current);
    }
    history[e.slug] = [...new Set(seen)];
  }
  return { seed, entities, batches, gold, history };
}

export const applyEventsForTest = (engine: BrainEngine, events: AppendedEvent[], remembered: Map<string, string>) => applyEvents(engine, events, remembered);

export function appendedHash(w: AppendedWorkload): string {
  return createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16);
}

export const question = (name: string) => `Which city does ${name} build widgets in now?`;
const noteSlug = (entity: string, b: number, suffix = '') => `notes/${entity.split('/')[1]}-update-${b}${suffix}`;
const noteBody = (name: string, b: number, text: string, date: string, extra = '') =>
  `---\ntype: note\ntitle: ${name} update ${b}\ndate: ${date}\n${extra}---\n${text}\n`;

async function applyEvents(engine: BrainEngine, events: AppendedEvent[], remembered: Map<string, string>): Promise<void> {
  const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true } as never, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  const put = async (slug: string, content: string) => {
    const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, source_id: 'default', ...(snap ? { expected_revision: snap.revision } : {}) } });
  };
  for (const e of events) {
    const name = e.entity.split('/')[1]!;
    switch (e.kind) {
      case 'create': await put(e.entity, `---\ntype: company\ntitle: ${name}\n---\nAs of ${e.date}, ${name} builds widgets in ${e.city}.\n`); break;
      case 'note': await put(noteSlug(e.entity, e.batch), noteBody(name, e.batch, `As of ${e.date}, ${name} builds widgets in ${e.city}.`, e.date)); break;
      case 'conflict_a': await put(noteSlug(e.entity, e.batch, 'a'), noteBody(name, e.batch, `As of ${e.date}, a morning memo says ${name} builds widgets in ${e.city}.`, e.date)); break;
      case 'conflict_b': await put(noteSlug(e.entity, e.batch, 'b'), noteBody(name, e.batch, `As of ${e.date}, correction to the morning memo: ${name} builds widgets in ${e.city}; the memo was wrong.`, e.date)); break;
      case 'remember': {
        const r = await handleToolCall(engine, 'remember', { fact: `As of ${e.date}, ${name} builds widgets in ${e.city}.`, entity: e.entity, provenance: 'workload' }) as { id: string };
        remembered.set(e.entity, String(r.id));
        break;
      }
      case 'forget': await handleToolCall(engine, 'forget', { id: remembered.get(e.entity)! }); break;
      case 'make_private': {
        const slug = noteSlug(e.entity, 9);
        const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
        await put(slug, noteBody(name, 9, snap!.page.compiled_truth.trim(), String((snap!.page.frontmatter as Record<string, unknown>).date ?? e.date), 'visibility: private\n'));
        break;
      }
    }
  }
}

/** Restricted MCP grant (cannot read private pages): any private-note text, slug or pinned answer text in a response is a leak. */
export async function leakageProbe(engine: BrainEngine, w: AppendedWorkload, answerTexts: string[]): Promise<{ probes: number; leaks: string[] }> {
  const leaks: string[] = [];
  let probes = 0;
  const auth = { token: 't', clientId: 'b5-probe', scopes: ['read'], sourceId: 'default', allowedSources: ['default'] };
  // Answer text that also appears in a world-visible page is that page's text, not a leaked answer.
  const publicTexts = (await engine.executeRaw<{ body: string }>(
    `SELECT compiled_truth AS body FROM pages WHERE deleted_at IS NULL AND COALESCE(frontmatter->>'visibility', 'world') <> 'private' AND NOT (frontmatter ? 'pinned_question')`)).map(r => r.body);
  for (const e of w.entities) {
    const slug = noteSlug(e.slug, 9);
    const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    const secret = snap?.page.compiled_truth.trim() ?? '';
    for (const [tool, params] of [
      ['search', { query: `${e.name} builds widgets` }], ['get_page', { slug }], ['context_pack', { entities: e.slug }],
      ['questions_status', { id: `default:questions/x` }],
    ] as Array<[string, Record<string, unknown>]>) {
      probes++;
      const r = await dispatchToolCall(engine, tool, params, { remote: true, transport: 'stdio', sourceId: 'default', auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
      const text = r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
      const echoed = params.slug === slug;
      const privateNote = (secret && text.includes(secret)) || (!echoed && text.includes(slug));
      const pinnedSurface = text.includes('pinned_questions') || text.includes('"withheld"') || /questions\/[a-z0-9-]+-[0-9a-f]{8}/.test(text)
        || (tool === 'questions_status' && !text.includes('question_owner_only'));
      const answerOnly = answerTexts.some(a => a.length > 20 && text.includes(a) && !publicTexts.some(p => p.includes(a)));
      if (privateNote || pinnedSurface || answerOnly) leaks.push(`${tool}:${e.slug}`);
    }
  }
  return { probes, leaks };
}

export interface StateRead { entity: string; batch: number; gold: string; correct: boolean; stale: boolean; usd: number }
export interface ArmRun { arm: string; refresh_model?: string; reads: StateRead[]; lifecycle_usd: number; refresh_attempts: number }

/** Arms that read the brain directly (no maintained answer). `_full` variants get every retrieved item; the others the pinned answer's token budget. */
export const READER_ARMS = ['query_reader', 'query_reader_full', 'anchored_reader', 'anchored_reader_full'] as const;
const FULL_QUERY_HITS = 16;

export interface AppendedOpts {
  workload: AppendedWorkload;
  readerModel: string;
  /** Refresh model for the pinned arm; the first pinned arm also runs the reader arms, think and the leakage probe. */
  refreshModel: string;
  withBaselines: boolean;
  /** Embed stale chunks after every write batch (needs an embedding model configured on the gateway). */
  embed?: boolean;
  arms: Pick<GateOpts, 'questionChat' | 'reader' | 'think'>;
}

export const fit = (parts: string[], budget: number) => {
  let context = '';
  for (const part of parts) {
    const next = `${context}\n${part}`;
    if (tokens(next) > budget) break;
    context = next;
  }
  return context.trim();
};

export async function runAppended(opts: AppendedOpts): Promise<{ arms: ArmRun[]; leakage: { probes: number; leaks: string[] } }> {
  const w = opts.workload;
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const newArm = (arm: string, refresh_model?: string): ArmRun => ({ arm, ...(refresh_model ? { refresh_model } : {}), reads: [], lifecycle_usd: 0, refresh_attempts: 0 });
  const pinned = newArm('pinned', opts.refreshModel);
  const readers = Object.fromEntries(READER_ARMS.map(a => [a, newArm(a)])) as Record<typeof READER_ARMS[number], ArmRun>;
  const think = newArm('think');
  const leakage = { probes: 0, leaks: [] as string[] };
  const remembered = new Map<string, string>();
  try {
    await engine.setConfig('models.standing_questions', opts.refreshModel);
    await engine.setConfig('cycle.standing_questions.cooldown_days', '0');
    await engine.setConfig('cycle.standing_questions.max_per_cycle', String(w.entities.length));
    await engine.setConfig('cycle.standing_questions.budget_usd', '1000');
    await engine.setConfig('cycle.standing_questions.last_run_at', new Date().toISOString());
    const ctx = { engine, config: { engine: engine.kind, embedding_disabled: !opts.embed } as never, remote: false as const, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    const { hybridSearch } = await import('../../src/core/search/hybrid.ts');
    const { runEmbedCore } = await import('../../src/commands/embed.ts');
    for (let b = 0; b < BATCHES; b++) {
      await applyEvents(engine, w.batches[b]!, remembered);
      if (opts.embed) {
        const r = await runEmbedCore(engine, { stale: true, sourceId: 'default', quiet: true });
        if (r.failures > 0) throw new Error(`embedding failed for ${r.failures} page(s): ${JSON.stringify(r.failure_samples)}`);
      }
      if (b === 0) {
        for (const e of w.entities) await pinQuestion(ctx, { question: question(e.name), scope: { entity: e.slug } }, { chat: opts.arms.questionChat });
      } else {
        await runPhaseStandingQuestions(engine, { dryRun: false, chat: opts.arms.questionChat });
      }
      const pins = await listPins(engine, { sourceIds: ['default'] });
      const answerTexts: string[] = [];
      for (const e of w.entities) {
        const gold = w.gold[e.slug]![b]!;
        const past = new Set(w.history[e.slug]!);
        const q = question(e.name);
        const read = async (arm: ArmRun, context: string) => {
          const r = await readerAnswer(opts.arms.reader, opts.readerModel, q, context);
          arm.reads.push({ entity: e.slug, batch: b, gold, correct: correctFor(r.text, gold), stale: staleFor(r.text, gold, past), usd: priced(r.model, r.input_tokens, r.output_tokens) });
        };
        const pack = await pinnedAnswersForPack(ctx, [e.slug]);
        const pinnedText = (pack?.pinned_questions ?? []).flatMap(p => p.answer).join(' ');
        answerTexts.push(...(pack?.pinned_questions ?? []).flatMap(p => p.answer));
        await read(pinned, pinnedText);
        if (!opts.withBaselines) continue;
        const budget = Math.max(tokens(pinnedText), 200);
        const hits = (await hybridSearch(engine, q, { sourceId: 'default', limit: FULL_QUERY_HITS })).map(h => `[${h.slug}] ${h.chunk_text}`);
        const pin = pins.find(p => p.scope_entity === e.slug);
        const anchored = pin ? (await retrieveEvidence(engine, pin)).map(i => i.text) : [];
        await read(readers.query_reader, fit(hits, budget));
        await read(readers.query_reader_full, hits.join('\n'));
        await read(readers.anchored_reader, fit(anchored, budget));
        await read(readers.anchored_reader_full, anchored.join('\n'));
        const t = await opts.arms.think(q, engine, 'default');
        think.reads.push({ entity: e.slug, batch: b, gold, correct: correctFor(t.answer, gold), stale: staleFor(t.answer, gold, past), usd: t.usd });
      }
      if (opts.withBaselines && b >= 10) {
        const probe = await leakageProbe(engine, w, answerTexts);
        leakage.probes += probe.probes; leakage.leaks.push(...probe.leaks);
      }
    }
    const [spend] = await engine.executeRaw<{ usd: number; attempts: number }>('SELECT COALESCE(SUM(spend_usd), 0)::float8 AS usd, COALESCE(SUM(refresh_attempts), 0)::int AS attempts FROM pinned_questions');
    pinned.lifecycle_usd = Number(spend?.usd ?? 0);
    pinned.refresh_attempts = Number(spend?.attempts ?? 0);
  } finally {
    await engine.disconnect();
  }
  return { arms: opts.withBaselines ? [pinned, ...Object.values(readers), think] : [pinned], leakage };
}

/** Batches until an arm is correct again after the gold value changes (censored at the end of the run). */
export function freshnessLag(reads: StateRead[], w: AppendedWorkload): { changes: number; mean_lag_batches: number; correct_at_change: number } {
  let changes = 0, lagSum = 0, atChange = 0;
  for (const e of w.entities) {
    const g = w.gold[e.slug]!;
    const byBatch = new Map(reads.filter(r => r.entity === e.slug).map(r => [r.batch, r]));
    for (let b = 1; b < g.length; b++) {
      if (g[b] === g[b - 1]) continue;
      changes++;
      let k = 0;
      while (b + k < g.length && g[b + k] === g[b] && !byBatch.get(b + k)?.correct) k++;
      lagSum += k;
      if (byBatch.get(b)?.correct) atChange++;
    }
  }
  return { changes, mean_lag_batches: changes ? lagSum / changes : 0, correct_at_change: changes ? atChange / changes : 0 };
}

export function summarize(arm: ArmRun, w: AppendedWorkload, ratio: number, queryPerRead: number | null) {
  const n = arm.reads.length;
  const correct = arm.reads.filter(r => r.correct).length;
  const stale = arm.reads.filter(r => r.stale).length;
  const perRead = n ? arm.reads.reduce((s, r) => s + r.usd, 0) / n : 0;
  const usd = arm.lifecycle_usd + ratio * n * perRead;
  return {
    arm: arm.arm, ...(arm.refresh_model ? { refresh_model: arm.refresh_model } : {}), reads_per_write: ratio,
    reads: n * ratio, accuracy: n ? correct / n : 0, stale_wrong_rate: n ? stale / n : 0,
    lifecycle_usd: arm.lifecycle_usd, read_usd: ratio * n * perRead, usd, usd_per_correct: correct ? usd / (correct * ratio) : null,
    ...(arm.arm === 'pinned' && queryPerRead !== null ? { break_even_reads_per_pin: queryPerRead > perRead ? Math.ceil(arm.lifecycle_usd / w.entities.length / (queryPerRead - perRead)) : null } : {}),
    freshness: freshnessLag(arm.reads, w),
  };
}

type Summary = ReturnType<typeof summarize>;
const spread = (xs: number[]) => ({ mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) });

/** Mean and spread across seeds of each arm's per-seed summary at one reads-per-write ratio. */
export function aggregate(perSeed: Summary[][]): Array<Record<string, unknown>> {
  const key = (s: Summary) => `${s.reads_per_write}|${s.arm}|${s.refresh_model ?? ''}`;
  const groups = new Map<string, Summary[]>();
  for (const s of perSeed.flat()) groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);
  return [...groups.values()].map(g => ({
    reads_per_write: g[0]!.reads_per_write, arm: g[0]!.arm, ...(g[0]!.refresh_model ? { refresh_model: g[0]!.refresh_model } : {}), seeds: g.length,
    accuracy: spread(g.map(s => s.accuracy)), stale_wrong_rate: spread(g.map(s => s.stale_wrong_rate)),
    mean_lag_batches: spread(g.map(s => s.freshness.mean_lag_batches)), correct_at_change: spread(g.map(s => s.freshness.correct_at_change)),
    lifecycle_usd: spread(g.map(s => s.lifecycle_usd)), usd_per_correct: spread(g.map(s => s.usd_per_correct ?? Infinity)),
  }));
}

/**
 * Run-3 preregistered rule: pinned (default refresh model) beats the anchored
 * control when, in every seed, its accuracy is higher or its freshness lag is
 * lower, with zero leaks across seeds. A leak means opt-in; otherwise a miss is a tie.
 */
export function decide(perSeed: Array<{ seed: number; summary: Summary[]; leaks: number }>, defaultModel: string, control = 'anchored_reader') {
  const seeds = perSeed.map(({ seed, summary, leaks }) => {
    const at1 = summary.filter(s => s.reads_per_write === 1);
    const p = at1.find(s => s.arm === 'pinned' && s.refresh_model === defaultModel)!;
    const c = at1.find(s => s.arm === control)!;
    const accuracy = p.accuracy > c.accuracy;
    const freshness = p.freshness.mean_lag_batches < c.freshness.mean_lag_batches;
    return { seed, leaks, pinned_accuracy: p.accuracy, control_accuracy: c.accuracy, pinned_lag: p.freshness.mean_lag_batches, control_lag: c.freshness.mean_lag_batches, beats_accuracy: accuracy, beats_freshness: freshness, beats: accuracy || freshness };
  });
  const leaks = seeds.reduce((n, s) => n + s.leaks, 0);
  const outcome = leaks > 0 ? 'opt_in_leak' : seeds.every(s => s.beats) ? 'pinned_beats_control' : 'tie_anchored_retrieval_wins';
  return { control, refresh_model: defaultModel, seeds, leaks, outcome };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const json = args.includes('--json');
  const seeds = (flag('--seeds') ?? flag('--seed') ?? '42').split(',').map(Number);
  const readerModel = flag('--reader-model') ?? 'anthropic:claude-sonnet-5-5';
  const embeddingModel = flag('--embeddings');
  const { resolveModel } = await import('../../src/core/model-config.ts');
  const defaultModel = await resolveModel(null, { configKey: 'models.standing_questions', tier: 'deep', fallback: 'opus' });
  const refreshModels = (flag('--refresh-models') ?? defaultModel).split(',').map(s => s.trim()).filter(Boolean);
  const entities = Number(flag('--entities') ?? 6);
  const workloads = seeds.map(seed => generateAppendedWorkload(seed, entities));
  const states = entities * BATCHES;
  // Per state, at run 2's measured sizes x1.25 (full-evidence reads are new and sized generously): each refresh model's refresh
  // (1.25k in / 200 out) plus its pinned read, two budgeted reader arms (650 in / 50 out), two full-evidence reader arms
  // (2k in / 50 out) and think (3k in / 550 out). The SpendGuard enforces the cap; embedding calls are not metered.
  const perState = refreshModels.reduce((s, m) => s + priced(m, 1_250, 200) + priced(readerModel, 650, 50), 0)
    + 2 * priced(readerModel, 650, 50) + 2 * priced(readerModel, 2_000, 50) + priced(defaultModel, 3_000, 550);
  const estimate = seeds.length * states * perState;
  const plan = { mode: 'plan', seeds, workload_hashes: workloads.map(appendedHash), states_per_seed: states, refresh_models: refreshModels, reader_model: readerModel, embedding_model: embeddingModel ?? null, est_usd: estimate };
  if (args.includes('--plan') || (!args.includes('--offline') && !args.includes('--run'))) {
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }
  const paid = args.includes('--run');
  const cap = Number(flag('--max-usd'));
  if (paid && (!args.includes('--yes') || !Number.isFinite(cap) || cap < estimate)) {
    console.error(`Refusing a paid run: pass --yes and --max-usd >= the estimate ($${estimate.toFixed(2)}).`);
    process.exit(3);
  }
  if (embeddingModel && !paid) {
    console.error('--embeddings needs --run (offline mode makes no network calls).');
    process.exit(2);
  }
  const guard = new SpendGuard(paid ? cap : Infinity);
  if (paid) {
    const { configureGateway } = await import('../../src/core/ai/gateway.ts');
    configureGateway({ chat_model: normalizeModelId(defaultModel), ...(embeddingModel ? { embedding_model: embeddingModel, embedding_dimensions: 1024 } : {}), env: { ...process.env } as Record<string, string> });
  }
  const perSeed: Array<{ seed: number; workload_hash: string; leakage: { probes: number; leaks: string[] }; summary: Summary[]; reads: unknown[] }> = [];
  for (const workload of workloads) {
    const runs: ArmRun[] = [];
    let leakage = { probes: 0, leaks: [] as string[] };
    for (const [i, model] of refreshModels.entries()) {
      const arms = paid ? paidArms(defaultModel, guard) : offlineArms(model, readerModel);
      const out = await runAppended({ workload, readerModel, refreshModel: model, withBaselines: i === 0, embed: !!embeddingModel, arms });
      runs.push(...out.arms);
      if (i === 0) leakage = out.leakage;
      if (!json) console.error(`[appended-gate] seed ${workload.seed}, refresh model ${model} done; metered spend $${guard.spent.toFixed(4)}`);
    }
    const queryRun = runs.find(r => r.arm === 'query_reader');
    const queryPerRead = queryRun && queryRun.reads.length ? queryRun.reads.reduce((s, r) => s + r.usd, 0) / queryRun.reads.length : null;
    perSeed.push({ seed: workload.seed, workload_hash: appendedHash(workload), leakage, summary: RATIOS.flatMap(ratio => runs.map(r => summarize(r, workload, ratio, queryPerRead))),
      reads: runs.map(r => ({ arm: r.arm, refresh_model: r.refresh_model ?? null, lifecycle_usd: r.lifecycle_usd, refresh_attempts: r.refresh_attempts, reads: r.reads })) });
    const partial = flag('--partial');
    if (partial) writeFileSync(partial, JSON.stringify({ metered_spend_usd: guard.spent, per_seed: perSeed }, null, 2));
  }
  const out = { mode: paid ? 'run' : 'offline', plumbing_only: !paid, workload: 'appended', seeds, entities, batches: BATCHES, states_per_seed: states,
    reader_model: readerModel, think_model: defaultModel, refresh_models: refreshModels, embedding_model: embeddingModel ?? null,
    metered_spend_usd: Number.isFinite(guard.spent) ? guard.spent : null,
    leakage: { probes: perSeed.reduce((n, s) => n + s.leakage.probes, 0), leaks: perSeed.flatMap(s => s.leakage.leaks.map(l => `seed ${s.seed}:${l}`)) },
    decision: decide(perSeed.map(s => ({ seed: s.seed, summary: s.summary, leaks: s.leakage.leaks.length })), refreshModels.includes(defaultModel) ? defaultModel : refreshModels[0]!),
    aggregate: aggregate(perSeed.map(s => s.summary)), per_seed: perSeed };
  console.log(json ? JSON.stringify(out, null, 2) : JSON.stringify(out));
}

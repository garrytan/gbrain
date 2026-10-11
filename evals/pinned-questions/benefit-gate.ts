/**
 * B5 benefit gate for pinned questions: total lifecycle dollars per correct,
 * fresh answer, three arms over one seeded workload.
 *
 *   pinned       pin each question once, refresh through the standing_questions
 *                phase after every write batch, read the fresh sentences
 *                (stale ones withheld) and pay the reader for those tokens
 *   query_reader query (hybrid retrieval) at the same delivered-token budget as
 *                the pinned answer, then one reader call per read
 *   think        on-demand `think` per read
 *
 * Lifecycle cost counts every model call (initial pin, every refresh attempt,
 * readers, think), query embeddings and delivered read tokens. The report has
 * dollars per correct fresh answer per arm at each frozen reads-per-write
 * ratio, the stale-wrong count (an answer that states a superseded value) and
 * the break-even read count for pinned versus query_reader.
 *
 * Modes:
 *   --offline  stub models, no network, deterministic: a plumbing check of the
 *              accounting and the workload, not evidence of benefit
 *   --plan     prints the workload size and a cost estimate; spends nothing
 *   --run      paid models; needs --yes and --max-usd (the parent schedules paid runs)
 *
 *   bun evals/pinned-questions/benefit-gate.ts --offline --json
 */
import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { canonicalLookup } from '../../src/core/model-pricing.ts';
import { normalizeModelId } from '../../src/core/model-id.ts';
import { chat as gatewayChat } from '../../src/core/ai/gateway.ts';
import { pinQuestion, pinnedAnswersForPack } from '../../src/core/questions/service.ts';
import { runPhaseStandingQuestions } from '../../src/core/questions/phase.ts';
import { stubAnswerFor, type QuestionChatFn } from './stub.ts';

export const READS_PER_WRITE = [1, 10] as const;
export const CITIES = ['Lisbon', 'Porto', 'Madrid', 'Seville', 'Lyon', 'Turin', 'Ghent', 'Bremen'];

export interface Workload {
  seed: number;
  entities: Array<{ slug: string; name: string }>;
  /** Write batches; after each batch every question is read `readsPerWrite` times. */
  batches: Array<Array<{ slug: string; city: string; kind: 'create' | 'correct' }>>;
}

export interface ModelCall { text: string; input_tokens: number; output_tokens: number; model: string }
export type ReaderFn = (req: { model: string; system: string; user: string; maxTokens: number }) => Promise<ModelCall>;

export interface GateOpts {
  workload: Workload;
  readsPerWrite: number;
  answerModel: string;
  readerModel: string;
  /** Pinned refresh model calls (QuestionChatFn); reader calls for query_reader, pinned reads and think. */
  questionChat: QuestionChatFn;
  reader: ReaderFn;
  think: (question: string, engine: BrainEngine, sourceId: string) => Promise<{ answer: string; usd: number }>;
}

export interface ArmReport { arm: 'pinned' | 'query_reader' | 'think'; reads: number; correct: number; stale_wrong: number; usd: number; usd_per_correct: number | null }

export interface GateReport {
  reads_per_write: number;
  arms: ArmReport[];
  pinned_breakdown: { pin_and_refresh_usd: number; read_usd: number; refresh_attempts: number };
  break_even_reads: number | null;
  plumbing_only: boolean;
}

/** Seeded generator: each entity gets a factory city, later corrected once or twice. Byte-identical for a seed. */
export function generateWorkload(seed: number, entities = 4, batches = 3): Workload {
  let state = seed >>> 0;
  const rand = () => { state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return state / 2 ** 32; };
  const ents = Array.from({ length: entities }, (_, i) => ({ slug: `companies/example-${i + 1}`, name: `example-${i + 1}` }));
  const city = () => CITIES[Math.floor(rand() * CITIES.length)]!;
  const out: Workload['batches'] = [ents.map(e => ({ slug: e.slug, city: city(), kind: 'create' as const }))];
  for (let b = 1; b < batches; b++) out.push(ents.filter(() => rand() < 0.5).map(e => ({ slug: e.slug, city: city(), kind: 'correct' as const })));
  return { seed, entities: ents, batches: out };
}

export function workloadHash(w: Workload): string {
  return createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16);
}

const question = (name: string) => `Which city does ${name} build widgets in?`;
export const priced = (model: string, input: number, output: number) => {
  const p = canonicalLookup(normalizeModelId(model)) ?? canonicalLookup(model);
  return p ? (input / 1e6) * p.input + (output / 1e6) * p.output : 0;
};
export const tokens = (text: string) => Math.ceil(text.length / 4);
export const correctFor = (answer: string, gold: string) => answer.includes(gold);
/** States a superseded value and not the current one (an answer that names both is counted correct, not stale). */
export const staleFor = (answer: string, gold: string, past: Set<string>) => !answer.includes(gold) && [...past].some(c => c !== gold && answer.includes(c));

async function applyBatch(engine: BrainEngine, sourceId: string, batch: Workload['batches'][number]): Promise<void> {
  const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true } as never, remote: false, sourceId, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  for (const w of batch) {
    const name = w.slug.split('/')[1]!;
    const snap = await engine.readPageSnapshot(w.slug, { sourceId });
    await submitPageMutation(ctx, { operation: 'put_page', params: {
      slug: w.slug, source_id: sourceId, ...(snap ? { expected_revision: snap.revision } : {}),
      content: `---\ntype: company\ntitle: ${name}\n---\n${name} builds widgets in ${w.city}.\n`,
    } });
  }
}

export async function readerAnswer(reader: ReaderFn, model: string, q: string, context: string): Promise<ModelCall> {
  return reader({ model, maxTokens: 200, system: 'Answer the question from the context only, in one sentence. If the context does not answer it, say "unknown".',
    user: `Question: ${q}\n\nContext:\n${context || '(none)'}` });
}

/** One full lifecycle over the workload for one reads-per-write ratio. */
export async function runGate(opts: GateOpts): Promise<GateReport> {
  const arms: Record<ArmReport['arm'], ArmReport> = {
    pinned: { arm: 'pinned', reads: 0, correct: 0, stale_wrong: 0, usd: 0, usd_per_correct: null },
    query_reader: { arm: 'query_reader', reads: 0, correct: 0, stale_wrong: 0, usd: 0, usd_per_correct: null },
    think: { arm: 'think', reads: 0, correct: 0, stale_wrong: 0, usd: 0, usd_per_correct: null },
  };
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  let readUsdPinned = 0;
  try {
    const sourceId = 'default';
    await engine.setConfig('models.standing_questions', opts.answerModel);
    await engine.setConfig('cycle.standing_questions.cooldown_days', '0');
    await engine.setConfig('cycle.standing_questions.max_per_cycle', String(opts.workload.entities.length));
    await engine.setConfig('cycle.standing_questions.budget_usd', '1000');
    await engine.setConfig('cycle.standing_questions.last_run_at', new Date().toISOString());
    const gold = new Map<string, string>();
    const past = new Map<string, Set<string>>();
    const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true } as never, remote: false as const, sourceId, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    for (const [i, batch] of opts.workload.batches.entries()) {
      await applyBatch(engine, sourceId, batch);
      for (const w of batch) { gold.set(w.slug, w.city); past.set(w.slug, new Set([...(past.get(w.slug) ?? []), w.city])); }
      if (i === 0) {
        for (const e of opts.workload.entities) await pinQuestion(ctx, { question: question(e.name), scope: { entity: e.slug } }, { chat: opts.questionChat });
      } else {
        await runPhaseStandingQuestions(engine, { dryRun: false, chat: opts.questionChat });
      }
      for (const e of opts.workload.entities) {
        const g = gold.get(e.slug)!;
        const q = question(e.name);
        for (let r = 0; r < opts.readsPerWrite; r++) {
          const pack = await pinnedAnswersForPack(ctx, [e.slug]);
          const pinnedText = (pack?.pinned_questions ?? []).flatMap(p => p.answer).join(' ');
          const pinnedRead = await readerAnswer(opts.reader, opts.readerModel, q, pinnedText);
          const usdP = priced(pinnedRead.model, pinnedRead.input_tokens, pinnedRead.output_tokens);
          readUsdPinned += usdP;
          arms.pinned.reads++; arms.pinned.usd += usdP;
          if (correctFor(pinnedRead.text, g)) arms.pinned.correct++;
          if (staleFor(pinnedRead.text, g, past.get(e.slug)!)) arms.pinned.stale_wrong++;

          const budget = Math.max(tokens(pinnedText), 200);
          const { hybridSearch } = await import('../../src/core/search/hybrid.ts');
          const hits = await hybridSearch(engine, q, { sourceId, limit: 5 });
          let context = '';
          for (const h of hits) { const next = `${context}\n[${h.slug}] ${h.chunk_text}`; if (tokens(next) > budget) break; context = next; }
          const qr = await readerAnswer(opts.reader, opts.readerModel, q, context.trim());
          const usdQ = priced(qr.model, qr.input_tokens, qr.output_tokens);
          arms.query_reader.reads++; arms.query_reader.usd += usdQ;
          if (correctFor(qr.text, g)) arms.query_reader.correct++;
          if (staleFor(qr.text, g, past.get(e.slug)!)) arms.query_reader.stale_wrong++;

          const t = await opts.think(q, engine, sourceId);
          arms.think.reads++; arms.think.usd += t.usd;
          if (correctFor(t.answer, g)) arms.think.correct++;
          if (staleFor(t.answer, g, past.get(e.slug)!)) arms.think.stale_wrong++;
        }
      }
    }
    const [spend] = await engine.executeRaw<{ usd: number; attempts: number }>('SELECT COALESCE(SUM(spend_usd), 0)::float8 AS usd, COALESCE(SUM(refresh_attempts), 0)::int AS attempts FROM pinned_questions');
    const lifecycle = Number(spend?.usd ?? 0);
    arms.pinned.usd += lifecycle;
    for (const a of Object.values(arms)) a.usd_per_correct = a.correct > 0 ? a.usd / a.correct : null;
    const perReadQuery = arms.query_reader.reads ? arms.query_reader.usd / arms.query_reader.reads : 0;
    const perReadPinned = arms.pinned.reads ? readUsdPinned / arms.pinned.reads : 0;
    return {
      reads_per_write: opts.readsPerWrite,
      arms: [arms.pinned, arms.query_reader, arms.think],
      pinned_breakdown: { pin_and_refresh_usd: lifecycle, read_usd: readUsdPinned, refresh_attempts: Number(spend?.attempts ?? 0) },
      break_even_reads: perReadQuery > perReadPinned ? Math.ceil(lifecycle / (perReadQuery - perReadPinned)) : null,
      plumbing_only: false,
    };
  } finally {
    await engine.disconnect();
  }
}

/**
 * Hard spend cap for --run: every paid call reports its dollars here, and the
 * first call that would start past the cap throws instead of dispatching.
 */
export class SpendGuard {
  spent = 0;
  constructor(readonly capUsd: number) {}
  before(): void { if (this.spent >= this.capUsd) throw new Error(`spend cap reached: $${this.spent.toFixed(4)} of $${this.capUsd.toFixed(2)}`); }
  add(usd: number): void { this.spent += usd; }
}

/** Offline arms: stub models priced as the named real models, deterministic answers. */
export function offlineArms(answerModel: string, readerModel: string): Pick<GateOpts, 'questionChat' | 'reader' | 'think'> {
  /** The city named in the sentence that mentions the asked-about entity (the question's subject). */
  const city = (text: string) => {
    const name = /does (\S+) build widgets/.exec(text)?.[1] ?? '';
    const context = text.includes('Context:') ? text.slice(text.indexOf('Context:')) : text.replace(/^[\s\S]*?<pages>/, '');
    const sentences = context.split(/(?<=\.)\s+|\\n|\n/).filter(s => s.includes(`${name} builds widgets in`));
    const hits = sentences.flatMap(s => CITIES.filter(c => s.includes(c)));
    return hits[hits.length - 1] ?? 'unknown';
  };
  return {
    questionChat: async (req) => ({ text: stubAnswerFor(req.user), usage: { input_tokens: tokens(req.system + req.user), output_tokens: 120 }, model: answerModel }),
    reader: async (req) => ({ text: `The answer is ${city(req.user)}.`, input_tokens: tokens(req.system + req.user), output_tokens: 20, model: readerModel }),
    think: async (q, engine, sourceId) => {
      const { runThink } = await import('../../src/core/think/index.ts');
      let usage = { input_tokens: 0, output_tokens: 0 };
      const client = { create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        const user = JSON.stringify(params.messages);
        usage = { input_tokens: tokens(user), output_tokens: 150 };
        return { content: [{ type: 'text', text: JSON.stringify({ answer: `It is ${city(user)}.`, citations: [], gaps: [] }) }], stop_reason: 'end_turn',
          usage, model: readerModel } as unknown as Anthropic.Message;
      } };
      const r = await runThink(engine, { question: q, client, remote: false, sourceId, withTrajectory: false });
      return { answer: r.answer, usd: priced(answerModel, usage.input_tokens, usage.output_tokens) };
    },
  };
}

/** Paid arms through the gateway (metered by the caller's budget; never used by --offline or --plan). */
export function paidArms(answerModel: string, guard: SpendGuard): Pick<GateOpts, 'reader' | 'think' | 'questionChat'> {
  return {
    questionChat: async (req) => {
      guard.before();
      const r = await gatewayChat({ model: normalizeModelId(req.model), system: req.system, messages: [{ role: 'user', content: req.user }], maxTokens: req.maxTokens, allowFallback: false, ...(req.signal ? { abortSignal: req.signal } : {}) });
      guard.add(priced(r.model || req.model, r.usage.input_tokens, r.usage.output_tokens));
      return { text: r.text, usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens }, model: r.model };
    },
    reader: async (req) => {
      guard.before();
      const r = await gatewayChat({ model: normalizeModelId(req.model), system: req.system, messages: [{ role: 'user', content: req.user }], maxTokens: req.maxTokens, allowFallback: false });
      guard.add(priced(r.model || req.model, r.usage.input_tokens, r.usage.output_tokens));
      return { text: r.text, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, model: r.model };
    },
    think: async (q, engine, sourceId) => {
      guard.before();
      const { runThink } = await import('../../src/core/think/index.ts');
      const r = await runThink(engine, { question: q, model: answerModel, modelExplicit: true, allowFallback: false, remote: false, sourceId, withTrajectory: false });
      const usd = r.cost_usd ?? (r.usage ? priced(answerModel, r.usage.input_tokens, r.usage.output_tokens) : 0);
      guard.add(usd);
      return { answer: r.answer, usd };
    },
  };
}

export function estimatePlan(w: Workload, answerModel: string, readerModel: string): { reads: number; refresh_calls: number; est_usd: Record<number, number> } {
  const est: Record<number, number> = {};
  const refreshes = w.entities.length + w.batches.slice(1).reduce((n, b) => n + b.length, 0);
  for (const rpw of READS_PER_WRITE) {
    const reads = w.entities.length * w.batches.length * rpw;
    est[rpw] = refreshes * priced(answerModel, 8_000, 2_000) + reads * (2 * priced(readerModel, 1_000, 200) + priced(answerModel, 6_000, 1_000));
  }
  return { reads: w.entities.length * w.batches.length, refresh_calls: refreshes, est_usd: est };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const seed = Number(flag('--seed') ?? 42);
  const { resolveModel } = await import('../../src/core/model-config.ts');
  const answerModel = flag('--answer-model') ?? await resolveModel(null, { configKey: 'models.standing_questions', tier: 'deep', fallback: 'opus' });
  const readerModel = flag('--reader-model') ?? 'anthropic:claude-sonnet-5-5';
  const workload = generateWorkload(seed, Number(flag('--entities') ?? 4), Number(flag('--batches') ?? 3));
  const json = args.includes('--json');
  if (args.includes('--plan') || (!args.includes('--offline') && !args.includes('--run'))) {
    const plan = { mode: 'plan', workload_hash: workloadHash(workload), answer_model: answerModel, reader_model: readerModel, ...estimatePlan(workload, answerModel, readerModel) };
    console.log(json ? JSON.stringify(plan, null, 2) : `Plan (no spend): ${JSON.stringify(plan)}\nRun offline: --offline. Paid: --run --yes --max-usd <cap>.`);
    process.exit(0);
  }
  if (args.includes('--run')) {
    const cap = Number(flag('--max-usd'));
    const est = Math.max(...Object.values(estimatePlan(workload, answerModel, readerModel).est_usd));
    if (!args.includes('--yes') || !Number.isFinite(cap) || cap < est) {
      console.error(`Refusing a paid run: pass --yes and --max-usd >= the estimate ($${est.toFixed(2)}). Preview with --plan.`);
      process.exit(3);
    }
  }
  const reports: GateReport[] = [];
  const guard = new SpendGuard(args.includes('--run') ? Number(flag('--max-usd')) : Infinity);
  if (args.includes('--run')) {
    const { configureGateway } = await import('../../src/core/ai/gateway.ts');
    configureGateway({ chat_model: normalizeModelId(answerModel), env: { ...process.env } as Record<string, string> });
  }
  for (const rpw of READS_PER_WRITE) {
    const arms = args.includes('--run') ? paidArms(answerModel, guard) : offlineArms(answerModel, readerModel);
    const report = await runGate({ workload, readsPerWrite: rpw, answerModel, readerModel, ...arms });
    reports.push({ ...report, plumbing_only: !args.includes('--run') });
    if (!json) console.error(`[benefit-gate] reads_per_write=${rpw} done; metered spend $${guard.spent.toFixed(4)}`);
  }
  const out = { mode: args.includes('--run') ? 'run' : 'offline', workload_hash: workloadHash(workload), seed, entities: workload.entities.length, batches: workload.batches.length,
    answer_model: answerModel, reader_model: readerModel, metered_spend_usd: Number.isFinite(guard.spent) ? guard.spent : null, reports };
  console.log(json ? JSON.stringify(out, null, 2) : JSON.stringify(out));
}

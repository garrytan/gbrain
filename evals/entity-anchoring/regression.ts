/**
 * Entity-anchored query retrieval, gate 2 (docs/eval/decisions/entity-anchoring-query/):
 * the existing retrieval evals that cover `query`, each run through the
 * `query` op with `search.entity_anchoring` on and off. Hermetic and
 * keyword-only (no gateway): NamedThingBench, the relational retrieval-quality
 * fixture, and the LongMemEval nightly fixture ingested the way
 * `gbrain eval longmemeval` ingests it. Each corpus also runs a cue-added
 * variant (" now" appended) as a diagnostic, so anchoring fires on corpora
 * whose questions never ask for a current state. `--dump-off <file>` writes the
 * key-off rows for a byte-identity check against a build without the change.
 *
 *   bun evals/entity-anchoring/regression.ts --json [--key search.query_facts_arm]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import { scoreQuestion, type NamedThingQuestion } from '../../src/eval/retrieval-quality/harness.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { haystackToPages, sessionSlug } from '../../src/eval/longmemeval/adapter.ts';
import { loadNamedThingQuestions, seedNamedThingCorpus } from '../../test/fixtures/retrieval-quality/namedthing/corpus.ts';
import { RELATIONAL_QUESTIONS, seedRelationalCorpus } from '../../test/fixtures/retrieval-quality/relational/corpus.ts';

const KEY = (() => { const i = process.argv.indexOf('--key'); return i >= 0 ? process.argv[i + 1]! : 'search.entity_anchoring'; })();
const TOKEN_BUDGET = (() => { const i = process.argv.indexOf('--token-budget'); return i >= 0 ? Number(process.argv[i + 1]) : undefined; })();
type Row = { slug: string; entity_anchored?: string; result_type?: string; chunk_text?: string };
/** Page rows only: an added fact row is not a page hit for recall. */
const pagesOf = (rows: Row[]) => rows.filter(r => r.result_type !== 'fact');
/** The key's own rows: anchored pages, facts-arm rows, or (temporal reserve) date-headed fact rows. */
const fired = (rows: Row[]) => rows.some(r => r.entity_anchored
  || (r.result_type === 'fact' && (KEY !== 'search.temporal_fact_reserve' || r.chunk_text?.startsWith('[observed '))));
const dump: Record<string, unknown> = {};

async function freshEngine(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

async function ranked(engine: PGLiteEngine, query: string, on: boolean, label: string): Promise<Row[]> {
  await engine.setConfig(KEY, on ? 'true' : 'false');
  const rows = await handleToolCall(engine, 'query', { query, limit: 10, expand: false, use_cache: false, ...(TOKEN_BUDGET ? { token_budget: TOKEN_BUDGET } : {}) }) as Row[];
  if (!on) dump[`${label}::${query}`] = rows;
  return rows;
}

interface CorpusReport { corpus: string; questions: number; triggered: number; recall10_lower: string[]; recall10_higher: number;
  mean_recall10: { on: number; off: number }; mean_rr: { on: number; off: number }; negative_clean_lost: string[] }

async function scoreCorpus(corpus: string, engine: PGLiteEngine, questions: NamedThingQuestion[]): Promise<CorpusReport> {
  const r: CorpusReport = { corpus, questions: questions.length, triggered: 0, recall10_lower: [], recall10_higher: 0, mean_recall10: { on: 0, off: 0 }, mean_rr: { on: 0, off: 0 }, negative_clean_lost: [] };
  for (const q of questions) {
    const on = await ranked(engine, q.query, true, corpus);
    const off = await ranked(engine, q.query, false, corpus);
    if (fired(on)) r.triggered++;
    const son = scoreQuestion(q, pagesOf(on).map(x => x.slug)), soff = scoreQuestion(q, pagesOf(off).map(x => x.slug));
    if (son.recall_at_10 < soff.recall_at_10) r.recall10_lower.push(q.query);
    if (son.recall_at_10 > soff.recall_at_10) r.recall10_higher++;
    if (soff.negative_clean === true && son.negative_clean === false) r.negative_clean_lost.push(q.query);
    r.mean_recall10.on += son.recall_at_10 / questions.length; r.mean_recall10.off += soff.recall_at_10 / questions.length;
    r.mean_rr.on += son.reciprocal_rank / questions.length; r.mean_rr.off += soff.reciprocal_rank / questions.length;
  }
  return r;
}

const withCue = (qs: NamedThingQuestion[]) => qs.map(q => ({ ...q, query: `${q.query.replace(/[?.!\s]+$/, '')} now?` }));

async function longMemEval(path: string, cue: boolean): Promise<CorpusReport> {
  const qs = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const r: CorpusReport = { corpus: `longmemeval-nightly${cue ? '+now' : ''}`, questions: qs.length, triggered: 0, recall10_lower: [], recall10_higher: 0, mean_recall10: { on: 0, off: 0 }, mean_rr: { on: 0, off: 0 }, negative_clean_lost: [] };
  for (const q of qs) {
    const engine = await freshEngine();
    try {
      for (const p of haystackToPages(q)) await importFromContent(engine, p.slug, p.content, { noEmbed: true });
      const gold = new Set<string>((q.answer_session_ids ?? []).map((id: string) => sessionSlug(q.question_id, id)));
      const text = cue ? `${String(q.question).replace(/[?.!\s]+$/, '')} now?` : q.question;
      const recall = (rows: Row[]) => gold.size ? rows.filter(x => gold.has(x.slug)).length / gold.size : 0;
      const rr = (rows: Row[]) => { const i = rows.findIndex(x => gold.has(x.slug)); return i < 0 ? 0 : 1 / (i + 1); };
      const on = pagesOf(await ranked(engine, text, true, r.corpus)), off = pagesOf(await ranked(engine, text, false, r.corpus));
      if (fired(await ranked(engine, text, true, `${r.corpus}#probe`))) r.triggered++;
      if (recall(on) < recall(off)) r.recall10_lower.push(q.question_id);
      if (recall(on) > recall(off)) r.recall10_higher++;
      r.mean_recall10.on += recall(on) / qs.length; r.mean_recall10.off += recall(off) / qs.length;
      r.mean_rr.on += rr(on) / qs.length; r.mean_rr.off += rr(off) / qs.length;
    } finally {
      await engine.disconnect();
    }
  }
  return r;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const reports: CorpusReport[] = [];
  for (const [name, seed, questions] of [
    ['namedthing', seedNamedThingCorpus, loadNamedThingQuestions()],
    ['relational', seedRelationalCorpus, RELATIONAL_QUESTIONS],
  ] as const) {
    const engine = await freshEngine();
    try {
      await seed(engine);
      reports.push(await scoreCorpus(name, engine, [...questions]));
      reports.push(await scoreCorpus(`${name}+now`, engine, withCue([...questions])));
      if (KEY === 'search.query_facts_arm' || KEY === 'search.temporal_fact_reserve') {
        // Diagnostic: one saved fact restating each question's answer, so fact rows take page slots.
        for (const q of questions) {
          const answer = q.relevant?.[0];
          if (answer) await engine.insertFact({ fact: `${q.query.replace(/[?.!\s]+$/, '')}: ${answer}`, kind: 'fact', entity_slug: q.seed ?? null, source: 'regression diagnostic', visibility: 'world' }, { source_id: 'default' });
        }
        reports.push(await scoreCorpus(`${name}+facts`, engine, [...questions]));
        // Not a gate: the same questions with a temporal cue, so the reserve fires.
        if (KEY === 'search.temporal_fact_reserve') reports.push(await scoreCorpus(`${name}+facts+when`, engine, questions.map(q => ({ ...q, query: `${q.query.replace(/[?.!\s]+$/, '')}, and when?` }))));
      }
    } finally {
      await engine.disconnect();
    }
  }
  const lme = new URL('../../test/fixtures/longmemeval-nightly.jsonl', import.meta.url).pathname;
  reports.push(await longMemEval(lme, false), await longMemEval(lme, true));
  const asWritten = reports.filter(r => !r.corpus.endsWith('+now') && !r.corpus.endsWith('+facts'));
  const withFacts = reports.filter(r => !r.corpus.endsWith('+now') && !r.corpus.endsWith('+when'));
  const out = { mode: 'hermetic', keyword_only: true, key: KEY, token_budget: TOKEN_BUDGET ?? null, pass: asWritten.every(r => r.recall10_lower.length === 0),
    pass_with_facts_diagnostics: withFacts.every(r => r.recall10_lower.length === 0), reports };
  const dumpPath = flag('--dump-off');
  if (dumpPath) writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  console.log(args.includes('--json') ? JSON.stringify(out, null, 2) : JSON.stringify(out));
}

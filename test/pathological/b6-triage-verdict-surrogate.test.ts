/**
 * GBRA-130 B-6 (#6860): the significance judge's quotes, notes, entities and content type were cut with UTF-16
 * `.slice`, so a cut inside a surrogate pair left a lone surrogate; both engines' JSONB input rejects it
 * (22P02), the verdict was never cached, the error stopped the triage pool and failed the synthesize phase, and
 * every cycle paid to judge the same transcript again.
 *
 * Authoring gate:
 * 1. Protects: a verdict whose strings were cut at a surrogate pair is cached well-formed; a verdict the
 *    database still refuses (here a NUL, 22P05) is reported per transcript, backs off like an unreliable verdict
 *    and never stops the other transcripts; run-scoped write errors still stop the pass.
 * 2. Regression: reverting any of the four cuts to `.slice`, dropping the write-time guard in putDreamVerdict,
 *    or rethrowing a per-transcript cache-write failure out of the pool.
 * 3. test/cycle-synthesize-triage.test.ts runs against a Map-backed fake engine that accepts any string, so it
 *    cannot see a JSONB refusal; this file runs the real engines (PGLite, and Postgres when DATABASE_URL is set).
 * 4. No production seam: the bad states are judge responses; run-scoped errors are injected by spying the
 *    engine's putDreamVerdict.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine, DreamVerdictInput } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildTriageMapBlock, runTriagePass, TRIAGE_VERSION, type JudgeClient, type TriagePassCfg } from '../../src/core/cycle/synthesize.ts';
import type { DiscoveredTranscript } from '../../src/core/cycle/transcript-discovery.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, type ItemSnapshotRow } from './harness.ts';

const MODEL = 'anthropic:claude-haiku-4-5-20251001';
const EMOJI = '\u{1F600}';

function transcript(prefix: string, name: string, content = `transcript ${name} discusses the durable memory roadmap. `.repeat(20)): DiscoveredTranscript {
  return { filePath: `/corpus/${prefix}/${name}.txt`, contentHash: `${prefix}-${name}-${content.length}`.padEnd(20, '0'), content, basename: name, inferredDate: null };
}

/** A judge whose verdict for each transcript is `verdicts[name]`, or a plain 0.8 verdict; counts calls. */
function judgeFor(verdicts: Record<string, Record<string, unknown>> = {}): JudgeClient & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    create: async params => {
      calls++;
      const asked = JSON.stringify(params.messages);
      const name = Object.keys(verdicts).find(n => asked.includes(`transcript ${n} `));
      const text = JSON.stringify(name ? verdicts[name] : { score: 0.8, content_type: 'reflection', segments: [{ quote: 'discusses the durable memory roadmap', note: 'plan' }], entities: ['acme-example'], reasons: ['ok'] });
      return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } } as never;
    },
  };
}

const cfg = (judge: JudgeClient, over: Partial<TriagePassCfg> = {}): TriagePassCfg =>
  ({ model: MODEL, maxChars: 24_000, maxTokens: 2048, threshold: 0.5, concurrency: 4, maxMs: 0, judge, ...over });

/** Verdict rows under one prefix in the harness snapshot shape: what a lost or rewritten verdict would change. */
async function snapshotVerdicts(engine: BrainEngine, prefix: string): Promise<Map<string, ItemSnapshotRow>> {
  const rows = await engine.executeRaw<{ file_path: string; content_hash: string; score: string | null; judged_at: string; segments: number }>(
    `SELECT file_path, content_hash, score::text AS score, judged_at::text AS judged_at, COALESCE(jsonb_array_length(segments), 0)::int AS segments
       FROM dream_verdicts WHERE file_path LIKE $1 ORDER BY file_path`, [`/corpus/${prefix}/%`]);
  return new Map(rows.map(r => [r.file_path, { slug: r.file_path, content_hash: `${r.content_hash}:${r.score}`, updated_at: r.judged_at, deleted_at: null, links: 0, chunks: r.segments }]));
}

const seed = (engine: BrainEngine, t: DiscoveredTranscript) => engine.putDreamVerdict(t.filePath, t.contentHash, {
  worth_processing: true, reasons: ['seed'], score: 0.9, content_type: 'reflection', segments: [{ quote: 'seeded quote' }], entities: [], model: MODEL, triage_version: TRIAGE_VERSION,
} satisfies DreamVerdictInput);

const nulVerdict = { score: 0.8, content_type: 'reflection', segments: [{ quote: 'discusses the durable\u0000memory roadmap' }], entities: [], reasons: ['ok'] };

describe('buildTriageMapBlock (B-6, #6860)', () => {
  test('a cached quote or note longer than the block cut never leaves a lone surrogate in the prompt', () => {
    const quote = `${'A'.repeat(299)}${EMOJI}`;
    const block = buildTriageMapBlock({ score: 0.9, content_type: 'reflection', entities: [], segments: [{ quote, note: `${'B'.repeat(199)}${EMOJI}` }] }, quote, 1);
    expect(block).toContain('A'.repeat(60));
    expect(block.isWellFormed()).toBe(true);
  });
});

for (const arm of pathologicalArms()) {
  describe(`B-6 triage verdict cache (${arm.backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (arm.backend === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(arm.databaseUrl!);
        engine = pg.engine;
        close = pg.close;
      }
    }, 180_000);
    afterAll(async () => { await close(); });

    test('B-6 fix: a quote, note, entity and content type cut inside a surrogate pair are cached well-formed and every transcript is cached', async () => {
      const p = 'fix';
      const [bad, healthy, other, cached] = ['emoji', 'healthy', 'other', 'cached'].map(n => transcript(p, n));
      await seed(engine, cached!);
      const judge = judgeFor({ emoji: { score: 0.8, content_type: `${'d'.repeat(39)}${EMOJI}`, reasons: ['ok'],
        segments: [{ quote: `${'A'.repeat(299)}${EMOJI}`, note: `${'B'.repeat(199)}${EMOJI}` }], entities: [`${'C'.repeat(79)}${EMOJI}`] } });
      const before = await snapshotVerdicts(engine, p);
      const pass = await expectUnitNotAborted(() => runTriagePass(engine, [bad!, healthy!, other!, cached!], cfg(judge)));
      expect(pass.verdictCacheFailures).toEqual([]);
      expect(judge.calls()).toBe(3);
      const row = (await engine.getDreamVerdict(bad!.filePath, bad!.contentHash))!;
      expect(row.score).toBe(0.8);
      expect([row.content_type, row.segments[0]!.quote, row.segments[0]!.note, row.entities[0]].map(s => String(s).isWellFormed())).toEqual([true, true, true, true]);
      expect(row.segments[0]!.quote).toBe('A'.repeat(299));
      expectOthersUnchanged(before, await snapshotVerdicts(engine, p), { expectProgress: [bad!.filePath, healthy!.filePath, other!.filePath] });
    }, 60_000);

    test('B-6 guard: putDreamVerdict stores a payload carrying lone surrogates as well-formed text', async () => {
      const t = transcript('guard', 'direct');
      await engine.putDreamVerdict(t.filePath, t.contentHash, { worth_processing: true, reasons: ['r\uD83D'], score: 0.7, content_type: 'reflection',
        segments: [{ quote: `${'A'.repeat(10)}\uD83D`, note: '\uDE00 note' }], entities: ['acme-example\uD83D'], model: MODEL, triage_version: TRIAGE_VERSION });
      const row = (await engine.getDreamVerdict(t.filePath, t.contentHash))!;
      expect(row.segments[0]!.quote).toBe(`${'A'.repeat(10)}\uFFFD`);
      expect([row.reasons[0], row.segments[0]!.note, row.entities[0]]).toEqual(['r\uFFFD', '\uFFFD note', 'acme-example\uFFFD']);
    }, 60_000);

    test('B-6 item: a verdict the database refuses is not cached, is reported with its code and fix, backs off, and the pool continues', async () => {
      const p = 'item';
      const [bad, healthy, other, cached] = ['nul', 'healthy', 'other', 'cached'].map(n => transcript(p, n));
      await seed(engine, cached!);
      const judge = judgeFor({ nul: nulVerdict });
      const before = await snapshotVerdicts(engine, p);
      const pass = await expectUnitNotAborted(() => runTriagePass(engine, [bad!, healthy!, other!, cached!], cfg(judge)));
      const failure = pass.verdictCacheFailures[0];
      expectItemFailure(failure && { key: failure.file, code: failure.code, fix: failure.fix.argv?.join(' ') }, { key: bad!.filePath, code: 'invalid_data', fix: /^gbrain dream retriage --force$/ });
      expect(pass.verdictCacheFailures.length).toBe(1);
      expect(pass.reports[0]).toMatchObject({ filePath: bad!.filePath, score: 0.8, worth: true, cached: false });
      const marker = (await engine.getDreamVerdict(bad!.filePath, bad!.contentHash))!;
      expect({ score: marker.score, content_type: marker.content_type }).toEqual({ score: null, content_type: 'triage_unreliable' });
      expectOthersUnchanged(before, await snapshotVerdicts(engine, p), { changed: [bad!.filePath], expectProgress: [healthy!.filePath, other!.filePath] });
    }, 60_000);

    test('B-6 run: a run-scoped error writing a verdict stops the pass and records nothing', async () => {
      const p = 'run';
      const write = engine.putDreamVerdict;
      for (const [i, { name, error }] of runScopedErrors().entries()) {
        const [bad, healthy] = [`bad${i}`, `healthy${i}`].map(n => transcript(p, n));
        const spy = spyOn(engine, 'putDreamVerdict').mockImplementation(async function (this: BrainEngine, filePath, ...rest) {
          if (filePath === bad!.filePath) throw error();
          return write.call(this, filePath, ...rest);
        });
        let thrown: unknown;
        try { await runTriagePass(engine, [bad!, healthy!], cfg(judgeFor(), { concurrency: 1 })); } catch (e) { thrown = e; } finally { spy.mockRestore(); }
        expect({ name, stopped: thrown !== undefined }).toEqual({ name, stopped: true });
        expect({ name, row: await engine.getDreamVerdict(bad!.filePath, bad!.contentHash) }).toEqual({ name, row: null });
        expect({ name, healthy: await engine.getDreamVerdict(healthy!.filePath, healthy!.contentHash) }).toEqual({ name, healthy: null });
      }
    }, 60_000);

    test('B-6 breaker: when most verdicts are refused the pass stops item_failures_systemic and backs off nothing', async () => {
      const p = 'breaker';
      const names = ['n0', 'n1', 'n2', 'n3', 'n4'];
      const transcripts = names.map(n => transcript(p, n));
      let thrown: unknown;
      try { await runTriagePass(engine, transcripts, cfg(judgeFor(Object.fromEntries(names.map(n => [n, nulVerdict]))), { concurrency: 1 })); } catch (e) { thrown = e; }
      expect((thrown as { code?: string } | undefined)?.code).toBe('item_failures_systemic');
      expect((await snapshotVerdicts(engine, p)).size).toBe(0);
    }, 60_000);

    test('B-6 recovery: a backed-off transcript is not judged again until its content changes, then its verdict is cached', async () => {
      const p = 'recovery';
      const bad = transcript(p, 'nul');
      const judge = judgeFor({ nul: nulVerdict });
      await runTriagePass(engine, [bad], cfg(judge));
      expect(judge.calls()).toBe(1);
      const held = await runTriagePass(engine, [bad], cfg(judge));
      expect(judge.calls()).toBe(1);
      expect(held.reports[0]).toMatchObject({ deferred: true, code: 'triage_unreliable_backoff' });
      const edited = transcript(p, 'nul', `transcript nul was edited and discusses the durable memory roadmap. `.repeat(20));
      const clean = judgeFor();
      const pass = await runTriagePass(engine, [edited], cfg(clean));
      expect(clean.calls()).toBe(1);
      expect(pass.verdictCacheFailures).toEqual([]);
      expect((await engine.getDreamVerdict(edited.filePath, edited.contentHash))?.score).toBe(0.8);
    }, 60_000);
  });
}

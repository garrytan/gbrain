/**
 * scripts/r1-namedthing-rerank-ab.ts + test/fixtures/retrieval-quality/namedthing/corpus.ts
 * — hermetic pins. No network: the embed transport is stubbed to throw (the CI
 * gate's stub), so only the OFF arm can run in-process; the ON arm's paid path
 * is covered by the pure verdict/integrity functions and by the CLI dry run's
 * "ON arm skipped" contract.
 */

import { describe, test, expect, beforeAll, afterAll  } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import type { RerankerReadiness } from '../src/core/ai/reranker-readiness.ts';
import { NAMEDTHING_CORPUS, loadNamedThingQuestions, seedNamedThingCorpus } from './fixtures/retrieval-quality/namedthing/corpus.ts';
import {
  ARM_PINS,
  R1_GLOSSARY_KEYS,
  R1_ON_RERANKER_MODEL,
  SEARCH_PIN_RESERVED,
  applyArmPins,
  buildOverlay,
  embedIntegrityProblems,
  onArmIntegrityProblems,
  pairArms,
  parseArgs,
  r1Verdict,
  renderMarkdown,
  runArm,
  type ArmRun,
  type QueryRecord,
  type R1Payload,
  type VerdictRow,
} from '../scripts/r1-namedthing-rerank-ab.ts';

const ROOT = join(import.meta.dir, '..');

describe('NamedThingBench corpus module', () => {
  test('corpus is the gate corpus: 3 placeholder pages, 4 chunks, 2 aliased pages, answers every fixture slug', () => {
    expect(NAMEDTHING_CORPUS.map(p => p.slug)).toEqual([
      'projects/example-amphitheater',
      'projects/example-civic-platform',
      'people/alice-example',
    ]);
    expect(NAMEDTHING_CORPUS.reduce((n, p) => n + p.chunks.length, 0)).toBe(4);
    expect(NAMEDTHING_CORPUS.filter(p => p.aliases?.length).length).toBe(2);
    const slugs = new Set(NAMEDTHING_CORPUS.map(p => p.slug));
    const questions = loadNamedThingQuestions();
    expect(questions.length).toBe(12);
    for (const q of questions) {
      for (const s of [...(q.relevant ?? []), ...(q.forbidden ?? [])]) expect(slugs.has(s)).toBe(true);
    }
  });

});

describe('seedNamedThingCorpus embedder contract', () => {
  // Own engine in beforeAll (test-isolation rule R3): the rejected seed may
  // have written pages before throwing, so it must not share the OFF-arm brain.
  let contractEngine: PGLiteEngine;
  beforeAll(async () => {
    __setEmbedTransportForTests(() => { throw new Error('stub'); });
    contractEngine = new PGLiteEngine();
    await contractEngine.connect({});
    await contractEngine.initSchema();
  });
  afterAll(async () => {
    __setEmbedTransportForTests(null);
    await contractEngine.disconnect();
  });
  test('refuses an embedder that returns the wrong count', async () => {
    await expect(seedNamedThingCorpus(contractEngine, { embed: async () => [new Float32Array(4)] })).rejects.toThrow(/returned 1 vector/);
  });
});

describe('OFF arm (stubbed embed) reproduces the CI gate through the arm runner', () => {
  let engine: PGLiteEngine;
  let off: ArmRun;

  beforeAll(async () => {
    __setEmbedTransportForTests(() => { throw new Error('stub: no embed in R1 test'); });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const seeded = await seedNamedThingCorpus(engine);
    expect(seeded).toEqual({ pages: 3, chunks: 4, embedded: 0, embedded_chars: 0 });
    await applyArmPins(engine, 'off');
    off = await runArm(engine, 'off', loadNamedThingQuestions());
  });

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    await engine.disconnect();
  });

  test('pins land on the config plane hybridSearch reads', async () => {
    for (const [k, v] of Object.entries(ARM_PINS.off)) expect(await engine.getConfig(k)).toBe(v);
    expect(ARM_PINS.on['search.reranker.model']).toBe(R1_ON_RERANKER_MODEL);
    expect(ARM_PINS.on['search.autocut']).toBe('false');
    expect(ARM_PINS.off['search.autocut']).toBe('false');
  });

  test('an overlay lands on top of the arm pins (and the reserved keys are exactly the arm axis)', async () => {
    await applyArmPins(engine, 'off', { 'search.autocut': 'true', 'search.relational_rerank_pin': '3' });
    expect(await engine.getConfig('search.autocut')).toBe('true');
    expect(await engine.getConfig('search.relational_rerank_pin')).toBe('3');
    expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
    await applyArmPins(engine, 'off'); // restore the pinned OFF shape for the sibling tests
    expect(await engine.getConfig('search.autocut')).toBe('false');
    // Every key the two arms differ on is reserved from --search-pin; every shared key is not.
    const onOnly = Object.keys(ARM_PINS.on).filter(k => ARM_PINS.on[k] !== ARM_PINS.off[k]);
    expect(onOnly.length).toBeGreaterThan(0);
    for (const k of onOnly) expect(SEARCH_PIN_RESERVED.test(k)).toBe(true);
    for (const k of Object.keys(ARM_PINS.off).filter(k => ARM_PINS.on[k] === ARM_PINS.off[k])) expect(SEARCH_PIN_RESERVED.test(k)).toBe(false);
  });

  test('gate + the incident families hold, exactly as test/eval-retrieval-quality.test.ts pins them', () => {
    expect(off.gate.pass).toBe(true);
    const byFam = new Map(off.report.families.map(f => [f.family, f]));
    expect(byFam.get('title-substring')!.hit_at_1).toBeGreaterThanOrEqual(0.95);
    expect(byFam.get('alias-synonym')!.hit_at_1).toBeGreaterThanOrEqual(0.98);
    expect(byFam.get('multi-chunk-dilution')!.hit_at_3).toBe(1.0);
  });

  test('records carry per-query hit flags, deduped top-3, the rank-1 evidence tier and the degraded stamp', () => {
    expect(off.records.length).toBe(12);
    for (const r of off.records) {
      expect(r.top3.length).toBeLessThanOrEqual(3);
      expect(new Set(r.top3).size).toBe(r.top3.length);
      expect(typeof r.hit_at_1).toBe('boolean');
      expect(typeof r.hit_at_3).toBe('boolean');
      expect(r.reranked_rows).toBe(0); // reranker off → no rerank_score anywhere
      expect(r.degraded.some(d => d.stage === 'reranker_skipped' || d.stage === 'rerank_passthrough')).toBe(false);
      expect(r.error).toBeUndefined();
    }
    const alias = off.records.find(r => r.query === 'hall of light')!;
    expect(alias.top?.slug).toBe('projects/example-amphitheater');
    expect(alias.top?.evidence).toBe('alias_hit');
    expect(alias.top?.create_safety).toBe('exists');
    const hard = off.records.find(r => r.family === 'hard-negative')!;
    expect(hard.hit_at_1).toBe(true); // clean
  });

  test('the stubbed arm is honest about its embedding degradation (live mode would refuse it)', () => {
    // Every query fell open to keyword-only: the embed stage is stamped, so
    // embedIntegrityProblems has something to say — this is why --stub-embed
    // never claims an R1 verdict.
    expect(embedIntegrityProblems(off).length).toBeGreaterThan(0);
  });
});

function rec(query: string, hit1: boolean, hit3: boolean, safety: string | null, extra: Partial<QueryRecord> = {}): QueryRecord {
  return {
    query,
    family: 'title-substring',
    slugs: ['a', 'b'],
    top3: ['a', 'b'],
    top: { slug: 'a', evidence: safety === 'exists' ? 'alias_hit' : safety === 'probable' ? 'keyword_exact' : 'weak_semantic', create_safety: safety, rerank_score: null },
    reranked_rows: 0,
    degraded: [],
    hit_at_1: hit1,
    hit_at_3: hit3,
    ...extra,
  };
}

function arm(records: QueryRecord[], armId: 'off' | 'on' = 'off'): ArmRun {
  return {
    arm: armId,
    records,
    report: { schema_version: 1, k: 3, total: records.length, families: [], questions: [] },
    gate: { pass: true, breaches: [], warnings: [] },
  };
}

const row = (query: string, off: [boolean, boolean, (string | null)?], on: [boolean, boolean, (string | null)?]): VerdictRow => ({
  query,
  off: { hit_at_1: off[0], hit_at_3: off[1], create_safety: off[2] ?? null },
  on: { hit_at_1: on[0], hit_at_3: on[1], create_safety: on[2] ?? null },
});

describe('r1Verdict (pure)', () => {
  test('0 losses → PASS (wins do not matter)', () => {
    const v = r1Verdict([row('a', [true, true], [true, true]), row('b', [false, true], [true, true]), row('c', [false, false], [false, true])]);
    expect(v.pass).toBe(true);
    expect(v.hit_at_1).toMatchObject({ wins: 1, losses: 0, net: 1 });
    expect(v.hit_at_3).toMatchObject({ wins: 1, losses: 0, net: 1 });
    expect(v.reasons).toEqual([]);
    expect(v.n).toBe(3);
  });

  test('one hit@3 loss (and no hit@1 loss) → PASS', () => {
    const v = r1Verdict([row('a', [false, true], [false, false]), row('b', [true, true], [true, true])]);
    expect(v.pass).toBe(true);
    expect(v.hit_at_3.losses).toBe(1);
    expect(v.hit_at_3.lost_queries).toEqual(['a']);
    expect(v.hit_at_1.losses).toBe(0);
  });

  test('one hit@1 loss → FAIL, even when hit@3 still holds and a win offsets it', () => {
    const v = r1Verdict([row('a', [true, true], [false, true]), row('b', [false, true], [true, true])]);
    expect(v.pass).toBe(false);
    expect(v.hit_at_1).toMatchObject({ wins: 1, losses: 1, net: 0, lost_queries: ['a'] });
    expect(v.reasons[0]).toMatch(/hit@1 losses 1 > 0: a/);
  });

  test('two hit@3 losses → FAIL, wins do not offset', () => {
    const v = r1Verdict([
      row('a', [false, true], [false, false]),
      row('b', [false, true], [false, false]),
      row('c', [false, false], [false, true]),
      row('d', [false, false], [false, true]),
    ]);
    expect(v.pass).toBe(false);
    expect(v.hit_at_3).toMatchObject({ wins: 2, losses: 2, net: 0 });
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toMatch(/hit@3 losses 2 > 1: a; b/);
  });

  test('create_safety downgrades are counted and named but never flip the verdict', () => {
    const v = r1Verdict([
      row('a', [true, true, 'exists'], [true, true, 'unknown']),
      row('b', [true, true, 'probable'], [true, true, 'exists']),
      row('c', [true, true, null], [true, true, 'exists']),
    ]);
    expect(v.pass).toBe(true);
    expect(v.create_safety).toEqual({ downgrades: 1, upgrades: 1, downgraded_queries: ['a'] });
  });
});

describe('pairing + ON-arm integrity (pure)', () => {
  const ready: RerankerReadiness = {
    model: R1_ON_RERANKER_MODEL, provider: 'voyage', modelId: 'rerank-2.5', recipeKnown: true, hasTouchpoint: true,
    modelListed: true, requiredKey: 'VOYAGE_API_KEY', keyPresent: true, sunset: null, sunsetPassed: false,
    selfHosted: false, sunsetBlocks: false, ready: true,
  };

  test('pairArms zips by position and refuses mismatched question sets', () => {
    const off = arm([rec('q1', true, true, 'exists'), rec('q2', false, true, 'probable')]);
    const on = arm([rec('q1', true, true, 'exists', { reranked_rows: 5 }), rec('q2', true, true, 'exists', { reranked_rows: 5 })], 'on');
    const rows = pairArms(off, on);
    expect(rows.map(r => r.query)).toEqual(['q1', 'q2']);
    expect(rows[1].off.hit_at_1).toBe(false);
    expect(rows[1].on.hit_at_1).toBe(true);
    expect(rows[1].on.create_safety).toBe('exists');
    expect(() => pairArms(off, arm([rec('q1', true, true, 'exists')], 'on'))).toThrow(/OFF ran 2 queries, ON ran 1/);
    expect(() => pairArms(off, arm([rec('q1', true, true, 'exists'), rec('zz', true, true, 'exists')], 'on'))).toThrow(/query mismatch at 1/);
  });

  test('a clean reranked ON arm has no problems', () => {
    const on = arm([rec('q1', true, true, 'exists', { reranked_rows: 7 })], 'on');
    expect(onArmIntegrityProblems(on, ready)).toEqual([]);
    expect(embedIntegrityProblems(on)).toEqual([]);
  });

  test('not-ready readiness, reranker_skipped / rerank_passthrough stamps, unscored results and thrown searches all fail loudly', () => {
    const on = arm([
      rec('skipped', true, true, 'exists', { reranked_rows: 0, degraded: [{ stage: 'reranker_skipped', reason: 'no_key' }] }),
      rec('passthrough', true, true, 'exists', { reranked_rows: 0, degraded: [{ stage: 'rerank_passthrough', reason: 'empty_result_set' }] }),
      rec('unscored', true, true, 'exists', { reranked_rows: 0 }),
      rec('threw', false, false, null, { slugs: [], top3: [], top: null, error: 'boom' }),
      rec('fine', true, true, 'exists', { reranked_rows: 3 }),
    ], 'on');
    const problems = onArmIntegrityProblems(on, { ...ready, ready: false, keyPresent: false });
    expect(problems.some(p => /not ready/.test(p) && /VOYAGE_API_KEY/.test(p))).toBe(true);
    expect(problems.some(p => /"skipped": degraded reranker_skipped \(no_key\)/.test(p))).toBe(true);
    expect(problems.some(p => /"passthrough": degraded rerank_passthrough/.test(p))).toBe(true);
    expect(problems.some(p => /"unscored": 2 result\(s\) but no row carries a rerank_score/.test(p))).toBe(true);
    expect(problems.some(p => /"threw": hybridSearch threw: boom/.test(p))).toBe(true);
    expect(problems.some(p => /"fine"/.test(p))).toBe(false);
    expect(onArmIntegrityProblems(on, null)).toContain('reranker readiness was not evaluated');
  });

  test('embedding degradation in a live arm is an integrity problem', () => {
    const off = arm([rec('q', true, true, 'probable', { degraded: [{ stage: 'embed_unavailable', reason: 'provider_error' }] })]);
    expect(embedIntegrityProblems(off)).toEqual(['OFF "q": degraded embed_unavailable (provider_error)']);
  });
});

describe('CLI', () => {
  test('parseArgs: defaults, flags, and validation', () => {
    expect(parseArgs([])).toEqual({ json: false, relational: false, limit: 10, stubEmbed: false });
    expect(parseArgs(['--json', '--stub-embed', '--relational', '--limit', '25', '--embed-cache', '/tmp/x.sqlite', '--out', '/tmp/r.json'])).toEqual({
      json: true, stubEmbed: true, relational: true, limit: 25, embedCache: '/tmp/x.sqlite', out: '/tmp/r.json',
    });
  });

  test('parseArgs: --autocut, --relational-pin and --search-pin overlays are accepted (search-pin is repeatable, last write wins)', () => {
    expect(parseArgs(['--autocut', 'on']).autocut).toBe('on');
    expect(parseArgs(['--autocut', 'off']).autocut).toBe('off');
    expect(parseArgs([]).autocut).toBeUndefined();
    for (const v of ['0', '7', '10', 'off']) expect(parseArgs(['--relational-pin', v]).relationalPin).toBe(v);
    expect(parseArgs([]).relationalPin).toBeUndefined();
    expect(parseArgs([]).searchPins).toBeUndefined();
    expect(parseArgs(['--search-pin', 'search.autocut=true'])).toMatchObject({ searchPins: { 'search.autocut': 'true' } });
    expect(parseArgs(['--search-pin', ' search.relational_rerank_pin = 5 ', '--search-pin', 'search.token_budget=off', '--search-pin', 'search.token_budget=4000']).searchPins).toEqual({
      'search.relational_rerank_pin': '5',
      'search.token_budget': '4000',
    });
    // A value may itself contain '=' — only the first one splits.
    expect(parseArgs(['--search-pin', 'search.x=a=b']).searchPins).toEqual({ 'search.x': 'a=b' });
  });

  test('buildOverlay: explicit --autocut / --relational-pin win over a colliding --search-pin (search pins spread first)', () => {
    // Pre-fix the search pins were spread LAST, so a pasted
    // `--search-pin search.autocut=false` silently overrode `--autocut on`.
    expect(buildOverlay(parseArgs(['--autocut', 'on', '--search-pin', 'search.autocut=false']))).toEqual({ 'search.autocut': 'true' });
    expect(buildOverlay(parseArgs(['--search-pin', 'search.autocut=false', '--autocut', 'on']))).toEqual({ 'search.autocut': 'true' });
    expect(buildOverlay(parseArgs(['--relational-pin', '3', '--search-pin', 'search.relational_rerank_pin=9']))).toEqual({ 'search.relational_rerank_pin': '3' });
    // Non-colliding search pins ride along untouched; no explicit flag → the pin stands.
    expect(buildOverlay(parseArgs(['--autocut', 'off', '--search-pin', 'search.token_budget=4000', '--search-pin', 'search.autocut=true']))).toEqual({
      'search.token_budget': '4000',
      'search.autocut': 'false',
    });
    expect(buildOverlay(parseArgs(['--search-pin', 'search.autocut=true']))).toEqual({ 'search.autocut': 'true' });
    expect(buildOverlay(parseArgs([]))).toEqual({});
  });

  describe('applyArmPins with the built overlay (config plane)', () => {
    let overlayEngine: PGLiteEngine;
    beforeAll(async () => {
      overlayEngine = new PGLiteEngine();
      await overlayEngine.connect({});
      await overlayEngine.initSchema();
    });
    afterAll(async () => { await overlayEngine.disconnect(); });
    test('the explicit flag lands on the config plane over a colliding --search-pin', async () => {
      await applyArmPins(overlayEngine, 'off', buildOverlay(parseArgs(['--autocut', 'on', '--search-pin', 'search.autocut=false'])));
      expect(await overlayEngine.getConfig('search.autocut')).toBe('true');
      expect(await overlayEngine.getConfig('search.reranker.enabled')).toBe('false');
    });
  });

  test('SEARCH_PIN_RESERVED covers the reranker keys and nothing else', () => {
    for (const k of ['search.reranker.model', 'search.reranker.enabled', 'search.reranker']) expect(SEARCH_PIN_RESERVED.test(k)).toBe(true);
    for (const k of ['search.autocut', 'search.mode', 'search.relational_rerank_pin', 'search.rerankerx', 'search.reranker_other']) expect(SEARCH_PIN_RESERVED.test(k)).toBe(false);
  });

  // Rejection goes through usage() → process.exit(2), so it is observed from a
  // child process (~0.2s each: the script exits before touching the brain).
  const rejected = (argv: string[]): { status: number | null; stderr: string } => {
    const r = spawnSync('bun', ['run', 'scripts/r1-namedthing-rerank-ab.ts', ...argv], { cwd: ROOT, encoding: 'utf-8' });
    return { status: r.status, stderr: r.stderr };
  };

  test('--autocut rejects anything but on|off (exit 2)', () => {
    const r = rejected(['--autocut', 'maybe']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--autocut takes on|off (got maybe)');
    expect(rejected(['--autocut']).stderr).toContain('--autocut needs a value');
  }, 30_000);

  test('--relational-pin rejects values outside 0-10|off (exit 2)', () => {
    for (const bad of ['11', '-1', 'on', '2.5']) {
      const r = rejected(['--relational-pin', bad]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--relational-pin takes 0-10 or off (got ${bad})`);
    }
  }, 30_000);

  test('--search-pin rejects malformed pins (exit 2): no "=", empty value, non-search.* key, bare "search."', () => {
    for (const bad of ['search.autocut', 'search.autocut=', 'autocut=true', 'search.=x', '=true']) {
      const r = rejected(['--search-pin', bad]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--search-pin takes search.<key>=<value> (got ${bad})`);
    }
  }, 30_000);

  test('--search-pin refuses the reserved search.reranker.* keys (the arm axis) BEFORE any spend (exit 2)', () => {
    for (const bad of ['search.reranker.model=voyage:rerank-2', 'search.reranker.enabled=false']) {
      const r = rejected(['--search-pin', bad, '--stub-embed']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--search-pin cannot overlay ${bad.split('=')[0]}`);
      expect(r.stderr).toContain(R1_ON_RERANKER_MODEL);
      expect(r.stderr).not.toContain('seeded'); // refused at parse time: the brain was never built
    }
  }, 30_000);

  test('--stub-embed dry run: OFF arm only, ON arm skipped with the VOYAGE_API_KEY note, glossary block present, exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r1-ab-'));
    try {
      const out = join(dir, 'receipt.json');
      const r = spawnSync('bun', ['run', 'scripts/r1-namedthing-rerank-ab.ts', '--stub-embed', '--json', '--out', out], {
        cwd: ROOT, encoding: 'utf-8', env: { ...process.env, VOYAGE_API_KEY: '', OPENAI_API_KEY: '' },
      });
      expect(r.status).toBe(0);
      const payload = JSON.parse(r.stdout) as R1Payload;
      expect(payload.mode).toBe('stub-embed');
      expect(payload.questions).toBe(12);
      expect(payload.arms.off.gate.pass).toBe(true);
      expect(payload.arms.off.records.length).toBe(12);
      expect(payload.arms.on).toBeNull();
      expect(payload.verdict).toBeNull();
      expect(payload.paired).toBeNull();
      expect(payload.on_skipped).toMatch(/VOYAGE_API_KEY/);
      expect(payload.reranker).toBeNull();
      expect(payload.embedder).toBeNull();
      expect(payload.spend_estimate_usd.total).toBeNull();
      for (const k of R1_GLOSSARY_KEYS) expect(typeof payload._meta.metric_glossary[k]).toBe('string');
      expect(JSON.parse(readFileSync(out, 'utf8')).schema_version).toBe(1);
      // Markdown renders the not-decided verdict from the same payload.
      const md = renderMarkdown(payload);
      expect(md).toContain('R1: **NOT DECIDED**');
      expect(md).toContain('| family | n | hit@1 OFF | hit@3 OFF | MRR OFF |');
      expect(r.stderr).toContain('ON arm needs VOYAGE_API_KEY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('usage errors exit 2', () => {
    const r = spawnSync('bun', ['run', 'scripts/r1-namedthing-rerank-ab.ts', '--bogus'], { cwd: ROOT, encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument: --bogus');
  }, 30_000);
});

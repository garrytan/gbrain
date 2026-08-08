/**
 * BrainBench CLI e2e — subprocess runs against a SMALL tmp corpus so the
 * literal exit codes (the CI product, decision 9) are asserted end-to-end:
 * 0 pass · 1 regression · 2 error/inconclusive. Also pins: the --out artifact
 * is complete valid JSON with the _meta.metric_glossary block, --update-baseline
 * is byte-deterministic across runs, anti-vacuous-pass, and the run-all wiring
 * (full corpus, in-process).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
let root: string;
let fixtures: string;
let gold: string;

function run(args: string[], cwd = REPO): { exitCode: number; stdout: string; stderr: string } {
  // Foreign-corpus runs opt OUT of the repo's committed baseline: the
  // poisoning defense requires any committed-vs-main divergence to match the
  // current run, and the repo's main.json never matches a tmp-corpus run.
  const full = args.includes('--committed-baseline')
    ? args
    : [...args, '--committed-baseline', join(root, 'no-committed-baseline.json')];
  const proc = Bun.spawnSync(['bun', 'src/cli.ts', 'eval', 'brainbench', ...full], {
    cwd,
    env: { ...process.env, GBRAIN_QUIET: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bb-e2e-'));
  fixtures = join(root, 'fixtures');
  gold = join(root, 'gold');
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(gold, { recursive: true });
  for (const id of ['kta-001-deal-recall', 'kta-002-quiet-smalltalk']) {
    cpSync(join(REPO, 'evals/brainbench/fixtures', `${id}.fixture.json`), join(fixtures, `${id}.fixture.json`));
    cpSync(join(REPO, 'evals/brainbench/gold', `${id}.gold.json`), join(gold, `${id}.gold.json`));
  }
  // Shared artifacts every consumer test depends on, built ONCE here so each
  // test is self-sufficient under -t filters / sharding (review finding:
  // order-dependent file production across describe blocks).
  const r = run(['--fixtures', fixtures, '--gold', gold, '--update-baseline', join(root, 'base1.json')]);
  if (r.exitCode !== 0) throw new Error(`beforeAll baseline build failed: ${r.stderr}`);
  const doctored = JSON.parse(readFileSync(join(root, 'base1.json'), 'utf-8'));
  const cellKey = Object.keys(doctored.counts).find((k) => doctored.counts[k].gold_total > 0)!;
  doctored.counts[cellKey].gold_failed = -1; // pretends fewer failures than any run can match
  writeFileSync(join(root, 'doctored.json'), JSON.stringify(doctored, null, 2));
});

describe('exit contract over a multi-brain run (PGLite exitCode-hijack guard)', () => {
  test('clean run: exit 0, --out is complete valid JSON with the glossary block', () => {
    const out = join(root, 'r1.json');
    const r = run(['--fixtures', fixtures, '--gold', gold, '--harness', 'openclaw', '--out', out]);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(out, 'utf-8'));
    expect(doc.receipt.result_schema_version).toBe(1);
    expect(doc.cells.length).toBeGreaterThan(0);
    expect(doc._meta.metric_glossary.know_to_ask_failure_rate).toContain('thesis failure mode');
    expect(doc.seed_failures).toEqual([]);
    expect(r.stdout).toContain('# BrainBench scoreboard');
  }, 30_000);

  test('--update-baseline is byte-deterministic across two runs (decision 10)', () => {
    const b2 = join(root, 'base2.json');
    expect(run(['--fixtures', fixtures, '--gold', gold, '--update-baseline', b2]).exitCode).toBe(0);
    // base1.json was produced by an entirely separate run in beforeAll.
    expect(readFileSync(b2, 'utf-8')).toBe(readFileSync(join(root, 'base1.json'), 'utf-8'));
  }, 60_000);

  test('--compare against own baseline: exit 0 PASS', () => {
    const b = join(root, 'base1.json');
    const r = run(['--fixtures', fixtures, '--gold', gold, '--compare', b]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('## Gate: PASS (same-hash)');
  }, 30_000);

  test('doctored main baseline (pretends fewer failures): exit 1 REGRESSION with named breach', () => {
    const r = run(['--fixtures', fixtures, '--gold', gold, '--compare', join(root, 'doctored.json')]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('## Gate: REGRESSION');
    expect(r.stdout).toContain('newly-failed');
  }, 30_000);

  test('--allow-regression flips the same comparison to exit 0 and records the reason', () => {
    const r = run([
      '--fixtures', fixtures, '--gold', gold,
      '--compare', join(root, 'doctored.json'),
      '--allow-regression', 'e2e test bless',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('regression allowed: e2e test bless');
  }, 30_000);

  test('fixtures_hash mismatch without a committed baseline: exit 2 INCONCLUSIVE', () => {
    const foreign = JSON.parse(readFileSync(join(root, 'base1.json'), 'utf-8'));
    foreign.fixtures_hash = 'f'.repeat(64);
    const path = join(root, 'foreign.json');
    writeFileSync(path, JSON.stringify(foreign, null, 2));
    const r = run([
      '--fixtures', fixtures, '--gold', gold,
      '--compare', path,
      '--committed-baseline', join(root, 'nonexistent.json'),
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('corpus-bless');
  }, 30_000);
});

describe('anti-vacuous-pass + error paths (always exit 2, never 0)', () => {
  test('empty fixtures dir: exit 2', () => {
    const empty = join(root, 'empty-fixtures');
    const emptyGold = join(root, 'empty-gold');
    mkdirSync(empty, { recursive: true });
    mkdirSync(emptyGold, { recursive: true });
    const r = run(['--fixtures', empty, '--gold', emptyGold]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('vacuous');
  }, 30_000);

  test('suite filter matching zero fixtures: exit 2', () => {
    const r = run(['--fixtures', fixtures, '--gold', gold, '--suite', 'continuity']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('vacuous');
  }, 30_000);

  test('malformed fixture JSON: exit 2 with the validation error named', () => {
    const badRoot = mkdtempSync(join(tmpdir(), 'bb-bad-'));
    const badF = join(badRoot, 'fixtures');
    const badG = join(badRoot, 'gold');
    mkdirSync(badF);
    mkdirSync(badG);
    writeFileSync(join(badF, 'bad.fixture.json'), '{ not json');
    const r = run(['--fixtures', badF, '--gold', badG]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('invalid JSON');
  }, 30_000);

  test('usage error (unknown flag): exit 2 with usage', () => {
    const r = run(['--frobnicate']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Usage: gbrain eval brainbench');
  }, 30_000);

  test('seed failure (duplicate slug across seed pages in one source): exit 2, fixture named', () => {
    const dupRoot = mkdtempSync(join(tmpdir(), 'bb-dup-'));
    const dupF = join(dupRoot, 'fixtures');
    const dupG = join(dupRoot, 'gold');
    mkdirSync(dupF);
    mkdirSync(dupG);
    // A page whose content exceeds importFromContent's size cap → status 'skipped' → SeedError.
    const huge = 'x'.repeat(5_000_001);
    writeFileSync(
      join(dupF, 'seedfail-001.fixture.json'),
      JSON.stringify({
        schema_version: 1,
        fixture_id: 'seedfail-001',
        suites: ['know-to-ask'],
        seed_pages: [{ slug: 'people/too-big', content: `---\ntitle: Too Big\n---\n${huge}` }],
        turns: [{ turn_id: 1, role: 'user', text: 'Hello Too Big' }],
      }),
    );
    writeFileSync(
      join(dupG, 'seedfail-001.gold.json'),
      JSON.stringify({ fixture_id: 'seedfail-001', turns: { '1': { should_retrieve: false } } }),
    );
    const r = run(['--fixtures', dupF, '--gold', dupG]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('SEED FAILURES');
    expect(r.stderr).toContain('seedfail-001');
  }, 30_000);
});

describe('holdout discipline (decision 22)', () => {
  test('gate mode excludes holdout fixtures; --include-holdout scores them', async () => {
    const { loadCorpus } = await import('../src/eval/brainbench/fixtures.ts');
    const { runBrainBench } = await import('../src/eval/brainbench/harness.ts');
    const corpus = await loadCorpus('evals/brainbench/fixtures', 'evals/brainbench/gold');
    const holdoutIds = new Set(
      corpus.fixtures.filter((f) => f.fixture.holdout).map((f) => f.fixture.fixture_id),
    );
    expect(holdoutIds.size).toBeGreaterThan(0);
    const pick = corpus.fixtures
      .filter((f) => f.fixture.category === 'kta-pos')
      .filter((f, i, arr) => f.fixture.holdout || arr.findIndex((x) => !x.fixture.holdout) === i)
      .slice(0, 4);
    const sub = { ...corpus, fixtures: pick };
    const gateRun = await runBrainBench(sub, {
      harnesses: ['openclaw'], suites: ['know-to-ask'], includeHoldout: false, llm: false,
    });
    for (const r of gateRun.turn_rows) expect(holdoutIds.has(r.fixture_id)).toBe(false);
    const pubRun = await runBrainBench(sub, {
      harnesses: ['openclaw'], suites: ['know-to-ask'], includeHoldout: true, llm: false,
    });
    expect(pubRun.turn_rows.length).toBeGreaterThan(gateRun.turn_rows.length);
  }, 60_000);
});

describe('file-vs-file --compare (pure diff, no run, no DB)', () => {
  test('identical files: exit 0 with a JSON outcome on stdout', () => {
    const b = join(root, 'base1.json');
    const r = run(['--compare', b, b]);
    expect(r.exitCode).toBe(0);
    const outcome = JSON.parse(r.stdout);
    expect(outcome.verdict).toBe('pass');
  }, 30_000);

  test('doctored current vs base: exit 1 with breaches listed', () => {
    const r = run(['--compare', join(root, 'doctored.json'), join(root, 'base1.json')]);
    // base1 (current) has MORE failures than doctored (main pretends fewer)…
    // order: --compare BASE CURRENT → current=base1, main=doctored.
    expect(r.exitCode).toBe(1);
    const outcome = JSON.parse(r.stdout);
    expect(outcome.verdict).toBe('regression');
    expect(outcome.breaches.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('--json stdout completeness', () => {
  test('stdout parses as a full result doc with compare embedded', () => {
    // All harnesses: base1.json carries cells for all three seams, and a
    // narrower run would (correctly) trip the disappeared-coverage breach.
    const r = run([
      '--fixtures', fixtures, '--gold', gold,
      '--json',
      '--compare', join(root, 'base1.json'),
    ]);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.receipt.result_schema_version).toBe(1);
    expect(doc.cells.length).toBeGreaterThan(0);
    expect(doc.compare.verdict).toBe('pass');
    expect(doc._meta.metric_glossary).toBeDefined();
  }, 30_000);
});

describe('--llm availability gate', () => {
  test('no config + no keys: exit 2 with an actionable message, before any run', () => {
    const bareHome = mkdtempSync(join(tmpdir(), 'bb-home-'));
    // Minimal explicit env (review finding): spreading process.env and
    // deleting a hardcoded key list leaks other provider keys (GOOGLE_*,
    // per-recipe ${ID}_API_KEY) — on a dev machine that could flip the gate
    // open and make REAL API calls from a test.
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: bareHome };
    const proc = Bun.spawnSync(
      ['bun', 'src/cli.ts', 'eval', 'brainbench', '--fixtures', fixtures, '--gold', gold, '--llm'],
      { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('requires a configured chat model');
  }, 30_000);
});

describe('render-brainbench-delta.ts (the CI step-summary block)', () => {
  test('renders verdict header + per-cell headline from the --out artifact', () => {
    const proc = Bun.spawnSync(['bun', 'scripts/render-brainbench-delta.ts', join(root, 'r1.json')], {
      cwd: REPO, stdout: 'pipe', stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    const md = proc.stdout.toString();
    expect(md).toContain('## BrainBench:');
    expect(md).toContain('| openclaw | production |');
    expect(md).toContain('know_to_ask_failure_rate=');
  }, 30_000);

  test('missing path argument: exit 2 with usage', () => {
    const proc = Bun.spawnSync(['bun', 'scripts/render-brainbench-delta.ts'], {
      cwd: REPO, stdout: 'pipe', stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(2);
  }, 30_000);
});

describe('privacy guard violation branches (negative path)', () => {
  test('a fixture with a real dollar amount + out-of-range year fails the scan (gold dir scanned too)', () => {
    const dirty = mkdtempSync(join(tmpdir(), 'bb-privacy-'));
    mkdirSync(join(dirty, 'fixtures'), { recursive: true });
    mkdirSync(join(dirty, 'gold'), { recursive: true });
    writeFileSync(
      join(dirty, 'fixtures', 'leak.fixture.json'),
      JSON.stringify({ turns: [{ text: 'They raised $50M for the series B' }] }),
    );
    // The year violation lives in GOLD — pins that the year scan covers the
    // gold dir as well (review finding: it previously scanned fixtures only).
    writeFileSync(
      join(dirty, 'gold', 'leak.gold.json'),
      JSON.stringify({ fixture_id: 'leak', turns: { '1': { gold_facts: [{ fact: 'raised back in 2019' }] } } }),
    );
    const proc = Bun.spawnSync(['bash', 'scripts/check-synthetic-corpus-privacy.sh'], {
      cwd: REPO,
      env: { ...process.env, BRAINBENCH_PRIVACY_DIR: dirty },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(1);
    const out = proc.stdout.toString();
    expect(out).toContain('explicit dollar amount');
    expect(out).toContain('out-of-range year');
  }, 30_000);
});

describe('run-all once-per-sweep semantics (decision 16)', () => {
  test('--suites brainbench with TWO modes writes exactly ONE n/a record with cells', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'bb-runall-'));
    const proc = Bun.spawnSync(
      ['bun', 'src/cli.ts', 'eval', 'run-all', '--suites', 'brainbench', '--modes', 'conservative,balanced', '--output', outDir],
      { cwd: REPO, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(proc.exitCode).toBe(0);
    const lines = readFileSync(join(outDir, 'eval-results.jsonl'), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1); // NOT multiplied by the two modes
    const record = JSON.parse(lines[0]);
    expect(record.schema_version).toBe(3);
    expect(record.suite).toBe('brainbench');
    expect(record.mode).toBe('n/a');
    expect(record.status).toBe('completed');
    expect(Object.keys(record.params.cells).length).toBe(12);
  }, 120_000);
});

describe('run-all wiring (decision 16) — full corpus, in-process', () => {
  test('runBrainBenchCore completes over the committed corpus with 12 cells', async () => {
    const { runBrainBenchCore } = await import('../src/commands/eval-brainbench.ts');
    const core = await runBrainBenchCore();
    expect(core.status).toBe('completed');
    expect(Object.keys(core.cells ?? {}).length).toBe(12);
    expect(core.fixtures_hash).toBeDefined();
    // Committed baseline matches the committed corpus hash (drift guard).
    // UNCONDITIONAL (review finding): a conditional existsSync would turn a
    // deleted baseline into a silent no-op instead of a failure.
    expect(existsSync('evals/brainbench/baselines/main.json')).toBe(true);
    const baseline = JSON.parse(readFileSync('evals/brainbench/baselines/main.json', 'utf-8'));
    expect(baseline.fixtures_hash).toBe(core.fixtures_hash);
  }, 120_000);
});

/**
 * BrainBench CLI e2e — subprocess runs against a SMALL tmp corpus so the
 * literal exit codes (the CI product, decision 9) are asserted end-to-end:
 * 0 pass · 1 regression · 2 error/inconclusive. Also pins: the --out artifact
 * is complete valid JSON with the _meta.metric_glossary block, --update-baseline
 * is byte-deterministic across runs, anti-vacuous-pass, and the run-all
 * once-per-sweep record semantics.
 *
 * Spawn budget: every independent CLI run executes ONCE in beforeAll through a
 * width-2 pool (each child boots its own PGLite; wider would multiply across
 * shards); tests assert on the cached results. The runs were order-independent
 * by construction already (each depends only on the beforeAll artifacts).
 *
 * The former "run-all wiring — full corpus, in-process" describe was deleted:
 * CI's dedicated brainbench job (scripts/ci-brainbench-gate.sh) runs the same
 * committed corpus fresh on every PR and its --compare against the committed
 * baseline is the authoritative completion + fixtures-hash drift gate; the
 * once-per-sweep test below still runs the full corpus once for the ledger
 * contract.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const CLI = join(REPO, 'src', 'cli.ts');
let root: string;
let fixtures: string;
let gold: string;

type RunResult = { exitCode: number; stdout: string; stderr: string };

function withDefaultCommittedBaseline(args: string[]): string[] {
  // Foreign-corpus runs opt OUT of the repo's committed baseline: the
  // poisoning defense requires any committed-vs-main divergence to match the
  // current run, and the repo's main.json never matches a tmp-corpus run.
  return args.includes('--committed-baseline')
    ? args
    : [...args, '--committed-baseline', join(root, 'no-committed-baseline.json')];
}

function run(args: string[], cwd = REPO): RunResult {
  const proc = Bun.spawnSync(['bun', CLI, 'eval', 'brainbench', ...withDefaultCommittedBaseline(args)], {
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

async function runAsync(args: string[], cwd = REPO): Promise<RunResult> {
  const proc = Bun.spawn(['bun', CLI, 'eval', 'brainbench', ...withDefaultCommittedBaseline(args)], {
    cwd,
    env: { ...process.env, GBRAIN_QUIET: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // A wedged child (the synchronous PGLite-WASM block class) would otherwise
  // hang beforeAll to its 300s cap and orphan a ~1.5GB process behind the CI
  // job timeout. SIGTERM at 120s (healthy runs finish in ~5-15s), SIGKILL +2s.
  const term = setTimeout(() => { try { proc.kill(); } catch { /* exited */ } }, 120_000);
  const hardKill = setTimeout(() => { try { proc.kill(9); } catch { /* exited */ } }, 122_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode: exitCode ?? -1, stdout, stderr };
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
  }
}

/**
 * The independent CLI runs, executed once through a width-2 pool.
 *
 * Local pool rather than test/helpers/cli-spawn.ts#runCliBatch: that helper
 * takes ONE shared opts for the whole batch, and this batch needs a per-job
 * cwd (the outside-cwd case) plus this file's own argv wrapper (the
 * --committed-baseline default). If runCliBatch grows per-argv opts, fold
 * this into it.
 */
const batch: Record<string, RunResult> = {};

async function runBatch(jobs: Array<[string, string[], string?]>, width = 2): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const idx = next++;
      const [key, args, cwd] = jobs[idx];
      batch[key] = await runAsync(args, cwd);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, () => worker()));
}

beforeAll(async () => {
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

  const foreign = JSON.parse(readFileSync(join(root, 'base1.json'), 'utf-8'));
  foreign.fixtures_hash = 'f'.repeat(64);
  writeFileSync(join(root, 'foreign.json'), JSON.stringify(foreign, null, 2));

  // Error-path corpora (independent tmp trees, built up front for the batch).
  const empty = join(root, 'empty-fixtures');
  const emptyGold = join(root, 'empty-gold');
  mkdirSync(empty, { recursive: true });
  mkdirSync(emptyGold, { recursive: true });
  const badRoot = mkdtempSync(join(tmpdir(), 'bb-bad-'));
  mkdirSync(join(badRoot, 'fixtures'));
  mkdirSync(join(badRoot, 'gold'));
  writeFileSync(join(badRoot, 'fixtures', 'bad.fixture.json'), '{ not json');
  const dupRoot = mkdtempSync(join(tmpdir(), 'bb-dup-'));
  mkdirSync(join(dupRoot, 'fixtures'));
  mkdirSync(join(dupRoot, 'gold'));
  // A page whose content exceeds importFromContent's size cap → status 'skipped' → SeedError.
  const huge = 'x'.repeat(5_000_001);
  writeFileSync(
    join(dupRoot, 'fixtures', 'seedfail-001.fixture.json'),
    JSON.stringify({
      schema_version: 1,
      fixture_id: 'seedfail-001',
      suites: ['know-to-ask'],
      seed_pages: [{ slug: 'people/too-big', content: `---\ntitle: Too Big\n---\n${huge}` }],
      turns: [{ turn_id: 1, role: 'user', text: 'Hello Too Big' }],
    }),
  );
  writeFileSync(
    join(dupRoot, 'gold', 'seedfail-001.gold.json'),
    JSON.stringify({ fixture_id: 'seedfail-001', turns: { '1': { should_retrieve: false } } }),
  );
  const outsideCwd = mkdtempSync(join(tmpdir(), 'bb-outside-cwd-'));

  await runBatch([
    ['outside-cwd', ['--harness', 'openclaw', '--suite', 'know-to-ask', '--json'], outsideCwd],
    ['clean-out', ['--fixtures', fixtures, '--gold', gold, '--harness', 'openclaw', '--out', join(root, 'r1.json')]],
    ['base2', ['--fixtures', fixtures, '--gold', gold, '--update-baseline', join(root, 'base2.json')]],
    ['compare-own', ['--fixtures', fixtures, '--gold', gold, '--compare', join(root, 'base1.json')]],
    ['compare-doctored', ['--fixtures', fixtures, '--gold', gold, '--compare', join(root, 'doctored.json')]],
    ['allow-regression', ['--fixtures', fixtures, '--gold', gold, '--compare', join(root, 'doctored.json'), '--allow-regression', 'e2e test bless']],
    ['foreign-hash', ['--fixtures', fixtures, '--gold', gold, '--compare', join(root, 'foreign.json'), '--committed-baseline', join(root, 'nonexistent.json')]],
    ['json-complete', ['--fixtures', fixtures, '--gold', gold, '--json', '--compare', join(root, 'base1.json')]],
    ['empty-fixtures', ['--fixtures', empty, '--gold', emptyGold]],
    ['suite-zero', ['--fixtures', fixtures, '--gold', gold, '--suite', 'continuity']],
    ['malformed', ['--fixtures', join(badRoot, 'fixtures'), '--gold', join(badRoot, 'gold')]],
    ['usage-error', ['--frobnicate']],
    ['seed-failure', ['--fixtures', join(dupRoot, 'fixtures'), '--gold', join(dupRoot, 'gold')]],
  ]);
  // The baseline build + 13 pooled runs each spawn a full brainbench child;
  // bun's default 5s hook timeout would SIGTERM them on a loaded shard.
}, 300_000);

describe('exit contract over a multi-brain run (PGLite exitCode-hijack guard)', () => {
  test('bundled defaults resolve outside the package working directory', () => {
    const r = batch['outside-cwd'];
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.cells.length).toBeGreaterThan(0);
    expect(doc.seed_failures).toEqual([]);
    expect(r.stderr).not.toContain('not a git repository');
  }, 60_000);

  test('clean run: exit 0, --out is complete valid JSON with the glossary block', () => {
    const r = batch['clean-out'];
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(join(root, 'r1.json'), 'utf-8'));
    expect(doc.receipt.result_schema_version).toBe(1);
    expect(doc.cells.length).toBeGreaterThan(0);
    expect(doc._meta.metric_glossary.know_to_ask_failure_rate).toContain('thesis failure mode');
    expect(doc.seed_failures).toEqual([]);
    expect(r.stdout).toContain('# BrainBench scoreboard');
  }, 30_000);

  test('--update-baseline is byte-deterministic across two runs (decision 10)', () => {
    expect(batch['base2'].exitCode).toBe(0);
    // base1.json was produced by an entirely separate run in beforeAll.
    expect(readFileSync(join(root, 'base2.json'), 'utf-8')).toBe(readFileSync(join(root, 'base1.json'), 'utf-8'));
  }, 60_000);

  test('--compare against own baseline: exit 0 PASS', () => {
    const r = batch['compare-own'];
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('## Gate: PASS (same-hash)');
  }, 30_000);

  test('doctored main baseline (pretends fewer failures): exit 1 REGRESSION with named breach', () => {
    const r = batch['compare-doctored'];
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('## Gate: REGRESSION');
    expect(r.stdout).toContain('newly-failed');
  }, 30_000);

  test('--allow-regression flips the same comparison to exit 0 and records the reason', () => {
    const r = batch['allow-regression'];
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('regression allowed: e2e test bless');
  }, 30_000);

  test('fixtures_hash mismatch without a committed baseline: exit 2 INCONCLUSIVE', () => {
    const r = batch['foreign-hash'];
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('corpus-bless');
  }, 30_000);
});

describe('anti-vacuous-pass + error paths (always exit 2, never 0)', () => {
  test('empty fixtures dir: exit 2', () => {
    const r = batch['empty-fixtures'];
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('vacuous');
  }, 30_000);

  test('suite filter matching zero fixtures: exit 2', () => {
    const r = batch['suite-zero'];
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('vacuous');
  }, 30_000);

  test('malformed fixture JSON: exit 2 with the validation error named', () => {
    const r = batch['malformed'];
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('invalid JSON');
  }, 30_000);

  test('usage error (unknown flag): exit 2 with usage', () => {
    const r = batch['usage-error'];
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Usage: gbrain eval brainbench');
  }, 30_000);

  test('seed failure (duplicate slug across seed pages in one source): exit 2, fixture named', () => {
    const r = batch['seed-failure'];
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
    const r = batch['json-complete'];
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

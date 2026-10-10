import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mineWeights } from '../../scripts/mine-shard-weights.ts';
import { BUN_SPAWNSYNC_POISONED, FailureCollector, captureTestLog } from '../../scripts/capture-test-log.ts';

const SCRIPT = resolve(import.meta.dir, '../../scripts/capture-test-log.ts');
const roots: string[] = [];
function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-capture-log-'));
  roots.push(root);
  const script = join(root, 'fixture.ts');
  const output = join(root, 'timings', 'execution.log');
  writeFileSync(script, source);
  return { root, script, output };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function run(source: string, args: string[] = [], job = 'test (1)') {
  const f = fixture(source);
  const proc = Bun.spawn([process.execPath, SCRIPT, '--job', job, '--out', f.output, '--', process.execPath, f.script, ...args], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { ...f, stdout, stderr, code, artifact: readFileSync(f.output, 'utf8') };
}

describe('timestamped test log capture', () => {
  it('preserves both live streams, group markers and final unterminated lines', async () => {
    const r = await run(`
process.stdout.write('##[group]test/fixture.test.ts:\\n\\n');
process.stderr.write('diagnostic\\r\\n');
await Bun.sleep(15);
process.stdout.write('stdout tail');
process.stderr.write('stderr tail');
`);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('##[group]test/fixture.test.ts:\n\nstdout tail');
    expect(r.stderr).toBe('diagnostic\r\nstderr tail');
    const messages: string[] = [];
    const timestamps: number[] = [];
    for (const line of r.artifact.trimEnd().split('\n')) {
      const match = /^test \(1\)\tcapture\t(\S+Z) (.*)$/.exec(line);
      expect(match).not.toBeNull();
      const timestamp = Date.parse(match![1]!);
      expect(Number.isFinite(timestamp)).toBe(true);
      timestamps.push(timestamp);
      messages.push(match![2]!);
    }
    expect(messages[0]).toBe('##[gbrain-capture-start]');
    expect(messages.at(-1)).toBe('##[gbrain-capture-complete] exit=0');
    expect(messages.slice(1, -1).sort()).toEqual(['##[group]test/fixture.test.ts:', '', 'diagnostic', 'stdout tail', 'stderr tail'].sort());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('can feed captured unit and E2E records directly to the weight miner', async () => {
    const unit = await run(`
console.log('##[group]test/fixture.test.ts:');
await Bun.sleep(20);
console.log(' 0 fail');
console.log('Ran 1 test across 1 file. [20ms]');
`);
    expect(mineWeights(unit.artifact, 'unit').get('test/fixture.test.ts')).toBeGreaterThan(0);
    expect(() => mineWeights(unit.artifact.slice(0, unit.artifact.lastIndexOf('test (1)\tcapture')), 'unit')).toThrow();
    const e2e = await run(`
console.log('=== fixture.e2e.test.ts ===');
console.log(' 0 fail');
console.log('Ran 1 test across 1 file. [125ms]');
console.log('Files: 1 total, 1 passed, 0 failed');
`, [], 'Selected E2E (diff-relevant) (2)');
    expect([...mineWeights(e2e.artifact, 'e2e')]).toEqual([['test/e2e/fixture.e2e.test.ts', 125]]);
  });

  it('preserves exit codes and passes argv literally without shell interpretation', async () => {
    const args = ['has spaces', '"quotes"', "'single'", '$(echo injected)', '`echo injected`', '; false', '*'];
    const r = await run(`console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 37;`, args);
    expect(r.code).toBe(37);
    expect(JSON.parse(r.stdout)).toEqual(args);
    expect(r.artifact).toContain(JSON.stringify(args));
    expect(r.artifact).toContain('##[error]captured command exited 37');
    expect(r.stderr).toBe('');
  });

  it('rejects invalid metadata before running a command and failed outer-runner artifacts before mining', async () => {
    const f = fixture('');
    await expect(captureTestLog('test\t(1)', f.output, [process.execPath, f.script])).rejects.toThrow('one TSV field');
    expect(existsSync(f.output)).toBe(false);
    const r = await run(`
console.log('##[group]test/fixture.test.ts:');
console.log(' 0 fail');
console.log('Ran 1 test across 1 file. [20ms]');
process.exitCode = 7;
`);
    expect(r.code).toBe(7);
    expect(() => mineWeights(r.artifact, 'unit')).toThrow('failed job log');
  });

  it('bounds long artifact lines while preserving all live bytes', async () => {
    const length = 256 * 1024 + 17;
    const r = await run(`process.stdout.write('x'.repeat(${length}));`);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('x'.repeat(length));
    const messages = r.artifact.trimEnd().split('\n').slice(1, -1).map(line => line.split(/\t\S+Z /)[1]!);
    expect(messages.join('')).toBe(r.stdout);
    expect(messages.every(message => message.length <= 64 * 1024)).toBe(true);
  });

  it('reports a missing command and preserves a child signal exit code', async () => {
    const f = fixture('');
    const missing = Bun.spawn([process.execPath, SCRIPT, '--job', 'test (1)', '--out', f.output, '--', join(f.root, 'missing-command')], {
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(await missing.exited).toBe(2);
    expect(await new Response(missing.stderr).text()).toContain('capture-test-log:');
    const signalled = await run(`process.kill(process.pid, 'SIGTERM');`);
    expect(signalled.code).toBe(143);
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`forwards ${signal} to its owned child and grandchild`, async () => {
      const f = fixture(`
import { renameSync } from 'node:fs';
const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
await Bun.write(process.argv[2] + '.tmp', JSON.stringify([process.pid, child.pid]));
renameSync(process.argv[2] + '.tmp', process.argv[2]);
setInterval(() => {}, 1000);
`);
      const pidsFile = join(f.root, 'pids.json');
      const proc = Bun.spawn([process.execPath, SCRIPT, '--job', 'test (1)', '--out', f.output, '--', process.execPath, f.script, pidsFile], {
        stdout: 'ignore', stderr: 'ignore',
      });
      let pids: number[] = [];
      const alive = (pid: number) => {
        try {
          if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
          process.kill(pid, 0);
          return true;
        } catch { return false; }
      };
      try {
        for (let i = 0; i < 100 && !existsSync(pidsFile); i++) await Bun.sleep(20);
        expect(existsSync(pidsFile)).toBe(true);
        pids = JSON.parse(readFileSync(pidsFile, 'utf8'));
        expect(pids).toHaveLength(2);
        expect(pids.every(alive)).toBe(true);
        proc.kill(signal);
        expect(await proc.exited).toBe(signal === 'SIGINT' ? 130 : 143);
        for (let i = 0; i < 100 && pids.some(alive); i++) await Bun.sleep(20);
        expect(pids.some(alive)).toBe(false);
      } finally {
        proc.kill('SIGKILL');
        for (const pid of pids) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
      }
    }, 10000);
  }
});

describe('failure step summary (B13)', () => {
  // Real Bun runs through the capture wrapper: the summary must carry the
  // file, the test, the first error block and a command that reproduces it.
  async function failing(name: string, source: string) {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-capture-summary-'));
    roots.push(root);
    writeFileSync(join(root, name), source);
    const summary = join(root, 'summary.md');
    const proc = Bun.spawn([process.execPath, SCRIPT, '--job', 'test (3)', '--out', join(root, 'unit.log'), '--',
      process.execPath, 'test', '--timeout=300', name], {
      cwd: root, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    const code = await proc.exited;
    return { code, summary: readFileSync(summary, 'utf8') };
  }

  it('an assertion failure shows the diff and a -t repro for exactly that test', async () => {
    const r = await failing('math.test.ts', `import { describe, test, expect } from 'bun:test';
describe('math', () => { test('adds (carry)', () => { expect(1 + 1).toBe(3); }); test('passes', () => {}); });`);
    expect(r.code).toBe(1);
    expect(r.summary).toContain('### test (3): exited 1');
    expect(r.summary).toContain('#### math.test.ts › math > adds (carry)');
    expect(r.summary).toContain('Expected: 3');
    expect(r.summary).toContain('Received: 2');
    expect(r.summary).toContain("Reproduce: `bun test --timeout=60000 math.test.ts -t 'math adds \\(carry\\)'`");
    expect(r.summary).not.toContain('passes');
  }, 30000);

  it('a timeout names the test and keeps the timeout message', async () => {
    const r = await failing('slow.test.ts', `import { test } from 'bun:test';
test('waits forever', async () => { await new Promise(() => {}); });`);
    expect(r.code).toBe(1);
    expect(r.summary).toContain('#### slow.test.ts › waits forever');
    expect(r.summary).toMatch(/timed out after 300ms/);
  }, 30000);

  it('a setup failure with no (fail) line falls back to the last log lines', async () => {
    const r = await failing('broken.test.ts', `import './missing-module';\nimport { test } from 'bun:test';\ntest('never', () => {});`);
    expect(r.code).not.toBe(0);
    expect(r.summary).toContain('No `(fail)` lines were printed');
    expect(r.summary).toContain('missing-module');
  }, 30000);

  it('green runs and runs outside Actions write no summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-capture-summary-'));
    roots.push(root);
    const summary = join(root, 'summary.md');
    const proc = Bun.spawn([process.execPath, SCRIPT, '--job', 'test (1)', '--out', join(root, 'unit.log'), '--', process.execPath, '-e', '0'], {
      stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    expect(await proc.exited).toBe(0);
    expect(existsSync(summary)).toBe(false);
  });
});

describe('bun_spawnsync_poisoned signature (oven-sh/bun#34069)', () => {
  // The shard-7 shape of run 38004627376 attempt 1 (d4dc2d4d8) and run 37971386009 (c12e14adf): a dangling child
  // killed at a deadline inside one file, then nothing but timeouts, in unrelated files, until the job budget ends.
  const feed = (lines: string[]) => { const c = new FailureCollector(); for (const line of lines) c.feed(line); return c; };
  const timeout = (test: string, ms: number) => [`(fail) ${test} [${ms}.00ms]`, `  ^ this test timed out after ${ms}ms.`];
  const poisonedRun = [
    'bun test v1.4.2 (744846f84)',
    '##[group]test/persistence-git-publication.test.ts:',
    '(pass) literal Git pathspecs publish only the bracketed target and preserve the index [89.95ms]',
    'killed 1 dangling process', 'killed 1 dangling process',
    ...timeout('unchanged replay, missing target and tracked deletion keep distinct outcomes', 60002),
    '##[group]test/voice-gate.test.ts:', '(pass) voice gate > default deny [1.20ms]',
    '##[group]test/persistence-preactivation-claim.test.ts:',
    'killed 1 dangling process', ...timeout('#6122 pre-activation claim (pglite) > the dry run reports the claim', 120000),
    '##[group]test/scripts/merge-lcov.test.ts:',
    'killed 1 dangling process', ...timeout('merge: DA summing across lanes > sums per-line hits', 60045),
  ];

  it('names the signature in the summary and the stderr line, with the Bun version and the upstream fix', () => {
    const c = feed(poisonedRun);
    expect(c.poisoned()).toBe(true);
    const summary = c.render('test (7)', '/tmp/unit.log', 1);
    expect(summary).toContain(`**${BUN_SPAWNSYNC_POISONED}**`);
    expect(summary).toContain('Bun v1.4.2');
    expect(summary).toContain('3 timed-out tests across 3 files');
    expect(summary).toContain('oven-sh/bun#34069');
    expect(summary).toContain('oven-sh/bun#44581');
    expect(summary).toContain('rerun the job');
    // The failing tests still follow, so the shard's own evidence is kept.
    expect(summary).toContain('#### test/scripts/merge-lcov.test.ts › merge: DA summing across lanes > sums per-line hits');
  });

  it('one hung test with a dangling child is not the signature', () => {
    const c = feed([
      'bun test v1.4.2 (744846f84)', '##[group]test/a.test.ts:', 'killed 1 dangling process',
      ...timeout('git that outlives the probe timeout keeps Git effects unfinished', 60001),
      '##[group]test/b.test.ts:', '(pass) b > works [1.00ms]',
    ]);
    expect(c.poisoned()).toBe(false);
    expect(c.render('test (7)', '/tmp/unit.log', 1)).not.toContain(BUN_SPAWNSYNC_POISONED);
  });

  it('a run of timeouts with no killed child is a slow or wedged backend, not the signature', () => {
    const c = feed([
      'bun test v1.4.2 (744846f84)',
      '##[group]test/a.test.ts:', ...timeout('a > first', 60000), ...timeout('a > second', 60000),
      '##[group]test/b.test.ts:', ...timeout('b > third', 60000), ...timeout('b > fourth', 60000),
    ]);
    expect(c.poisoned()).toBe(false);
    expect(c.render('test (7)', '/tmp/unit.log', 1)).not.toContain(BUN_SPAWNSYNC_POISONED);
  });

  it('a non-timeout failure after the kill, or timeouts confined to one file, is left for its own diagnosis', () => {
    const mixed = feed([
      ...poisonedRun,
      '##[group]test/c.test.ts:', 'error: expect(received).toBe(expected)', '(fail) c > asserts [2.00ms]',
    ]);
    expect(mixed.poisoned()).toBe(false);
    const oneFile = feed([
      'bun test v1.4.2 (744846f84)', '##[group]test/a.test.ts:', 'killed 1 dangling process',
      ...timeout('a > one', 60000), ...timeout('a > two', 60000), ...timeout('a > three', 60000),
    ]);
    expect(oneFile.poisoned()).toBe(false);
    expect(oneFile.render('test (7)', '/tmp/unit.log', 1)).not.toContain(BUN_SPAWNSYNC_POISONED);
  });
});

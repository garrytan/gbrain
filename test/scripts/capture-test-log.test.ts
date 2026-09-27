import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mineWeights } from '../../scripts/mine-shard-weights.ts';
import { captureTestLog } from '../../scripts/capture-test-log.ts';

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
const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
await Bun.write(process.argv[2], JSON.stringify([process.pid, child.pid]));
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

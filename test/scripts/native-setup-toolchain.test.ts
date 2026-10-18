/**
 * scripts/native/setup-toolchain.ts: every phase is bounded so a CI step fails
 * with a message naming the phase instead of running into the job timeout. The
 * download has one budget across sources and drops a source whose rate cannot
 * deliver the pinned size before it ends; extraction and `zig version` run
 * under timeouts. Each download case runs the real script against a loopback
 * mirror that trickles, or never answers.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { runWithin } from '../../scripts/native/setup-toolchain.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts/native/setup-toolchain.ts');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

/** A mirror whose responses trickle at `bytesPerSecond` (or never start, at 0), claiming a 50 MB archive. */
async function mirror(bytesPerSecond: number): Promise<string> {
  const server: Server = createServer((_req, res) => {
    if (bytesPerSecond === 0) return;
    res.writeHead(200, { 'content-length': String(50 * 1048576) });
    const tick = setInterval(() => res.write(Buffer.alloc(Math.ceil(bytesPerSecond / 10))), 100);
    res.on('close', () => clearInterval(tick));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  cleanup.push(() => server.closeAllConnections?.() ?? server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup(sources: string[], budgetSeconds: number) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-zig-setup-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, SCRIPT, '--dir', dir], {
    env: { ...process.env, GBRAIN_ZIG_SOURCES: sources.join(','), GBRAIN_ZIG_DOWNLOAD_BUDGET_S: String(budgetSeconds) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stderr, seconds: (Date.now() - started) / 1000 };
}

describe('scripts/native/setup-toolchain.ts download budget', () => {
  test('trickling sources are dropped by rate, and the step fails with a named error well inside the budget', async () => {
    const slow = await mirror(8 * 1024);
    const r = await setup([slow, slow], 10);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('Compiler download failed from every source within its 10s budget');
    expect(r.stderr.match(/too slow: \d+ KB\/s leaves \d+ MB for [\d.]+s of the download budget/g)?.length).toBeGreaterThanOrEqual(2);
    expect(r.seconds).toBeLessThan(10);
  }, 30_000);

  test('a source that never answers is dropped at the rate window, and sources past the budget are reported as not tried', async () => {
    const silent = await mirror(0);
    const r = await setup(Array.from({ length: 20 }, (_, i) => `${silent}/s${i}`), 2);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/s0\/\S+: too slow: 0 KB\/s/);
    expect(r.stderr).toMatch(/s19\/\S+: not tried/);
    expect(r.seconds).toBeLessThan(8);
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')('runWithin', () => {
  test('a command still running at its bound is killed and named', () => {
    const started = Date.now();
    expect(() => runWithin('sleep', ['30'], 500, 'Extracting the archive')).toThrow('Extracting the archive did not finish within 0.5s');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(runWithin('echo', ['0.14.1'], 5000, 'zig version').trim()).toBe('0.14.1');
  });
});

test('every Zig setup step has a step timeout that covers the script bounds and fits inside its job', () => {
  type Step = { run?: string; 'timeout-minutes'?: number };
  const doc = load(readFileSync(join(ROOT, '.github/workflows/native-locks.yml'), 'utf8')) as { jobs: Record<string, { 'timeout-minutes': number; steps: Step[] }> };
  const script = readFileSync(SCRIPT, 'utf8');
  const bound = (name: string) => Number(new RegExp(`${name} = (?:Number\\(process\\.env\\.\\w+ \\?\\? )?([\\d_]+)`).exec(script)![1]!.replace(/_/g, ''));
  const worstSeconds = bound('DOWNLOAD_BUDGET_MS') + bound('EXTRACT_MS') / 1000 + bound('VERSION_MS') / 1000;
  let steps = 0;
  for (const job of Object.values(doc.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.run?.includes('scripts/native/setup-toolchain.ts')) continue;
      steps++;
      expect(step['timeout-minutes']! * 60).toBeGreaterThan(worstSeconds);
      expect(step['timeout-minutes']!).toBeLessThan(job['timeout-minutes']);
    }
  }
  expect(steps).toBeGreaterThanOrEqual(2);
});

/**
 * #8990: the bootstrap entry's git probes (push health on the receipt's workspace, and the recorded-failure
 * superseded check) run asynchronously and are killed at the entry's deadline, so a git call that hangs never holds
 * doctor past --budget-ms and leaves no git child running. localProbe also caps a probe's output at 1 MiB.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctorRegistry } from '../src/commands/doctor/registry.ts';
import { bootstrapChecksEntry } from '../src/commands/doctor/checks/local-runtime.ts';
import { LOCAL_PROBE_MAX_OUTPUT_BYTES, localProbe } from '../src/commands/doctor/local-probe.ts';
import { startDoctorDeadline } from '../src/commands/doctor/budget.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { withEnv } from './helpers/with-env.ts';

const noProgress = new Proxy({}, { get: () => () => undefined }) as DoctorContext['progress'];
const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function ctxFor(args: string[]): DoctorContext {
  return {
    engine: null, args, jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'brain', orphanRatioSourceId: undefined,
    progress: noProgress, skillsDirResolution: { dir: null, source: 'none' }, skillsDir: null, autoFixReport: null, schemaVersion: 0,
    connectionFailed: false, only: null, tier: 'standard', deadline: startDoctorDeadline(args),
  };
}

/** A GBRAIN_HOME parent whose install receipt names `ws`, with one push-status record. */
function bootstrapHome(ws: string, pushStatus: object): string {
  const parent = tmp('gbrain-8990-home-');
  const dir = join(parent, '.gbrain', 'bootstrap');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({
    receipt_version: 1, workspace_dir: ws, source_id: 'workspace', agent_name: 'Testy', created_at: new Date().toISOString(),
    created_by: 'test', brain_created_by_bootstrap: false, created_paths: [], registrations: [],
  }));
  writeFileSync(join(dir, 'push-status.json'), JSON.stringify(pushStatus));
  return parent;
}

/** A `git` on PATH that ignores SIGTERM and waits on a 6 s child of its own, recording both pids. */
function hangingGit(): { bin: string; pids: string } {
  const bin = tmp('gbrain-8990-bin-');
  const pids = join(bin, 'pids');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ntrap '' TERM\necho $$ >> '${pids}'\nsleep 6 &\necho $! >> '${pids}'\nwait\n`, { mode: 0o755 });
  return { bin, pids };
}

const STALE_TS = new Date(Date.now() - 72 * 3_600_000).toISOString();

for (const [label, status] of [
  ['stale push, workspace probe', (ws: string) => ({ ts: STALE_TS, ok: true })],
  ['recorded push failure, superseded probe', (ws: string) => ({ ts: STALE_TS, ok: false, reason: 'push_failed', repoRoot: ws })],
] as const) {
  test(`#8990: a git call that hangs (${label}) is killed at the entry deadline and leaves no child running`, async () => {
    const ws = tmp('gbrain-8990-ws-');
    const parent = bootstrapHome(ws, status(ws));
    const { bin, pids } = hangingGit();
    await withEnv({ PATH: `${bin}:${process.env.PATH}`, GBRAIN_HOME: parent }, async () => {
      const started = Date.now();
      const checks = await runDoctorRegistry(ctxFor(['--json', '--budget-ms', '1000']), [bootstrapChecksEntry]);
      expect(Date.now() - started).toBeLessThan(1_000 + 400);
      expect(checks.find((c) => c.name === 'bootstrap_push_health')?.status).not.toBe('ok');
    });
    await new Promise((r) => setTimeout(r, 1_500));
    const launched = readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number);
    expect(launched.length).toBeGreaterThan(0);
    const alive = launched.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    expect(alive).toEqual([]);
  }, 30_000);
}

test('#8990: a probe whose output passes 1 MiB reads as absent and is killed', async () => {
  const bin = tmp('gbrain-8990-flood-');
  const pids = join(bin, 'pids');
  writeFileSync(join(bin, 'flood'), `#!/bin/sh\necho $$ >> '${pids}'\nexec yes '0 * * * * gbrain sync --all'\n`, { mode: 0o755 });
  const started = Date.now();
  const out = await localProbe(Date.now() + 4_000, join(bin, 'flood'), []);
  expect(out).toBeNull();
  expect(Date.now() - started).toBeLessThan(1_500);
  await new Promise((r) => setTimeout(r, 300));
  const launched = readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number);
  expect(launched.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } })).toEqual([]);
}, 30_000);

test('#8990: a probe that prints more than 1 MiB and exits 0 still reads as absent', async () => {
  const bin = tmp('gbrain-8990-over-');
  writeFileSync(join(bin, 'over'), `#!/bin/sh\nyes 'abcdefg' | head -c ${2 * 1024 * 1024}\n`, { mode: 0o755 });
  expect(await localProbe(Date.now() + 4_000, join(bin, 'over'), [])).toBeNull();
}, 30_000);

test('#8990: a probe under the cap returns its whole output', async () => {
  const bin = tmp('gbrain-8990-under-');
  const lines = Math.floor((LOCAL_PROBE_MAX_OUTPUT_BYTES - 1) / 8);
  writeFileSync(join(bin, 'under'), `#!/bin/sh\nyes 'abcdefg' | head -n ${lines}\n`, { mode: 0o755 });
  const out = await localProbe(Date.now() + 4_000, join(bin, 'under'), []);
  expect(out?.length).toBe(lines * 8);
}, 30_000);

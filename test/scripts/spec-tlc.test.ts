/**
 * scripts/spec/tlc.sh picks which TLA+ configs a run model-checks (spec/tla/README.md). TLC itself runs in the
 * tla-spec workflow; this pins the selection with a stand-in java that records each call: a *Full.cfg config runs only
 * when named, a *Nightly.cfg config only under TLC_NIGHTLY=1, and every run checks liveness once at the end.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts/spec/tlc.sh');
const PINNED_SHA = /^TLA_TOOLS_SHA256=(\S+)$/m.exec(readFileSync(join(ROOT, 'scripts/spec/tla-tools.env'), 'utf8'))![1];
const tmp = mkdtempSync(join(tmpdir(), 'tlc-sh-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fakeBin(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function runTlc(name: string, args: string[], extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmp, `${name}-`));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const calls = join(dir, 'java-calls.log');
  fakeBin(bin, 'java', `printf '%s\\n' "$*" >> "${calls}"\necho "3 distinct states found"\necho "Model checking completed. No error has been found."`);
  fakeBin(bin, 'sha256sum', `echo "${PINNED_SHA}  $1"`);
  const jar = join(dir, 'tla2tools.jar');
  writeFileSync(jar, 'stand-in');
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: dir, TLA2TOOLS: jar, TLC_OUT: join(dir, 'out'), TLC_WORKERS: '1', ...extraEnv },
  });
  let javaCalls: string[] = [];
  try { javaCalls = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean); } catch { javaCalls = []; }
  const configs = javaCalls.map(c => /-config (\S+)/.exec(c)?.[1] ?? '');
  return { ...r, javaCalls, configs };
}

describe('scripts/spec/tlc.sh config selection', () => {
  it('skips the *Full.cfg config on a whole-spec run and names the command that runs it', () => {
    const r = runTlc('default', ['refresh-barrier']);
    expect(r.status).toBe(0);
    expect(r.configs).not.toContain('RefreshBarrierAdoptFull.cfg');
    expect(r.configs).toContain('RefreshBarrierAdopt.cfg');
    expect(r.stdout).toContain('skip refresh-barrier/RefreshBarrierAdoptFull.cfg (full run only: bash scripts/spec/tlc.sh refresh-barrier RefreshBarrierAdoptFull.cfg)');
  });

  it('runs the nightly configs under TLC_NIGHTLY=1 and still skips the *Full.cfg config', () => {
    const r = runTlc('nightly', ['refresh-barrier'], { TLC_NIGHTLY: '1' });
    expect(r.status).toBe(0);
    expect(r.configs).toContain('RefreshBarrierAdoptBlindNightly.cfg');
    expect(r.configs).toContain('RefreshBarrierAdoptExpectedNightly.cfg');
    expect(r.configs).not.toContain('RefreshBarrierAdoptFull.cfg');
  });

  it('runs the *Full.cfg config when it is named', () => {
    const r = runTlc('named', ['refresh-barrier', 'RefreshBarrierAdoptFull.cfg']);
    expect(r.status).toBe(0);
    expect(r.configs).toEqual(['RefreshBarrierAdoptFull.cfg']);
  });

  it('checks liveness once at the end of every run (-lncheck final)', () => {
    const r = runTlc('lncheck', ['refresh-barrier', 'RefreshBarrierLiveness.cfg']);
    expect(r.status).toBe(0);
    expect(r.javaCalls).toHaveLength(1);
    expect(r.javaCalls[0]).toContain('-lncheck final');
  });
});

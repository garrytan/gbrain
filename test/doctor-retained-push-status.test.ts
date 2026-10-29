/**
 * Protect Doctor's distinction between deleted-root history and unreadable
 * evidence. Existing coverage lacks empty reads from deleted roots and JSON
 * primitives; reverting the repair breaks these outcomes. No test seam needed.
 */
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapDoctorChecks } from '../src/commands/doctor/bootstrap-checks.ts';
import { pushStatusFilesExist, pushStatusPath, pushStatusPathForRoot, readPushStatuses, readPushStatusForRoot } from '../src/core/workspace-push.ts';
import { withEnv } from './helpers/with-env.ts';

async function fixture(run: (parent: string, dir: string) => Promise<void>) {
  const parent = mkdtempSync(join(process.cwd(), 'push-history-'));
  const dir = join(parent, '.gbrain', 'bootstrap');
  mkdirSync(dir, { recursive: true });
  try {
    await withEnv({ GBRAIN_HOME: parent, HOME: parent, CODEX_HOME: join(parent, 'codex'), CLAUDE_CONFIG_DIR: join(parent, 'claude') }, () => run(parent, dir));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
async function health() {
  return (await bootstrapDoctorChecks(null)).filter(c => c.name === 'bootstrap_push_health');
}
function record(root: unknown) {
  return JSON.stringify({ repoRoot: root, ok: false, ts: new Date().toISOString(), reason: 'push_failed' });
}

test('deleted-root evidence preserves files and the physical bootstrap gate', async () => {
  await fixture(async (parent, dir) => {
    writeFileSync(join(dir, 'verify-retained.json'), JSON.stringify({ ok: true, ts: new Date().toISOString(), checks_failed: [] }));
    expect(await health()).toEqual([]);
    expect(await bootstrapDoctorChecks(null)).toEqual([]);
    writeFileSync(join(parent, 'not-directory'), 'file');
    for (const root of [join(parent, 'gone'), join(parent, 'not-directory', 'child')]) {
      writeFileSync(pushStatusPathForRoot(root), record(root));
    }
    writeFileSync(pushStatusPath(), '{'); // Per-root files override corrupt legacy evidence.
    const before = new Map(readdirSync(dir).map(n => [n, readFileSync(join(dir, n), 'utf8')]));
    expect(pushStatusFilesExist()).toBe(true);
    expect(readPushStatuses()).toEqual([]);
    expect(await health()).toEqual([]);
    expect((await bootstrapDoctorChecks(null)).some(c => c.name === 'bootstrap_last_verify')).toBe(true);
    for (const [name, bytes] of before) expect(readFileSync(join(dir, name), 'utf8')).toBe(bytes);
    expect(readdirSync(dir).sort()).toEqual([...before.keys()].sort());
  });
});

for (const value of ['null', 'true', '42', '"text"', '[]', '{', record(null), record(42), record(''), record('relative')]) {
  test(`unreadable authoritative record: ${value}`, async () => {
    await fixture(async (parent) => {
      const root = join(parent, 'gone');
      const file = pushStatusPathForRoot(root);
      writeFileSync(file, value);
      writeFileSync(pushStatusPath(), JSON.stringify({ ok: true, ts: new Date().toISOString() }));
      expect(readPushStatusForRoot(root)).toBeNull();
      expect(readPushStatuses()).toEqual([]);
      expect(await health()).toEqual([expect.objectContaining({ status: 'warn', message: 'push status unreadable' })]);
      expect(readFileSync(file, 'utf8')).toBe(value);
    });
  });
}

test('legacy primitive evidence is unreadable', async () => {
  await fixture(async () => {
    writeFileSync(pushStatusPath(), 'false');
    expect(readPushStatuses()).toEqual([]);
    expect(await health()).toEqual([expect.objectContaining({ status: 'warn', message: 'push status unreadable' })]);
  });
});

test('active failure survives mixed deleted and corrupt roots', async () => {
  await fixture(async (parent) => {
    const active = join(parent, 'active');
    mkdirSync(active);
    writeFileSync(pushStatusPathForRoot(active), record(active));
    const gone = join(parent, 'gone');
    writeFileSync(pushStatusPathForRoot(gone), record(gone));
    writeFileSync(pushStatusPathForRoot(join(parent, 'corrupt')), '{');
    expect(readPushStatuses().map(s => s.repoRoot)).toEqual([active]);
    expect(readPushStatusForRoot(gone)).toBeNull();
    expect((await health())[0]?.status).toBe('warn');
    expect((await health())[0]?.message).toContain('push_failed');
  });
});

test('denied traversal remains unreadable', async () => {
  await fixture(async (parent) => {
    const denied = join(parent, 'denied');
    const root = join(denied, 'workspace');
    mkdirSync(root, { recursive: true });
    writeFileSync(pushStatusPathForRoot(root), record(root));
    chmodSync(denied, 0);
    try {
      let code: string | undefined;
      try { statSync(root); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
      expect(code).toBe('EACCES'); // Positive control requires a non-root runner.
      expect(readPushStatuses()).toEqual([]);
      expect(readPushStatusForRoot(root)).toBeNull();
      expect(await health()).toEqual([expect.objectContaining({ status: 'warn', message: 'push status unreadable' })]);
    } finally {
      chmodSync(denied, 0o700);
    }
  });
});

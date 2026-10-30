/**
 * #7377: per-root push-status records whose workspace was deleted are kept
 * on disk as history; doctor read the empty filtered result as a parse
 * failure and warned "push status unreadable".
 *
 * - Only a stat ENOENT/ENOTDIR proves a root is gone; a denied traversal
 *   (EACCES) or an invalid repoRoot value stays unreadable, never green.
 * - Whole-file primitive, array or null JSON is unreadable in the central
 *   reader and the keyed reader alike.
 * - Per-root files keep precedence over the legacy file, and doctor never
 *   changes or removes a status file.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapDoctorChecks, type Check } from '../src/commands/doctor.ts';
import { pushStatusPathForRoot, readPushStatusForRoot, readPushStatuses } from '../src/core/workspace-push.ts';
import { withEnv } from './helpers/with-env.ts';

const T = 30_000;
const tmpDirs: string[] = [];
const locked: string[] = [];
afterAll(() => {
  for (const d of locked) chmodSync(d, 0o755);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makeHome(): { parent: string; home: string; dir: string } {
  const parent = mkdtempSync(join(tmpdir(), 'gb-7377-'));
  tmpDirs.push(parent);
  const home = join(parent, '.gbrain');
  const dir = join(home, 'bootstrap');
  mkdirSync(dir, { recursive: true });
  return { parent, home, dir };
}

const goneRoot = (parent: string, name: string) => join(parent, 'deleted-workspaces', name);
const writeRoot = (dir: string, hash: string, body: unknown) => writeFileSync(join(dir, `push-status-${hash}.json`), typeof body === 'string' ? body : JSON.stringify(body));
const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
const pushHealth = async (parent: string): Promise<Check | undefined> =>
  withEnv({ GBRAIN_HOME: parent }, async () => (await bootstrapDoctorChecks(null)).find((c) => c.name === 'bootstrap_push_health'));
const statuses = (parent: string) => withEnv({ GBRAIN_HOME: parent }, () => readPushStatuses());

describe('#7377 push-status records of deleted workspaces', () => {
  test('only gone roots → not reported unreadable, and every file is kept byte for byte', async () => {
    const { parent, dir } = makeHome();
    writeRoot(dir, 'aaaaaaaaaaaa', { ts: new Date().toISOString(), ok: true, repoRoot: goneRoot(parent, 'source-a') });
    writeRoot(dir, 'bbbbbbbbbbbb', { ts: new Date().toISOString(), ok: false, reason: 'push rejected', repoRoot: goneRoot(parent, 'source-b') });
    const before = snapshot(dir);
    expect(await statuses(parent)).toEqual([]);
    const c = await pushHealth(parent);
    expect(c?.status).toBe('ok');
    expect(c?.message).not.toContain('unreadable');
    expect(c?.message).toContain('2');
    expect(snapshot(dir)).toEqual(before);
  }, T);

  test('a root under a regular file (ENOTDIR) is gone too', async () => {
    const { parent, dir } = makeHome();
    const file = join(parent, 'plain-file');
    writeFileSync(file, 'x');
    writeRoot(dir, 'aaaaaaaaaaaa', { ts: new Date().toISOString(), ok: true, repoRoot: join(file, 'ws') });
    expect((await pushHealth(parent))?.status).toBe('ok');
  }, T);

  test('per-root files keep precedence over the legacy file even when they all name gone roots', async () => {
    const { parent, dir } = makeHome();
    writeFileSync(join(dir, 'push-status.json'), JSON.stringify({ ts: new Date().toISOString(), ok: false, reason: 'legacy failure' }));
    writeRoot(dir, 'aaaaaaaaaaaa', { ts: new Date().toISOString(), ok: true, repoRoot: goneRoot(parent, 'source-a') });
    const before = snapshot(dir);
    const c = await pushHealth(parent);
    expect(c?.status).toBe('ok');
    expect(c?.message).not.toContain('legacy failure');
    expect(snapshot(dir)).toEqual(before);
  }, T);

  test('a gone root next to a live failing root → the failure is still reported', async () => {
    const { parent, dir } = makeHome();
    const live = join(parent, 'live-ws');
    mkdirSync(live);
    writeRoot(dir, 'aaaaaaaaaaaa', { ts: new Date().toISOString(), ok: true, repoRoot: goneRoot(parent, 'source-a') });
    writeRoot(dir, 'bbbbbbbbbbbb', { ts: new Date().toISOString(), ok: false, reason: 'push rejected', repoRoot: live });
    expect((await statuses(parent)).map((s) => s.repoRoot)).toEqual([live]);
    expect((await pushHealth(parent))?.status).not.toBe('ok');
  }, T);

  test('a gone root next to a corrupt record → unreadable', async () => {
    const { parent, dir } = makeHome();
    writeRoot(dir, 'aaaaaaaaaaaa', { ts: new Date().toISOString(), ok: true, repoRoot: goneRoot(parent, 'source-a') });
    writeRoot(dir, 'bbbbbbbbbbbb', 'torn{{{');
    const c = await pushHealth(parent);
    expect(c?.status).toBe('warn');
    expect(c?.message).toBe('push status unreadable');
  }, T);

  test.skipIf(process.getuid?.() === 0)('a root behind a denied traversal (EACCES) stays unreadable', async () => {
    const { parent, dir } = makeHome();
    const guard = join(parent, 'guarded');
    mkdirSync(join(guard, 'ws'), { recursive: true });
    chmodSync(guard, 0o000);
    locked.push(guard);
    writeRoot(dir, 'aaaaaaaaaaaa', { ts: new Date().toISOString(), ok: true, repoRoot: join(guard, 'ws') });
    const c = await pushHealth(parent);
    chmodSync(guard, 0o755);
    expect(c?.status).toBe('warn');
    expect(c?.message).toBe('push status unreadable');
  }, T);

  for (const [label, repoRoot] of [['a number', 42], ['a relative path', 'relative/ws'], ['an empty string', ''], ['an object', { path: '/x' }]] as const) {
    test(`an invalid repoRoot (${label}) never reads green`, async () => {
      const { parent, dir } = makeHome();
      writeRoot(dir, 'aaaaaaaaaaaa', { ts: new Date().toISOString(), ok: true, repoRoot });
      const c = await pushHealth(parent);
      expect(c?.status).toBe('warn');
      expect(c?.message).toBe('push status unreadable');
    }, T);
  }
});

describe('#7377 whole-file non-object JSON is unreadable', () => {
  for (const body of ['5', '"ok"', 'true', 'null', '[]', '[{"ok":true}]']) {
    test(`per-root file ${body} → no entry, doctor warns unreadable`, async () => {
      const { parent, dir } = makeHome();
      writeRoot(dir, 'aaaaaaaaaaaa', body);
      expect(await statuses(parent)).toEqual([]);
      const c = await pushHealth(parent);
      expect(c?.status).toBe('warn');
      expect(c?.message).toBe('push status unreadable');
    }, T);
  }

  test('legacy file holding a primitive → unreadable, never "last push ok"', async () => {
    const { parent, dir } = makeHome();
    writeFileSync(join(dir, 'push-status.json'), '7');
    expect(await statuses(parent)).toEqual([]);
    expect((await pushHealth(parent))?.message).toBe('push status unreadable');
  }, T);

  test('the keyed reader agrees with the central reader', async () => {
    const { parent } = makeHome();
    const root = join(parent, 'keyed-ws');
    mkdirSync(root);
    await withEnv({ GBRAIN_HOME: parent }, () => {
      writeFileSync(pushStatusPathForRoot(root), '[]');
      expect(readPushStatusForRoot(root)).toBeNull();
      expect(readPushStatuses()).toEqual([]);
      writeFileSync(pushStatusPathForRoot(root), JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', ok: false, repoRoot: root }));
      expect(readPushStatusForRoot(root)).toEqual(readPushStatuses()[0]!);
    });
  }, T);
});

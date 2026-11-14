import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readGitHoldStatuses } from '../src/core/persistence/connector-status.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { __resetCliRoutingForTests, installCliRouting } from '../src/core/fix-routing.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-hold-fix-routing-'));
  mkdirSync(join(home, 'notes-git'));
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['notes-git', join(home, 'notes-git')]);
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', ['notes-git']);
  await writeGitHold(engine, {
    source_id: 'notes-git', incarnation, path: 'notes/a.md', source_path: 'notes/a.md', slug: 'notes/a', page_id: null, code: 'concurrent_write',
    message: 'notes/a.md changed in Git while a database write landed.', upstream_version: 'sha-a', observed_at: '2026-10-01T00:00:00.000Z',
    run_id: 'run-1', mode: 'managed', meta: { recovery_version: 1 },
  });
}, 120_000);

afterAll(async () => { __resetCliRoutingForTests(); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);

test('sources status pins the brain into a concurrent_write hold fix', async () => {
  installCliRouting(() => ({ brain: 'host' }));
  const status = (await readGitHoldStatuses(engine, ['notes-git'])).get('notes-git')!;
  const fix = status.items[0]!.fix;
  expect(fix.argv).toEqual(['gbrain', 'sources', 'reconcile', 'notes-git', 'notes/a', '--preview', '--brain', 'host']);
  expect(fix.then?.argv?.slice(-2)).toEqual(['--brain', 'host']);
});

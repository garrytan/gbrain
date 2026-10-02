/**
 * #5401 / DX-O5: `gbrain projections drain` through the real CLI entrypoint.
 * Exit 0 when nothing tried failed, 1 when a page failed, 2 when it did not run
 * (bad usage, or `projection_owner_resident` because a resident holds the
 * PGLite brain — refused before any engine opens, including for a mounted
 * PGLite brain on a host configured for Postgres).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';
import { runCli } from './helpers/cli-spawn.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-projections-cli-'));
const healthyHome = join(root, 'healthy');
const failingHome = join(root, 'failing');
const mountedHome = join(root, 'mounted');

function writeConfig(home: string, config: Record<string, unknown>) {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
}

async function seedBrain(home: string, broken: boolean) {
  const database_path = join(home, '.gbrain', 'brain.pglite');
  writeConfig(home, { engine: 'pglite', database_path });
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path });
  try {
    await engine.initSchema();
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('cli-example','cli-example')");
    for (const slug of ['notes/a', 'notes/b']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Example ${slug}.` }, { sourceId: 'cli-example' });
    await engine.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE source_id='cli-example'");
    await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
      SELECT s.incarnation,p.slug,p.knowledge_revision,'test_backlog' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id='cli-example'
      ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision`);
    if (broken) await engine.putPage('broken-code', { type: 'code', page_kind: 'code', title: 'Missing origin', compiled_truth: 'export const example = 1;' }, { sourceId: 'cli-example' });
  } finally { await engine.disconnect(); }
}

beforeAll(async () => {
  await seedBrain(healthyHome, false);
  await seedBrain(failingHome, true);
  writeConfig(mountedHome, { engine: 'postgres', database_url: 'postgresql://example@127.0.0.1:1/unreachable' });
  writeFileSync(join(mountedHome, '.gbrain', 'mounts.json'), JSON.stringify({ version: 1, mounts: [
    { id: 'team-a', path: join(mountedHome, 'team-a'), engine: 'pglite', database_path: join(mountedHome, 'team-a.pglite'), enabled: true },
  ] }));
}, 240_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('gbrain projections drain', () => {
  test('help lists the command; bad usage exits 2 without running', async () => {
    expect((await runCli(['--help'], { home: healthyHome })).stdout).toContain('projections drain [--limit n]');
    const help = await runCli(['projections', '--help'], { home: healthyHome });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Exit codes: 0 nothing tried failed; 1 some pages failed; 2 did not run');
    const unknown = await runCli(['projections', 'rebuild'], { home: healthyHome });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('Error [invalid_params]');
    const limit = await runCli(['projections', 'drain', '--limit', '0', '--json'], { home: healthyHome });
    expect(limit.exitCode).toBe(2);
    expect(JSON.parse(limit.stdout)).toMatchObject({ error: 'invalid_params', suggestion: expect.stringContaining('gbrain projections drain --limit 1000') });
  }, 120_000);

  test('exit 0 drains the backlog and says it is empty', async () => {
    const human = await runCli(['projections', 'drain'], { home: healthyHome });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('projections drain: 2 rebuilt, 0 superseded, 0 failed, 0 remaining. The projection backlog is empty.');
    const again = await runCli(['projections', 'drain', '--json'], { home: healthyHome });
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({ rebuilt: 0, superseded: 0, failed: [], remaining: 0 });
  }, 120_000);

  test('exit 1 reports each failed page with its source, slug, reason and next action', async () => {
    const json = await runCli(['projections', 'drain', '--json'], { home: failingHome });
    expect(json.exitCode).toBe(1);
    const payload = JSON.parse(json.stdout);
    expect(payload).toMatchObject({ rebuilt: 2, superseded: 0, remaining: 1 });
    expect(payload.failed).toEqual([{ source_id: 'cli-example', slug: 'broken-code', reason: expect.stringContaining('recorded source path') }]);
    const human = await runCli(['projections', 'drain'], { home: failingHome });
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain('failed: cli-example/broken-code: Code projection requires a recorded source path');
    expect(human.stderr).toContain('next: restore frontmatter.file or source_path on broken-code');
    expect(human.stdout).toContain('0 rebuilt, 0 superseded, 1 failed, 1 remaining. Failed pages stay queued');
    expect(human.stdout).not.toContain('backlog is empty');
  }, 120_000);

  test('exit 2 projection_owner_resident while a resident holds the PGLite brain, before any engine opens', async () => {
    const lock = await acquireLock(join(healthyHome, '.gbrain', 'brain.pglite'));
    try {
      const human = await runCli(['projections', 'drain'], { home: healthyHome, timeoutMs: 30_000 });
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toContain('Error [projection_owner_resident]');
      expect(human.stderr).toContain(`(pid ${process.pid}), so the drain did not run.`);
      expect(human.stderr).toContain('watch the pending count with `gbrain doctor` (text_projection_readiness)');
      expect(human.stderr).toContain('systemctl --user stop gbrain-serve.service && { gbrain projections drain; systemctl --user start gbrain-serve.service; }');
      const json = await runCli(['projections', 'drain', '--json'], { home: healthyHome, timeoutMs: 30_000 });
      expect(json.exitCode).toBe(2);
      expect(JSON.parse(json.stdout)).toMatchObject({ error: 'projection_owner_resident', docs: 'docs/guides/repair.md#projection-owner-resident' });
    } finally { await releaseLock(lock); }
  }, 120_000);

  test('a mounted PGLite brain on a Postgres-configured host is refused for its own resident', async () => {
    const lock = await acquireLock(join(mountedHome, 'team-a.pglite'));
    try {
      const refused = await runCli(['projections', 'drain', '--brain', 'team-a'], { home: mountedHome, timeoutMs: 30_000 });
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain(`The PGLite brain at ${join(mountedHome, 'team-a.pglite')} is held by`);
      expect(refused.stderr).toContain('`gbrain doctor --brain team-a`');
      expect(refused.stderr).toContain('systemctl --user stop gbrain-serve.service && { gbrain projections drain --brain team-a; systemctl --user start gbrain-serve.service; }');
    } finally { await releaseLock(lock); }
  }, 120_000);
});

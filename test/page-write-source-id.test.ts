import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
const SLUG = 'notes/source-selector';
const SOURCE = 'workspace';
let dir: string;
let config: { engine: 'pglite'; database_path: string };
let engine: PGLiteEngine;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-page-source-'));
  config = { engine: 'pglite', database_path: join(dir, 'db') };
  engine = new PGLiteEngine();
  await engine.connect(config);
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('workspace', 'workspace') ON CONFLICT DO NOTHING");
  for (const sourceId of ['default', SOURCE]) {
    await engine.putPage(SLUG, {
      type: 'note', title: sourceId, compiled_truth: `${sourceId} body`,
    }, { sourceId });
  }
  await engine.disconnect();
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ ...config, embedding: { disabled: true } }));
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[], stdin?: string) {
  const child = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
    cwd: dir,
    env: {
      GBRAIN_HOME: dir,
      GBRAIN_NO_BANNER: '1',
      GBRAIN_BACKUP_CHECK: '0',
      GBRAIN_SKIP_UPGRADE_CHECK: '1',
    },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test('timeline-add and append route --source-id to the selected page source', async () => {
  const timeline = await cli(['timeline-add', SLUG, '2026-10-31', 'selected source entry', '--source-id', SOURCE, '--json']);
  expect(timeline.code).toBe(0);

  const append = await cli(['append', SLUG, '--source-id', SOURCE, '--json'], 'selected source append');
  expect(append.code).toBe(0);

  await engine.connect(config);
  const entries = await engine.executeRaw<{ source_id: string; summary: string }>(
    `SELECT p.source_id, t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`, [SLUG]);
  const pages = await engine.executeRaw<{ source_id: string; compiled_truth: string; timeline: string }>(
    'SELECT source_id, compiled_truth, timeline FROM pages WHERE slug = $1 ORDER BY source_id', [SLUG]);
  expect(entries).toContainEqual({ source_id: SOURCE, summary: 'selected source entry' });
  expect(`${pages.find(page => page.source_id === SOURCE)?.compiled_truth}\n${pages.find(page => page.source_id === SOURCE)?.timeline}`).toContain('selected source append');
  expect(`${pages.find(page => page.source_id === 'default')?.compiled_truth}\n${pages.find(page => page.source_id === 'default')?.timeline}`).toBe('default body\n');
}, 120_000);

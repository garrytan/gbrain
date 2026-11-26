/**
 * #10080: sync stored pages whose slug (the file path without .md) was over 255 characters, which every operation
 * that names a page refuses. The shared import screen now holds such a file as `slug_too_long` before anything is
 * stored: a file import skips it, and a managed sync holds it while the rest of the source syncs.
 * Protects: no page is ever stored under a slug over 255 characters; a slug of exactly 255 still imports.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { classifyImportHold, parseMarkdown } from '../src/core/markdown.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-10080-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const body = '---\ntype: note\ntitle: Deep\n---\n\nA page deep in an exported folder tree.\n';
/** A source-relative Markdown path whose slug is exactly `length` characters. */
const pathOfSlug = (length: number) => { const stem = 'drive/' + 'folder-example/'.repeat(20); return `${stem.slice(0, length - 1)}x.md`; };
let engine: PGLiteEngine;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

test('the shared screen holds a slug over 255 characters and admits one of exactly 255', () => {
  const over = pathOfSlug(256), at = pathOfSlug(255);
  expect(over.length - 3).toBe(256);
  expect(classifyImportHold(parseMarkdown(body, over, { validate: true }))).toMatchObject({ code: 'slug_too_long', key: 'slug' });
  expect(classifyImportHold(parseMarkdown(body, at, { validate: true }))).toBeNull();
});

test('a file import skips a file whose slug is over 255 characters and stores nothing', async () => {
  const rel = pathOfSlug(270);
  const file = join(home, 'import', rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  const result = await importFromFile(engine, file, rel, { noEmbed: true } as never);
  expect(result).toEqual(expect.objectContaining({ status: 'skipped', skip_reason: 'slug_too_long', refusal: expect.objectContaining({ code: 'slug_too_long' }) }));
  expect(await engine.executeRaw('SELECT slug FROM pages WHERE length(slug) > 255')).toEqual([]);
});

test('a managed sync holds the file as slug_too_long and imports the rest of the source', async () => withEnv(env, async () => {
  const sourceId = `long-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId);
  const rel = pathOfSlug(280);
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, rel), body);
  writeFileSync(join(root, 'notes', 'short.md'), body.replace('Deep', 'Short'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'pages');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const result = await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true, noExtract: true });
  expect((result.held ?? []).map(hold => [hold.path, hold.code])).toEqual([[rel, 'slug_too_long']]);
  expect((await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [sourceId])).map(row => row.slug)).toEqual(['notes/short']);
}), 120_000);

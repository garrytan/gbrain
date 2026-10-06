/**
 * #5377: on a managed brain `reindex --markdown` cannot re-import through the
 * legacy writer. It delegates to the projection repairs (safe-chunks, then
 * contextual-mode), which change no page revision, journal or canonical file.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindex } from '../src/commands/reindex.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-reindex-managed-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr);
  let stdout = '', stderr = '';
  (process.stdout.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => { stdout += String(chunk); return true; };
  (process.stderr.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => { stderr += String(chunk); return true; };
  try { return { result: await fn(), stdout, stderr }; } finally { process.stdout.write = out; process.stderr.write = err; }
}

test('managed reindex --markdown re-seals drifted pages without a page write (#5377)', () => withEnv({ GBRAIN_HOME: home }, async () => {
  _resetCliExitVerdictForTests();
  await importFromContent(engine, 'notes/a', '---\ntitle: A\ntype: note\n---\n\nAlpha body text for the reindex fixture.\n', { noEmbed: true, sourceId: 'default' });
  await engine.executeRaw("UPDATE pages SET chunker_version=1 WHERE slug='notes/a'");
  const [before] = await engine.executeRaw<{ knowledge_revision: string }>("SELECT knowledge_revision FROM pages WHERE slug='notes/a'");
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

  const { result, stderr } = await quiet(() => runReindex(engine, ['--markdown', '--no-embed']));
  expect(stderr).not.toContain('legacy writer');
  expect(result.failed).toBe(0);
  expect(result.reindexed).toBe(1);
  expect(result.pendingAfter).toBe(0);
  expect(currentExitCode()).toBe(0);
  const [after] = await engine.executeRaw<{ knowledge_revision: string; chunker_version: number }>("SELECT knowledge_revision, chunker_version FROM pages WHERE slug='notes/a'");
  expect(after.chunker_version).toBe(MARKDOWN_CHUNKER_VERSION);
  expect(after.knowledge_revision).toBe(before.knowledge_revision);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests')).toEqual([]);
}));

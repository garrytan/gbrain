import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { decodeDeepResearchId } from '../src/core/deep-research-id.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { runCli } from './helpers/cli-spawn.ts';

describe('deep research CLI search/fetch round-trip', () => {
  let home: string;
  let engine: PGLiteEngine;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-deep-research-'));
    const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
    engine = new PGLiteEngine();
    await engine.connect(config);
    await engine.initSchema();
    await engine.setConfig('search.mcp_keyword_only', 'true');
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('beta', 'beta')`);
    for (const [sourceId, body] of [['default', 'Unrelated default material.'], ['beta', 'Zirconiumneedle beta evidence.']]) {
      await engine.putPage('notes/shared-example', { type: 'note', title: sourceId, compiled_truth: body }, { sourceId });
      await installFixtureChunks(engine, 'notes/shared-example', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }], { sourceId });
    }
    await engine.disconnect();
  }, 60_000);
  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('actual CLI fetch uses hit source even when ambient source is default', async () => {
    const searched = await runCli(['search', 'Zirconiumneedle', '--source', '__all__', '--json'], { home, cwd: home });
    expect(searched.exitCode).toBe(0);
    const hits = JSON.parse(searched.stdout);
    expect(hits).toHaveLength(1);
    expect(decodeDeepResearchId(hits[0].id)).toEqual({ sourceId: 'beta', slug: 'notes/shared-example' });
    const fetched = await runCli(['fetch', hits[0].id, '--source', 'default', '--json'], { home, cwd: home });
    expect(fetched.exitCode).toBe(0);
    const page = JSON.parse(fetched.stdout);
    expect(page.id).toBe(hits[0].id);
    expect(page.metadata.source_id).toBe('beta');
    expect(page.text).toContain('Zirconiumneedle beta evidence.');
    expect(page.url).toBe('gbrain://page/beta/notes/shared-example');
  }, 60_000);

  test('actual CLI refuses an ambiguous legacy slug', async () => {
    const result = await runCli(['fetch', 'notes/shared-example', '--source', '__all__', '--json'], { home, cwd: home });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('ambiguous_id');
    expect(result.stdout + result.stderr).not.toContain('Zirconiumneedle');
  }, 60_000);
});

/**
 * #6871: `gbrain migrate --to <engine>` (the legacy copier) must carry an image chunk's
 * `embedding_image` vector. It used to copy the chunk with only the text embedding, so a
 * migrated image page lost its visual vector and needed a paid re-embed to be found by image
 * search again.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { saveConfig } from '../src/core/config.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

describe('gbrain migrate carries image vectors (#6871)', () => {
  afterEach(() => { _resetCliExitVerdictForTests(); });

  test('an image chunk arrives on the target with its embedding_image vector', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-migrate-image-home-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'gbrain-migrate-image-target-'));
    const targetPath = join(targetDir, 'brain.pglite');
    let source: PGLiteEngine | null = null;
    let target: PGLiteEngine | null = null;
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });
        source = new PGLiteEngine();
        await source.connect({});
        await source.initSchema();
        await source.putPage('images/diagram-example.png', { type: 'image', title: 'diagram-example.png', compiled_truth: '', timeline: '', frontmatter: {} });
        const visual = new Float32Array(1024);
        visual[0] = 0.75;
        visual[1023] = -0.5;
        await source.upsertChunks('images/diagram-example.png', [{
          chunk_index: 0, chunk_text: 'diagram-example.png', chunk_source: 'image_asset', modality: 'image', embedding_image: visual,
        }]);

        const log = console.log;
        console.log = () => {};
        try { await runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath]); } finally { console.log = log; }
        expect(currentExitCode()).toBe(0);

        target = new PGLiteEngine();
        await target.connect({ database_path: targetPath });
        const rows = await target.executeRaw<{ modality: string; image: string | null }>(
          `SELECT cc.modality, cc.embedding_image::text AS image FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
            WHERE p.slug = 'images/diagram-example.png'`);
        expect(rows.length).toBe(1);
        expect(rows[0]!.modality).toBe('image');
        expect(rows[0]!.image).not.toBeNull();
        const copied = JSON.parse(rows[0]!.image!) as number[];
        expect(copied.length).toBe(1024);
        expect(copied[0]).toBeCloseTo(0.75);
        expect(copied[1023]).toBeCloseTo(-0.5);
      });
    } finally {
      await (target as PGLiteEngine | null)?.disconnect();
      await (source as PGLiteEngine | null)?.disconnect();
      rmSync(home, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  }, 120_000);
});

/** Canonical storage bytes must agree with index privacy and seal comparisons. */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import { importFromContent, importImageFile, _resetOcrRunBudgetForTests } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../../src/core/chunkers/recursive.ts';
import { FACTS_FENCE_BEGIN, renderFactsTable } from '../../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { sanitizeRemoteBody } from '../../src/core/remote-body.ts';
import * as gateway from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const SOURCE = 'canonical-chunk-privacy-fixture';
const NUL = String.fromCharCode(0);
const LONE_HI = String.fromCharCode(0xd83c);
const PRIVATE = 'PRIVATE_CANONICAL_BODY_CANARY';
const WORLD = 'WORLD_CANONICAL_BODY_CONTROL';
const obscure = (marker: string) => marker.replace('gbrain:', `gbrain:${NUL}`);

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: canonical chunk text privacy`, () => {
    let engine: BrainEngine;
    let fixtureDir: string;

    beforeAll(async () => {
      gateway.configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      await engine.connect(kind === 'postgres' ? { database_url: process.env.DATABASE_URL! } : {});
      await engine.initSchema();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SOURCE]);
      fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-canonical-chunks-'));
    }, 120_000);

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [SOURCE]);
    });

    afterAll(async () => {
      try {
        if (engine) {
          await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SOURCE]);
          await engine.disconnect();
        }
      } finally {
        if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
        gateway.resetGateway();
        _resetOcrRunBudgetForTests();
      }
    }, 60_000);

    async function version(slug: string): Promise<number> {
      const [row] = await engine.executeRaw<{ version: number }>(
        'SELECT chunker_version AS version FROM pages WHERE source_id = $1 AND slug = $2', [SOURCE, slug]);
      return Number(row.version);
    }

    async function imported(slug: string, body: string, timeline = '') {
      const result = await importFromContent(engine, slug,
        serializeMarkdown({}, body, timeline, { type: 'note', title: 'Canonical text fixture', tags: [] }),
        { sourceId: SOURCE, noEmbed: true, forceRechunk: true });
      expect(result.status).toBe('imported');
      expect(await version(slug)).toBe(MARKDOWN_CHUNKER_VERSION);
      return result;
    }

    test('canonical embedding refresh preserves a seal and matching hash; changed text invalidates', async () => {
      const slug = 'notes/canonical-refresh';
      await imported(slug, 'Public canonical replacement � control.');
      const before = await engine.getChunks(slug, { sourceId: SOURCE, requireSafeChunks: true });
      expect(before).toHaveLength(1);
      const vector = new Float32Array(1536); vector[0] = 1;
      const poison = before[0].chunk_text.replace('�', LONE_HI) + NUL;
      // Embedding refresh supplies body fields only; omitted code metadata
      // retains its stored value under the upsert contract.
      const input: ChunkInput[] = [{
        chunk_index: before[0].chunk_index,
        chunk_source: before[0].chunk_source,
        chunk_text: poison,
        embedding: vector,
      }];
      await engine.upsertChunks(slug, input, { sourceId: SOURCE });
      expect(input[0].chunk_text).toBe(poison); // normalization must not mutate the caller's input
      expect(await version(slug)).toBe(MARKDOWN_CHUNKER_VERSION);
      const refreshed = await engine.getChunks(slug, { sourceId: SOURCE, requireSafeChunks: true });
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0].chunk_text).toBe(before[0].chunk_text);
      expect(refreshed[0].embedding_is_null).toBe(false);
      const hashes = () => engine.executeRaw<{ stored: string; recomputed: string }>(
        `SELECT c.embedded_text_hash AS stored, md5(c.chunk_text) AS recomputed
         FROM content_chunks c JOIN pages p ON p.id = c.page_id
         WHERE p.source_id = $1 AND p.slug = $2`, [SOURCE, slug]);
      let [hash] = await hashes();
      expect(hash.stored).toBe(hash.recomputed);

      await engine.upsertChunks(slug, [{ ...input[0], chunk_text: `${poison} changed` }], { sourceId: SOURCE });
      expect(await version(slug)).toBeLessThan(0);
      expect(await engine.getChunks(slug, { sourceId: SOURCE, requireSafeChunks: true })).toEqual([]);
      const [changed] = await engine.getChunks(slug, { sourceId: SOURCE });
      expect(changed.chunk_text).toBe(`${before[0].chunk_text} changed`);
      [hash] = await hashes();
      expect(hash.stored).toBe(hash.recomputed);
    });

    test('identity fields still reject poisoned input without changing sealed chunks', async () => {
      const slug = 'notes/canonical-identity';
      await imported(slug, 'Public identity control.');
      const chunks = await engine.getChunks(slug, { sourceId: SOURCE });
      await expect(engine.upsertChunks(slug, [{
        chunk_index: chunks[0].chunk_index,
        chunk_text: chunks[0].chunk_text,
        chunk_source: `compiled_${NUL}truth` as ChunkInput['chunk_source'],
      }], { sourceId: SOURCE })).rejects.toThrow();
      expect(await version(slug)).toBe(MARKDOWN_CHUNKER_VERSION);
      expect(await engine.getChunks(slug, { sourceId: SOURCE, requireSafeChunks: true })).toEqual(chunks);
    });

    test('actual imports normalize protected prose, facts, timeline and code fences before indexing', async () => {
      const slug = 'notes/canonical-protected';
      const facts = renderFactsTable([
        { rowNum: 1, claim: WORLD, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
        { rowNum: 2, claim: PRIVATE, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
      ]).replace(FACTS_FENCE_BEGIN, obscure(FACTS_FENCE_BEGIN));
      const takes = `${obscure(TAKES_FENCE_BEGIN)}\n\`\`\`typescript\nexport const hidden = '${PRIVATE}';\n\`\`\`\n${TAKES_FENCE_END}`;
      const body = `Public canonical prefix ${LONE_HI}.\n${takes}\n${facts}\nPublic canonical suffix.`;
      const timeline = `Public timeline prefix.\n${takes}\n${facts}\nPublic timeline suffix.`;
      // Direct chunker/compile callers also use this boundary on raw text.
      const sanitized = sanitizeRemoteBody(body);
      expect(sanitized).toContain(WORLD);
      expect(sanitized).toContain('Public canonical prefix �.');
      expect(sanitized).not.toContain(PRIVATE);
      expect(sanitized).not.toContain(NUL);
      const result = await imported(slug, body, timeline);
      const page = (await engine.getPage(slug, { sourceId: SOURCE }))!;
      expect(page.compiled_truth).toContain(TAKES_FENCE_BEGIN);
      expect(page.compiled_truth).toContain(PRIVATE); // owner body is preserved
      expect(page.compiled_truth).not.toContain(NUL);
      expect(page.compiled_truth).toContain('�');
      const chunks = await engine.getChunks(slug, { sourceId: SOURCE, requireSafeChunks: true });
      expect(chunks.length).toBeGreaterThan(0);
      const text = chunks.map(chunk => chunk.chunk_text).join('\n');
      expect(text).toContain(WORLD);
      expect(text).toContain('Public canonical prefix �.');
      expect(text).toContain('Public timeline suffix.');
      expect(text).not.toContain(PRIVATE);
      expect(text).not.toContain(NUL);
      expect(result.parsedPage?.compiled_truth).toBe(page.compiled_truth);
      expect(result.parsedPage?.timeline).toBe(page.timeline);
      expect(chunks.some(chunk => chunk.chunk_source === 'fenced_code')).toBe(false);
      expect(sanitizeRemoteBody(page.compiled_truth)).not.toContain(PRIVATE);
      expect(sanitizeRemoteBody(page.timeline)).not.toContain(PRIVATE);
      expect(await engine.searchKeyword(PRIVATE, { sourceId: SOURCE, requireSafeChunks: true })).toEqual([]);
      expect((await engine.searchKeyword(WORLD, { sourceId: SOURCE, requireSafeChunks: true })).length).toBeGreaterThan(0);
    });

    test('successful OCR normalizes protected markers before image sealing', async () => {
      const path = join(fixtureDir, 'canonical.png');
      writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9kAAAAASUVORK5CYII=', 'base64'));
      gateway.configureGateway({ ...LEGACY_EMBEDDING_CONFIG, embedding_image_ocr_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'synthetic-ocr-key' } });
      _resetOcrRunBudgetForTests();
      const ocr = spyOn(gateway, 'generateOcrText').mockResolvedValue(`Public OCR.\n${obscure(TAKES_FENCE_BEGIN)}\n${PRIVATE}\n${obscure(TAKES_FENCE_END)}`);
      const vector = new Float32Array(1024); vector[0] = 1;
      const embed = spyOn(gateway, 'embedMultimodal').mockResolvedValue([vector]);
      try {
        const slug = 'images/canonical.png';
        const result = await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' },
          () => importImageFile(engine, path, slug, { sourceId: SOURCE }));
        expect(result.status).toBe('imported');
        expect(ocr).toHaveBeenCalledTimes(1);
        expect(embed).toHaveBeenCalledTimes(1);
        expect(await version(slug)).toBeLessThan(MARKDOWN_CHUNKER_VERSION);
        expect(await engine.getChunks(slug, { sourceId: SOURCE, requireSafeChunks: true })).toEqual([]);
        const page = (await engine.getPage(slug, { sourceId: SOURCE }))!;
        expect(page.compiled_truth).toContain(TAKES_FENCE_BEGIN);
        expect(page.compiled_truth).not.toContain(NUL);
        const [chunk] = await engine.getChunks(slug, { sourceId: SOURCE });
        expect(chunk.chunk_text).toContain('Public OCR.');
        expect(chunk.chunk_text).not.toContain(PRIVATE);
      } finally {
        ocr.mockRestore();
        embed.mockRestore();
        gateway.configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      }
    });
  });
}

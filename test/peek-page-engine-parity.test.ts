/**
 * Engine contract for the authenticated exact-page readback snapshot.
 *
 * PGLite always runs in memory. Postgres runs only when DATABASE_URL names the
 * repository's test database, matching the existing engine-parity convention.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { pagePeekSnapshotFromRows } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { PagePeekSnapshot } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const TEST_SUFFIX = `${process.pid}`;
const SOURCE_A = `peek-parity-a-${TEST_SUFFIX}`;
const SOURCE_B = `peek-parity-b-${TEST_SUFFIX}`;
const SLUG = 'wiki/exact-peek';

let pglite: PGLiteEngine;
let postgres: PostgresEngine | null = null;

function engines(): BrainEngine[] {
  return postgres ? [pglite, postgres] : [pglite];
}

async function cleanupOwnedRows(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('DELETE FROM pages WHERE source_id = ANY($1::text[])', [[SOURCE_A, SOURCE_B]]);
  await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [[SOURCE_A, SOURCE_B]]);
}

async function ensureSources(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name)
     VALUES ($1, $2), ($3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [SOURCE_A, `Peek parity A ${TEST_SUFFIX}`, SOURCE_B, `Peek parity B ${TEST_SUFFIX}`],
  );
}

async function seedPage(
  engine: BrainEngine,
  sourceId: string,
  body: string,
  hash: string,
  chunkText: string,
  model: string,
  tokenCount: number,
): Promise<void> {
  await engine.putPage(SLUG, {
    type: 'note',
    title: `${sourceId} exact page`,
    compiled_truth: body,
    timeline: '',
    content_hash: hash,
    frontmatter: {
      quarantine: { reason: 'fixture-review' },
      embed_skip: { reason: 'fixture-skip' },
      fixture_source: sourceId,
    },
  }, { sourceId });
  await engine.upsertChunks(SLUG, [{
    chunk_index: 0,
    chunk_text: chunkText,
    chunk_source: 'compiled_truth',
    modality: 'text',
    model,
    token_count: tokenCount,
  }], { sourceId });
}

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();

  if (process.env.DATABASE_URL) {
    postgres = new PostgresEngine();
    await postgres.connect({ database_url: process.env.DATABASE_URL });
    await postgres.initSchema();
  }
});

afterAll(async () => {
  await pglite.disconnect();
  if (postgres) {
    await cleanupOwnedRows(postgres);
    await postgres.disconnect();
  }
});

beforeEach(async () => {
  await resetPgliteState(pglite);
  if (postgres) await cleanupOwnedRows(postgres);
  for (const engine of engines()) await ensureSources(engine);
});

function assertCoherentVersion(snapshot: PagePeekSnapshot, allowedVersions: number[]): void {
  const bodyMatch = /^version-(\d+)$/.exec(snapshot.compiled_truth);
  expect(bodyMatch).not.toBeNull();
  const version = Number(bodyMatch?.[1]);
  expect(allowedVersions).toContain(version);
  expect(snapshot.content_hash).toBe(`hash-${version}`);
  expect(snapshot.chunks).toHaveLength(1);
  expect(snapshot.chunks[0]?.model).toBe(`peek-model-${version}`);
  expect(snapshot.chunks[0]?.token_count).toBe(version);
}

function syntheticPeekRow(frontmatter: unknown): Record<string, unknown> {
  return {
    source_id: SOURCE_A,
    slug: SLUG,
    compiled_truth: 'HOSTILE_FRONTMATTER_BODY_MUST_NOT_ESCAPE',
    frontmatter,
    content_hash: 'hostile-frontmatter-hash',
    deleted_at: null,
    chunk_index: 0,
    chunk_source: 'compiled_truth',
    modality: 'text',
    model: 'peek-model-hostile',
    token_count: 3,
    embedded_at: null,
    keyword_indexed: true,
    vector_indexed: false,
  };
}

describe('peekPage engine parity', () => {
  test('fails closed without content when a projected frontmatter value is not an object', () => {
    const hostileValues: unknown[] = [
      null,
      [],
      42,
      true,
      '"scalar"',
      '[]',
      'null',
      'not-json',
    ];

    for (const hostile of hostileValues) {
      let message = '';
      try {
        pagePeekSnapshotFromRows([syntheticPeekRow(hostile)]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe('Invalid peek_page frontmatter: expected a JSON object.');
      expect(message).not.toContain('HOSTILE_FRONTMATTER_BODY_MUST_NOT_ESCAPE');
    }

    expect(pagePeekSnapshotFromRows([syntheticPeekRow('{"safe":"value"}')])?.frontmatter)
      .toEqual({ safe: 'value' });
  });

  test('fails closed on hostile JSONB frontmatter in both engines', async () => {
    for (const engine of engines()) {
      await seedPage(
        engine,
        SOURCE_A,
        'HOSTILE_JSONB_BODY_MUST_NOT_ESCAPE',
        'hostile-jsonb-hash',
        'hostile-jsonb-chunk',
        'peek-model-hostile-jsonb',
        4,
      );

      for (const hostile of [null, [], 42, true, 'scalar']) {
        await engine.executeRaw(
          `UPDATE pages
           SET frontmatter = $1::jsonb
           WHERE source_id = $2 AND slug = $3`,
          [JSON.stringify(hostile), SOURCE_A, SLUG],
        );
        await expect(engine.peekPage(SOURCE_A, SLUG)).rejects.toThrow(
          'Invalid peek_page frontmatter: expected a JSON object.',
        );
      }
    }
  });

  test('uses exact source_id + slug and returns metadata without chunk text or vectors', async () => {
    for (const engine of engines()) {
      await seedPage(
        engine,
        SOURCE_A,
        'source-a-body',
        'hash-a',
        'CHUNK_TEXT_MUST_NOT_ESCAPE_A',
        'peek-model-a',
        11,
      );
      await seedPage(
        engine,
        SOURCE_B,
        'source-b-body',
        'hash-b',
        'CHUNK_TEXT_MUST_NOT_ESCAPE_B',
        'peek-model-b',
        22,
      );

      const a = await engine.peekPage(SOURCE_A, SLUG);
      const b = await engine.peekPage(SOURCE_B, SLUG);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a?.compiled_truth).toBe('source-a-body');
      expect(b?.compiled_truth).toBe('source-b-body');
      expect(a?.content_hash).toBe('hash-a');
      expect(b?.content_hash).toBe('hash-b');
      expect(a?.frontmatter.fixture_source).toBe(SOURCE_A);
      expect(b?.frontmatter.fixture_source).toBe(SOURCE_B);
      expect(a?.quarantined).toBe(true);
      expect(a?.embed_skipped).toBe(true);
      expect(a?.chunks).toEqual([{
        chunk_index: 0,
        chunk_source: 'compiled_truth',
        modality: 'text',
        model: 'peek-model-a',
        token_count: 11,
        embedded_at: null,
        keyword_indexed: true,
        vector_indexed: false,
      }]);

      const serializedA = JSON.stringify(a);
      expect(serializedA).not.toContain('CHUNK_TEXT_MUST_NOT_ESCAPE_A');
      expect(serializedA).not.toContain('CHUNK_TEXT_MUST_NOT_ESCAPE_B');
      expect(a?.chunks[0]).not.toHaveProperty('chunk_text');
      expect(a?.chunks[0]).not.toHaveProperty('embedding');
      expect(a?.chunks[0]).not.toHaveProperty('embedding_image');
      expect(a?.chunks[0]).not.toHaveProperty('embedding_multimodal');
    }
  });

  test('hides soft-deleted rows unless includeDeleted is explicitly true', async () => {
    for (const engine of engines()) {
      await seedPage(engine, SOURCE_A, 'deleted-body', 'deleted-hash', 'deleted-chunk', 'peek-model', 5);
      await engine.softDeletePage(SLUG, { sourceId: SOURCE_A });

      expect(await engine.peekPage(SOURCE_A, SLUG)).toBeNull();
      const deleted = await engine.peekPage(SOURCE_A, SLUG, { includeDeleted: true });
      expect(deleted).not.toBeNull();
      expect(deleted?.deleted_at).toBeInstanceOf(Date);
      expect(deleted?.source_id).toBe(SOURCE_A);
      expect(deleted?.slug).toBe(SLUG);
    }
  });

  test('does not mutate last_retrieved_at or the MCP request log', async () => {
    for (const engine of engines()) {
      await seedPage(engine, SOURCE_A, 'no-mutation-body', 'no-mutation-hash', 'no-mutation-chunk', 'peek-model', 7);
      await engine.executeRaw(
        `UPDATE pages
         SET last_retrieved_at = '2026-08-01T01:02:03.000Z'::timestamptz
         WHERE source_id = $1 AND slug = $2`,
        [SOURCE_A, SLUG],
      );

      const beforePage = await engine.executeRaw<{ last_retrieved_at: Date | string | null }>(
        'SELECT last_retrieved_at FROM pages WHERE source_id = $1 AND slug = $2',
        [SOURCE_A, SLUG],
      );
      const beforeLog = await engine.executeRaw<{ count: number | string }>(
        'SELECT COUNT(*)::int AS count FROM mcp_request_log',
      );

      const snapshot = await engine.peekPage(SOURCE_A, SLUG);
      expect(snapshot).not.toBeNull();

      const afterPage = await engine.executeRaw<{ last_retrieved_at: Date | string | null }>(
        'SELECT last_retrieved_at FROM pages WHERE source_id = $1 AND slug = $2',
        [SOURCE_A, SLUG],
      );
      const afterLog = await engine.executeRaw<{ count: number | string }>(
        'SELECT COUNT(*)::int AS count FROM mcp_request_log',
      );
      expect(new Date(String(afterPage[0]?.last_retrieved_at)).toISOString())
        .toBe(new Date(String(beforePage[0]?.last_retrieved_at)).toISOString());
      expect(Number(afterLog[0]?.count)).toBe(Number(beforeLog[0]?.count));
    }
  });

  test('never returns a page/chunk mixture across a concurrent writer transaction', async () => {
    for (const engine of engines()) {
      await seedPage(engine, SOURCE_A, 'version-0', 'hash-0', 'chunk-0', 'peek-model-0', 0);

      for (let version = 1; version <= 8; version += 1) {
        let markPageUpdated: (() => void) | undefined;
        let releaseWriter: (() => void) | undefined;
        const pageUpdated = new Promise<void>((resolve) => { markPageUpdated = resolve; });
        const writerReleased = new Promise<void>((resolve) => { releaseWriter = resolve; });

        const writer = engine.transaction(async (tx) => {
          await tx.executeRaw(
            `UPDATE pages
             SET compiled_truth = $1, content_hash = $2
             WHERE source_id = $3 AND slug = $4`,
            [`version-${version}`, `hash-${version}`, SOURCE_A, SLUG],
          );
          markPageUpdated?.();
          await writerReleased;
          await tx.executeRaw(
            `UPDATE content_chunks
             SET model = $1, token_count = $2
             WHERE page_id = (
               SELECT id FROM pages WHERE source_id = $3 AND slug = $4
             )`,
            [`peek-model-${version}`, version, SOURCE_A, SLUG],
          );
        });

        await pageUpdated;
        const concurrentRead = engine.peekPage(SOURCE_A, SLUG);
        await Promise.resolve();
        releaseWriter?.();

        const [duringWrite] = await Promise.all([concurrentRead, writer]);
        expect(duringWrite).not.toBeNull();
        assertCoherentVersion(duringWrite!, [version - 1, version]);

        const afterCommit = await engine.peekPage(SOURCE_A, SLUG);
        expect(afterCommit).not.toBeNull();
        assertCoherentVersion(afterCommit!, [version]);
      }
    }
  });
});

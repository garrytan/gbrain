/**
 * Segmented version retention prunes by generation range and counts distinct texts (Wave C 1E, C4e; spec §5
 * "Versions prune").
 *
 * 1. Protects: page-state/versions.ts pruneSegmentedVersions reads each closed manifest row of the page once,
 *    merged with the kept versions' generations (page_body_manifest_closed), so its work grows with the closed rows
 *    plus the versions, never with their product; and its pinned bytes count each text (source_id, sha256) once,
 *    leaving out texts the live generation holds, so a row that moved (closed and reopened with the same text)
 *    pins no bytes and a text closed in several generations counts once. The retention policy is unchanged:
 *    the newest `versions.segmented_max_per_page`, oldest-first while pinned bytes exceed
 *    max(`versions.segmented_max_pinned_bytes`, body_bytes), a newest-first prefix (segmented-versions.test.ts).
 * 2. Fails when: the prune joins every closed row to every kept version (O(closed rows x versions)), or sums a moved
 *    row's bytes although its text is live or counted already.
 * 3. Work is EXPLAIN (ANALYZE, FORMAT JSON) of the prune statement inside a savepoint rolled back before it runs:
 *    rows produced plus rows removed by filters, times loops, summed over plan nodes. Counts, never time. Runs on
 *    PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PAGE_BODY_CONFIG_KEYS } from '../../src/core/page-body/limits.ts';
import { pruneSegmentedVersions } from '../../src/core/page-state/versions.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentPage } from '../helpers/segmented-chunks-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const SLUG = 'notes/segmented-prune-example';
const KB = 1024;
const VERSIONS = 50;
const CLOSED_PER_GENERATION = 100;
const LIVE = 100;

interface PlanNode { 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Join Filter'?: number;
  'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] }

function examined(node: PlanNode): number {
  const loops = node['Actual Loops'] ?? 1;
  const own = ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Join Filter'] ?? 0)
    + (node['Rows Removed by Index Recheck'] ?? 0)) * loops;
  return own + (node.Plans ?? []).reduce((n, child) => n + examined(child), 0);
}

/** Whether `prop` is a method of `target`'s class chain (a function value on a prototype, not an own property or a getter). */
function isMethod(target: object, prop: PropertyKey): boolean {
  if (Object.prototype.hasOwnProperty.call(target, prop)) return false;
  for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (descriptor) return typeof descriptor.value === 'function';
  }
  return false;
}

/** `tx` whose executeRaw statements on page_body_manifest are measured first, in a savepoint rolled back before they run. */
function measuredTx(tx: BrainEngine, work: number[]): BrainEngine {
  return new Proxy(tx, { get(target, prop) {
    if (prop === 'executeRaw') return async (sql: string, params?: unknown[], opts?: unknown) => {
      if (/page_body_manifest/.test(sql)) {
        await target.executeRaw('SAVEPOINT prune_probe');
        const [row] = await target.executeRaw<Record<string, unknown>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
        await target.executeRaw('ROLLBACK TO SAVEPOINT prune_probe');
        const raw = Object.values(row!)[0];
        work.push(examined(((typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>)[0]!.Plan));
      }
      return target.executeRaw(sql, params, opts as never);
    };
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' && isMethod(target, prop) ? value.bind(target) : value;
  } });
}

for (const kind of testBackends()) {
  describe(`segmented version prune (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw('DELETE FROM page_segment_texts');
      await engine.executeRaw('DELETE FROM config WHERE key IN ($1, $2)', [PAGE_BODY_CONFIG_KEYS.versionsMaxPerPage, PAGE_BODY_CONFIG_KEYS.versionsMaxPinnedBytes]);
    });

    test('the prune reads each closed row once, not once per kept version', async () => {
      await engine.setConfig(PAGE_BODY_CONFIG_KEYS.versionsMaxPerPage, String(VERSIONS * 2));
      await engine.setConfig(PAGE_BODY_CONFIG_KEYS.versionsMaxPinnedBytes, String(1024 * 1024 * KB));
      // Generations 1..VERSIONS each close CLOSED_PER_GENERATION rows of their own text; LIVE rows stay open throughout.
      const { pageId } = await segmentPage(engine, SLUG, { generation: 1, occurrences: [], bodyBytes: LIVE * KB });
      await engine.executeRaw(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body)
        SELECT 'default', sha256(convert_to('text ' || k, 'UTF8')), $2::int, 1, convert_to('text ' || k, 'UTF8')
          FROM generate_series(1, $1::int) AS k`, [VERSIONS * CLOSED_PER_GENERATION + LIVE, KB]);
      await engine.executeRaw(`INSERT INTO page_body_manifest (page_id, occurrence_id, gen_from, gen_to, seq, region, source_id, sha256,
          byte_start, byte_len, line_start, line_count, cut_kind, entry_state, static_proj_bytes, static_proj_lines, hash_state)
        SELECT $1::int, k, CASE WHEN k <= $2::int THEN 1 ELSE (k - $2::int - 1) / $3::int + 1 END, CASE WHEN k <= $2::int THEN NULL ELSE (k - $2::int - 1) / $3::int + 2 END,
               k, 'truth', 'default', sha256(convert_to('text ' || k, 'UTF8')), k * $4::int, $4::int, 0, 1, 'heading', '{}'::jsonb, $4::int, 1, '\\x00'::bytea
          FROM generate_series(1, $2::int + $5::int) AS k`, [pageId, LIVE, CLOSED_PER_GENERATION, KB, VERSIONS * CLOSED_PER_GENERATION]);
      await engine.createVersion(SLUG);
      await engine.executeRaw(`INSERT INTO page_versions (page_id, body_storage, body_generation, body_bytes, content_hash, frontmatter, knowledge_revision, title, type, tags, is_deleted, source_path)
        SELECT page_id, body_storage, g, body_bytes, content_hash, frontmatter, knowledge_revision, title, type, tags, is_deleted, source_path
          FROM page_versions, generate_series(2, $2::int) AS g WHERE page_id = $1 ORDER BY g`, [pageId, VERSIONS]);
      await engine.executeRaw('UPDATE pages SET body_generation = $2 WHERE id = $1', [pageId, VERSIONS + 1]);

      const work: number[] = [];
      expect(await engine.transaction(tx => pruneSegmentedVersions(measuredTx(tx, work), pageId))).toBe(0);
      expect(work).toHaveLength(1);
      const closed = VERSIONS * CLOSED_PER_GENERATION;
      // O(closed rows + live rows + versions); joining each closed row to each kept version reads at least closed x versions / 2.
      expect(work[0]!).toBeLessThanOrEqual(16 * (closed + LIVE + VERSIONS));
    }, 120_000);

    test('pinned bytes count each text once and leave out texts the live generation holds (moved rows)', async () => {
      await engine.setConfig(PAGE_BODY_CONFIG_KEYS.versionsMaxPinnedBytes, String(10 * KB));
      // Occurrence 1 moves at generations 2 and 3 and stays live with the same text; occurrence 2 moves at
      // generation 2 and is closed at 3: its one text pins 8 KiB however many of its rows a version references.
      const { pageId } = await segmentPage(engine, SLUG, {
        generation: 1,
        bodyBytes: KB,
        occurrences: [
          { id: 1, byteStart: 0, genFrom: 1, genTo: 2, byteLen: 8 * KB, chunks: [{ text: 'moving opening' }] },
          { id: 1, byteStart: 100, genFrom: 2, genTo: 3, byteLen: 8 * KB, chunks: [{ text: 'moving opening' }] },
          { id: 1, byteStart: 200, genFrom: 3, byteLen: 8 * KB, chunks: [{ text: 'moving opening' }] },
          { id: 2, byteStart: 8 * KB, genFrom: 1, genTo: 2, byteLen: 8 * KB, chunks: [{ text: 'moving tail' }] },
          { id: 2, byteStart: 9 * KB, genFrom: 2, genTo: 3, byteLen: 8 * KB, chunks: [{ text: 'moving tail' }] },
        ],
      });
      const atGeneration = (generation: number) => engine.executeRaw('UPDATE pages SET body_generation = $2 WHERE id = $1', [pageId, generation]);
      await atGeneration(1); await engine.createVersion(SLUG);
      await atGeneration(2); await engine.createVersion(SLUG);
      // 8 KiB (occurrence 2's text) pinned <= 10 KiB: both versions stay. Summing rows counts 32 KiB and prunes both.
      const kept = await engine.executeRaw<{ body_generation: number }>(
        `SELECT body_generation FROM page_versions WHERE page_id = $1 AND body_storage = 'segmented' ORDER BY id`, [pageId]);
      expect(kept.map(r => Number(r.body_generation))).toEqual([1, 2]);
      // A distinct closed text still counts: another 8 KiB tail closed at generation 3 makes generation 2 pin 16 KiB
      // (both tails, each once), over the cap, so generations 2 and 1 go; generation 3 pins nothing beyond the live body.
      await engine.executeRaw(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body)
        VALUES ('default', sha256(convert_to('other tail', 'UTF8')), 10, 1, convert_to('other tail', 'UTF8'))`);
      await engine.executeRaw(`INSERT INTO page_body_manifest (page_id, occurrence_id, gen_from, gen_to, seq, region, source_id, sha256,
          byte_start, byte_len, line_start, line_count, cut_kind, entry_state, static_proj_bytes, static_proj_lines, hash_state)
        VALUES ($1, 3, 2, 3, 9, 'truth', 'default', sha256(convert_to('other tail', 'UTF8')), $2::int, $2::int, 0, 1, 'heading', '{}'::jsonb, $2::int, 1, '\\x00'::bytea)`, [pageId, 8 * KB]);
      await atGeneration(3); await engine.createVersion(SLUG);
      const after = await engine.executeRaw<{ body_generation: number }>(
        `SELECT body_generation FROM page_versions WHERE page_id = $1 AND body_storage = 'segmented' ORDER BY id`, [pageId]);
      expect(after.map(r => Number(r.body_generation))).toEqual([3]);
    });
  });
}

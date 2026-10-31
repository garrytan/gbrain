/**
 * Per-segment derivation rows (engine-sql/page-body.ts readSegmentDerivations / upsertSegmentDerivations /
 * retireSegmentDerivations, migration v265) and the facts.source_window column, shared by the PGLite arm
 * (test/engine-sql-segment-derivations.test.ts) and the Postgres arm (test/e2e/segment-derivations-postgres.test.ts).
 * The JSONB checks matter on Postgres, where a stringified `::jsonb` bind would store a string scalar.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { ROW_BATCH_MAX_ROWS } from '../../src/core/batch-rows.ts';
import { parseSourceWindow, sourceWindowFor, type SegmentDerivationInput, type SegmentDerivationKind,
  type SegmentDerivationState } from '../../src/core/page-body/derivations.ts';
import { hexOf, sha256 } from './page-body-fixtures.ts';

async function freshPage(engine: BrainEngine): Promise<number> {
  const slug = `notes/derivations-${randomUUID().slice(0, 8)}`;
  await engine.putPage(slug, { type: 'note', title: 'Derivation probe', compiled_truth: 'body' });
  const rows = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'", [slug]);
  return Number(rows[0]!.id);
}

function row(pageId: number, kind: SegmentDerivationKind, occurrenceId: number, overrides: Partial<SegmentDerivationInput> = {}): SegmentDerivationInput {
  return { pageId, kind, occurrenceId, version: 1, segmentSha256: sha256(`segment ${occurrenceId}`), contextHash: sha256(`context ${kind} ${occurrenceId}`),
    state: 'done' as SegmentDerivationState, output: { links: [{ to: 'people/alice-example', at: occurrenceId }] }, receipt: null, ...overrides };
}

export function defineSegmentDerivationCases(opts: { getEngine: () => BrainEngine }): void {
  test('rows round-trip bytes, JSONB objects and timestamps, ordered by kind then occurrence', async () => {
    const engine = opts.getEngine();
    const pageId = await freshPage(engine);
    const output = { candidates: [{ slug: 'people/alice-example', context: 'met ☃ "quoted"' }], nested: { b: 2, a: [1, null] } };
    await engine.upsertSegmentDerivations([
      row(pageId, 'timeline', 20, { state: 'skipped', output: null, receipt: { reason: 'no_entries' } }),
      row(pageId, 'links', 20, { output, version: 3 }),
      row(pageId, 'links', 10, { state: 'failed', output: null, receipt: { error: 'timeout' } }),
    ]);
    const rows = await engine.readSegmentDerivations(pageId);
    expect(rows.map(r => [r.kind, r.occurrenceId, r.state, r.version])).toEqual([['links', 10, 'failed', 1], ['links', 20, 'done', 3], ['timeline', 20, 'skipped', 1]]);
    const links20 = rows[1]!;
    expect(links20.pageId).toBe(pageId);
    expect(hexOf(links20.segmentSha256)).toBe(hexOf(sha256('segment 20')));
    expect(hexOf(links20.contextHash)).toBe(hexOf(sha256('context links 20')));
    expect(links20.output).toEqual(output);
    expect(links20.receipt).toBeNull();
    expect(rows[2]!.receipt).toEqual({ reason: 'no_entries' });
    expect(links20.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const kinds = await engine.executeRaw<{ o: string; r: string }>(
      'SELECT jsonb_typeof(output) AS o, jsonb_typeof(receipt) AS r FROM page_segment_derivations WHERE page_id = $1 AND pipeline = $2 AND occurrence_id = 10',
      [pageId, 'links']);
    expect(kinds).toEqual([{ o: null as unknown as string, r: 'object' }]);
    const stored = await engine.executeRaw<{ t: string }>(
      "SELECT jsonb_typeof(output) AS t FROM page_segment_derivations WHERE page_id = $1 AND pipeline = 'links' AND occurrence_id = 20", [pageId]);
    expect(stored).toEqual([{ t: 'object' }]);
  });

  test('an upsert replaces the row under the same key, keeps created_at and moves updated_at', async () => {
    const engine = opts.getEngine();
    const pageId = await freshPage(engine);
    await engine.upsertSegmentDerivations([row(pageId, 'mentions', 7, { state: 'partial' })]);
    await engine.executeRaw("UPDATE page_segment_derivations SET created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' WHERE page_id = $1", [pageId]);
    const [before] = await engine.readSegmentDerivations(pageId);
    await engine.upsertSegmentDerivations([row(pageId, 'mentions', 7, { state: 'done', version: 2, segmentSha256: sha256('new text'), output: { found: ['acme-example'] } })]);
    const after = await engine.readSegmentDerivations(pageId);
    expect(after.length).toBe(1);
    expect(after[0]!.state).toBe('done');
    expect(after[0]!.version).toBe(2);
    expect(hexOf(after[0]!.segmentSha256)).toBe(hexOf(sha256('new text')));
    expect(after[0]!.output).toEqual({ found: ['acme-example'] });
    expect(after[0]!.createdAt).toBe(before!.createdAt);
    expect(after[0]!.updatedAt > before!.updatedAt).toBe(true);
  });

  test('reads filter by kind and occurrence; an empty occurrence list reads nothing', async () => {
    const engine = opts.getEngine();
    const pageId = await freshPage(engine);
    await engine.upsertSegmentDerivations([row(pageId, 'links', 1), row(pageId, 'links', 2), row(pageId, 'synopsis', 1)]);
    expect((await engine.readSegmentDerivations(pageId, { kind: 'links' })).map(r => r.occurrenceId)).toEqual([1, 2]);
    expect((await engine.readSegmentDerivations(pageId, { occurrenceIds: [1] })).map(r => r.kind)).toEqual(['links', 'synopsis']);
    expect((await engine.readSegmentDerivations(pageId, { kind: 'synopsis', occurrenceIds: [2] }))).toEqual([]);
    expect(await engine.readSegmentDerivations(pageId, { occurrenceIds: [] })).toEqual([]);
    expect(await engine.readSegmentDerivations(pageId + 100_000)).toEqual([]);
  });

  test('retire deletes only rows of occurrences outside the live set, per kind or for every kind', async () => {
    const engine = opts.getEngine();
    const pageId = await freshPage(engine);
    const other = await freshPage(engine);
    await engine.upsertSegmentDerivations([row(pageId, 'links', 1), row(pageId, 'links', 2), row(pageId, 'links', 3),
      row(pageId, 'timeline', 2), row(pageId, 'timeline', 4), row(other, 'links', 2)]);
    expect(await engine.retireSegmentDerivations(pageId, [1, 3], { kind: 'links' })).toBe(1);
    expect((await engine.readSegmentDerivations(pageId)).map(r => `${r.kind}:${r.occurrenceId}`)).toEqual(['links:1', 'links:3', 'timeline:2', 'timeline:4']);
    expect(await engine.retireSegmentDerivations(pageId, [1])).toBe(3);
    expect((await engine.readSegmentDerivations(pageId)).map(r => `${r.kind}:${r.occurrenceId}`)).toEqual(['links:1']);
    expect(await engine.retireSegmentDerivations(pageId, [])).toBe(1);
    expect((await engine.readSegmentDerivations(other)).length).toBe(1);
  });

  test('more rows than one statement batch all land', async () => {
    const engine = opts.getEngine();
    const pageId = await freshPage(engine);
    const count = ROW_BATCH_MAX_ROWS * 2 + 7;
    await engine.upsertSegmentDerivations(Array.from({ length: count }, (_, i) => row(pageId, 'fences', i + 1)));
    expect((await engine.readSegmentDerivations(pageId, { kind: 'fences' })).length).toBe(count);
  });

  test('the table refuses an unknown pipeline, a short hash and an unknown state, and goes with its page', async () => {
    const engine = opts.getEngine();
    const pageId = await freshPage(engine);
    await expect(engine.upsertSegmentDerivations([row(pageId, 'nope' as SegmentDerivationKind, 1)])).rejects.toThrow();
    await expect(engine.upsertSegmentDerivations([row(pageId, 'links', 1, { segmentSha256: new Uint8Array(31) })])).rejects.toThrow();
    await expect(engine.upsertSegmentDerivations([row(pageId, 'links', 1, { state: 'pending' as SegmentDerivationState })])).rejects.toThrow();
    await engine.upsertSegmentDerivations([row(pageId, 'links', 1)]);
    await engine.executeRaw('DELETE FROM pages WHERE id = $1', [pageId]);
    const left = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_segment_derivations WHERE page_id = $1', [pageId]);
    expect(Number(left[0]!.n)).toBe(0);
  });

  test('facts.source_window stores a window anchor as a JSONB object and refuses a malformed one', async () => {
    const engine = opts.getEngine();
    const window = sourceWindowFor(42, 3, 'user: hello\nassistant: hi\n');
    const slug = `conversations/window-${randomUUID().slice(0, 8)}`;
    const inserted = await engine.executeRaw<{ id: number }>(
      "INSERT INTO facts (fact, source, source_markdown_slug, source_window) VALUES ('likes tea', 'test:window', $1, $2::text::jsonb) RETURNING id",
      [slug, JSON.stringify(window)]);
    const read = await engine.executeRaw<{ w: unknown; t: string }>('SELECT source_window AS w, jsonb_typeof(source_window) AS t FROM facts WHERE id = $1', [inserted[0]!.id]);
    expect(read[0]!.t).toBe('object');
    const value = typeof read[0]!.w === 'string' ? JSON.parse(read[0]!.w as string) : read[0]!.w;
    expect(parseSourceWindow(value)).toEqual(window);
    const nulls = await engine.executeRaw<{ n: number }>("INSERT INTO facts (fact, source) VALUES ('no window', 'test:window') RETURNING (source_window IS NULL)::int AS n");
    expect(Number(nulls[0]!.n)).toBe(1);
    await expect(engine.executeRaw("INSERT INTO facts (fact, source, source_window) VALUES ('bad', 'test:window', $1::text::jsonb)",
      [JSON.stringify(JSON.stringify(window))])).rejects.toThrow();
    await expect(engine.executeRaw("INSERT INTO facts (fact, source, source_window) VALUES ('bad', 'test:window', $1::text::jsonb)",
      [JSON.stringify({ occurrence_id: '42', window_ordinal: 3, window_text_sha: window.window_text_sha })])).rejects.toThrow();
  });
}

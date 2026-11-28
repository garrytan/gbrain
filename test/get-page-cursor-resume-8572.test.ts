/** #8572: a same-page stale cursor still wins beside lower-priority selectors. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { decodeCursor } from '../src/core/page-window/window.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { asOwner } from './helpers/owner-tier.ts';

const getPage = operations.find(op => op.name === 'get_page')!;
const body = Array.from({ length: 800 }, (_, i) => `Line ${i}: café 🌱 roadmap notes and supporting evidence.`).join('\n');
for (const backend of testBackends()) describe(`stale cursor continuation (${backend})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const get = (params: Record<string, unknown>) => getPage.handler({ engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} },
    remote: true, transport: 'stdio', dryRun: false, sourceId: 'default' } as OperationContext, params) as Promise<Record<string, any>>;
  const put = (slug: string, text: string) => asOwner(engine, tx => importFromContent(tx, slug,
    `---\ntitle: Cursor fixture\ntype: note\n---\n${text}\n`, { noEmbed: true, sourceId: 'default', forceRechunk: true }));
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await engine.setConfig('pages.segmented_storage', 'off');
  }, 120_000);
  afterAll(async () => { await close?.(); }, 60_000);

  test('resumes the saved position and budget after an edit, not the fallback range', async () => {
    for (const view of ['read', 'markdown']) {
      const slug = `notes/cursor-${view}`;
      expect((await put(slug, body)).status).toBe('imported');
      const first = await get({ slug, view, body: 'window', max_bytes: 1200 });
      const cursor = decodeCursor(first.next_cursor)!;
      expect(cursor.offset).toBeGreaterThan(0);
      expect((await put(slug, body + '\nA later edit.')).status).toBe('imported');
      const expected = await get({ slug, view, bytes: { offset: cursor.offset, length: cursor.max_bytes } });
      for (const lower of [{ lines: { from: 1, count: 1 } }, { bytes: { offset: 0, length: 20 } },
        { around_chunk_id: 999999, lines: { from: 1, count: 1 }, bytes: { offset: 0, length: 20 } }]) {
        const resumed = await get({ slug, view, cursor: first.next_cursor, ...lower, include_content: true });
        expect(resumed.window).toEqual(expected.window);
        expect(resumed.window_selector.applied).toBe('cursor');
        expect(resumed.window_selector.note).toContain('current revision');
        expect(resumed.window_selector.note).toContain('not the page\'s content');
        expect(resumed.content).toBeUndefined();
        expect(resumed.compiled_truth).toBeUndefined();
        const next = decodeCursor(resumed.next_cursor)!;
        expect(next.revision).toBe(resumed.revision);
        expect(next.max_bytes).toBe(cursor.max_bytes);
        const continued = await get({ slug, view, cursor: resumed.next_cursor });
        expect(continued.window.byte_start).toBe(resumed.window.byte_end);
      }
      await expect(get({ slug, view, cursor: first.next_cursor })).rejects.toMatchObject({ canonical: 'revision_changed' });
    }
  }, 120_000);

  test('clamps a resumed cursor to the new end after shrink, without restarting at fallback lines', async () => {
    const slug = 'notes/cursor-shrink';
    await put(slug, body);
    const first = await get({ slug, body: 'window', max_bytes: 1200 });
    await put(slug, 'Short replacement.');
    const resumed = await get({ slug, cursor: first.next_cursor, lines: { from: 1, count: 1 } });
    expect(resumed.window.byte_start).toBe(resumed.size.total_bytes);
    expect(resumed.window.byte_end).toBe(resumed.size.total_bytes);
    expect(resumed.window.text).toBe('');
    expect(resumed.next_cursor).toBeUndefined();
    expect(resumed.window_selector.applied).toBe('cursor');
  }, 60_000);
});

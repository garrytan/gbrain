/**
 * Wave B PR 2 (spec 7.2): get_page over a segmented page answers what it
 * answers over the same page stored inline.
 *
 * 1. Protects: for a page that fits both ways (a 2 MB body, several segments), the
 *    body: 'none', outline (every page), window (no selector, lines, bytes,
 *    a cursor walk to the end) and view: 'markdown' (paged to its end)
 *    responses of a segmented copy equal the inline copy's, for a local and a
 *    remote caller, apart from the segmented-only fields (body_storage,
 *    size.body_bytes / body_lines / tail_*), the chunk count (the segmented
 *    chunker cuts per segment, spec 4.1), the revision and the cursor's page
 *    id and revision. Coordinates are projected bytes on both.
 * 2. Fails when: a segmented window, line number, outline entry (line range,
 *    byte range, dates, the leading entry) or markdown byte differs from the
 *    whole-document cut, or a cursor walk skips or repeats bytes.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { decodeCursor } from '../../src/core/page-window/window.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const getPage = operations.find(o => o.name === 'get_page')!;
const SLUG = 'notes/parity-example';
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Headings every ~30 KB, dates, fenced code holding a heading, multi-byte text, one line longer than a window, and a timeline. */
function content(): string {
  const truth: string[] = ['Preamble about acme-example before any heading.', ''];
  for (let s = 0; s < 100; s++) {
    truth.push(`## Section ${s} — 2024-${String(1 + (s % 12)).padStart(2, '0')}-1${s % 10} café`, '');
    if (s % 7 === 3) truth.push('```md', '# not a heading inside a fence', '```', '');
    if (s === 40) truth.push(`long line ${'λ'.repeat(30_000)} end`, '');
    for (let p = 0; p < 300; p++) truth.push(`- ${s}.${p} alice-example noted the widget plan on 2023-0${1 + (p % 9)}-0${1 + (p % 9)} ✓`);
    truth.push('');
  }
  const timeline = Array.from({ length: 400 }, (_, i) => `- **2025-0${1 + (i % 9)}-1${i % 10}** | entry ${i} about acme-example`).join('\n');
  return `---\ntitle: Parity example\ntype: note\ntags: [log]\n---\n${truth.join('\n')}\n\n<!-- timeline -->\n\n${timeline}\n`;
}

/** The response without what only a segmented page reports, its revision, and the cursor's page id and revision. */
function comparable(r: Record<string, any>): Record<string, any> {
  const out = JSON.parse(JSON.stringify(r)) as Record<string, any>;
  delete out.revision;
  delete out.body_storage;
  delete out.chunks;
  if (out.edit_target) delete out.edit_target.revision;
  if (out.size) for (const k of ['body_bytes', 'body_lines', 'tail_sha256', 'tail_region']) delete out.size[k];
  if (out.next_cursor) {
    const c = decodeCursor(out.next_cursor)!;
    out.next_cursor = { view: c.view, offset: c.offset, max_bytes: c.max_bytes };
    out.next.arguments.cursor = out.next_cursor;
  }
  return out;
}

for (const kind of testBackends()) {
  describe(`get_page parity, segmented vs inline (${kind})`, () => {
    const engines: Record<'inline' | 'segmented', BrainEngine> = {} as never;
    const closers: Array<() => Promise<void>> = [];

    beforeAll(async () => {
      for (const storage of ['inline', 'segmented'] as const) {
        let engine: BrainEngine;
        if (kind === 'postgres') {
          const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
          engine = pg.engine;
          closers.push(pg.close);
        } else {
          engine = new PGLiteEngine();
          await engine.connect({});
          await engine.initSchema();
          closers.push(() => engine.disconnect());
        }
        await engine.setConfig('pages.segmented_storage', storage === 'segmented' ? 'on' : 'off');
        await importFromContent(engine, SLUG, content(), { sourceId: 'default', noEmbed: true });
        const [row] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [SLUG]);
        expect(row?.body_storage).toBe(storage);
        engines[storage] = engine;
      }
      const [rows] = await engines.segmented.executeRaw<{ n: unknown }>('SELECT count(*) AS n FROM page_body_manifest');
      expect(Number(rows!.n)).toBeGreaterThanOrEqual(3);
    }, 300_000);

    afterAll(async () => { for (const close of closers) await close(); });

    const ctx = (engine: BrainEngine, remote: boolean): OperationContext => ({ engine, config: {} as GBrainConfig, logger: noopLogger, dryRun: false, remote,
      sourceId: 'default', ...(remote ? { transport: 'http', auth: { token: 'fixture', clientId: 'parity-client', principal: { kind: 'oauth_client', id: 'parity-client' },
        scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } : {}) } as unknown as OperationContext);
    const both = async (remote: boolean, params: Record<string, unknown>) => {
      const [inline, segmented] = await Promise.all((['inline', 'segmented'] as const).map(async s =>
        await getPage.handler(ctx(engines[s], remote), { slug: SLUG, ...params }) as Record<string, any>));
      return { inline: inline!, segmented: segmented! };
    };
    const expectSame = async (remote: boolean, params: Record<string, unknown>) => {
      const { inline, segmented } = await both(remote, params);
      expect(segmented.body_storage).toBe('segmented');
      expect(comparable(segmented)).toEqual(comparable(inline));
      return { inline, segmented };
    };

    for (const remote of [false, true]) {
      const who = remote ? 'remote' : 'local';

      test(`${who}: body none, auto and every outline page agree`, async () => {
        const none = await expectSame(remote, { body: 'none' });
        // The stored size is a trusted read's only: a remote caller sees projected totals, as for an inline page.
        if (remote) expect(none.segmented.size.body_bytes).toBeUndefined();
        else expect(none.segmented.size.body_bytes).toBeGreaterThan(1_900_000);
        if (remote) await expectSame(remote, {});
        let from = 0;
        let pages = 0;
        for (;;) {
          const { inline } = await expectSame(remote, { body: 'outline', outline_from: from });
          pages++;
          if (inline.outline.next_from_index === undefined) break;
          from = inline.outline.next_from_index;
        }
        expect(pages).toBeGreaterThanOrEqual(1);
      }, 120_000);

      test(`${who}: windows by lines, bytes and a cursor walk to the end agree`, async () => {
        await expectSame(remote, { body: 'window' });
        for (const lines of [{ from: 1, count: 50 }, { from: 9_000, count: 400 }, { from: 12_041, count: 3 }, { from: 24_300, count: 2_000 }, { from: 99_999, count: 5 }]) {
          await expectSame(remote, { body: 'window', lines });
        }
        for (const bytes of [{ offset: 0, length: 4_000 }, { offset: 1_048_570, length: 40_000 }, { offset: 1_300_001, length: 9_000 }, { offset: 1_999_999, length: 70_000 }]) {
          await expectSame(remote, { body: 'window', bytes });
        }
        let { inline, segmented } = await expectSame(remote, { body: 'window', max_bytes: 300_000 });
        let windows = 1;
        while (inline.next_cursor) {
          const [i, s] = await Promise.all([
            getPage.handler(ctx(engines.inline, remote), { slug: SLUG, cursor: inline.next_cursor }),
            getPage.handler(ctx(engines.segmented, remote), { slug: SLUG, cursor: segmented.next_cursor }),
          ]) as Array<Record<string, any>>;
          inline = i!;
          segmented = s!;
          expect(comparable(segmented)).toEqual(comparable(inline));
          windows++;
        }
        expect(windows).toBeGreaterThan(5);
      }, 180_000);

      test(`${who}: view markdown paged to its end agrees, sha256 included`, async () => {
        let { inline, segmented } = await expectSame(remote, { body: 'window', view: 'markdown', max_bytes: 400_000 });
        expect(segmented.size.sha256).toMatch(/^[0-9a-f]{64}$/);
        while (inline.next_cursor) {
          const [i, s] = await Promise.all([
            getPage.handler(ctx(engines.inline, remote), { slug: SLUG, view: 'markdown', cursor: inline.next_cursor }),
            getPage.handler(ctx(engines.segmented, remote), { slug: SLUG, view: 'markdown', cursor: segmented.next_cursor }),
          ]) as Array<Record<string, any>>;
          inline = i!;
          segmented = s!;
          expect(comparable(segmented)).toEqual(comparable(inline));
        }
      }, 180_000);
    }
  });
}

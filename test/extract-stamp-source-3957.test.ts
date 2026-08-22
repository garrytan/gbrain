/**
 * #3957 — extraction stamping + source threading + FS/DB timeline shape parity.
 *
 * Pins the cluster of silent no-ops around the links_extracted_at watermark
 * and timeline row shapes:
 *  1. parseTimelineEntries (DB path) splits `Source — Summary` on
 *     pipe-separated bullets exactly like extractTimelineFromContent (FS
 *     path), so the same bullet extracted through both paths dedups under
 *     the (page_id, date, summary, source) index instead of duplicating.
 *  2. markPagesExtractedBatch returns the stamped-row count (both engines —
 *     PGLite pinned here, Postgres via the DATABASE_URL-gated parity suite),
 *     and stampExtracted logs the shortfall to stderr instead of silently
 *     claiming success on a wrong-source stamp.
 *  3. runExtractCore's full FS walk (mode 'all') stamps walked pages, so a
 *     full extract no longer leaves the whole brain permanently "stale".
 *  4. addTimelineEntriesBatch's pages JOIN excludes soft-deleted pages.
 *  5. put_page auto-timeline threads ctx.sourceId (+ the parsed source
 *     label), so timeline rows land on the page the write targeted instead
 *     of defaulting to 'default'.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { parseTimelineEntries, LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { extractTimelineFromContent } from '../src/core/timeline-extract.ts';
import { runExtractCore, extractStaleFromDB, stampExtracted } from '../src/commands/extract.ts';
import { operations, type Operation, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;
let tempDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  tempDir = mkdtempSync(join(tmpdir(), 'gbrain-3957-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const CANON_BULLET = '- **2026-01-05** | meeting — Discussed the wiki';

describe('#3957 parseTimelineEntries — FS/DB source split parity', () => {
  test('pipe-separated bullet splits Source — Summary like the FS extractor', () => {
    const db = parseTimelineEntries(CANON_BULLET);
    const fs = extractTimelineFromContent(CANON_BULLET, 'people/alice');
    expect(db).toHaveLength(1);
    expect(fs).toHaveLength(1);
    expect(db[0].source).toBe('meeting');
    expect(db[0].summary).toBe('Discussed the wiki');
    // The load-bearing parity: identical (source, summary) dedup shape.
    expect({ source: db[0].source, summary: db[0].summary })
      .toEqual({ source: fs[0].source, summary: fs[0].summary });
  });

  test('dash-separated bullet is one summary — never shattered on interior dashes', () => {
    const db = parseTimelineEntries('- **2026-01-05** - moved to Berlin - permanently');
    expect(db).toHaveLength(1);
    expect(db[0].source).toBe('markdown');
    expect(db[0].summary).toBe('moved to Berlin - permanently');
  });

  test('pipe bullet without a Source delimiter keeps the FS fallback source', () => {
    const db = parseTimelineEntries('- **2026-01-05** | plain summary with no delimiter');
    const fs = extractTimelineFromContent('- **2026-01-05** | plain summary with no delimiter', 'x');
    expect(db[0].source).toBe('markdown');
    expect(db[0].source).toBe(fs[0].source);
    expect(db[0].summary).toBe(fs[0].summary);
  });

  test('delimiter inside a markdown link never splits (shared link-aware finder)', () => {
    const line = '- **2026-01-05** | [Deals — Q1 Review](deals/q1.md) recap';
    const db = parseTimelineEntries(line);
    const fs = extractTimelineFromContent(line, 'x');
    expect(db[0].summary).toBe(fs[0].summary);
    expect(db[0].source).toBe(fs[0].source);
  });

  test('Chinese pipe-separated bullet splits too', () => {
    const db = parseTimelineEntries('- 2020年1月2日 | 董事会 — 决定融资');
    expect(db).toHaveLength(1);
    expect(db[0].date).toBe('2020-01-02');
    expect(db[0].source).toBe('董事会');
    expect(db[0].summary).toBe('决定融资');
  });
});

describe('#3957 markPagesExtractedBatch count + stampExtracted shortfall', () => {
  test('returns the stamped-row count; wrong-source refs are a visible shortfall', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('wiki', 'wiki') ON CONFLICT (id) DO NOTHING`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('people/alice', 'wiki', 'person', 'Alice', 'x', '')`,
    );
    const now = new Date().toISOString();
    // Right source stamps 1; wrong source ('default') matches nothing.
    expect(await engine.markPagesExtractedBatch(
      [{ slug: 'people/alice', source_id: 'wiki' }], now,
    )).toBe(1);
    expect(await engine.markPagesExtractedBatch(
      [{ slug: 'people/alice', source_id: 'default' }], now,
    )).toBe(0);
    expect(await engine.markPagesExtractedBatch([], now)).toBe(0);
  });

  test('stampExtracted logs the shortfall to stderr (never throws)', async () => {
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await stampExtracted(engine, [
        { slug: 'ghost/none', source_id: 'default' },
      ]);
    } finally {
      process.stderr.write = origWrite;
    }
    const joined = writes.join('');
    expect(joined).toContain('stamped 0/1');
    expect(joined).toContain('extract --stale');
  });
});

describe('#3957 full FS walk stamps the watermark (mode all)', () => {
  test('runExtractCore full walk leaves walked pages fresh, not stale', async () => {
    mkdirSync(join(tempDir, 'people'), { recursive: true });
    writeFileSync(join(tempDir, 'people', 'alice.md'), `# Alice\n\n${CANON_BULLET}\n`);
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('people/alice', 'default', 'person', 'Alice', 'x', '')`,
    );
    const before = await engine.countStalePagesForExtraction({});
    expect(before).toBe(1);

    await runExtractCore(engine, { mode: 'all', dir: tempDir });

    const after = await engine.countStalePagesForExtraction({});
    expect(after).toBe(0);
  });

  test('full walk stamps the row\'s READ updated_at (clamped to versionTs), never now() (D4)', async () => {
    mkdirSync(join(tempDir, 'people'), { recursive: true });
    writeFileSync(join(tempDir, 'people', 'alice.md'), `# Alice\n\n${CANON_BULLET}\n`);
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('people/alice', 'default', 'person', 'Alice', 'x', '')`,
    );

    await runExtractCore(engine, { mode: 'all', dir: tempDir });

    // Pre-fix the stamp was now() — a FUTURE watermark strictly greater than
    // updated_at, which masks a concurrent edit landing between the content
    // read and the stamp. The D4-correct stamp equals the pre-read
    // GREATEST(updated_at, versionTs).
    const rows = await engine.executeRaw<{ ok: boolean }>(
      `SELECT links_extracted_at = GREATEST(updated_at, $1::timestamptz) AS ok
       FROM pages WHERE slug = 'people/alice' AND source_id = 'default'`,
      [LINK_EXTRACTOR_VERSION_TS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
  });

  test('incremental (slugs) walk stamps the pre-read updated_at too (D4)', async () => {
    mkdirSync(join(tempDir, 'people'), { recursive: true });
    writeFileSync(join(tempDir, 'people', 'alice.md'), '# Alice\n');
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('people/alice', 'default', 'person', 'Alice', 'x', '')`,
    );

    await runExtractCore(engine, { mode: 'all', dir: tempDir, slugs: ['people/alice'] });

    const rows = await engine.executeRaw<{ ok: boolean }>(
      `SELECT links_extracted_at = GREATEST(updated_at, $1::timestamptz) AS ok
       FROM pages WHERE slug = 'people/alice' AND source_id = 'default'`,
      [LINK_EXTRACTOR_VERSION_TS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
  });

  test('links- or timeline-only walks do NOT stamp (C3/D6 rule)', async () => {
    mkdirSync(join(tempDir, 'people'), { recursive: true });
    writeFileSync(join(tempDir, 'people', 'alice.md'), '# Alice\n');
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('people/alice', 'default', 'person', 'Alice', 'x', '')`,
    );
    await runExtractCore(engine, { mode: 'links', dir: tempDir });
    expect(await engine.countStalePagesForExtraction({})).toBe(1);
    await runExtractCore(engine, { mode: 'timeline', dir: tempDir });
    expect(await engine.countStalePagesForExtraction({})).toBe(1);
  });
});

describe('#3957 timeline batch JOIN excludes soft-deleted pages', () => {
  test('addTimelineEntriesBatch inserts 0 rows for a soft-deleted page', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, deleted_at)
       VALUES ('people/gone', 'default', 'person', 'Gone', 'x', '', now())`,
    );
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'people/gone', date: '2026-01-05', source: 'meeting', summary: 'ghost entry', detail: '', source_id: 'default' },
    ]);
    expect(inserted).toBe(0);
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM timeline_entries`,
    );
    expect(Number(rows[0]?.n ?? -1)).toBe(0);
  });
});

describe('#3957 stale-dedup: FS-extracted bullet does not duplicate under --stale', () => {
  test('extract --stale re-extraction of an FS-shaped row is a no-op', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('people/alice', 'default', 'person', 'Alice', $1, '')`,
      [`# Alice\n\n${CANON_BULLET}\n`],
    );
    // FS-path shape lands first (what sync's inline extractTimelineForSlugs
    // writes): split source + trimmed summary.
    const fsEntries = extractTimelineFromContent(CANON_BULLET, 'people/alice');
    const insertedFs = await engine.addTimelineEntriesBatch(
      fsEntries.map(e => ({ slug: e.slug, date: e.date, source: e.source, summary: e.summary, detail: e.detail ?? '', source_id: 'default' })),
    );
    expect(insertedFs).toBe(1);

    // The DB stale sweep re-extracts the same page. Pre-fix it wrote
    // source='' + summary 'meeting — Discussed the wiki' → a duplicate row.
    const r = await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, includeFrontmatter: false, catchUp: false,
    });
    expect(r.pagesProcessed).toBe(1);

    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM timeline_entries`,
    );
    expect(Number(rows[0]?.n ?? -1)).toBe(1);
  });
});

describe('#3957 put_page auto-timeline threads ctx.sourceId', () => {
  test('timeline rows attach to the source the write targeted', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('wiki', 'wiki') ON CONFLICT (id) DO NOTHING`,
    );
    // Decoy same-slug page in 'default': pre-fix the batch omitted source_id,
    // so rows landed here (or nowhere) instead of on the wiki page.
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('people/bob', 'default', 'person', 'Bob (decoy)', 'x', '')`,
    );
    const put_page = operations.find(o => o.name === 'put_page') as Operation;
    const ctx = {
      engine: engine as unknown as BrainEngine,
      config: { engine: 'pglite' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      remote: false,
      sourceId: 'wiki',
    } as unknown as OperationContext;
    const result = await put_page.handler(ctx, {
      slug: 'people/bob',
      content: `# Bob\n\n${CANON_BULLET}\n`,
      type: 'person',
    }) as { auto_timeline?: { created?: number } };
    expect(result.auto_timeline?.created).toBe(1);

    const rows = await engine.executeRaw<{ source_id: string; source: string; summary: string }>(
      `SELECT p.source_id, te.source, te.summary
       FROM timeline_entries te JOIN pages p ON p.id = te.page_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe('wiki');
    expect(rows[0].source).toBe('meeting');
    expect(rows[0].summary).toBe('Discussed the wiki');
  });
});

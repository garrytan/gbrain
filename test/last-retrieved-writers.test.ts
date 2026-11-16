/**
 * #7200: which read verbs write the stale-page signal (page_retrievals).
 *
 * 1. Protects: the documented writer set in src/core/last-retrieved.ts:
 *    search, query, get_page, fetch and recall with `query` record a page
 *    retrieval; recall without `query` (a read of facts) does not.
 * 2. Fails when: a verb drops its bump, recall's facts-only path starts
 *    bumping, or a new call site appears without a decision recorded here and
 *    in the last-retrieved.ts header.
 * 3. Existing coverage: test/last-retrieved.test.ts covers the drain and the
 *    throttle with a stub engine; nothing pinned which verbs write.
 * 4. No production seam: the real op handlers on PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { awaitPendingLastRetrievedWrites, _resetTrackRetrievalCacheForTests } from '../src/core/last-retrieved.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const SLUG = 'notes/alice-example-ledger';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetTrackRetrievalCacheForTests();
  await importFromContent(engine, SLUG, '# Alice Example ledger\nThe quillmarsh ledger kept by alice-example.', { noEmbed: true });
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES ('default', $1, 'alice-example keeps the quillmarsh ledger.', 'fact', 'world', 'fixture')`, [SLUG]);
});

function localCtx(): OperationContext {
  return {
    engine, config: {} as never, dryRun: false, remote: false, transport: 'stdio', sourceId: 'default',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
  } as OperationContext;
}

async function retrievedAfter(op: string, params: Record<string, unknown>): Promise<string[]> {
  await engine.executeRaw('DELETE FROM page_retrievals');
  await operations.find(o => o.name === op)!.handler(localCtx(), params);
  await awaitPendingLastRetrievedWrites();
  const rows = await engine.executeRaw<{ slug: string }>('SELECT p.slug FROM page_retrievals r JOIN pages p ON p.id = r.page_id');
  return rows.map(r => r.slug);
}

describe('page retrieval writers', () => {
  const WRITERS: Array<[string, Record<string, unknown>]> = [
    ['search', { query: 'quillmarsh ledger' }],
    ['query', { query: 'quillmarsh ledger', expand: false }],
    ['get_page', { slug: SLUG }],
    ['fetch', { id: SLUG }],
    ['recall', { query: 'quillmarsh ledger' }],
  ];
  for (const [op, params] of WRITERS) {
    test(`${op} ${JSON.stringify(params)} records the page it surfaced`, async () => {
      expect(await retrievedAfter(op, params)).toEqual([SLUG]);
    });
  }

  const NON_WRITERS: Array<[string, Record<string, unknown>]> = [
    ['recall', { entity: SLUG }],
    ['recall', { question: 'who keeps the quillmarsh ledger' }],
  ];
  for (const [op, params] of NON_WRITERS) {
    test(`${op} ${JSON.stringify(params)} reads facts and records no page retrieval`, async () => {
      expect(await retrievedAfter(op, params)).toEqual([]);
    });
  }

  test('every bumpLastRetrievedAt call site is a documented writer', () => {
    const root = join(import.meta.dir, '..');
    const sites: Record<string, number> = {};
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) {
          const count = readFileSync(path, 'utf8').match(/\bbumpLastRetrievedAt\(ctx\.engine/g)?.length ?? 0;
          if (count) sites[relative(root, path)] = count;
        }
      }
    };
    walk(join(root, 'src'));
    // A new reader that bumps is a deliberate choice: add it to the writer
    // list in src/core/last-retrieved.ts and to WRITERS above.
    expect(sites).toEqual({
      'src/core/ops/facts.ts': 1,
      'src/core/ops/pages.ts': 2,
      'src/core/ops/search.ts': 3,
    });
  });
});

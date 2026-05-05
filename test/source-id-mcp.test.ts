import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
import { setupDB, teardownDB, getConn, getEngine } from './e2e/helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL || '';
const SAFE_TEST_DB = /localhost:5434\/gbrain_test(?:\?|$)/.test(DATABASE_URL);

if (DATABASE_URL && !SAFE_TEST_DB) {
  throw new Error(`Refusing to run source-id MCP tests against non-test DATABASE_URL: ${DATABASE_URL}`);
}

const describeDb = SAFE_TEST_DB ? describe : describe.skip;

function makeCtx(): OperationContext {
  return {
    engine: getEngine(),
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
  };
}

describeDb('MCP source_id routing for put_page/get_page', () => {
  beforeAll(async () => {
    await setupDB();
  });

  beforeEach(async () => {
    const conn = getConn();
    await conn.unsafe(`DELETE FROM pages`);
    await conn.unsafe(`DELETE FROM sources WHERE id != 'default'`);
    await conn.unsafe(
      `INSERT INTO sources (id, name) VALUES ('testsrc', 'testsrc') ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await teardownDB();
  });

  test('put_page with explicit source_id writes to that source', async () => {
    const putPage = operationsByName.put_page;
    await putPage.handler(makeCtx(), {
      slug: 'test/source-explicit',
      content: '# Explicit Source\n\nbody',
      source_id: 'testsrc',
    });

    const rows = await getConn().unsafe(
      `SELECT source_id, slug FROM pages WHERE slug = 'test/source-explicit'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('testsrc');
  });

  test('get_page with source_id returns the page from that source', async () => {
    const engine = getEngine();
    await engine.putPage('test/shared', {
      type: 'note' as any,
      title: 'Default',
      compiled_truth: 'default body',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('test/shared', {
      type: 'note' as any,
      title: 'Source',
      compiled_truth: 'source body',
      timeline: '',
      frontmatter: {},
    }, 'testsrc');

    const getPage = operationsByName.get_page;
    const result = await getPage.handler(makeCtx(), {
      slug: 'test/shared',
      source_id: 'testsrc',
    }) as { title: string; compiled_truth: string };

    expect(result.title).toBe('Source');
    expect(result.compiled_truth).toBe('source body');
  });

  test('put_page without source_id preserves default-source behavior', async () => {
    const putPage = operationsByName.put_page;
    await putPage.handler(makeCtx(), {
      slug: 'test/default-source',
      content: '# Default Source\n\nbody',
    });

    const rows = await getConn().unsafe(
      `SELECT source_id FROM pages WHERE slug = 'test/default-source'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });

  test('put_page with unknown source_id throws OperationError', async () => {
    const putPage = operationsByName.put_page;
    const promise = putPage.handler(makeCtx(), {
      slug: 'test/bad-source',
      content: '# Bad Source\n\nbody',
      source_id: 'missing-source',
    });

    await expect(promise).rejects.toBeInstanceOf(OperationError);
    await expect(promise).rejects.toThrow(/Unknown source_id: missing-source/);
  });
});

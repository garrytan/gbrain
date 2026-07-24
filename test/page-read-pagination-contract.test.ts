/**
 * v0.43 — contract coverage for per-call source_id on get_page and
 * list_pages, plus deterministic offset pagination.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { OperationContext } from '../src/core/operations';
import { operationsByName } from '../src/core/operations';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('hermes-memory', 'hermes-memory', '/tmp/hm') ON CONFLICT (id) DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('bear-brain', 'bear-brain', '/tmp/bb') ON CONFLICT (id) DO NOTHING`,
  );
  await engine.putPage('hot/turn/evt-1', {
    type: 'turn_event',
    title: 'Turn event one',
    compiled_truth: 'turn body one',
    frontmatter: {},
  }, { sourceId: 'hermes-memory' });
  await engine.putPage('hot/turn/evt-2', {
    type: 'turn_event',
    title: 'Turn event two',
    compiled_truth: 'turn body two',
    frontmatter: {},
  }, { sourceId: 'hermes-memory' });
  await engine.putPage('decisions/2026-01', {
    type: 'decision',
    title: 'Decision page',
    compiled_truth: 'decision body',
    frontmatter: {},
  }, { sourceId: 'bear-brain' });
  await engine.putPage('hot/turn/evt-3', {
    type: 'turn_event',
    title: 'Turn event three',
    compiled_truth: 'turn body three',
    frontmatter: {},
  }, { sourceId: 'hermes-memory' });
});

function localCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    sourceId: 'default',
    remote: false,
    localFederatedSourceIds: ['hermes-memory', 'bear-brain'],
    ...overrides,
  } as OperationContext;
}

// ---------------------------------------------------------------------------
// get_page source_id narrowing
// ---------------------------------------------------------------------------
describe('get_page per-call source_id', () => {
  const op = operationsByName.get_page;

  test('exact match in the requested source returns the page', async () => {
    const result = await op.handler(localCtx(), {
      slug: 'hot/turn/evt-1',
      source_id: 'hermes-memory',
    });
    expect(result).toHaveProperty('slug', 'hot/turn/evt-1');
    expect(result).toHaveProperty('source_id', 'hermes-memory');
    // local caller sees compiled_truth
    expect(result).toHaveProperty('compiled_truth', 'turn body one');
  });

  test('exact match in the wrong source returns page_not_found', async () => {
    await expect(
      op.handler(localCtx(), {
        slug: 'hot/turn/evt-1',
        source_id: 'bear-brain',
      }),
    ).rejects.toThrow(/Page not found/);
  });

  test('unqualified read sees cross-source pages via federated scope', async () => {
    const result = await op.handler(localCtx(), {
      slug: 'decisions/2026-01',
    });
    expect(result).toHaveProperty('slug', 'decisions/2026-01');
    expect(result).toHaveProperty('source_id', 'bear-brain');
  });
});

// ---------------------------------------------------------------------------
// list_pages source_id + offset
// ---------------------------------------------------------------------------
describe('list_pages source_id and offset', () => {
  const op = operationsByName.list_pages;

  test('lists only pages from the requested source', async () => {
    const result = (await op.handler(localCtx(), {
      source_id: 'hermes-memory',
      sort: 'slug',
    })) as any[];
    expect(result.length).toBe(3);
    for (const row of result) {
      expect(row.source_id).toBe('hermes-memory');
    }
  });

  test('lists only pages from another source', async () => {
    const result = (await op.handler(localCtx(), {
      source_id: 'bear-brain',
    })) as any[];
    expect(result.length).toBe(1);
    expect(result[0].source_id).toBe('bear-brain');
  });

  test('offset=1 skips the first page in deterministic order', async () => {
    const all = (await op.handler(localCtx(), {
      source_id: 'hermes-memory',
      sort: 'slug',
    })) as any[];
    const skipped = (await op.handler(localCtx(), {
      source_id: 'hermes-memory',
      sort: 'slug',
      offset: 1,
    })) as any[];
    expect(skipped.length).toBe(2);
    expect(skipped[0].slug).toBe(all[1].slug);
  });

  test('limit=1, offset=2 returns only the third page', async () => {
    const result = (await op.handler(localCtx(), {
      source_id: 'hermes-memory',
      sort: 'slug',
      limit: 1,
      offset: 2,
    })) as any[];
    expect(result.length).toBe(1);
    const all = (await op.handler(localCtx(), {
      source_id: 'hermes-memory',
      sort: 'slug',
      limit: 100,
    })) as any[];
    expect(result[0].slug).toBe(all[2].slug);
  });

  test('offset beyond total returns empty', async () => {
    const result = (await op.handler(localCtx(), {
      source_id: 'hermes-memory',
      offset: 999,
    })) as any[];
    expect(result).toEqual([]);
  });

  test('offset=0 default preserved when not passed', async () => {
    const result = (await op.handler(localCtx(), {
      source_id: 'hermes-memory',
      sort: 'slug',
    })) as any[];
    expect(result.length).toBe(3);
  });

  test('output remains metadata-only (no body/prose)', async () => {
    const result = (await op.handler(localCtx(), {
      source_id: 'hermes-memory',
      limit: 1,
    })) as any[];
    expect(result.length).toBeGreaterThanOrEqual(1);
    const row = result[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('compiled_truth');
    expect(row).not.toHaveProperty('content');
    expect(row).toHaveProperty('slug');
    expect(row).toHaveProperty('title');
    expect(row).toHaveProperty('source_id');
  });
});

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveSourceId } from '../src/core/source-resolver.ts';

let engine: PGLiteEngine;

async function freshEngine(): Promise<PGLiteEngine> {
  const next = new PGLiteEngine();
  await next.connect({});
  await next.initSchema();
  return next;
}

async function addSideSource(id = 'side'): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [id, `/tmp/${id}`],
  );
}

afterAll(async () => {
  await engine?.disconnect();
});

beforeEach(async () => {
  await engine?.disconnect();
  engine = await freshEngine();
  delete process.env.GBRAIN_SOURCE;
});

describe('sole non-default routing preserves established default state', () => {
  test('an established default is not bypassed by a side source', async () => {
    await engine.putPage('wiki/established', {
      type: 'note',
      title: 'Established',
      compiled_truth: 'live default corpus',
    });
    await addSideSource();

    expect(await resolveSourceId(engine, null, '/')).toBe('default');
  });

  test('an empty seeded default still rescues to the sole side source', async () => {
    await addSideSource('vault');

    expect(await resolveSourceId(engine, null, '/')).toBe('vault');
  });

  test('soft-deleted default pages do not establish the default', async () => {
    await engine.putPage('wiki/deleted', {
      type: 'note',
      title: 'Deleted',
      compiled_truth: 'no longer live',
    });
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() WHERE slug = 'wiki/deleted'`,
    );
    await addSideSource('vault');

    expect(await resolveSourceId(engine, null, '/')).toBe('vault');
  });

  test('a failed default-page check fails conservatively to default', async () => {
    const failingEngine = {
      kind: 'pglite',
      async executeRaw<T>(sql: string): Promise<T[]> {
        if (sql.includes('SELECT id, local_path')) return [] as T[];
        if (sql.includes('archived = false')) return [{ id: 'side' }] as T[];
        if (sql.includes('COUNT(*)')) throw new Error('page count unavailable');
        return [] as T[];
      },
      async getConfig(): Promise<null> {
        return null;
      },
    } as unknown as BrainEngine;

    expect(await resolveSourceId(failingEngine, null, '/')).toBe('default');
  });
});

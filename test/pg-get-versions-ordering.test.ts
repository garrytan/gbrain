import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PgEngineBase, type PgQueryable } from '../src/core/pg-engine-base.ts';

interface QueryCall {
  text: string;
  params?: unknown[];
}

class PgGetVersionsHarness extends PgEngineBase {
  readonly calls: QueryCall[] = [];

  protected get queryable(): PgQueryable {
    return {
      query: async (text, params) => {
        this.calls.push({ text, params });
        if (text.includes('FROM page_versions pv')) {
          return {
            rows: [{
              id: '12',
              page_id: '7',
              compiled_truth: 'Version content',
              frontmatter: '{"aliases":["versioned"]}',
              snapshot_at: '2026-05-20T00:00:00.000Z',
            }],
          };
        }
        return { rows: [] };
      },
    };
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return fn(this as unknown as BrainEngine);
  }

  protected async withSearchTimeout<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T> {
    return fn(this.queryable);
  }

  protected async execRaw(_sql: string): Promise<void> {}
}

describe('PgEngineBase getVersions', () => {
  test('uses deterministic version ordering and maps row types', async () => {
    const engine = new PgGetVersionsHarness();

    const versions = await engine.getVersions('systems/versioned');

    expect(engine.calls[0]?.text).toContain('ORDER BY pv.snapshot_at DESC, pv.id DESC');
    expect(versions).toEqual([{
      id: 12,
      page_id: 7,
      compiled_truth: 'Version content',
      frontmatter: { aliases: ['versioned'] },
      snapshot_at: new Date('2026-05-20T00:00:00.000Z'),
    }]);
  });
});

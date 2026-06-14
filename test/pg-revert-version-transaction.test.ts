import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PgEngineBase, type PgQueryable } from '../src/core/pg-engine-base.ts';

type QueryScope = 'root' | 'tx';

interface QueryCall {
  scope: QueryScope;
  text: string;
  params?: unknown[];
}

interface HarnessState {
  calls: QueryCall[];
  transactionCalls: number;
}

class PgRevertVersionHarness extends PgEngineBase {
  constructor(
    private readonly scope: QueryScope = 'root',
    readonly state: HarnessState = { calls: [], transactionCalls: 0 },
  ) {
    super();
  }

  protected get queryable(): PgQueryable {
    return {
      query: async (text, params) => {
        this.state.calls.push({ scope: this.scope, text, params });

        if (text.includes('FROM pages WHERE slug = $1') && text.includes('FOR UPDATE')) {
          return { rows: [pageRow('Current content')] };
        }
        if (text.includes('FROM page_versions pv')) {
          return {
            rows: [{
              compiled_truth: 'Reverted content',
              frontmatter: { aliases: ['old-system'] },
              title: 'Versioned System',
              type: 'system',
              timeline: 'Original timeline',
            }],
          };
        }
        if (text.includes('SELECT tag FROM tags')) {
          return { rows: [{ tag: 'versioned' }] };
        }
        if (text.includes('UPDATE pages')) {
          return { rows: [] };
        }
        if (text.includes('SELECT id, slug, type, title, compiled_truth')) {
          return { rows: [pageRow('Reverted content')] };
        }
        if (text.includes('SELECT cc.* FROM content_chunks')) {
          return { rows: [] };
        }
        if (text.includes('SELECT id FROM pages WHERE slug = $1')) {
          return { rows: [{ id: 42 }] };
        }
        return { rows: [] };
      },
    };
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    this.state.transactionCalls += 1;
    const txEngine = new PgRevertVersionHarness('tx', this.state);
    return fn(txEngine as unknown as BrainEngine);
  }

  override async getConfig(_key: string): Promise<string | null> {
    return null;
  }

  protected async withSearchTimeout<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T> {
    return fn(this.queryable);
  }

  protected async execRaw(_sql: string): Promise<void> {}
}

function pageRow(compiledTruth: string): Record<string, unknown> {
  return {
    id: 42,
    slug: 'systems/versioned',
    type: 'system',
    title: 'Versioned System',
    compiled_truth: compiledTruth,
    timeline: 'Original timeline',
    frontmatter: { aliases: ['old-system'] },
    content_hash: 'hash',
    created_at: new Date('2026-05-20T00:00:00.000Z'),
    updated_at: new Date('2026-05-20T00:00:00.000Z'),
  };
}

describe('PgEngineBase revertToVersion transaction boundary', () => {
  test('locks and restores the page through one transaction-scoped engine', async () => {
    const engine = new PgRevertVersionHarness();

    await engine.revertToVersion('systems/versioned', 7);

    expect(engine.state.transactionCalls).toBe(1);
    expect(engine.state.calls.every(call => call.scope === 'tx')).toBe(true);
    expect(engine.state.calls[0]?.text).toContain('FOR UPDATE');
    expect(engine.state.calls.map(call => call.text)).toContainEqual(expect.stringContaining('UPDATE pages'));
    expect(engine.state.calls.map(call => call.text)).toContainEqual(expect.stringContaining('INSERT INTO content_chunks'));
  });
});

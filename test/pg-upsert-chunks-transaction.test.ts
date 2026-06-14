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

class PgUpsertChunksHarness extends PgEngineBase {
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
        if (text.includes('SELECT id FROM pages WHERE slug = $1')) {
          return { rows: [{ id: 42 }] };
        }
        return { rows: [] };
      },
    };
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    this.state.transactionCalls += 1;
    const txEngine = new PgUpsertChunksHarness('tx', this.state);
    return fn(txEngine as unknown as BrainEngine);
  }

  protected async withSearchTimeout<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T> {
    return fn(this.queryable);
  }

  protected async execRaw(_sql: string): Promise<void> {}

  protected override async onChunksChanged(pageId: number): Promise<void> {
    this.state.calls.push({ scope: this.scope, text: 'onChunksChanged', params: [pageId] });
  }
}

describe('PgEngineBase upsertChunks transaction boundary', () => {
  test('runs page lookup, chunk replacement, and chunk-change hook in one transaction', async () => {
    const engine = new PgUpsertChunksHarness();

    await engine.upsertChunks('systems/atomic-chunks', [{
      chunk_index: 0,
      chunk_text: 'Atomic replacement chunk',
      chunk_source: 'compiled_truth',
    }]);

    expect(engine.state.transactionCalls).toBe(1);
    expect(engine.state.calls.map(call => call.scope)).toEqual(['tx', 'tx', 'tx', 'tx']);
    expect(engine.state.calls.map(call => call.text)).toEqual([
      expect.stringContaining('SELECT id FROM pages WHERE slug = $1'),
      expect.stringContaining('DELETE FROM content_chunks'),
      expect.stringContaining('INSERT INTO content_chunks'),
      'onChunksChanged',
    ]);
  });

  test('runs empty chunk replacement and chunk-change hook in one transaction', async () => {
    const engine = new PgUpsertChunksHarness();

    await engine.upsertChunks('systems/empty-chunks', []);

    expect(engine.state.transactionCalls).toBe(1);
    expect(engine.state.calls.map(call => call.scope)).toEqual(['tx', 'tx', 'tx']);
    expect(engine.state.calls.map(call => call.text)).toEqual([
      expect.stringContaining('SELECT id FROM pages WHERE slug = $1'),
      expect.stringContaining('DELETE FROM content_chunks'),
      'onChunksChanged',
    ]);
  });
});

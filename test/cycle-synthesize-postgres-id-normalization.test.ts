import { describe, expect, test } from 'bun:test';
import { __testing } from '../src/core/cycle/synthesize.ts';

const {
  collectChildPutPageSlugs,
  collectChildPutPageWriterJobIds,
} = __testing as unknown as {
  collectChildPutPageSlugs: (
    engine: { executeRaw(sql: string, params: unknown[]): Promise<Array<{ job_id: unknown; slug: string }>> },
    childIds: number[],
    chunkInfo: Map<number, { idx: number; hash6: string }>,
  ) => Promise<Array<{ slug: string; source_id: string }>>;
  collectChildPutPageWriterJobIds: (
    engine: { executeRaw(sql: string, params: unknown[]): Promise<Array<{ job_id: unknown }>> },
    childIds: number[],
  ) => Promise<Set<number>>;
};

describe('synthesize Postgres id normalization', () => {
  test('normalizes string/bigint child job ids for writer detection and chunked slug rewriting', async () => {
    const engine = {
      async executeRaw(sql: string) {
        if (sql.includes(`COALESCE(input->>'slug'`)) {
          return [
            { job_id: '1001', slug: 'wiki/personal/reflections/abc123' },
            { job_id: 1002n, slug: 'wiki/originals/ideas/def456' },
          ];
        }
        return [
          { job_id: '1001' },
          { job_id: 1002n },
          { job_id: 'not-a-number' },
        ];
      },
    };

    const writerIds = await collectChildPutPageWriterJobIds(engine as any, [1001, 1002]);
    expect([...writerIds]).toEqual([1001, 1002]);
    expect(writerIds.has(1001)).toBe(true);
    expect(writerIds.has(1002)).toBe(true);

    const refs = await collectChildPutPageSlugs(
      engine as any,
      [1001, 1002],
      new Map<number, { idx: number; hash6: string }>([
        [1001, { idx: 0, hash6: 'abc123' }],
        [1002, { idx: 1, hash6: 'def456' }],
      ]),
    );

    expect(refs).toEqual([
      { slug: 'wiki/originals/ideas/def456-c1', source_id: 'default' },
      { slug: 'wiki/personal/reflections/abc123-c0', source_id: 'default' },
    ]);
  });
});

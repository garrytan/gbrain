import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

type SqlCall =
  | { target: 'root' | 'reserved'; kind: 'tag'; text: string; values: unknown[] }
  | { target: 'root' | 'reserved'; kind: 'unsafe'; query: string; values: unknown[] | undefined }
  | { target: 'root'; kind: 'reserve' }
  | { target: 'reserved'; kind: 'release' };

function createSqlMock(opts?: { unsafeResult?: Record<string, unknown>[]; unsafeError?: Error }) {
  const calls: SqlCall[] = [];

  const reserved: any = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({
      target: 'reserved',
      kind: 'tag',
      text: Array.from(strings).join('<??>'),
      values,
    });
    return [];
  };

  reserved.unsafe = async (query: string, values?: unknown[]) => {
    calls.push({ target: 'reserved', kind: 'unsafe', query, values });
    if (opts?.unsafeError) throw opts.unsafeError;
    return opts?.unsafeResult ?? [];
  };

  reserved.release = async () => {
    calls.push({ target: 'reserved', kind: 'release' });
    return [];
  };

  const sql: any = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({
      target: 'root',
      kind: 'tag',
      text: Array.from(strings).join('<??>'),
      values,
    });
    return [];
  };

  sql.reserve = async () => {
    calls.push({ target: 'root', kind: 'reserve' });
    return reserved;
  };

  return { sql, calls };
}

describe('PostgresEngine search wiring', () => {
  test('searchKeyword uses a reserved connection, scopes statement_timeout, and passes type/exclude filters', async () => {
    const { sql, calls } = createSqlMock({
      unsafeResult: [{
        slug: 'people/alice',
        page_id: 1,
        title: 'Alice',
        type: 'person',
        chunk_text: 'keyword result',
        chunk_source: 'compiled_truth',
        score: 0.8,
        stale: false,
      }],
    });

    const engine = new PostgresEngine() as any;
    engine._sql = sql;

    const results = await engine.searchKeyword('keyword', {
      type: 'person',
      exclude_slugs: ['People/Alice'],
    });

    expect(results.map((entry: any) => entry.slug)).toEqual(['people/alice']);
    expect(calls).toEqual([
      { target: 'root', kind: 'reserve' },
      expect.objectContaining({ target: 'reserved', kind: 'tag' }),
      expect.objectContaining({ target: 'reserved', kind: 'unsafe' }),
      expect.objectContaining({ target: 'reserved', kind: 'tag' }),
      { target: 'reserved', kind: 'release' },
    ]);
    expect((calls[1] as Extract<SqlCall, { target: 'reserved'; kind: 'tag' }>).text).toContain(
      "SET statement_timeout = '8s'",
    );
    expect((calls[2] as Extract<SqlCall, { target: 'reserved'; kind: 'unsafe' }>).query).toContain(
      'AND p.type = $2',
    );
    expect((calls[2] as Extract<SqlCall, { target: 'reserved'; kind: 'unsafe' }>).query).toContain(
      'AND p.slug != ALL($3::text[])',
    );
    expect((calls[2] as Extract<SqlCall, { target: 'reserved'; kind: 'unsafe' }>).values).toEqual([
      'keyword',
      'person',
      ['people/alice'],
    ]);
    expect((calls[3] as Extract<SqlCall, { target: 'reserved'; kind: 'tag' }>).text).toContain(
      "SET statement_timeout = '0'",
    );
  });

  test('searchKeyword resets statement_timeout and releases the reserved connection when the query fails', async () => {
    const { sql, calls } = createSqlMock({
      unsafeError: new Error('simulated query failure'),
    });

    const engine = new PostgresEngine() as any;
    engine._sql = sql;

    await expect(engine.searchKeyword('keyword')).rejects.toThrow('simulated query failure');
    expect(calls).toHaveLength(5);
    expect(calls[0]).toEqual({ target: 'root', kind: 'reserve' });
    expect((calls[3] as Extract<SqlCall, { target: 'reserved'; kind: 'tag' }>).text).toContain(
      "SET statement_timeout = '0'",
    );
    expect(calls[4]).toEqual({ target: 'reserved', kind: 'release' });
  });

  test('searchVector uses a reserved connection, scopes statement_timeout, and passes type/exclude filters', async () => {
    const { sql, calls } = createSqlMock({
      unsafeResult: [{
        slug: 'projects/apollo',
        page_id: 2,
        title: 'Apollo',
        type: 'project',
        chunk_text: 'vector result',
        chunk_source: 'compiled_truth',
        score: 0.9,
        stale: false,
      }],
    });

    const engine = new PostgresEngine() as any;
    engine._sql = sql;

    const results = await engine.searchVector(new Float32Array([1, 0, 0]), {
      type: 'project',
      exclude_slugs: ['Projects/Apollo'],
      limit: 7,
    });

    expect(results.map((entry: any) => entry.slug)).toEqual(['projects/apollo']);
    expect(calls[0]).toEqual({ target: 'root', kind: 'reserve' });
    expect((calls[1] as Extract<SqlCall, { target: 'reserved'; kind: 'tag' }>).text).toContain(
      "SET statement_timeout = '8s'",
    );
    expect((calls[2] as Extract<SqlCall, { target: 'reserved'; kind: 'unsafe' }>).query).toContain(
      'AND p.type = $2',
    );
    expect((calls[2] as Extract<SqlCall, { target: 'reserved'; kind: 'unsafe' }>).query).toContain(
      'AND p.slug != ALL($3::text[])',
    );
    expect((calls[2] as Extract<SqlCall, { target: 'reserved'; kind: 'unsafe' }>).query).toContain('LIMIT $4');
    expect((calls[2] as Extract<SqlCall, { target: 'reserved'; kind: 'unsafe' }>).values).toEqual([
      '[1,0,0]',
      'project',
      ['projects/apollo'],
      7,
    ]);
    expect((calls[3] as Extract<SqlCall, { target: 'reserved'; kind: 'tag' }>).text).toContain(
      "SET statement_timeout = '0'",
    );
    expect(calls[4]).toEqual({ target: 'reserved', kind: 'release' });
  });
});

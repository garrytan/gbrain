/**
 * #6930: the vendored driver's shared array types and transaction pipelining ship in all three runtime copies
 * (ESM, CommonJS, workerd). The behaviour is proven on the ESM copy by test/pathological/pg-round-trips-6930.test.ts
 * and test/e2e/pgbouncer-transaction-pipeline-6930.test.ts; this pins that every copy carries the same patch.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('vendored Postgres driver #6930 patch', () => {
  test('all three shipped copies carry the shared array types and transaction pipelining (offline)', () => {
    for (const path of ['src', 'cjs/src', 'cf/src']) {
      const connection = readFileSync(new URL('../vendor/postgres/' + path + '/connection.js', import.meta.url), 'utf8');
      expect(connection).toContain('needsTypes && options.array_types && options.array_types.rows');
      expect(connection).toContain('options.array_types && (options.array_types.rows = types.map(');
      expect(connection).toMatch(/noteBudget\(q\)\n\s+noteTransaction\(q\)/);
      expect(connection).toMatch(/&& sent\.length < pipelineLimit\(\)\n\s+&& mayPipeline/);
      expect(connection).toContain('return transaction_pipeline > max_pipeline && inTransactionAfterSent && connection.reserved');
      const index = readFileSync(new URL('../vendor/postgres/' + path + '/index.js', import.meta.url), 'utf8');
      expect(index).toContain("'max_pipeline', 'transaction_pipeline', 'backoff'");
      expect(index).toContain('array_types     : o.array_types || null,');
      // GBRA-156: only an opted-in first statement its test accepts goes out before BEGIN's answer, and only with transaction_pipeline on.
      expect(index).toContain("const first = typeof options === 'object' && options.first && sql.options.transaction_pipeline > sql.options.max_pipeline");
      expect(index).toContain('const strings = Array.isArray(q.strings) ? q.strings : [String(q.strings)]');
      expect(index).toContain('&& q.args.every(x => !(x instanceof Query || x instanceof Builder || x instanceof Identifier || Array.isArray(x) && x.some(y => y instanceof Query)))');
      expect(index).toContain("&& test(strings.reduce((a, s, i) => a + '$' + i + s))");
      expect(index).toMatch(/if \(!sent\) \{\n\s+held = true\n\s+return opening\.then\(\(\) => handler\(q\), q\.reject\)/);
      // GBRA-156: `early` sends each statement it accepts, in order until one is refused, on any pool that pipelines inside a transaction.
      expect(index).toContain('&& (sql.options.transaction_pipeline > sql.options.max_pipeline || sql.options.max_pipeline > 0)');
      expect(index).toContain('const test = early || !firstSeen && first');
      expect(index).toContain('const sent = !held && test');
      expect(index).toMatch(/const \[opened, result\] = await Promise\.allSettled\(\[begun, ran\]\)\n\s+if \(opened\.status === 'rejected'\)\n\s+throw opened\.reason/);
    }
    const types = readFileSync(new URL('../vendor/postgres/types/index.d.ts', import.meta.url), 'utf8');
    expect(types).toContain('transaction_pipeline: number;');
    expect(types).toContain('begin<T>(options: { mode?: string; first?: (statement: string) => boolean; early?: (statement: string) => boolean }');
    expect(types).toContain('array_types: { rows: Array<[number, number]> | null } | null;');
  });
});

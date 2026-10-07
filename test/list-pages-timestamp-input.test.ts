/**
 * #6103: list_pages `updated_after` the database cannot parse.
 *
 * 1. Protects: a malformed or out-of-range `updated_after` (SQLSTATE 22007 /
 *    22008 from the `::timestamptz` cast) is the caller's input error and
 *    renders as `invalid_params` with a fix, never as `internal_error`, which
 *    sends callers to doctor.
 * 2. Fails when: list_pages lets the cast error escape unmapped, maps an
 *    unrelated SQLSTATE, or blames updated_after when the caller never sent
 *    it.
 * 3. The hybrid search arms already rethrow this class (search-date-bound
 *    tests); list_pages had no mapping at all.
 * 4. No new seam: the real handler over PGLite; the negative controls wrap
 *    the engine's own listPages.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { toAgentError } from '../src/core/agent-output.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/alpha-example', { type: 'note', title: 'Alpha', compiled_truth: 'alpha body' }, { sourceId: 'default' });
});

afterAll(async () => {
  await engine.disconnect();
});

function ctx(remote: boolean): OperationContext {
  return { engine, config: { engine: 'pglite' }, sourceId: 'default', remote, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
}

const listPages = (params: Record<string, unknown>, remote = true) => operationsByName.list_pages.handler(ctx(remote), params);
const render = { transport: 'stdio' as const, isCallable: () => true, preapproved: () => false };
const failure = (params: Record<string, unknown>) => listPages(params).then(() => undefined, (e: unknown) => e);

describe('list_pages updated_after the database cannot parse (#6103)', () => {
  for (const [what, value] of [['malformed', 'not-a-date-xyz'], ['out of range', '2026-13-45T99:00:00Z']] as const) {
    test(`a ${what} updated_after renders invalid_params with a fix and no echo of the value`, async () => {
      const env = toAgentError(await failure({ updated_after: value }), { transport: 'stdio', op: 'list_pages', render });
      expect(env.code).toBe('invalid_params');
      expect(env.message).toBe('list_pages: updated_after is not a date or timestamp the database can read.');
      expect(env.suggestion).toContain('2026-08-11T00:00:00Z');
      expect(env.fix).toMatchObject({ next: 'run', mcp: { tool: 'list_pages', arguments: { updated_after: '2026-08-11T00:00:00Z', limit: 1 } } });
      expect(JSON.stringify(env)).not.toContain(value);
    });
  }

  test('the keyset form maps the same way', async () => {
    const err = await failure({ updated_after: 'not-a-date-xyz', updated_after_slug: 'notes/alpha-example' });
    expect((err as { code?: string }).code).toBe('invalid_params');
  });

  test('a well-formed updated_after still lists', async () => {
    const rows = await listPages({ updated_after: '2000-01-01T00:00:00Z' }) as Array<{ slug: string }>;
    expect(rows.map(r => r.slug)).toEqual(['notes/alpha-example']);
  });

  test('other SQLSTATEs, and 22007 without an updated_after, pass through unchanged', async () => {
    const original = engine.listPages;
    try {
      for (const [code, params] of [['57014', { updated_after: '2000-01-01T00:00:00Z' }], ['22007', {}]] as const) {
        const thrown = Object.assign(new Error(`synthetic ${code}`), { code });
        engine.listPages = async () => { throw thrown; };
        expect(await failure(params)).toBe(thrown);
      }
    } finally {
      engine.listPages = original;
    }
  });
});

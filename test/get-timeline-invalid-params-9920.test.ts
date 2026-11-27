/**
 * #9920: get_timeline passed after/before/since/until and limit straight to SQL, so a malformed date or a
 * negative limit came back as internal_error with a "run gbrain doctor" hint.
 *
 * 1. Protects: a window date that is not a YYYY-MM-DD calendar day, or a limit that is not a positive
 *    integer, is invalid_params naming the field, before any read.
 * 2. Fails when: the handler stops validating any of the five fields.
 * 3. Real seams: the get_timeline operation handler on a PGLite brain, local and remote callers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

const getTimeline = operationsByName['get_timeline']!;
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'hello' });
  await engine.addTimelineEntry('people/alice-example', { date: '2026-01-02', summary: 'met' });
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

const ctx = (remote: boolean) => ({
  engine, config: {}, dryRun: false, remote, sourceId: 'default',
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}) as unknown as OperationContext;

async function refusal(params: Record<string, unknown>, remote = false): Promise<{ code?: string; message?: string } | null> {
  try {
    await getTimeline.handler(ctx(remote), { slug: 'people/alice-example', ...params });
    return null;
  } catch (e) {
    return e as { code?: string; message?: string };
  }
}

describe('get_timeline input validation (#9920)', () => {
  for (const [field, params] of [
    ['after', { after: 'nope' }],
    ['before', { before: '2026-13-40' }],
    ['since', { since: 'yesterday' }],
    ['until', { until: '2026-02-30' }],
    ['limit', { limit: -1 }],
    ['limit', { limit: 1.5 }],
  ] as const) {
    test(`${JSON.stringify(params)} is invalid_params naming ${field}`, async () => {
      for (const remote of [false, true]) {
        const err = await refusal(params, remote);
        expect(err?.code).toBe('invalid_params');
        expect(err?.message).toContain(field);
      }
    });
  }

  test('limit 0 still reads as the default, as before', async () => {
    const rows = await getTimeline.handler(ctx(false), { slug: 'people/alice-example', limit: 0 });
    expect(Array.isArray(rows) ? rows.length : 0).toBe(1);
  });

  test('a valid window and limit still read the entry', async () => {
    const rows = await getTimeline.handler(ctx(false), { slug: 'people/alice-example', after: '2026-01-01', before: '2026-03-31', limit: 5 });
    expect(Array.isArray(rows) ? rows.length : 0).toBe(1);
  });
});

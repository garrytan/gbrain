/**
 * `delta` cursor exactness at the column's microsecond precision.
 *
 * `pages.updated_at` stores microseconds; a cursor minted from a JS Date
 * (millisecond precision) re-selects every row in the last delivered row's
 * millisecond on the next wake, so same-millisecond pages are re-delivered
 * (duplicates under at-least-once, never skips). The cursor now rides
 * `Page.updated_at_iso` (projected by `listPages`) end to end: the stateless
 * `next_cursor.since` round-trip and the per-session `last_wake_at` read-back.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;
const del = operations.find((o) => o.name === 'delta')!;
const putPage = operations.find((o) => o.name === 'put_page')!;

function localCtx(): OperationContext {
  return {
    engine,
    config: {} as GBrainConfig,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as OperationContext;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VerbResult = Record<string, any>;
const slugs = (r: VerbResult): string[] => (r.pages as Array<{ slug: string }>).map((p) => p.slug);

async function call(op: typeof del, p: Record<string, unknown>): Promise<VerbResult> {
  return (await op.handler(localCtx(), p)) as VerbResult;
}

/** Two pages one microsecond apart inside ONE millisecond, stamped via SQL
 * (putPage server-stamps now()). `base` is a timestamptz expression. */
async function seedPair(base: string, params: unknown[] = []): Promise<void> {
  for (const s of ['a', 'b']) {
    await call(putPage, { slug: `notes/us-${s}`, content: `# ${s}\n\nbody` });
  }
  await engine.executeRaw(
    `UPDATE pages SET updated_at = (${base}) + interval '100 microseconds' WHERE slug = 'notes/us-a'`, params,
  );
  await engine.executeRaw(
    `UPDATE pages SET updated_at = (${base}) + interval '101 microseconds' WHERE slug = 'notes/us-b'`, params,
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('delta — cursor carries column-precision microseconds', () => {
  test('stateless: next_cursor.since is the exact row timestamp and the resumed wake re-delivers nothing', async () => {
    await seedPair(`'2026-08-10T12:00:00.000000Z'::timestamptz`);
    const r1 = await call(del, { since: '2026-08-10T11:59:00Z' });
    expect(slugs(r1)).toEqual(['notes/us-a', 'notes/us-b']);
    expect(r1.next_cursor.since).toBe('2026-08-10T12:00:00.000101Z');
    expect(r1.next_cursor.slug).toBe('notes/us-b');

    const r2 = await call(del, { since: r1.next_cursor.since, since_slug: r1.next_cursor.slug });
    expect(slugs(r2)).toEqual([]);
    // The cursor is stable across an empty wake (not re-rounded on echo).
    expect(r2.next_cursor.since).toBe('2026-08-10T12:00:00.000101Z');
  });

  test('session: the stored cursor reads back exact, so the third wake re-delivers nothing', async () => {
    const sid = 'us-session';
    const r0 = await call(del, { session_id: sid });
    expect(slugs(r0)).toEqual([]);
    // Stamp the pair just after the established cursor, inside its millisecond.
    await seedPair(`SELECT last_wake_at FROM session_context_state WHERE session_id = $1`, [sid]);
    const r1 = await call(del, { session_id: sid });
    expect(slugs(r1)).toEqual(['notes/us-a', 'notes/us-b']);
    expect(r1.next_cursor.since).toMatch(/\.\d{6}Z$/);

    const r2 = await call(del, { session_id: sid });
    expect(slugs(r2)).toEqual([]);
  });
});

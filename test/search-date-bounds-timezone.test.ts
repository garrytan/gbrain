/**
 * Observable contract: query since=until includes the whole UTC calendar day
 * independently of the database session TimeZone, including UTC midnight.
 * Regression: a bare date lower bound is cast as local midnight, losing early
 * events west of UTC and admitting previous-day events east of UTC.
 * Existing resolver tests compare strings; the normal Bun test runtime is UTC,
 * so they do not exercise the real SQL cast in a non-UTC session.
 * No production seam: real in-memory PGLite and public operation handlers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

describe('date-only query bounds are independent of database timezone', () => {
  let engine: PGLiteEngine;
  let ctx: OperationContext;
  const query = operations.find(op => op.name === 'query')!;
  const put = operations.find(op => op.name === 'put_page')!;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    ctx = {
      engine, config: { engine: 'pglite', database_path: ':memory:' },
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      dryRun: false, remote: false, sourceId: 'default',
    };
    for (const [name, date] of [
      ['before', '2024-06-14T23:59:59Z'],
      ['midnight', '2024-06-15T00:00:00Z'],
      ['early', '2024-06-15T00:10:00Z'],
      ['late', '2024-06-15T23:59:59.999Z'],
      ['after', '2024-06-16T00:00:00Z'],
    ]) {
      await put.handler(ctx, {
        slug: `notes/date-window-${name}`,
        content: `---\ntype: note\ntitle: Date window ${name}\nevent_date: ${date}\n---\ndatewindowfixture ${name}\n`,
      });
    }
  }, 60_000);

  afterAll(async () => { await engine.disconnect(); }, 30_000);

  test.each(['America/Toronto', 'UTC', 'Asia/Tokyo'])(
    'returns exactly the calendar-day pages in %s',
    async zone => {
      await engine.executeRaw("SELECT set_config('TimeZone', $1, false)", [zone]);
      const rows = await query.handler(ctx, {
        query: 'datewindowfixture', since: '2024-06-15', until: '2024-06-15',
        expand: false, autocut: false, adaptive_return: false, use_cache: false,
        limit: 100, mode: 'conservative', relational: false,
      }) as Array<{ slug: string }>;
      expect([...new Set(rows.map(row => row.slug))].sort()).toEqual([
        'notes/date-window-early', 'notes/date-window-late', 'notes/date-window-midnight',
      ]);
    }, 30_000,
  );
});

/**
 * delta never advances a cursor past content it did not deliver (P0, the
 * contributor audit wave). Both engines: PGLite always, Postgres when
 * DATABASE_URL names a test database (persistence-validation lane).
 *
 * Failure injection wraps the real engine in a Proxy so one read arm throws
 * while every other statement hits the real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { getSessionContextState, upsertSessionContextState } from '../src/core/context/session-state.ts';
import { assembleDeltaContext } from '../src/core/context/turn-context.ts';
import { renderNotice, type Notice, type RenderContext } from '../src/core/agent-output.ts';
import { V208_SQL_FOR_TESTS } from './helpers/delta-v208.ts';
import postgres from '#postgres';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const del = operations.find((o) => o.name === 'delta')!;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Methods made to throw on demand (`failing`: the call rejects; `throwOnAccess`:
 * reading the property throws, which escapes `.catch()` chains); `sql`
 * makes executeRaw reject for statements matching a pattern; `delayMs` adds
 * latency to listPages. Everything else passes through.
 */
interface Faults { failing: Set<string>; throwOnAccess: Set<string>; sql: RegExp | null; delayMs: number }

function faulty(engine: BrainEngine, faults: Faults): BrainEngine {
  return new Proxy(engine, {
    get(t, k) {
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      if (typeof k === 'string' && faults.throwOnAccess.has(k)) throw new Error(`injected ${k} access failure`);
      if (typeof k === 'string' && faults.failing.has(k)) {
        return async () => { throw new Error(`injected ${k} failure`); };
      }
      if (k === 'executeRaw' && faults.sql) {
        const re = faults.sql;
        return (sql: string, params?: unknown[]) => {
          if (re.test(sql)) return Promise.reject(new Error('injected session-state failure'));
          return t.executeRaw(sql as never, params as never);
        };
      }
      if (k === 'listPages' && faults.delayMs > 0) {
        const ms = faults.delayMs;
        return async (...a: unknown[]) => { await new Promise((r) => setTimeout(r, ms)); return (t.listPages as (...x: unknown[]) => unknown)(...a); };
      }
      return typeof v === 'function' && k !== 'constructor' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as BrainEngine;
}

for (const kind of testBackends()) {
  describe(`delta cursor integrity (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let databaseUrl = '';
    const faults: Faults = { failing: new Set(), throwOnAccess: new Set(), sql: null, delayMs: 0 };
    let notices: Notice[] = [];
    const ctx = (): OperationContext => ({
      engine: faulty(engine, faults), config: {} as GBrainConfig, logger: noopLogger, dryRun: false, remote: false, sourceId: 'default',
      emitNotice: (n: Notice) => { notices.push(n); },
    } as OperationContext);
    const call = async (p: Record<string, unknown>): Promise<R> => (await del.handler(ctx(), p)) as R;
    const state = (sid = 's1') => getSessionContextState(engine, 'default', null, sid);
    const factsCursor = async (sid = 's1') =>
      (await engine.executeRaw<{ at: string | null; id: string | number | null; n: string | number }>(
        `SELECT to_char(facts_cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, facts_cursor_id AS id, degraded_wakes AS n
           FROM session_context_state WHERE session_id = $1`, [sid]))[0];
    const incomplete = () => notices.filter((n) => n.code === 'delta_incomplete');
    const stdio: RenderContext = { transport: 'stdio', isCallable: () => true, preapproved: () => false };
    const cli: RenderContext = { transport: 'cli', isCallable: () => false, preapproved: () => false };
    const http: RenderContext = { transport: 'http', isCallable: () => true, preapproved: () => false };
    /** Drain a delta loop, collecting every page slug and fact id it delivers. */
    async function drain(first: Record<string, unknown>, nextArgs: (r: R) => Record<string, unknown>, cap = 40): Promise<{ slugs: Set<string>; ids: Set<number>; calls: number }> {
      const slugs = new Set<string>();
      const ids = new Set<number>();
      let args = first;
      for (let i = 0; i < cap; i++) {
        const r = await call(args);
        for (const p of r.pages) slugs.add(p.slug);
        for (const f of r.facts) ids.add(f.id);
        if (!r.has_more && !r.degraded_reason) return { slugs, ids, calls: i + 1 };
        args = nextArgs(r);
      }
      throw new Error('delta loop did not terminate');
    }

    /** Move both arm cursors of every session back (a session that last woke `ago` ago). */
    async function rewind(ago: string): Promise<void> {
      await engine.executeRaw(`UPDATE session_context_state SET last_wake_at = now() - $1::interval, facts_cursor_at = now() - $1::interval, facts_cursor_id = 0`, [ago]);
    }
    async function page(slug: string, agoMs: number): Promise<void> {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}` });
      await engine.executeRaw(`UPDATE pages SET updated_at = now() - ($1 || ' milliseconds')::interval WHERE slug = $2`, [String(agoMs), slug]);
    }
    async function fact(text: string, agoMs: number): Promise<number> {
      const { id } = await engine.insertFact({ fact: text, kind: 'fact', visibility: 'world', entity_slug: null, source: 'test' } as never, { source_id: 'default' });
      await engine.executeRaw(`UPDATE facts SET created_at = now() - ($1 || ' milliseconds')::interval WHERE id = $2`, [String(agoMs), id]);
      return id;
    }

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close, databaseUrl } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      faults.failing.clear();
      faults.throwOnAccess.clear();
      faults.sql = null;
      faults.delayMs = 0;
      notices = [];
      __resetHotMemoryCacheForTests();
      await engine.executeRaw('DELETE FROM session_context_state');
      await engine.executeRaw('DELETE FROM facts');
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'notes/%' OR slug LIKE 'people/%'`);
    });

    test('pages arm throws: neither the session nor the stateless cursor advances, and the next call delivers the page', async () => {
      await call({ session_id: 's1' });
      await rewind('10 seconds');
      const before = (await state())!.last_wake_at;
      await page('notes/missed-by-failed-read', 2_600);

      faults.failing.add('listPages');
      const failed = await call({ session_id: 's1' });
      expect(failed.degraded_reason).toContain('pages');
      expect(failed.pages).toEqual([]);
      expect((await state())!.last_wake_at).toBe(before);
      expect(failed.next_cursor.since).toBe(before);

      const stateless = await call({ since: before });
      expect(stateless.next_cursor.since).toBe(before);

      faults.failing.clear();
      const retry = await call({ session_id: 's1' });
      expect(retry.degraded_reason).toBeUndefined();
      expect(retry.pages.map((p: R) => p.slug)).toContain('notes/missed-by-failed-read');
    });

    test('facts arm throws while pages are delivered: pages advance, facts hold, and the facts arrive on the next call', async () => {
      await call({ session_id: 's1' });
      await rewind('10 seconds');
      const factsBefore = await factsCursor();
      await fact('fact recorded before the failed read', 5_000);
      await page('notes/delivered-page', 3_000);

      faults.failing.add('listFactsKeyset');
      const failed = await call({ session_id: 's1' });
      expect(failed.degraded_reason).toContain('facts');
      expect(failed.facts).toEqual([]);
      expect(failed.pages.map((p: R) => p.slug)).toEqual(['notes/delivered-page']);
      expect((await state())!.last_wake_at).toBe(failed.pages[0].updated_at);
      expect(await factsCursor()).toMatchObject({ at: factsBefore.at });
      // The legacy single cursor holds entirely while any arm failed.
      expect(failed.next_cursor.since).toBe(failed.since);

      faults.failing.clear();
      const retry = await call({ session_id: 's1' });
      expect(retry.facts.map((f: R) => f.fact)).toContain('fact recorded before the failed read');
      expect(retry.pages).toEqual([]);
    });

    test('deadline: injected latency leaves every arm unknown in one snapshot, and an unknown arm holds its cursor', async () => {
      await page('notes/slow-page', 5_000);
      faults.delayMs = 300;
      const res = await assembleDeltaContext(faulty(engine, faults), { sourceId: 'default', since: new Date(Date.now() - 60_000).toISOString(), deadlineMs: 40 });
      expect(res.degradedReason).toBe('deadline');
      expect(res.deltaArms).toEqual({ pages: 'unknown', facts: 'unknown', threads: 'unknown' });
      await new Promise((r) => setTimeout(r, 400));
      // The late completion never mutates the returned snapshot.
      expect(res.deltaArms).toEqual({ pages: 'unknown', facts: 'unknown', threads: 'unknown' });
      expect(res.deltaPages).toEqual([]);
    });

    test('budget-dropped facts re-surface; a duplicate cluster spanning the budget cut loses nothing', async () => {
      await call({ session_id: 's1' });
      await rewind('1 minute');
      const long = 'x'.repeat(200);
      await fact(`dup claim ${long}`, 50_000);
      await fact(`distinct claim B ${long}`, 40_000);
      await fact(`dup claim ${long}`, 30_000);
      await fact(`distinct claim C ${long}`, 20_000);
      const seen = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const r = await call({ session_id: 's1', budget_tokens: 140 });
        for (const f of r.facts) seen.add(f.fact.slice(0, 18));
        if (!r.has_more) break;
      }
      expect([...seen].sort()).toEqual(['distinct claim B x', 'distinct claim C x', 'dup claim xxxxxxxx']);
    });

    test('a budget too small for one waiting item says so with the budget that fits, and moves no cursor', async () => {
      await call({ session_id: 's1' });
      await rewind('1 minute');
      await fact(`oversized ${'y'.repeat(400)}`, 30_000);
      const before = await factsCursor();
      const r = await call({ session_id: 's1', budget_tokens: 40 });
      expect(r.facts).toEqual([]);
      expect(r.has_more).toBe(true);
      expect(await factsCursor()).toMatchObject({ at: before.at, id: before.id });
      const fix = incomplete()[0]?.fix;
      expect(fix?.actor).toBe('agent');
      const needed = Number(fix?.argv?.[fix.argv.indexOf('--budget-tokens') + 1]);
      expect(needed).toBeGreaterThan(40);
      const ok = await call({ session_id: 's1', budget_tokens: needed });
      expect(ok.facts.map((f: R) => f.fact.slice(0, 9))).toEqual(['oversized']);
    });

    test('session-state read error: retryable refusal, checkpoint kept, the next wake delivers from it', async () => {
      await call({ session_id: 's1' });
      await rewind('10 seconds');
      const before = (await state())!.last_wake_at;
      await page('notes/after-checkpoint', 5_000);
      faults.sql = /SELECT[\s\S]*session_context_state/;
      await expect(call({ session_id: 's1' })).rejects.toMatchObject({ code: 'unavailable', reason: 'session_state' });
      faults.sql = null;
      expect((await state())!.last_wake_at).toBe(before);
      const r = await call({ session_id: 's1' });
      expect(r.pages.map((p: R) => p.slug)).toContain('notes/after-checkpoint');
    });

    test('session-state write error: session_state degraded with a stateless continuation', async () => {
      await call({ session_id: 's1' });
      await rewind('10 seconds');
      await page('notes/write-fails', 5_000);
      faults.sql = /INSERT INTO session_context_state/;
      const r = await call({ session_id: 's1' });
      expect(r.degraded_reason).toBe('session_state');
      expect(r.pages.map((p: R) => p.slug)).toEqual(['notes/write-fails']);
      expect(typeof r.next_cursor.cursor).toBe('string');
      expect(incomplete()).toHaveLength(1);
      faults.sql = null;
      const resumed = await call({ cursor: r.next_cursor.cursor });
      expect(resumed.pages).toEqual([]);
    });

    test('first wake (including a GC-expired session) says the cursor started now and how to replay', async () => {
      await call({ session_id: 's1' });
      await engine.executeRaw('DELETE FROM session_context_state');
      notices = [];
      const r = await call({ session_id: 's1' });
      expect(r.pages).toEqual([]);
      const n = notices.find((x) => x.code === 'empty_retrieval');
      expect(n?.kind).toBe('info');
      expect(n?.why).toContain('replay statelessly with since');
    });

    test('a thread builder throw marks threads degraded and holds the time cursor', async () => {
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example works on things.' });
      await call({ session_id: 's1' });
      await rewind('10 seconds');
      const before = (await state())!.last_wake_at;
      await page('notes/with-threads', 5_000);
      faults.throwOnAccess.add('getLinks');
      const r = await call({ session_id: 's1', entities: 'people/alice-example' });
      expect(r.degraded_reason).toContain('threads');
      expect((await state())!.last_wake_at).toBe(before);
    });

    test('escalation: wait on the first two degraded wakes, report on the third; rendered on CLI, stdio and HTTP', async () => {
      await call({ session_id: 's1' });
      faults.failing.add('listPages');
      for (let i = 0; i < 3; i++) await call({ session_id: 's1' });
      const [a, b, c] = incomplete();
      for (const rc of [cli, stdio, http]) {
        expect(renderNotice(a, rc).fix?.next).toBe('wait');
        expect(renderNotice(b, rc).fix?.next).toBe('wait');
        expect(renderNotice(c, rc).fix?.next).toBe('report');
      }
      expect(renderNotice(a, stdio).fix?.mcp).toEqual({ tool: 'delta', arguments: { session_id: 's1' } });
      expect(renderNotice(a, cli).fix?.argv).toEqual(['gbrain', 'delta', '--session-id', 's1']);
      expect(Number((await factsCursor()).n)).toBe(3);
      faults.failing.clear();
      await call({ session_id: 's1' });
      expect(Number((await factsCursor()).n)).toBe(0);
    });

    test('stateless callers always get wait; concurrent degraded wakes count atomically', async () => {
      faults.failing.add('listPages');
      for (let i = 0; i < 3; i++) await call({ since: new Date(Date.now() - 60_000).toISOString() });
      expect(incomplete().map((n) => renderNotice(n, stdio).fix?.next)).toEqual(['wait', 'wait', 'wait']);
      await call({ session_id: 'atomic' });
      await Promise.all(Array.from({ length: 5 }, () =>
        upsertSessionContextState(engine, 'default', null, 'atomic', { degradedWakes: 'increment' })));
      expect(Number((await factsCursor('atomic')).n)).toBe(5);
    });

    test('store down: the consecutive count falls back to the process and still escalates', async () => {
      const sid = `down-${kind}`;
      await call({ session_id: sid });
      faults.failing.add('listPages');
      faults.sql = /INSERT INTO session_context_state/;
      for (let i = 0; i < 3; i++) await call({ session_id: sid });
      expect(incomplete().map((n) => renderNotice(n, stdio).fix?.next)).toEqual(['wait', 'wait', 'report']);
    });

    test('120 facts since the cursor drain with none lost (session and stateless cursor)', async () => {
      await call({ session_id: 's1' });
      await rewind('10 minutes');
      const ids: number[] = [];
      for (let i = 0; i < 120; i++) ids.push(await fact(`bulk fact ${i}`, 300_000 - i * 10));
      const session = await drain({ session_id: 's1' }, () => ({ session_id: 's1' }));
      expect(session.ids.size).toBe(120);
      expect(session.calls).toBeGreaterThanOrEqual(3);
      const since = new Date(Date.now() - 600_000).toISOString();
      const stateless = await drain({ since }, (r) => ({ cursor: r.next_cursor.cursor }));
      expect([...stateless.ids].sort((x, y) => x - y)).toEqual([...ids].sort((x, y) => x - y));
    });

    test('old request shape (since + since_slug only) loses nothing and resets the slug when it clamps', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 70; i++) ids.push(await fact(`legacy fact ${i}`, 300_000 - i * 10));
      for (let i = 0; i < 3; i++) await page(`notes/legacy-page-${i}`, 100_000 - i * 10);
      const since = new Date(Date.now() - 600_000).toISOString();
      let clampedSlug = 'never clamped';
      const res = await drain({ since }, (r) => {
        if (r.has_more && r.next_cursor.slug === '') clampedSlug = '';
        return { since: r.next_cursor.since, since_slug: r.next_cursor.slug };
      });
      expect(res.ids.size).toBe(70);
      expect(res.slugs.size).toBe(3);
      expect(clampedSlug).toBe('');
    });

    test('an unpageable same-timestamp boundary refuses legacy callers with delta_cursor_upgrade_required; the cursor drains it', async () => {
      const at = new Date(Date.now() - 300_000).toISOString();
      for (let i = 0; i < 60; i++) {
        const id = await fact(`tied fact ${i}`, 0);
        await engine.executeRaw(`UPDATE facts SET created_at = $1::text::timestamptz WHERE id = $2`, [at, id]);
      }
      const since = new Date(Date.now() - 600_000).toISOString();
      const r1 = await call({ since });
      expect(r1.facts).toHaveLength(50);
      let refusal: R | null = null;
      try {
        await call({ since: r1.next_cursor.since, since_slug: r1.next_cursor.slug });
      } catch (e) { refusal = e as R; }
      expect(refusal?.code).toBe('delta_cursor_upgrade_required');
      const cursor = refusal!.fix.mcp.arguments.cursor as string;
      const factsArm = (c: string) => JSON.parse(Buffer.from(c, 'base64url').toString('utf8')).f;
      expect(factsArm(cursor)).toEqual(factsArm(r1.next_cursor.cursor));
      const res = await drain({ cursor }, (r) => ({ cursor: r.next_cursor.cursor }));
      expect(res.ids.size + r1.facts.length).toBe(60);
    });

    test('replay: a gap larger than both arm limits drains statelessly without moving the session cursor', async () => {
      await call({ session_id: 's1' });
      await rewind('20 minutes');
      const sessionBefore = (await state())!.last_wake_at;
      for (let i = 0; i < 60; i++) await page(`notes/gap-page-${String(i).padStart(2, '0')}`, 600_000 - i * 10);
      for (let i = 0; i < 60; i++) await fact(`gap fact ${i}`, 600_000 - i * 10);
      const since = new Date(Date.now() - 1_200_000).toISOString();
      const res = await drain({ since }, (r) => ({ cursor: r.next_cursor.cursor }));
      expect(res.slugs.size).toBe(60);
      expect(res.ids.size).toBe(60);
      expect((await state())!.last_wake_at).toBe(sessionBefore);
    });

    test('a >limit page cluster inside ONE millisecond drains with no re-delivery (microsecond keyset binds exactly on both engines)', async () => {
      for (let i = 0; i < 55; i++) {
        const slug = `notes/ms-${String(i).padStart(2, '0')}`;
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug });
        await engine.executeRaw(`UPDATE pages SET updated_at = '2026-08-10T12:00:00.000000Z'::timestamptz + ($1 || ' microseconds')::interval WHERE slug = $2`, [String(i + 1), slug]);
      }
      const delivered: string[] = [];
      let args: Record<string, unknown> = { since: '2026-08-10T11:00:00Z' };
      for (let i = 0; i < 6; i++) {
        const r = await call(args);
        delivered.push(...r.pages.map((p: R) => p.slug));
        if (!r.has_more) break;
        args = { since: r.next_cursor.since, since_slug: r.next_cursor.slug };
      }
      expect(delivered).toHaveLength(55);
      expect(new Set(delivered).size).toBe(55);
    });

    test('cursor validation: malformed, out-of-range and non-integer ids are invalid_params', async () => {
      const enc = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64url');
      for (const cursor of [
        'not a cursor!',
        enc({ v: 2, p: ['2026-01-01T00:00:00Z', null], f: ['2026-01-01T00:00:00Z', 1] }),
        enc({ v: 1, p: ['0000-01-01T00:00:00.000000Z', null], f: ['2026-01-01T00:00:00Z', 1] }),
        enc({ v: 1, p: ['2026-02-31T00:00:00Z', null], f: ['2026-01-01T00:00:00Z', 1] }),
        enc({ v: 1, p: ['2026-01-01T00:00:00Z', null], f: ['2026-01-01T00:00:00Z', 1.5] }),
        enc({ v: 1, p: ['2026-01-01T00:00:00Z', null], f: ['2026-01-01T00:00:00Z', -1] }),
      ]) {
        await expect(call({ cursor, session_id: 'validation' })).rejects.toMatchObject({ code: 'invalid_params' });
      }
    });

    test('since outside years 0001-9999 (year 0000, 10000, negative) is invalid_params naming the range', async () => {
      for (const since of ['0000-01-01T00:00:00.000000Z', '0000-12-31T00:00:00Z', '+010000-01-01T00:00:00Z', '-000001-01-01T00:00:00Z', '0001-01-01T00:30:00+01:00']) {
        await expect(call({ since })).rejects.toMatchObject({ code: 'invalid_params' });
      }
      await expect(call({ since: '0000-01-01T00:00:00.000000Z' })).rejects.toThrow(/0001-01-01/);
      const ok = await call({ since: '0001-01-01T00:00:00Z' });
      expect(ok.since).toBe('0001-01-01T00:00:00.000Z');
    });

    test('migration v208 initializes an existing row\'s facts cursor from last_wake_at', async () => {
      await engine.executeRaw(`INSERT INTO session_context_state (source_id, client_id, session_id, last_wake_at) VALUES ('default', 'local', 'legacy-row', '2026-08-10T12:00:00.000123Z')`);
      await engine.executeRaw(`UPDATE session_context_state SET facts_cursor_at = NULL, facts_cursor_id = NULL, degraded_wakes = 0 WHERE session_id = 'legacy-row'`);
      for (const stmt of V208_SQL_FOR_TESTS) await engine.executeRaw(stmt);
      expect(await factsCursor('legacy-row')).toMatchObject({ at: '2026-08-10T12:00:00.000123Z' });
      expect(Number((await factsCursor('legacy-row')).id)).toBe(0);
    });

    if (kind === 'postgres') {
      test('commit visibility: a transaction committing within the lag is delivered; beyond it, the documented bound', async () => {
        const other = postgres(databaseUrl, { max: 1, prepare: false });
        try {
          await call({ session_id: 'vis' });
          await engine.executeRaw(`UPDATE session_context_state SET last_wake_at = now() - interval '1 minute', facts_cursor_at = now() - interval '1 minute', facts_cursor_id = 0 WHERE session_id = 'vis'`);
          // Within the lag: the row's created_at (transaction start) stays after the horizon the empty wake advances to.
          await other.begin(async (tx) => {
            await tx`INSERT INTO facts (source_id, fact, kind, visibility, source) VALUES ('default', 'late but within lag', 'fact', 'world', 'test')`;
            await call({ session_id: 'vis' });
          });
          const within = await call({ session_id: 'vis' });
          expect(within.facts.map((f: R) => f.fact)).toContain('late but within lag');
          // Beyond the lag: a transaction that started before the horizon and commits after an empty wake is missed.
          await engine.executeRaw(`UPDATE session_context_state SET facts_cursor_at = now(), facts_cursor_id = 0 WHERE session_id = 'vis'`);
          await other.begin(async (tx) => {
            await tx`INSERT INTO facts (source_id, fact, kind, visibility, source) VALUES ('default', 'late beyond lag', 'fact', 'world', 'test')`;
            await new Promise((r) => setTimeout(r, 2_300));
            await call({ session_id: 'vis' });
          });
          const beyond = await call({ session_id: 'vis' });
          expect(beyond.facts.map((f: R) => f.fact)).not.toContain('late beyond lag');
        } finally {
          await other.end();
        }
      }, 30_000);
    }
  });
}

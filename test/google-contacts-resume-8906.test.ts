/** #8906: a People re-list makes durable bounded progress before later services run. Synthetic API only. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { runGoogleSync, parseGoogleSourceConfig } from '../src/core/google/google-source.ts';
import { createConnectorFixture, contact, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const f = createConnectorFixture();
beforeAll(f.setup, 180_000);
afterAll(f.teardown);

test('an expired cursor re-lists in bounded pages, resumes without replay, then banks its token before Calendar fails', () => withEnv(f.env, async () => {
  for (const engine of f.engines) {
    const config = { ...googleConfig, g_services: 'contacts,calendar' };
    const source = await f.boundSource(engine, config);
    const cfg = parseGoogleSourceConfig(config, source.dir);
    let baseline = true;
    const pages: number[] = [];
    let calendarCalls = 0;
    const fetcher = withGoogleAccount(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/connections')) {
        if (baseline) return json({ connections: [], nextSyncToken: 'expired-example' });
        const sync = u.searchParams.get('syncToken');
        if (sync === 'expired-example') return json({ error: { code: 410, message: 'Sync token expired' } }, 410);
        if (sync === 'fresh-example') return json({ connections: [], nextSyncToken: 'fresh-example' });
        const page = Number(u.searchParams.get('pageToken') ?? 0);
        pages.push(page);
        return json({ connections: [contact(`c${page}`, `Person Example ${page}`)],
          ...(page < 5 ? { nextPageToken: String(page + 1) } : { nextSyncToken: 'fresh-example' }) });
      }
      if (u.pathname.endsWith('/events')) {
        calendarCalls++;
        return baseline ? json({ items: [], nextSyncToken: 'calendar-example' }) : json({ error: { message: 'fixture calendar failure' } }, 400);
      }
      throw new Error(`Unexpected fixture route ${u.pathname}`);
    });
    const run = () => runGoogleSync(engine, source.id, cfg, options, fetcher);
    await run();
    baseline = false;
    await run();
    expect(pages, engine.kind).toEqual([0, 1, 2, 3]);
    expect(calendarCalls).toBe(2);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [source.id]))[0]!.n).toBe(4);
    await run();
    expect(pages).toEqual([0, 1, 2, 3, 4, 5]);
    expect(calendarCalls).toBe(3);
    // A partial later service must not discard the completed contacts checkpoint.
    await run();
    expect(pages).toEqual([0, 1, 2, 3, 4, 5]);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [source.id]))[0]!.n).toBe(6);
  }
}), 180_000);

test('a failed continuation resumes the last published page; cancellation cannot bank the fetched page', () => withEnv(f.env, async () => {
  for (const engine of f.engines) {
    const source = await f.boundSource(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, source.dir);
    let fail = true;
    let cancel = false;
    let controller = new AbortController();
    const pages: number[] = [];
    const fetcher = withGoogleAccount(async (url: string) => {
      const u = new URL(url);
      if (!u.pathname.endsWith('/connections')) throw new Error(`Unexpected fixture route ${u.pathname}`);
      if (u.searchParams.get('syncToken') === 'finished') return json({ connections: [], nextSyncToken: 'finished' });
      const page = Number(u.searchParams.get('pageToken') ?? 0);
      pages.push(page);
      if (page === 1 && fail) return json({ error: { message: 'synthetic listing failure' } }, 400);
      if (page === 1 && cancel) controller.abort(new Error('synthetic cancellation'));
      return json({ connections: [contact(`resume${page}`, `Resume Example ${page}`)],
        ...(page === 0 ? { nextPageToken: '1' } : { nextSyncToken: 'finished' }) });
    });
    const run = () => runGoogleSync(engine, source.id, cfg, { ...options, signal: controller.signal }, fetcher);
    await run();
    expect(pages).toEqual([0, 1]);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [source.id]))[0]!.n).toBe(1);
    fail = false;
    cancel = true;
    await run().catch(error => { if (!controller.signal.aborted) throw error; });
    expect(pages).toEqual([0, 1, 1]);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [source.id]))[0]!.n).toBe(1);
    controller = new AbortController();
    cancel = false;
    await run();
    expect(pages).toEqual([0, 1, 1, 1]);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [source.id]))[0]!.n).toBe(2);
    await run();
    expect(pages).toEqual([0, 1, 1, 1]);
  }
}), 180_000);

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { contact, createConnectorFixture, googleConfig, json, options, sourceCheckpoint, withGoogleAccount } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const PAGES = 4;
const PER_PAGE = 5;

test('#8906 managed contacts re-list: a deadline mid-list keeps the checkpointed pages in the connector state; the next run resumes there and applies every contact once', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const pageTokens: Array<string | null> = [];
    let onList: (() => void) | undefined;
    const fetcher = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (!u.pathname.endsWith('/people/me/connections')) return json({ error: { message: 'unexpected fixture route' } }, 400);
      const pageToken = u.searchParams.get('pageToken');
      pageTokens.push(pageToken);
      onList?.();
      if (init?.signal?.aborted) throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      const n = pageToken === null ? 1 : Number(pageToken.slice(1));
      const connections = Array.from({ length: PER_PAGE }, (_, i) => contact('c' + ((n - 1) * PER_PAGE + i), 'Person ' + ((n - 1) * PER_PAGE + i) + ' Example'));
      return json(n < PAGES ? { connections, nextPageToken: 'p' + (n + 1) } : { connections, nextSyncToken: 'ppl-new' });
    };
    const run = (signal?: AbortSignal) => runGoogleSync(engine, f.id, cfg, { ...options, ...(signal ? { signal } : {}) }, withGoogleAccount(fetcher, cfg.account));
    const imports = async () => (await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY slug", [f.id])).map((r) => r.slug);
    const state = async () => {
      await disposePersistenceConsumer(engine);
      const [row] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { contacts_sync_token?: string | null; contacts_relist?: { page_token: string } | null } }[] }[];
      return row?.completed_keys[0]?.state;
    };

    // The deadline fires as the run asks for page 3: pages 1 and 2 are banked.
    const controller = new AbortController();
    onList = () => { if (pageTokens.length === 3) controller.abort(); };
    const aborted = await run(controller.signal).then((r) => r.status, (e: Error) => e.name);
    expect(['partial', 'AbortError']).toContain(aborted);
    expect(pageTokens).toEqual([null, 'p2', 'p3']);
    const banked = await state();
    expect(banked?.contacts_relist?.page_token).toBe('p3');
    expect(banked?.contacts_sync_token ?? null).toBeNull();
    expect(await imports()).toHaveLength(2 * PER_PAGE);

    onList = undefined;
    pageTokens.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(pageTokens).toEqual(['p3', 'p4']);
    const all = await imports();
    expect(all).toHaveLength(PAGES * PER_PAGE);
    expect(new Set(all).size).toBe(PAGES * PER_PAGE);
    const done = await state();
    expect(done?.contacts_sync_token).toBe('ppl-new');
    expect(done?.contacts_relist ?? null).toBeNull();
  }
}), 120_000);

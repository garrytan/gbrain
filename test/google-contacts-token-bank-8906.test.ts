import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, sourceCheckpoint, withGoogleAccount, contact } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

test('contacts syncToken is banked before gmail runs, so a wall-clock abort in gmail does not lose a long re-list (#8906)', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'contacts,gmail' };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const controller = new AbortController();
    let contactsListed = false;
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.includes('/people/me/connections')) { contactsListed = true; return json({ connections: [contact('c000000001', 'Alice Example')], nextSyncToken: 'ppl-sync-1' }); }
      // The wall-clock budget expires once the contacts re-list is done.
      if (contactsListed) controller.abort();
      return json({ error: { message: 'aborted fixture route' } }, 500);
    };
    const outcome = await runGoogleSync(engine, f.id, cfg, { ...options, signal: controller.signal }, withGoogleAccount(fetcher, cfg.account))
      .then((r) => r.status, (e: Error) => e.name);
    expect(typeof outcome).toBe('string');
    await disposePersistenceConsumer(engine);
    const [row] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { contacts_sync_token?: string | null } }[] }[];
    expect(row?.completed_keys[0]?.state?.contacts_sync_token).toBe('ppl-sync-1');
  }
}), 120_000);

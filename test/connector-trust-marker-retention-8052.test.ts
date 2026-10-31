import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { repairPageMarker } from '../src/core/trust/page-handlers.ts';
import { createConnectorFixture, options, json, googleConfig, contact, withGoogleAccount } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

test('a managed Google re-render retains a repaired trust marker', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig };
    const f = await source(engine, config);
    let changed = false;
    const fetcher = async (url: string) => {
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      if (url.includes('/people/me/connections')) return json({
        connections: [{ ...contact('fixture-1', 'Fixture Contact'), ...(changed ? { phoneNumbers: [{ value: '555-0100' }] } : {}) }],
        nextSyncToken: 'contacts-next',
      });
      throw new Error('Unexpected fixture route');
    };
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const run = () => runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(fetcher));
    await run();
    const [row] = await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM pages WHERE source_id=$1 AND frontmatter->>'google_contact_id'='people/fixture-1'", [f.id]);
    const snapshot = await engine.readPageSnapshot(row!.slug, { sourceId: f.id });
    await repairPageMarker(engine, { sourceId: f.id, slug: row!.slug, expectedRevision: snapshot!.revision,
      confirmation: { via: 'preview_hash' } });
    expect((await engine.readPageSnapshot(row!.slug, { sourceId: f.id }))?.page.frontmatter.trust_tier).toBe('external_untrusted');

    changed = true;
    await run();

    expect((await engine.readPageSnapshot(row!.slug, { sourceId: f.id }))?.page.frontmatter.trust_tier).toBe('external_untrusted');
  }
}), 120_000);

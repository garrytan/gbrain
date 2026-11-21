/**
 * #9676: a connector import stored a new page as external_untrusted but rendered no trust_tier marker into its
 * frontmatter (#8052 carried an existing marker only), so a re-read of the page file could place it above its stored
 * tier and doctor provenance_stamp_drift counted every new import under marker_missing.
 *
 * Protects: every managed connector import renders trust_tier: external_untrusted, on a new page and on a re-render
 * of a page stored without the marker, so the database row and its file agree from the first write. The marker is
 * the least trusted of the stored marker and the import's tier, so a stored marker never raises the page.
 * Seams: none; the real managed Google importer with a fake People API, PGLite always and Postgres when DATABASE_URL
 * is set (test/e2e/connector-trust-marker-9676.test.ts).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { scanProvenanceDrift } from '../src/core/trust/provenance-drift.ts';
import { contact, createConnectorFixture, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

async function connectorSource(engine: BrainEngine, bound = false) {
  const f = bound ? await boundSource(engine, googleConfig) : await source(engine, googleConfig);
  let generation = 0;
  const fetcher = withGoogleAccount(async (url: string) => {
    if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
    if (url.includes('/people/me/connections')) {
      return json({ connections: [{ ...contact('c1', 'Alice Example'), organizations: [{ name: `Acme Example ${generation}` }] }], nextSyncToken: `token-${generation}` });
    }
    throw new Error(`Unexpected Google fixture route: ${url}`);
  }, googleConfig.g_account);
  const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
  const sync = async () => {
    const result = await runGoogleSync(engine, f.id, cfg, options, fetcher);
    expect(result.failedFiles ?? 0).toBe(0);
  };
  await sync();
  const [page] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id]);
  const read = async () => (await engine.executeRaw<{ trust_tier: string; marker: string | null; org: string }>(
    "SELECT trust_tier, frontmatter->>'trust_tier' AS marker, compiled_truth AS org FROM pages WHERE source_id=$1 AND slug=$2", [f.id, page!.slug]))[0]!;
  const files = () => (readdirSync(f.dir, { recursive: true }) as string[]).filter(p => p.endsWith('.md') && !p.split('/').some(s => s.startsWith('.')))
    .map(p => readFileSync(join(f.dir, p), 'utf8')).filter(text => text.includes('Alice Example'));
  const resync = async () => { generation++; await sync(); expect((await read()).org).toContain(`Acme Example ${generation}`); };
  const setMarker = async (marker: string | null) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw(marker === null ? "UPDATE pages SET frontmatter = frontmatter - 'trust_tier' WHERE source_id=$1 AND slug=$2"
      : `UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('trust_tier', $3::text) WHERE source_id=$1 AND slug=$2`, marker === null ? [f.id, page!.slug] : [f.id, page!.slug, marker]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect((await read()).marker).toBe(marker);
  };
  return { id: f.id, read, files, resync, setMarker };
}

test('a new connector import renders the trust_tier marker into the row and its file, and the drift check stays at zero', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await connectorSource(engine, true);
    expect(await s.read()).toMatchObject({ trust_tier: 'external_untrusted', marker: 'external_untrusted' });
    expect(s.files().length).toBeGreaterThan(0);
    for (const file of s.files()) expect(file).toContain('trust_tier: external_untrusted');
    expect((await scanProvenanceDrift(engine, s.id)).marker_missing).toBe(0);
    await s.resync();
    expect(await s.read()).toMatchObject({ trust_tier: 'external_untrusted', marker: 'external_untrusted' });
    expect((await scanProvenanceDrift(engine, s.id)).marker_missing).toBe(0);
  }
}), 180_000);

test('a page stored without the marker gets it on the next connector import', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await connectorSource(engine);
    await s.setMarker(null);
    await s.resync();
    expect(await s.read()).toMatchObject({ trust_tier: 'external_untrusted', marker: 'external_untrusted' });
    expect((await scanProvenanceDrift(engine, s.id)).marker_missing).toBe(0);
  }
}), 180_000);

test('a stored marker never raises the page: a higher one is lowered to the tier the import assigns', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await connectorSource(engine);
    await s.setMarker('agent_written');
    await s.resync();
    expect(await s.read()).toMatchObject({ trust_tier: 'external_untrusted', marker: 'external_untrusted' });
  }
}), 180_000);

// Condition from review: the changed render is the connector publisher's own prepareFrontmatter (connector_v2_* intents
// only, local connector writers only). put_page and every other page write stamps through page-prepare's own hook, so
// an owner's local write and a full-surface member's write keep the tier they had before #9676.
test('an owner local put_page and a full-surface member put_page keep their own tier, never the connector one', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await connectorSource(engine);
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-example') ON CONFLICT DO NOTHING");
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method,
      client_id_issued_at, source_id, federated_read, member_id) VALUES ('member-client-example', 'x', 'member-client-example', '{}', '{client_credentials}', 'read write',
      'client_secret_post', 0, 'default', '{default}', 'alice-example') ON CONFLICT DO NOTHING`);
    const auth = { token: 't', clientId: 'member-client-example', principal: { kind: 'oauth_client', id: 'member-client-example' },
      scopes: ['read', 'write'], member: { id: 'alice-example', groups: [] } } as unknown as AuthInfo;
    const writers = {
      owner: { remote: false, sourceId: 'default' },
      member: { remote: true, transport: 'http', surface: 'full', auth, sourceId: 'default' },
    } as const;
    const tiers: Record<string, unknown> = {};
    for (const [who, opts] of Object.entries(writers)) {
      const slug = `notes/${who}-write-example`;
      const res = await dispatchToolCall(engine, 'put_page', { slug, content: `---\ntype: note\ntitle: ${who}\n---\n# ${who}\nA note the ${who} wrote.` }, opts as never);
      expect({ who, error: res.isError === true ? res.content.map(c => c.text).join('') : null }).toEqual({ who, error: null });
      const [row] = await engine.executeRaw<{ trust_tier: string; marker: string | null }>(
        "SELECT trust_tier, frontmatter->>'trust_tier' AS marker FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]);
      tiers[who] = row;
    }
    const own = { trust_tier: 'agent_written', marker: 'agent_written' };
    expect(tiers).toEqual({ owner: own, member: own });
  }
}), 180_000);

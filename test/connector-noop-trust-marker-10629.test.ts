/**
 * #10629: a connector page imported before the trust_tier marker was stamped has no marker line in its canonical file.
 * Re-fetching the unchanged item is a no-op, but the prepared file target carried the stamped marker, so the unchanged
 * check admitted it as canonical_file_differs on every sweep.
 *
 * Protects: an unchanged re-fetch of such a page is skipped without queueing a new persistence request.
 * Seams: the real managed Google importer with a fake People API, PGLite always and Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { contact, createConnectorFixture, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

test('an unchanged re-fetch of a page whose file has no trust_tier marker queues no new request', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, googleConfig);
    let sweeps = 0;
    const fetcher = withGoogleAccount(async (url: string) => {
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      if (url.includes('/people/me/connections')) return json({ connections: [contact('c1', 'Alice Example')], nextSyncToken: `token-${++sweeps}` });
      throw new Error(`Unexpected Google fixture route: ${url}`);
    }, googleConfig.g_account);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    await runGoogleSync(engine, f.id, cfg, options, fetcher);
    await runGoogleSync(engine, f.id, cfg, options, fetcher); // settles pending projection work first
    // Rewind to the pre-#9691 state: no marker in the stored page or its file.
    const [page] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter - 'trust_tier' WHERE source_id=$1 AND slug=$2", [f.id, page!.slug]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const paths = (readdirSync(f.dir, { recursive: true }) as string[]).filter(p => p.endsWith('.md') && !p.split('/').some(s => s.startsWith('.')))
      .map(p => join(f.dir, p)).filter(p => readFileSync(p, 'utf8').includes('Alice Example'));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) writeFileSync(p, readFileSync(p, 'utf8').replace(/^trust_tier:.*\n/m, ''));
    const count = async () => Number((await engine.executeRaw<{ n: string }>("SELECT count(*) AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import'", [f.id]))[0]!.n);
    const before = await count();
    await runGoogleSync(engine, f.id, cfg, options, fetcher);
    expect(await count()).toBe(before);
  }
}), 180_000);

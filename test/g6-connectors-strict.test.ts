/**
 * G6 (git-canonical memory): the managed connectors on a strict (canonical: git) source are door-only.
 *
 * A managed Google sweep (google/sweep-shared.ts importRendered -> ManagedConnectorSync.importMarkdown) and a managed
 * GitHub sweep (github-source.ts materializePage -> the same importMarkdown) admit one connector_v2_import request per
 * item (persistence/connector-sync.ts submit) and the owner publishes each through publishMutation (PGLite) or
 * publishSingleWrite (Postgres). After a sweep of three items every page is at HEAD with the bytes on disk, the tree
 * is clean, the git-gap census reports no gap, and the sweep makes at most one commit per publication group.
 * PGLite here; Postgres in test/e2e/g6-connectors-strict-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { completeBaselineSweep, githubConfig, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { describeMeasure, expectDoorOnly, head, initStrictCheckout, measureBatch, strictSource } from './helpers/strict-door-census.ts';

const people = ['alice-example', 'bob-example', 'carol-example'];
const contactsFetch = withGoogleAccount(async (url: string) => json(url.includes('/settings/sendAs') ? { sendAs: [] } : {
  connections: people.map(id => ({ resourceName: `people/${id}`, names: [{ displayName: id.replace('-example', ' Example') }],
    emailAddresses: [{ value: `${id}@example.invalid` }], organizations: [{ name: 'Acme Example' }] })),
  nextSyncToken: 'contacts-g6',
}));

const issues = [1, 2, 3].map(number => ({ number, title: `Example issue ${number}`, state: 'open', body: `Synthetic issue body ${number}.`,
  created_at: '2026-01-01T00:00:00Z', updated_at: `2026-01-0${number + 1}T00:00:00Z`, labels: [], assignees: [], user: { login: 'example-user' },
  html_url: `https://github.com/acme-example/app/issues/${number}` }));
const issuesFetch = async (url: string) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/issues')) return json(issues);
  if (path.endsWith('/pulls') || path.endsWith('/comments')) return json([]);
  const detail = /\/issues\/(\d+)$/.exec(path);
  if (detail) return json(issues.find(issue => issue.number === Number(detail[1])));
  if (path === '/repos/acme-example/app') return json({ full_name: 'acme-example/app', private: true, default_branch: 'main' });
  throw new Error(`Unexpected external fixture route ${path}`);
};

const env = { CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' };
const connectorSource = (config: Record<string, unknown>) => async ({ engine, root }: { engine: import('../src/core/engine.ts').BrainEngine; root: string }) => {
  initStrictCheckout(root);
  await engine.executeRaw("UPDATE sources SET config=$1::text::jsonb WHERE id='default'", [JSON.stringify(config)]);
};
const connectorSlugs = (engine: import('../src/core/engine.ts').BrainEngine) => engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug").then(rows => rows.map(row => row.slug));

for (const backend of testBackends()) describe(`[${backend}] G6: managed connectors on a strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('Google contacts sweep of three people: every page at HEAD, clean tree, no census gap, one commit per group', () => withEnv(env, () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const base = head(root);
    const run = () => runGoogleSync(engine, 'default', parseGoogleSourceConfig(googleConfig, root), options, contactsFetch);
    await completeBaselineSweep(engine, 'default', run);
    const slugs = await connectorSlugs(engine);
    expect(slugs.length).toBeGreaterThanOrEqual(people.length);
    const m = await measureBatch(engine, 'default', root, base, slugs);
    console.log(describeMeasure(`google/${backend}`, m));
    expectDoorOnly(m, expect);
  }, { databaseUrl, setup: connectorSource(googleConfig) })), 120_000);

  test('GitHub sweep of three issues: every page at HEAD, clean tree, no census gap, one commit per group', () => withEnv(env, () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const base = head(root);
    const run = () => runGitHubSync(engine, 'default', parseGitHubSourceConfig(githubConfig, root), options, issuesFetch);
    await completeBaselineSweep(engine, 'default', run);
    const slugs = await connectorSlugs(engine);
    expect(slugs.length).toBeGreaterThanOrEqual(issues.length);
    const m = await measureBatch(engine, 'default', root, base, slugs);
    console.log(describeMeasure(`github/${backend}`, m));
    expectDoorOnly(m, expect);
  }, { databaseUrl, setup: connectorSource(githubConfig) })), 120_000);
});

/**
 * G6 (git-canonical memory): the managed connectors on a strict (canonical: git) source are door-only.
 *
 * A managed Google sweep (google/sweep-shared.ts importRendered -> ManagedConnectorSync.importMarkdown) and a managed
 * GitHub sweep (github-source.ts materializePage -> the same importMarkdown) admit one connector_v2_import request per
 * item (persistence/connector-sync.ts submit) and the owner publishes each through publishMutation (PGLite) or
 * publishSingleWrite (Postgres). After a sweep of three items every page is at HEAD with the bytes on disk, the tree
 * is clean, the git-gap census reports no gap, and the sweep makes at most one commit per publication group.
 * PGLite here; Postgres in test/e2e/g6-connectors-strict-postgres.test.ts.
 *
 * #7971: protects=private connector transitions remove the former public file from disk and HEAD in the receipt's
 * commit without losing the live private page; fails_when=the strict-private branch omits the removal target;
 * why_new=the sweep census only covered public pages, not private transitions or HEAD-only removals; seam=none.
 * Also pins local-edit refusal, repeated/sticky privacy and newly private pages; no claim=erasing prior Git history.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { gitAsync } from './helpers/git-publication.ts';
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

  for (const [connector, config] of [['google', googleConfig], ['github', githubConfig]] as const) {
    for (const headOnly of [false, true]) test(`${connector}: becoming private removes the ${headOnly ? 'HEAD-only' : 'on-disk'} canonical file in the committed receipt (#7971)`, () => withEnv(env, () => managedBrain(async ({ engine, root }) => {
      await strictSource(engine);
      const path = 'notes/provider-event.md';
      const slug = 'notes/provider-event';
      const cfg = connector === 'google' ? parseGoogleSourceConfig(config, root) : parseGitHubSourceConfig(config, root);
      const content = (privatePage: boolean) => `---\ntitle: Synthetic provider event\ntype: note\n${privatePage ? 'visibility: private\n' : ''}---\nSynthetic provider content.\n`;
      const run = (privatePage: boolean) => withConnectorSync(engine, 'default', connector, cfg, options, async session => {
        expect(session).not.toBeNull();
        return session!.importMarkdown(path, content(privatePage));
      });
      await run(false);
      expect(await gitAsync(root, 'show', `HEAD:${path}`)).toContain('Synthetic provider content.');
      const publicHead = head(root);
      if (headOnly) unlinkSync(join(root, path));
      else {
        const bytes = readFileSync(join(root, path), 'utf8');
        writeFileSync(join(root, path), bytes + '\nUncoordinated local edit.\n');
        await expect(run(true)).rejects.toMatchObject({ code: 'source_changed' });
        expect(head(root)).toBe(publicHead);
        expect(readFileSync(join(root, path), 'utf8')).toContain('Uncoordinated local edit.');
        expect((await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter.visibility).not.toBe('private');
        writeFileSync(join(root, path), bytes);
      }
      await run(true);
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      expect(snapshot?.page.frontmatter.visibility).toBe('private');
      expect(snapshot?.page.compiled_truth).toContain('Synthetic provider content.');
      expect(existsSync(join(root, path))).toBe(false);
      expect(await gitAsync(root, 'ls-tree', '--name-only', 'HEAD', '--', path)).toBe('');
      expect(head(root)).not.toBe(publicHead);
      expect(await gitAsync(root, 'status', '--porcelain')).toBe('');
      const [receipt] = await engine.executeRaw<{ state: string; outcome: any }>(
        "SELECT state,outcome FROM persistence_requests WHERE slug=$1 AND source_id='default' ORDER BY sequence DESC LIMIT 1", [slug]);
      expect(receipt.state).toBe('committed');
      expect(receipt.outcome.persistence.git_commit).toBe(head(root));
      const [page] = await engine.executeRaw<{ database_only_reason: string; source_path: string | null }>(
        "SELECT database_only_reason,source_path FROM pages WHERE slug=$1 AND source_id='default'", [slug]);
      expect(page).toEqual({ database_only_reason: 'private', source_path: null });
      const privateHead = head(root);
      // A repeated render, and even a later public provider render, must not republish a private page.
      await run(true);
      await run(false);
      expect(head(root)).toBe(privateHead);
      expect(existsSync(join(root, path))).toBe(false);
      expect((await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter.visibility).toBe('private');
      await withConnectorSync(engine, 'default', connector, cfg, options, async session => {
        await session!.importMarkdown('notes/born-private.md', content(true).replace('Synthetic provider content.', 'New private provider content.'));
      });
      expect(existsSync(join(root, 'notes/born-private.md'))).toBe(false);
      expect(await gitAsync(root, 'ls-tree', '--name-only', 'HEAD', '--', 'notes/born-private.md')).toBe('');
      expect(head(root)).toBe(privateHead);
      expect((await engine.getPage('notes/born-private', { sourceId: 'default' }))?.frontmatter.visibility).toBe('private');
    }, { databaseUrl, setup: connectorSource(config) })), 120_000);
  }

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

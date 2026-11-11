/**
 * GST-2462 (D2): an operator can always make one page unreadable to callers not bound to the owner, even a page whose
 * file left git outside the write door and a page at the root of the source named after a folder, where put_page with
 * visibility: private refuses source_changed and a folder rule cannot name the page.
 *
 * 1. Protects: a page rule (slug: <exact slug>) restricts exactly one page, through the same applied rulebook, trigger
 *    stamp and read predicate as folder rules, with no page file written or committed; the owner keeps reading it;
 *    removing the rule is the undo (a widening, held until gbrain access apply).
 * 2. Fails when: a page rule is refused, leaks to an unbound caller, covers a sibling (a folder of the same name, a
 *    longer slug) or writes the page's file; or the TS and SQL matchers disagree.
 * 3. Real seams: the managed git source and its door, the gbrain access rule CLI module, the trigger stamp, MCP
 *    dispatch with tokens from the token service, PGLite and Postgres; a repo-less brain for the database store.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { folderRulesAllow, matchingRuleIds, normalizeRule, parsePolicyYaml, serializePolicyYaml } from '../src/core/access/folder-rules.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const op = (n: string) => operations.find(o => o.name === n)!;
const page = (title: string, body: string, extra = '') => `---\ntype: note\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const put = (ctx: OperationContext, slug: string, content: string, rev?: string) =>
  op('put_page').handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 30_000, ...(rev ? { expected_revision: rev } : {}) }) as Promise<Record<string, any>>;

async function cli(engine: BrainEngine, args: string[]): Promise<any> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runAccessRules(engine, args[0]!, [...args.slice(1), '--json'], true); } finally { spy.mockRestore(); }
  const text = lines.join('\n');
  try { return JSON.parse(text); } catch { throw new Error(`gbrain access ${args.join(' ')} printed no JSON: ${text}`); }
}

/** Mints an unbound token and one bound to the owner member; returns a reader that says whether get_page shows the slug. */
async function readers(engine: BrainEngine): Promise<(who: 'owner' | 'unbound', slug: string) => Promise<boolean>> {
  await engine.executeRaw("INSERT INTO access_members (id) VALUES ('owner-example') ON CONFLICT DO NOTHING");
  await engine.setConfig('access.owner_member', 'owner-example');
  const tokens: Record<string, string> = {};
  for (const who of ['owner', 'unbound'] as const) {
    const minted = await mintLegacyToken(engine, { name: `d2-${who}`, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
    tokens[who] = minted.token;
    if (who === 'owner') await engine.executeRaw("UPDATE access_tokens SET member_id = 'owner-example' WHERE id = $1::uuid", [minted.id]);
  }
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  __resetPrivateVisibilityCacheForTests();
  return async (who, slug) => {
    const auth = await provider.verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
    const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
    return out.isError !== true && out.content.map(c => c.text).join('\n').includes(`canary-${slug.replace(/\//g, '-')}`);
  };
}

const body = (slug: string) => `Body canary-${slug.replace(/\//g, '-')}.`;

describe('page rules (slug:) in the folder-rule grammar', () => {
  test('a slug rule matches exactly one page, never a folder of the same name or a longer slug, and round-trips', () => {
    const parsed = parsePolicyYaml('version: 1\nrules:\n  - slug: projects\n    readable_by: owner-example\n  - slug: notes/secret-example\n    readable_by: owner-example\n');
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    expect(parsed.rules.map(r => r.prefix).sort()).toEqual(['notes/secret-example', 'projects']);
    expect(parsePolicyYaml(serializePolicyYaml(parsed.rules))).toEqual(parsed);
    expect(new Set(parsed.rules.map(r => r.id)).size).toBe(2);
    const rules = parsed.rules;
    expect(matchingRuleIds('projects', rules)).toHaveLength(1);
    for (const slug of ['projects/plan', 'projects-old', 'projectsx', 'notes/secret-example-2', 'notes/secret-example/x']) expect(matchingRuleIds(slug, rules)).toBeNull();
    expect(folderRulesAllow('projects', rules, ['member:alice-example'])).toBe(false);
    expect(folderRulesAllow('projects/plan', rules, ['member:alice-example'])).toBe(true);
  });

  test('numeric and keyword-like slugs, prefixes and readers survive a write and read of access.yml', () => {
    const rules = ['2024', 'true', 'null', '1.5', '2024/'].map(p => { const r = normalizeRule(p.endsWith('/') ? { prefix: p, readable_by: ['2024'] } : { slug: p, readable_by: ['2024'] }); if (!('rule' in r)) throw new Error(r.problem); return r.rule; });
    const back = parsePolicyYaml(serializePolicyYaml(rules));
    expect(back.ok && back.rules.map(r => [r.id, r.prefix, r.readable_by])).toEqual([...rules].sort((a, b) => (a.id < b.id ? -1 : 1)).map(r => [r.id, r.prefix, r.readable_by]));
  });

  test('a prefix without a trailing slash is still refused, and names the slug form; slug and prefix together are refused', () => {
    const r = normalizeRule({ prefix: 'projects', readable_by: ['owner-example'] });
    expect('problem' in r && r.problem).toContain('slug: projects');
    expect('problem' in normalizeRule({ slug: 'projects', prefix: 'projects/', readable_by: ['owner-example'] })).toBe(true);
    for (const slug of ['Projects', 'projects/', '../x', '/projects', 'a//b', 'a/*']) expect('problem' in normalizeRule({ slug, readable_by: ['owner-example'] })).toBe(true);
  });
});

for (const backend of testBackends()) {
  describe(`page rules on a managed git source whose files left HEAD outside the door (${backend})`, () => {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
    const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), 'archive/\n'); durableGitRepo(root, ['.gitignore']); };

    test('a root page named after its folder and a page in a folder: put refuses, a page rule hides each from unbound callers only, writes no page file, and its removal is the undo', () => managedBrain(async ({ engine, ctx, root }) => {
      const slugs = ['projects', 'projects/plan', 'projectsx', 'notes/secret-example', 'notes/seed'];
      const revs: Record<string, string> = {};
      for (const slug of slugs) {
        const r = await put(ctx, slug, page(slug, body(slug)));
        expect(r).toMatchObject({ state: 'committed' });
        revs[slug] = r.revision;
      }
      await settleManagedGitEffects(engine);
      git(root, 'rm', '-q', '--', 'projects.md', 'notes/secret-example.md');
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'external removal');
      const head = git(root, 'rev-parse', 'HEAD').trim();
      const read = await readers(engine);
      for (const slug of slugs) expect({ slug, unbound: await read('unbound', slug) }).toEqual({ slug, unbound: true });

      for (const slug of ['projects', 'notes/secret-example']) {
        const refused = await put(ctx, slug, page(slug, body(slug), 'visibility: private\n'), revs[slug]).catch(e => ({ ...e, message: e.message }));
        expect(JSON.stringify(refused)).toContain('source_changed');
        expect(JSON.stringify(refused)).toContain(`gbrain access rule add --slug ${slug}`);
      }

      for (const slug of ['projects', 'notes/secret-example']) {
        const added = await cli(engine, ['rule', 'add', '--slug', slug, '--readers', 'owner-example', '--yes']);
        expect({ state: added.state, store: added.store, path: added.git?.path }).toEqual({ state: 'applied', store: 'git', path: '.gbrain/access.yml' });
      }
      const stamps = Object.fromEntries((await engine.executeRaw<{ slug: string; ids: string[] | null }>(
        "SELECT slug, folder_rule_ids AS ids FROM pages WHERE source_id='default' AND slug = ANY($1::text[])", [slugs])).map(r => [r.slug, r.ids]));
      expect(stamps['projects']).toHaveLength(1);
      expect(stamps['notes/secret-example']).toHaveLength(1);
      for (const slug of ['projects/plan', 'projectsx', 'notes/seed']) expect({ slug, ids: stamps[slug] }).toEqual({ slug, ids: null });

      for (const slug of slugs) {
        const hidden = slug === 'projects' || slug === 'notes/secret-example';
        expect({ slug, unbound: await read('unbound', slug), owner: await read('owner', slug) }).toEqual({ slug, unbound: !hidden, owner: true });
      }
      expect(existsSync(join(root, 'projects.md'))).toBe(false);
      expect(existsSync(join(root, 'notes', 'secret-example.md'))).toBe(false);
      expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toMatch(/^(projects|notes\/secret-example)\.md$/m);
      expect(git(root, 'diff', '--name-only', head, 'HEAD').trim().split('\n')).toEqual(['.gbrain/access.yml']);

      for (const slug of ['projects', 'notes/secret-example']) await cli(engine, ['rule', 'rm', (await cli(engine, ['rule', 'list'])).rules.find((r: any) => r.prefix === slug).id, '--yes']);
      expect(await read('unbound', 'projects')).toBe(false);
      const preview = await cli(engine, ['apply']);
      await cli(engine, ['apply', '--yes', '--expect', preview.plan_hash]);
      for (const slug of slugs) expect({ slug, unbound: await read('unbound', slug) }).toEqual({ slug, unbound: true });
    }, { databaseUrl, setup }), 240_000);
  });

  describe(`page rules on a repo-less brain (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({ engine: 'pglite' } as never); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const slug of ['projects', 'projects/plan']) await importFromContent(engine, slug, page(slug, body(slug)), { sourceId: 'default' });
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('a page rule on a root page hides it from unbound callers, keeps the folder page, and the owner reads both', async () => {
      const read = await readers(engine);
      const added = await cli(engine, ['rule', 'add', '--slug', 'projects', '--readers', 'owner-example', '--yes']);
      expect({ state: added.state, store: added.store }).toEqual({ state: 'applied', store: 'database' });
      const clash = await cli(engine, ['rule', 'add', '--prefix', 'projects.page/', '--readers', 'owner-example', '--yes']).catch(e => e);
      expect({ code: clash.code, message: clash.message }).toEqual({ code: 'access_rule_invalid', message: 'Rule id "projects.page" already names projects, and projects.page/ derives the same id.' });
      expect((await cli(engine, ['rule', 'list'])).rules.map((r: { id: string; prefix: string }) => [r.id, r.prefix])).toEqual([['projects.page', 'projects']]);
      expect({ unbound: await read('unbound', 'projects'), owner: await read('owner', 'projects'), folder: await read('unbound', 'projects/plan') })
        .toEqual({ unbound: false, owner: true, folder: true });
    }, 120_000);
  });
}

/**
 * GBRA-706: a git brain whose branch has no commit yet (`gbrain init --git`, the first day).
 *
 * 1. Protects: the first `gbrain sync --no-pull` on an unborn HEAD ends up to date instead of failing, and leaves the
 *    source's folder rules unmarked, so a remote read neither loses pages nor carries access_policy_pending; a source an
 *    older release already marked (the whole-source rebuild mark) is cleared by that same sync; the first commit then
 *    syncs as usual. A git store that already holds rules keeps enforcing them when its HEAD becomes unborn (an orphan
 *    branch): the removal is held and nothing is deleted.
 * 2. Fails when: the folder-rule history read on an unborn HEAD is taken for a partial clone again (the whole source
 *    reads as nobody remotely), the managed pass throws on `rev-parse HEAD`, or an unborn HEAD widens a git store.
 * 3. Existing coverage: access-folder-rules-git (the git store with history), access-first-import-gst2638 (first import).
 * 4. Real seams: an activated managed brain on a real git checkout (managedBrain), performSync (the managed pass, as
 *    `gbrain sync --no-pull` runs it), MCP dispatch with remote=true and member-bound tokens, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { coverageRows, markPolicyInvalid, policyStatus } from '../src/core/access/policy.ts';
import { rebuildPreflight } from '../src/core/access/policy-git.ts';
import { testBackends } from './helpers/test-backends.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pageText = (title: string, canary: string) => ['---', 'type: note', `title: ${title}`, '---', `# ${title}`, '', `First day notes ${canary}.`].join('\n') + '\n';
const POLICY = 'version: 1\nrules:\n  - id: alice\n    prefix: partners/alice-example/\n    readable_by: [alice-example]\n';
const SRC = 'default';

for (const kind of testBackends()) {
  describe(`a git brain with no commit yet (${kind})`, () => {
    const databaseUrl = kind === 'postgres' ? process.env.DATABASE_URL : undefined;
    const unborn = ({ root }: { root: string }) => {
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'user.email', 't@t.co');
      git(root, 'config', 'user.name', 't');
    };

    /** Members alice-example and bob-example, a read token bound to each, and a remote MCP call as either. */
    async function readers(engine: BrainEngine) {
      __resetPrivateVisibilityCacheForTests();
      const tokens: Record<string, string> = {};
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      for (const [name, member] of [['alice', 'alice-example'], ['bob', 'bob-example']] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'] });
        tokens[name] = minted.token;
        await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      }
      return async (who: 'alice' | 'bob', canary: string): Promise<string> => {
        const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
        const auth = await provider.verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
        const sourceId = auth.sourceId ?? 'default';
        const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
        const out = await dispatchToolCall(engine, 'search', { query: canary, match: 'keyword', fields: 'full', limit: 20 }, {
          remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
          ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
        });
        return out.content.map(c => c.text).join('\n');
      };
    }
    const sync = (engine: BrainEngine) => performSync(engine, { sourceId: SRC, noPull: true, noEmbed: true, noExtract: true });
    const invalid = async (engine: BrainEngine) => (await coverageRows(engine, SRC)).filter(c => c.reason === 'invalid').map(c => c.prefix);
    const seen = (text: string, canary: string) => ({ found: text.includes(canary), pending: text.includes('access_policy_pending') });
    function commitPages(root: string, pages: Record<string, string>, policy?: string) {
      for (const [slug, canary] of Object.entries(pages)) {
        mkdirSync(join(root, slug, '..'), { recursive: true });
        writeFileSync(join(root, `${slug}.md`), pageText(slug, canary));
      }
      if (policy) { mkdirSync(join(root, '.gbrain'), { recursive: true }); writeFileSync(join(root, '.gbrain/access.yml'), policy); }
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'pages');
    }

    test('the first sync of an unborn HEAD is up to date with no access_policy_pending; the first commit then syncs and its rules apply', async () => {
      await managedBrain(async ({ engine, root }) => {
        const search = await readers(engine);
        expect(await rebuildPreflight(engine, SRC, root)).toBeNull();
        const first = await sync(engine);
        expect({ status: first.status, imported: first.filesImported, invalid: await invalid(engine), store: (await policyStatus(engine, SRC)).store })
          .toEqual({ status: 'up_to_date', imported: 0, invalid: [], store: null });
        expect(seen(await search('bob', 'canaryunbornnothing'), 'canaryunbornnothing')).toEqual({ found: false, pending: false });
        commitPages(root, { 'notes/first-day': 'canaryunbornopen', 'partners/alice-example/plan': 'canaryunbornplan' }, POLICY);
        await sync(engine);
        expect({ rules: (await policyStatus(engine, SRC)).rules.map(r => r.id), invalid: await invalid(engine) }).toEqual({ rules: ['alice'], invalid: [] });
        expect({ open: seen(await search('bob', 'canaryunbornopen'), 'canaryunbornopen'), alice: seen(await search('alice', 'canaryunbornplan'), 'canaryunbornplan'),
          bob: seen(await search('bob', 'canaryunbornplan'), 'canaryunbornplan') })
          .toEqual({ open: { found: true, pending: false }, alice: { found: true, pending: false }, bob: { found: false, pending: false } });
      }, { databaseUrl, setup: unborn });
    }, 240_000);

    test('a source an older release marked on its unborn HEAD (the whole-source rebuild mark) is cleared by the next sync', async () => {
      await managedBrain(async ({ engine }) => {
        const search = await readers(engine);
        await markPolicyInvalid(engine, SRC, null, { problems: [{ line: null, message: 'The folder-rule history cannot be read.' }], commit: null, file: 'rebuild' });
        expect(seen(await search('bob', 'canaryunbornstuck'), 'canaryunbornstuck')).toEqual({ found: false, pending: true });
        const r = await sync(engine);
        expect({ status: r.status, invalid: await invalid(engine), read: seen(await search('bob', 'canaryunbornstuck'), 'canaryunbornstuck') })
          .toEqual({ status: 'up_to_date', invalid: [], read: { found: false, pending: false } });
      }, { databaseUrl, setup: unborn });
    }, 240_000);

    test('a git store with rules keeps enforcing them when its HEAD becomes unborn: the removal is held and no page is deleted', async () => {
      await managedBrain(async ({ engine, root }) => {
        const search = await readers(engine);
        await sync(engine);
        expect((await policyStatus(engine, SRC)).rules.map(r => r.id)).toEqual(['alice']);
        const pages = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL', [SRC]))[0]!.n;
        const before = await pages();
        git(root, 'checkout', '-q', '--orphan', 'fresh');
        const r = await sync(engine);
        const s = await policyStatus(engine, SRC);
        expect({ status: r.status, store: s.store, rules: s.rules.map(x => x.id), held: s.held.map(h => `${h.rule}:${h.kind}`), pages: await pages() })
          .toEqual({ status: 'up_to_date', store: 'git', rules: ['alice'], held: ['alice:removed'], pages: before });
        expect({ alice: seen(await search('alice', 'canaryunbornsecret'), 'canaryunbornsecret').found, bob: seen(await search('bob', 'canaryunbornsecret'), 'canaryunbornsecret').found })
          .toEqual({ alice: true, bob: false });
      }, { databaseUrl, setup: ({ root }) => { unborn({ root }); commitPages(root, { 'notes/open': 'canaryunbornopen', 'partners/alice-example/secret': 'canaryunbornsecret' }, POLICY); } });
    }, 240_000);
  });
}

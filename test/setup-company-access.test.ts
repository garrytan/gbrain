/**
 * GBRA-585 PR 1: company-brain setup decisions D (setup names the owner), A (setup's member keys read the company
 * source) and C (setup refuses to turn a brain with history shared until the admin picks).
 *
 * 1. Protects: `gbrain access serves several --owner <id>` (what `gbrain setup <harness> --serves several` runs) names
 *    the brain owner when none is set, keeps an existing one, rebinds no credential and lists the live credentials
 *    bound to no member with the command that binds each; nothing it does narrows what an owner-bound credential reads.
 * 2. Fails when: setup leaves the brain with no owner, replaces an owner, binds a credential on its own, or an
 *    owner-bound credential reads a different set of pages after setup.
 * 3. Existing coverage: setup-serves-several.test.ts (members, rules, keys), access-owner tests (access owner set).
 * 4. Real seams: labelSeveral on PGLite and Postgres (repo-less), the key verified by the serve --http verifier and
 *    dispatched remote=true; `bun src/cli.ts setup` spawned against a temp HOME / GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { labelSeveral } from '../src/commands/access-serves.ts';
import { mintToken } from '../src/commands/auth-mint.ts';
import { addMember } from '../src/core/access/members.ts';
import { ownerMemberId, setOwner } from '../src/core/access/owner.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { box, gbrain, pageText, removeTempDirs, setup, tempDir } from './helpers/setup-serves-box.ts';

afterAll(removeTempDirs);

const ROSTER = ['alice-example', 'bob-example'];
/** Pages outside the roster's people/ folders, so labelling the roster changes nothing an owner-bound key reads. */
const PAGES: Record<string, string> = {
  'notes/world-topic': 'worldcanary',
  'journal/owner-day': 'journalcanary',
  'people/carol-public': 'carolcanary',
};

async function openEngine(kind: string): Promise<{ engine: BrainEngine; close: () => Promise<void> }> {
  if (kind === 'postgres') return isolatedPersistencePostgres(process.env.DATABASE_URL!);
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  return { engine, close: () => engine.disconnect() };
}

/** The canaries a keyword search through `token` returns, read remotely as the serve --http verifier does. */
async function tokenReads(engine: BrainEngine, token: string, canaries: string[], sourceIds?: string[]): Promise<string[]> {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
  const sourceId = auth.sourceId ?? 'default';
  const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
  const out = await dispatchToolCall(engine, 'search', { query: 'harbor ledger notes', match: 'keyword', fields: 'full', limit: 50, ...(sourceIds ? { source_ids: sourceIds } : {}) }, {
    remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
  const text = out.content.map(c => c.text).join('\n');
  return canaries.filter(c => text.includes(c)).sort();
}

for (const kind of testBackends()) {
  describe(`D: access serves several names the owner (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    const label = (roster: string[], owner?: string) => withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined },
      () => labelSeveral(engine, roster, 'default', true, true, { ...(owner ? { owner } : {}) } as never));

    beforeAll(async () => {
      ({ engine, close } = await openEngine(kind));
      home = tempDir('gbrain-owner-');
      for (const [slug, canary] of Object.entries(PAGES)) await importFromContent(engine, slug, pageText(slug, canary), { sourceId: 'default', noEmbed: true });
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('no owner: --owner adds the member, names it the owner, binds nothing and lists each unbound credential with its rescope command', async () => {
      const unbound = await mintToken(engine, 'claude-desktop', { scopes: ['read', 'write'] });
      expect(await ownerMemberId(engine)).toBeNull();
      const r = await label(ROSTER, 'owner-example') as any;
      expect(r.error).toBeUndefined();
      expect(r.owner).toEqual({ id: 'owner-example', action: 'add' });
      expect(r.completed).toContain('owner');
      expect(await ownerMemberId(engine)).toBe('owner-example');
      expect(r.unbound).toEqual([{ kind: 'token', name: 'claude-desktop', command: 'gbrain auth rescope --token claude-desktop --member owner-example' }]);
      const [row] = await engine.executeRaw<{ member_id: string | null }>('SELECT member_id FROM access_tokens WHERE id = $1', [unbound.id]);
      expect(row!.member_id).toBeNull();
      const again = await label(ROSTER, 'owner-example') as any;
      expect(again.owner).toEqual({ id: 'owner-example', action: 'keep' });
    }, 120_000);
  });

  describe(`D: an existing owner is kept and its credential reads the same pages (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    beforeAll(async () => {
      ({ engine, close } = await openEngine(kind));
      home = tempDir('gbrain-owner-kept-');
      for (const [slug, canary] of Object.entries(PAGES)) await importFromContent(engine, slug, pageText(slug, canary), { sourceId: 'default', noEmbed: true });
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test("an owner set by hand stays the owner, and the owner's bound key reads the same pages before and after", async () => {
      await addMember(engine, 'owner-example');
      await setOwner(engine, 'owner-example');
      const ownerKey = await mintToken(engine, 'owner-laptop', { scopes: ['read', 'write'], binding: { member: 'owner-example' } });
      const canaries = Object.values(PAGES);
      const before = await tokenReads(engine, ownerKey.token, canaries);
      expect(before).toEqual([...canaries].sort());
      const r = await withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(engine, ROSTER, 'default', true, true, { owner: 'login-example' } as never)) as any;
      expect(r.error).toBeUndefined();
      expect(r.owner).toMatchObject({ id: 'owner-example', action: 'keep' });
      expect(await ownerMemberId(engine)).toBe('owner-example');
      expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM access_members WHERE id = 'login-example'"))[0]!.n).toBe(0);
      expect(await tokenReads(engine, ownerKey.token, canaries)).toEqual(before);
    }, 120_000);
  });
}

describe('D: gbrain setup --serves several names the owner (spawned, PGLite)', () => {
  const login = (() => { try { return userInfo().username; } catch { return ''; } })().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64).replace(/[._-]+$/, '');

  test('--owner: the preview shows it and writes nothing; the run sets it, binds no credential and prints each unbound one with its rescope command', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gbrain(b, ['auth', 'create', 'claude-desktop', '--scopes', 'read,write'])).exitCode).toBe(0);
    const preview = await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--owner', 'owner-example', '--dry-run']);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('owner      owner-example (will add a member and name it the brain owner)');
    expect(preview.stdout).toContain('gbrain auth rescope --token claude-desktop --member owner-example');
    expect(JSON.parse((await gbrain(b, ['access', 'owner', '--json'])).stdout).owner).toBeNull();
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    const run = await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--owner', 'owner-example']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('owner      owner-example (added a member and named it the brain owner)');
    const owner = JSON.parse((await gbrain(b, ['access', 'owner', '--json'])).stdout);
    expect(owner.owner).toBe('owner-example');
    expect(owner.bound_credentials).toEqual([]);
    const kept = await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--owner', 'other-example', '--json']);
    expect(kept.exitCode).toBe(0);
    expect(kept.doc.serves.receipt.owner).toMatchObject({ id: 'owner-example', action: 'keep' });
    expect(JSON.parse((await gbrain(b, ['access', 'owner', '--json'])).stdout).owner).toBe('owner-example');
  }, 480_000);

  test('without --owner the owner is the login name as a member id, and setup says how to name someone else', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const preview = await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--dry-run']);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain(`owner      ${login} is named from your login name; to name someone else, pass --owner <id>`);
    const run = await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--json']);
    expect(run.exitCode).toBe(0);
    expect(run.doc.serves).toMatchObject({ owner_from: 'login', receipt: { owner: { id: login, action: 'add' } } });
    expect(JSON.parse((await gbrain(b, ['access', 'owner', '--json'])).stdout).owner).toBe(login);
  }, 480_000);
});

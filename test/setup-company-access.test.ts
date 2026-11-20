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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { labelSeveral, receiptLines, receiptOk } from '../src/commands/access-serves.ts';
import { applyApproved, previewApply } from '../src/core/access/policy.ts';
import { historyRefusal } from '../src/commands/setup-serves.ts';
import { currentFolderRules } from '../src/commands/access-rules.ts';
import { mintToken } from '../src/commands/auth-mint.ts';
import { addMember } from '../src/core/access/members.ts';
import { ownerMemberId, setOwner } from '../src/core/access/owner.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { box, gbrain, memoryBrain, openBrainFile, pageText, removeTempDirs, setup, tempDir } from './helpers/setup-serves-box.ts';

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
  const engine = await memoryBrain();
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

const COMPANY: Record<string, string> = {
  'company/facts': 'factscanary',
  'company/calls/2026-11-01-hiring-debrief': 'callcanary',
  'company/board/owner-only': 'boardcanary',
};
const companyText = (slug: string, canary: string) => slug === 'company/board/owner-only'
  ? `---\ntype: note\ntitle: ${slug}\nreadable_by: [owner-example]\n---\n# ${slug}\n\nHarbor ledger notes ${canary}.\n`
  : pageText(slug, canary);
const keyFile = (home: string, member: string) => join(home, '.gbrain', 'member-keys', `${member}.key`);
const tokenRow = async (engine: BrainEngine, name: string) => (await engine.executeRaw<{ source_grant: string; source_id: string | null; federated_read: unknown }>(
  'SELECT source_grant, source_id, federated_read FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]))[0]!;
const list = (v: unknown) => Array.isArray(v) ? v : String(v ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);

for (const kind of testBackends()) {
  describe(`A: setup's member keys read the company source (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    let ownerKey: string;
    const ALL = [...Object.values(PAGES), ...Object.values(COMPANY), 'alicecanary', 'bobcanary'];
    const label = (roster: string[], apply = true) => withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(engine, roster, 'default', apply, true, { owner: 'owner-example' }));

    beforeAll(async () => {
      ({ engine, close } = await openEngine(kind));
      home = tempDir('gbrain-company-');
      for (const [slug, canary] of Object.entries(PAGES)) await importFromContent(engine, slug, pageText(slug, canary), { sourceId: 'default', noEmbed: true });
      for (const m of ['alice-example', 'bob-example']) await importFromContent(engine, `people/${m}/plan`, pageText(`people/${m}/plan`, `${m.split('-')[0]}canary`), { sourceId: 'default', noEmbed: true });
      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('company', 'company', '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
      for (const [slug, canary] of Object.entries(COMPANY)) await importFromContent(engine, slug, companyText(slug, canary), { sourceId: 'company', noEmbed: true });
      await addMember(engine, 'owner-example');
      await setOwner(engine, 'owner-example');
      ownerKey = (await mintToken(engine, 'owner-laptop', { scopes: ['read', 'write'], binding: { member: 'owner-example' } })).token;
      await addMember(engine, 'carol-example');
      const carol = await mintToken(engine, 'member-carol-example', { scopes: ['read', 'write'], binding: { member: 'carol-example' } });
      mkdirSync(join(home, '.gbrain', 'member-keys'), { recursive: true, mode: 0o700 });
      writeFileSync(keyFile(home, 'carol-example'), `${carol.token}\n`, { mode: 0o600 });
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('the preview names the read set, the company pages and calls, and says a later-federated source waits for a re-run', async () => {
      const preview = await label(['alice-example', 'bob-example', 'carol-example'], false) as any;
      expect(preview.reads).toEqual({ write: 'default', sources: ['default', 'company'], company: { pages: 3, calls: 1 } });
      const text = receiptLines(preview).join('\n');
      expect(text).toContain('reads      keys this run mints write to default and read default, company');
      expect(text).toContain('source company holds 3 page(s), 1 of them imported calls');
      expect(text).toContain("including calls they did not attend");
      expect(text).toContain('A source federated later does not reach these keys until you run setup again');
      expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM access_members WHERE id = 'alice-example'"))[0]!.n).toBe(0);
    }, 120_000);

    test("new keys get a source list with company; a key minted before is kept as it is; the owner's key reads the same pages", async () => {
      // The roster's own people/<member>/ folders are closed to the owner by the folder rules access serves several already
      // wrote on master; this PR does not change them, so the owner's reads are compared on every other page.
      const OWNER_SEES = ALL.filter(c => c !== 'alicecanary' && c !== 'bobcanary');
      const ownerBefore = await tokenReads(engine, ownerKey, OWNER_SEES);
      expect(ownerBefore).toEqual(['carolcanary', 'journalcanary', 'worldcanary']);
      const r = await label(['alice-example', 'bob-example', 'carol-example']);
      expect(r.error).toBeUndefined();
      for (const m of ['alice-example', 'bob-example']) {
        const row = await tokenRow(engine, `member-${m}`);
        expect([row.source_grant, row.source_id, list(row.federated_read)]).toEqual(['federated', 'default', ['default', 'company']]);
      }
      expect((await tokenRow(engine, 'member-carol-example')).source_grant).toBe('default');
      const alice = await tokenReads(engine, readFileSync(keyFile(home, 'alice-example'), 'utf8').trim(), ALL);
      expect(alice).toContain('callcanary');
      expect(alice).toContain('factscanary');
      expect(alice).toContain('alicecanary');
      expect(alice).not.toContain('bobcanary');
      expect(alice).not.toContain('boardcanary');
      expect(await tokenReads(engine, readFileSync(keyFile(home, 'carol-example'), 'utf8').trim(), ALL)).not.toContain('callcanary');
      const [company] = await engine.executeRaw<{ config: unknown }>("SELECT config FROM sources WHERE id = 'company'");
      expect(JSON.stringify(company!.config)).not.toContain('"federated":true');
      expect(await tokenReads(engine, ownerKey, OWNER_SEES)).toEqual(ownerBefore);
    }, 120_000);

    test('a re-run adds a newly federated source to the list keys and never removes one; default-grant keys stay as they are', async () => {
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('guests', 'guests', '{"federated":true}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      const r = await label(['alice-example', 'bob-example', 'carol-example']) as any;
      expect(r.error).toBeUndefined();
      expect(r.keys.map((k: any) => [k.member, k.action, k.adds ?? []])).toEqual([['alice-example', 'keep', ['guests']], ['bob-example', 'keep', ['guests']], ['carol-example', 'keep', []]]);
      expect(list((await tokenRow(engine, 'member-alice-example')).federated_read)).toEqual(['default', 'company', 'guests']);
      expect((await tokenRow(engine, 'member-carol-example')).source_grant).toBe('default');
      await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb WHERE id = 'guests'");
      const again = await label(['alice-example', 'bob-example', 'carol-example']) as any;
      expect(again.keys.every((k: any) => !k.adds?.length)).toBe(true);
      expect(list((await tokenRow(engine, 'member-alice-example')).federated_read)).toEqual(['default', 'company', 'guests']);
    }, 120_000);
  });
}

describe('A: gbrain setup --shape company --transcripts gives the members the calls (spawned, PGLite)', () => {
  test("on a new brain each member's key reads an imported call, and the readers line says who reads them", async () => {
    const b = box();
    const dir = join(b.root, 'calls');
    mkdirSync(dir);
    writeFileSync(join(dir, '2026-03-04 acme-example renewal.txt'), 'Alice: harbor ledger notes callcanary, we agreed to move acme-example to annual billing.\n');
    const r = await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--owner', 'owner-example', '--shape', 'company', '--no-stdio-member', '--transcripts', dir, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.transcripts.not_scoped).toMatchObject({ reason: 'stdio_unbound' });
    expect(r.doc.serves.regrant.keys.map((k: any) => [k.member, k.adds])).toEqual([['alice-example', ['company']], ['bob-example', ['company']]]);
    expect(r.doc.brain_layout.transcripts.readers.detail).toMatch(/^every member key gbrain setup minted, and other keys only when their grant names source company/);
    expect(r.doc.brain_layout.transcripts.readers.detail).not.toContain('everyone who can read source company');
    const engine = await openBrainFile(b.home);
    try {
      for (const m of ROSTER) expect(await tokenReads(engine, readFileSync(keyFile(b.home, m), 'utf8').trim(), ['callcanary'])).toEqual(['callcanary']);
    } finally {
      await engine.disconnect();
    }
  }, 480_000);
});


const HISTORY: Record<string, string> = {
  'journal/owner-day': 'journalcanary',
  'conversations/claude-code/2026-11-01/plan-abc12345': 'archivecanary',
};
const historyText = (slug: string, canary: string) => `---\ntype: ${slug.startsWith('conversations/') ? 'conversation' : 'note'}\ntitle: ${slug}\n---\n# ${slug}\n\nHarbor ledger notes ${canary}.\n`;

for (const kind of testBackends()) {
  describe(`C: turning a brain with history shared needs a choice (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    beforeAll(async () => {
      ({ engine, close } = await openEngine(kind));
      home = tempDir('gbrain-history-');
      for (const [slug, canary] of Object.entries(HISTORY)) await importFromContent(engine, slug, historyText(slug, canary), { sourceId: 'default', noEmbed: true });
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('the refusal names the count, the DMs/chat/mail and archive share and both choices; --labelled-only keeps the history from members, not from the owner', async () => {
      await addMember(engine, 'owner-example');
      await setOwner(engine, 'owner-example');
      const ownerKey = (await mintToken(engine, 'owner-laptop', { scopes: ['read', 'write'], binding: { member: 'owner-example' } })).token;
      const canaries = Object.values(HISTORY);
      const ownerBefore = await tokenReads(engine, ownerKey, canaries);
      expect(ownerBefore).toEqual([...canaries].sort());
      const flags = { serves: 'several' as const, dryRun: false };
      const status = { serves: 'one' as const, from: 'derived' as const, enabled_members: ['owner-example'], since: null, owner: 'owner-example', stdio_member: null } as never;
      const preview = await withEnv({ GBRAIN_HOME: home }, () => labelSeveral(engine, ROSTER, 'default', false, true, { owner: 'owner-example' }));
      const refusal = historyRefusal(status, preview, flags, 'claude-code', ROSTER, { id: 'owner-example', from: 'flag' });
      expect(refusal).toMatchObject({ code: 'setup_history_choice_required' });
      expect(refusal!.message).toContain('2 page(s)');
      expect(refusal!.message).toContain('1 of them DMs, chat or mail');
      expect(refusal!.message).toContain('1 in the conversation archive');
      expect(refusal!.suggestion).toContain('--labelled-only');
      expect(refusal!.suggestion).toContain('--open-history');
      expect(historyRefusal(status, preview, { ...flags, openHistory: true }, 'claude-code', ROSTER, undefined)).toBeNull();
      expect(historyRefusal(status, preview, { ...flags, labelledOnly: true }, 'claude-code', ROSTER, undefined)).toBeNull();
      expect(historyRefusal({ ...(status as object), serves: 'several' } as never, preview, flags, 'claude-code', ROSTER, undefined)).toBeNull();
      expect(historyRefusal(status, { ...preview, open_pages: { ...preview.open_pages!, total: 0 } }, flags, 'claude-code', ROSTER, undefined)).toBeNull();
      const r = await withEnv({ GBRAIN_HOME: home }, () => labelSeveral(engine, ROSTER, 'default', true, true, { owner: 'owner-example', labelledOnly: true }));
      expect(r.error).toBeUndefined();
      const alice = readFileSync(keyFile(home, 'alice-example'), 'utf8').trim();
      expect(await tokenReads(engine, alice, canaries)).toEqual([]);
      expect(await tokenReads(engine, ownerKey, canaries)).toEqual(ownerBefore);
    }, 120_000);
  });
}

describe('C: gbrain setup --serves several on a brain with history (spawned, PGLite)', () => {
  async function historyBox() {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    for (const [slug, canary] of Object.entries(HISTORY)) expect((await gbrain(b, ['put', slug, '--content', historyText(slug, canary)])).exitCode).toBe(0);
    return b;
  }
  const memberReads = async (b: ReturnType<typeof box>, member: string) => {
    const engine = await openBrainFile(b.home);
    try { return await tokenReads(engine, readFileSync(keyFile(b.home, member), 'utf8').trim(), Object.values(HISTORY)); } finally { await engine.disconnect(); }
  };
  const args = ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--owner', 'owner-example'];

  test('without a choice setup refuses and writes nothing; --labelled-only keeps the history private; a brain already shared is not refused', async () => {
    const b = await historyBox();
    const refused = await setup(b, [...args, '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('setup_history_choice_required');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    const status = JSON.parse((await gbrain(b, ['access', 'serves', '--json', '--no-open-pages'])).stdout);
    expect(status).toMatchObject({ serves: 'one', enabled_members: [] });
    const run = await setup(b, [...args, '--labelled-only']);
    expect(run.exitCode).toBe(0);
    expect(await memberReads(b, 'alice-example')).toEqual([]);
    const again = await setup(b, args);
    expect(again.exitCode).toBe(0);
  }, 480_000);

  test('--open-history lets the members read it', async () => {
    const b = await historyBox();
    const run = await setup(b, [...args, '--open-history']);
    expect(run.exitCode).toBe(0);
    expect(await memberReads(b, 'alice-example')).toEqual(['archivecanary', 'journalcanary']);
  }, 480_000);

  test('a new brain is not asked: one this run creates, and one with no pages yet', async () => {
    const fresh = box();
    expect((await setup(fresh, args)).exitCode).toBe(0);
    const empty = box();
    expect((await gbrain(empty, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await setup(empty, args)).exitCode).toBe(0);
  }, 480_000);
});



const COMPANY_CANARIES = ['factscanary', 'callcanary', 'boardcanary'];
const companyRules = (engine: BrainEngine) => currentFolderRules(engine, 'company');

for (const kind of testBackends()) {
  describe(`C: labelled-only members read the company pages through one company/ rule (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    let ownerKey: string;
    const label = (roster: string[], labelledOnly: boolean, apply = true) => withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined },
      () => labelSeveral(engine, roster, 'default', apply, true, { owner: 'owner-example', labelledOnly }));
    const memberReads = (member: string) => tokenReads(engine, readFileSync(keyFile(home, member), 'utf8').trim(), COMPANY_CANARIES);

    beforeAll(async () => {
      ({ engine, close } = await openEngine(kind));
      home = tempDir('gbrain-company-rule-');
      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('company', 'company', '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
      for (const [slug, canary] of Object.entries(COMPANY)) await importFromContent(engine, slug, companyText(slug, canary), { sourceId: 'company', noEmbed: true });
      await addMember(engine, 'owner-example');
      await setOwner(engine, 'owner-example');
      ownerKey = (await mintToken(engine, 'owner-laptop', { scopes: ['read', 'write'], binding: { member: 'owner-example' },
        sources: { kind: 'federated', writeSource: 'default', readSources: ['default', 'company'] } })).token;
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('a run that is not labelled-only adds no company rule', async () => {
      const r = await label(['dave-example'], false) as any;
      expect(r.error).toBeUndefined();
      expect(r.company_rule).toBeUndefined();
      expect(await companyRules(engine)).toEqual([]);
      expect(await memberReads('dave-example')).toEqual(['callcanary', 'factscanary']);
    }, 120_000);

    test("the preview shows the rule and writes nothing; the run adds company/ for the owner and every member; members read company/facts and a call; the owner's key reads the same", async () => {
      const ownerBefore = await tokenReads(engine, ownerKey, COMPANY_CANARIES);
      expect(ownerBefore).toEqual(['boardcanary', 'callcanary', 'factscanary']);
      const preview = await label(['alice-example', 'bob-example'], true, false) as any;
      expect(preview.company_rule).toMatchObject({ source: 'company', id: 'company', prefix: 'company/', action: 'add',
        readers: ['member:alice-example', 'member:bob-example', 'member:dave-example', 'member:owner-example'] });
      expect(receiptLines(preview).join('\n')).toContain('rule       company:company/ readable by alice-example, bob-example, dave-example, owner-example (will add)');
      expect(await companyRules(engine)).toEqual([]);
      const r = await label(['alice-example', 'bob-example'], true) as any;
      expect(r.error).toBeUndefined();
      expect((await companyRules(engine)).map(x => [x.id, x.prefix, x.readable_by])).toEqual([['company', 'company/', ['member:alice-example', 'member:bob-example', 'member:dave-example', 'member:owner-example']]]);
      for (const m of ['alice-example', 'bob-example', 'dave-example']) expect(await memberReads(m)).toEqual(['callcanary', 'factscanary']);
      expect(await tokenReads(engine, ownerKey, COMPANY_CANARIES)).toEqual(ownerBefore);
    }, 120_000);

    test('a re-run with one more member adds that member and keeps every reader', async () => {
      const r = await label(['alice-example', 'bob-example', 'carol-example'], true) as any;
      expect(r.error).toBeUndefined();
      expect(r.company_rule).toMatchObject({ action: 'add', adds: ['member:carol-example'], write: { state: 'recorded' } });
      expect(receiptOk(r)).toBe(true);
      expect(receiptLines(r).join('\n')).toContain('the added readers wait for approval, as every widening does: preview with gbrain access apply --source company');
      expect((await companyRules(engine))[0]!.readable_by).toEqual(['member:alice-example', 'member:bob-example', 'member:carol-example', 'member:dave-example', 'member:owner-example']);
      expect(await memberReads('carol-example')).toEqual([]);
      const plan = await previewApply(engine, 'company');
      await applyApproved(engine, 'company', { expect: plan.plan_hash! });
      expect(await memberReads('carol-example')).toEqual(['callcanary', 'factscanary']);
      for (const m of ['alice-example', 'bob-example', 'dave-example']) expect(await memberReads(m)).toEqual(['callcanary', 'factscanary']);
      const again = await label(['alice-example'], true) as any;
      expect(again.company_rule).toMatchObject({ action: 'keep' });
      expect((await companyRules(engine))[0]!.readable_by).toHaveLength(5);
    }, 120_000);
  });
}

describe('C: gbrain setup --shape company --labelled-only gives labelled-only members the calls (spawned, PGLite)', () => {
  test('each labelled-only member reads an imported call through the company/ rule', async () => {
    const b = box();
    const dir = join(b.root, 'calls');
    mkdirSync(dir);
    writeFileSync(join(dir, '2026-03-04 acme-example renewal.txt'), 'Alice: harbor ledger notes callcanary, we agreed to move acme-example to annual billing.\n');
    const r = await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--owner', 'owner-example', '--shape', 'company', '--no-stdio-member', '--transcripts', dir, '--labelled-only', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.transcripts.not_scoped).toMatchObject({ reason: 'stdio_unbound' });
    expect(r.doc.serves.regrant.company_rule).toMatchObject({ prefix: 'company/', action: 'add', readers: ['member:alice-example', 'member:bob-example', 'member:owner-example'] });
    expect(r.doc.brain_layout.transcripts.readers).toMatchObject({ members: ['alice-example', 'bob-example', 'owner-example'], serves: 'several' });
    expect(r.doc.brain_layout.transcripts.readers.detail).toMatch(/^alice-example, bob-example, owner-example only \(the company\/ rule on source company names them/);
    const engine = await openBrainFile(b.home);
    try {
      for (const m of ROSTER) expect(await tokenReads(engine, readFileSync(keyFile(b.home, m), 'utf8').trim(), ['callcanary'])).toEqual(['callcanary']);
    } finally {
      await engine.disconnect();
    }
  }, 480_000);
});


test('C: a preview that failed or could not count the pages still refuses (fail closed)', () => {
  const status = { serves: 'one', from: 'derived', enabled_members: [], since: null, owner: null, stdio_member: null } as never;
  const flags = { serves: 'several' as const, dryRun: false };
  const failed = historyRefusal(status, null, flags, 'claude-code', ROSTER, undefined);
  expect(failed).toMatchObject({ code: 'setup_history_choice_required' });
  expect(failed!.message).toContain('pages setup could not count (the preview failed)');
  const uncounted = historyRefusal(status, { members: [], open_pages: null, open_pages_error: { code: 'open_pages_timeout', message: 'x', retry: 'y' } } as never, flags, 'claude-code', ROSTER, undefined);
  expect(uncounted!.message).toContain('pages setup could not count (open_pages_timeout)');
  expect(historyRefusal(status, null, { ...flags, labelledOnly: true }, 'claude-code', ROSTER, undefined)).toBeNull();
});

test('C: the --labelled-only choice leaves the owner out of --members, so following it is not blocked', () => {
  const status = { serves: 'one', from: 'derived', enabled_members: [], since: null, owner: null, stdio_member: null } as never;
  const preview = { members: [], open_pages: { total: 3, sensitive: 0, archive: 0 } } as never;
  const flags = { serves: 'several' as const, dryRun: false };
  for (const owner of [{ id: 'alice-example', from: 'login' as const }, { id: 'alice-example', from: 'flag' as const }]) {
    const refusal = historyRefusal(status, preview, flags, 'claude-code', ROSTER, owner)!;
    const argv = (refusal.fix as { argv: string[] }).argv;
    expect(argv.slice(argv.indexOf('--members'), argv.indexOf('--members') + 2)).toEqual(['--members', 'bob-example']);
    expect(argv).toContain('--labelled-only');
    expect(refusal.message + refusal.suggestion).toContain('--members alice-example,bob-example');
  }
});

describe('C: the history refusal names the effective owner and the preview error (review fix-check)', () => {
  const one = { serves: 'one', from: 'derived', enabled_members: [], since: null, owner: null, stdio_member: null };
  const preview = { members: [], open_pages: { total: 3, sensitive: 0, archive: 0 } } as never;
  const flags = { serves: 'several' as const, dryRun: false };
  const argvOf = (e: unknown) => (e as { fix: { argv: string[] } }).fix.argv;
  const membersOf = (argv: string[]) => argv[argv.indexOf('--members') + 1];

  test('a configured owner wins over the login owner: it is the one left out of --members and named', () => {
    const refusal = historyRefusal({ ...one, owner: 'alice-example' } as never, preview, flags, 'claude-code', ROSTER, { id: 'login-example', from: 'login' })!;
    expect(membersOf(argvOf(refusal))).toBe('bob-example');
    expect(refusal.suggestion).toContain('the owner alice-example reads the whole brain');
    expect(refusal.suggestion).not.toContain('login-example');
  });

  test('a login owner left out of --members is pinned with --owner', () => {
    const argv = argvOf(historyRefusal(one as never, preview, flags, 'claude-code', ROSTER, { id: 'alice-example', from: 'login' }));
    expect(membersOf(argv)).toBe('bob-example');
    expect(argv.slice(argv.indexOf('--owner'), argv.indexOf('--owner') + 2)).toEqual(['--owner', 'alice-example']);
  });

  test('a failed preview names the error the preview reported', () => {
    const refusal = historyRefusal(one as never, null, flags, 'claude-code', ROSTER, undefined, 'access_serves_key_dir_in_git')!;
    expect(refusal.message).toContain('the preview failed: access_serves_key_dir_in_git');
  });
});

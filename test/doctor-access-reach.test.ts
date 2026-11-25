/**
 * GBRA-585 (decision F): doctor's access-reach checks (doctor/checks/access-reach.ts).
 *
 * 1. Protects: on a brain several people use, doctor warns, read-only, when
 *    - access_shared_source_unread: a shared source (no member bound to it) holds pages that no enabled member's live
 *      token or OAuth client reads, through federation or a source grant;
 *    - access_disabled_member_credentials: live tokens or OAuth clients are bound to a disabled or removed member.
 *    Each names the count, a few slugs or credential names (never content) and a read-only next step; a remote caller
 *    gets counts only. Nothing is written.
 * 2. Fails when: a check misses one of the walk cases, flags a page or source someone reads, names pages or credentials
 *    to a remote caller, writes anything, needs a git repository, or scans unbounded on a large brain.
 * 3. Existing coverage: member-access checks (malformed, unknown readers), open-shared-pages (pages everyone reads).
 * 4. Real seams: PGLite repo-less (Postgres when DATABASE_URL is set); credentials minted by the real token minter.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { addMember, disableMember, removeMember } from '../src/core/access/members.ts';
import { bindMemberSource } from '../src/core/access/member-sources.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { accessReachEntry } from '../src/commands/doctor/checks/access-reach.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { runRemoteDoctorTier } from '../src/commands/doctor/remote-tier.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

type CheckOut = { name: string; status: string; message: string; readiness_state?: string; details?: Record<string, any>; fix?: Record<string, any> };

const page = (readers?: string[]) => `---\ntype: note\ntitle: t\n${readers ? `readable_by: [${readers.join(', ')}]\n` : ''}---\n# t\n\nHarbor ledger body.\n`;

async function stateHash(engine: BrainEngine): Promise<string> {
  const rows = await Promise.all([
    engine.executeRaw('SELECT source_id, slug, frontmatter::text AS f, page_readers, folder_rule_ids FROM pages ORDER BY source_id, slug'),
    engine.executeRaw('SELECT id, name, revoked_at, member_id FROM access_tokens ORDER BY id'),
    engine.executeRaw('SELECT client_id, deleted_at, member_id FROM oauth_clients ORDER BY client_id'),
    engine.executeRaw('SELECT id, disabled_at, tombstoned_at FROM access_members ORDER BY id'),
    engine.executeRaw('SELECT id, config::text AS c FROM sources ORDER BY id'),
    engine.executeRaw("SELECT key, value FROM config WHERE key NOT LIKE 'doctor.%' ORDER BY key"),
  ]);
  return JSON.stringify(rows);
}

for (const kind of testBackends()) {
  describe(`doctor access reach (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const run = async (remote = false) => await accessReachEntry.run({ engine, remote } as unknown as DoctorContext) as unknown as CheckOut[];
    const check = async (name: string, remote = false) => (await run(remote)).find(c => c.name === name)!;
    const token = async (name: string, member: string | null, sourceGrant?: string[]) => {
      const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], ...(sourceGrant ? { sourceGrant } : {}) });
      if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      return minted;
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await importFromContent(engine, 'notes/team', page(), { sourceId: 'default', noEmbed: true });
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('a one-person brain with no members: every check is not applicable or ok, and nothing is written', async () => {
      const before = await stateHash(engine);
      const checks = await run();
      expect(checks.map(c => c.name).sort()).toEqual(['access_disabled_member_credentials', 'access_shared_source_unread']);
      for (const c of checks) expect(c.status).toBe('ok');
      expect((await check('access_shared_source_unread')).readiness_state).toBe('not_applicable');
      expect(await stateHash(engine)).toBe(before);
    }, 60_000);

    test('a shared source that no member key reads is named; federating it, granting it or binding it to a member clears it', async () => {
      for (const id of ['alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
      await engine.setConfig('access.serves', 'several');
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('company', 'company', '{"federated": false}'::jsonb), ('empty-src', 'empty-src', '{"federated": false}'::jsonb)`);
      await importFromContent(engine, 'calls/standup', page(), { sourceId: 'company', noEmbed: true });
      await token('alice-laptop', 'alice-example');
      await token('bob-laptop', 'bob-example');
      const before = await stateHash(engine);
      const c = await check('access_shared_source_unread');
      expect(c.status).toBe('warn');
      expect(c.details!.sources).toEqual(['company']);
      expect(c.message).toContain('company');
      expect(c.message).not.toContain('empty-src');
      expect(c.fix!.argv).toEqual(['gbrain', 'sources', 'list', '--json']);
      expect(c.fix!.ask_user).toBe(true);
      const remote = await check('access_shared_source_unread', true);
      expect(remote.status).toBe('warn');
      expect(JSON.stringify(remote)).not.toContain('company');
      expect(remote.details).toEqual({ count: 1 });
      expect(await stateHash(engine)).toBe(before);

      await engine.executeRaw(`UPDATE sources SET config = '{"federated": true}'::jsonb WHERE id = 'company'`);
      expect((await check('access_shared_source_unread')).status).toBe('ok');
      await engine.executeRaw(`UPDATE sources SET config = '{"federated": false}'::jsonb WHERE id = 'company'`);
      await token('carol-company', 'carol-example', ['company']);
      expect((await check('access_shared_source_unread')).status).toBe('ok');
      await engine.executeRaw("UPDATE access_tokens SET revoked_at = now() WHERE name = 'carol-company'");
      expect((await check('access_shared_source_unread')).status).toBe('warn');
      await bindMemberSource(engine, 'carol-example', 'company');
      expect((await check('access_shared_source_unread')).status).toBe('ok');
      await engine.executeRaw("DELETE FROM access_member_sources WHERE source_id = 'company'");
    }, 60_000);

    test('a guest source is not a shared source: members reach it only through an owner grant, which guest_source checks', async () => {
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('guests-a', 'guests-a', '{"federated": true, "guest": true}'::jsonb), ('guests-b', 'guests-b', '{"federated": false}'::jsonb)`);
      await importFromContent(engine, 'notes/guest-a', page(), { sourceId: 'guests-a', noEmbed: true });
      await importFromContent(engine, 'notes/guest-b', page(), { sourceId: 'guests-b', noEmbed: true });
      await engine.executeRaw("INSERT INTO guest_sources (source_id, writers) VALUES ('guests-b', ARRAY[]::text[])");
      const c = await check('access_shared_source_unread');
      expect(c.details!.sources ?? []).not.toContain('guests-a');
      expect(c.details!.sources ?? []).not.toContain('guests-b');
    }, 60_000);

    test('a key whose write source is archived reads nothing, as login refuses it, so it is no reader of a shared source', async () => {
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('old-src', 'old-src', '{"federated": false}'::jsonb)`);
      await token('erin-old', 'alice-example', ['old-src', 'company']);
      expect((await check('access_shared_source_unread')).details!.sources ?? []).not.toContain('company');
      await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'old-src'");
      expect((await check('access_shared_source_unread')).details!.sources).toContain('company');
      await engine.executeRaw("UPDATE access_tokens SET revoked_at = now() WHERE name = 'erin-old'");
    }, 60_000);

    test('remote run_doctor refuses both checks as host-only instead of returning an empty report', async () => {
      const ctx = { engine, remote: true, transport: 'http', sourceId: 'default', config: {} as never,
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      for (const name of accessReachEntry.emits!) {
        let err: unknown;
        try { await runRemoteDoctorTier(ctx, { only: [name] }); } catch (e) { err = e; }
        expect((err as { code?: string } | undefined)?.code).toBe('invalid_params');
        expect(String((err as Error).message)).toContain(`gbrain doctor --only ${name}`);
      }
    }, 60_000);

    test('a key of a disabled member does not count as a reader of a shared source', async () => {
      await token('dave-company', null, ['company']);
      await addMember(engine, 'dave-example');
      await engine.executeRaw("UPDATE access_tokens SET member_id = 'dave-example' WHERE name = 'dave-company'");
      expect((await check('access_shared_source_unread')).status).toBe('ok');
      await disableMember(engine, 'dave-example');
      expect((await check('access_shared_source_unread')).status).toBe('warn');
    }, 60_000);

    test('live credentials bound to a disabled or removed member are named; revoked ones are not', async () => {
      await disableMember(engine, 'bob-example');
      await removeMember(engine, 'carol-example');
      await token('carol-old', 'carol-example');
      await token('bob-revoked', 'bob-example');
      await engine.executeRaw("UPDATE access_tokens SET revoked_at = now() WHERE name = 'bob-revoked'");
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method,
        client_id_issued_at, member_id) VALUES ('bob-client', 'x', 'bob-agent', '{}', '{client_credentials}', 'read', 'client_secret_post', 0, 'bob-example'),
        ('alice-client', 'x', 'alice-agent', '{}', '{client_credentials}', 'read', 'client_secret_post', 0, 'alice-example')`);
      const before = await stateHash(engine);
      const c = await check('access_disabled_member_credentials');
      expect(c.status).toBe('warn');
      expect(c.details!.count).toBe(4);
      expect(c.details!.credentials).toEqual([
        { kind: 'client', name: 'bob-agent', id: 'bob-client', member: 'bob-example', state: 'disabled' },
        { kind: 'token', name: 'bob-laptop', id: expect.any(String), member: 'bob-example', state: 'disabled' },
        { kind: 'token', name: 'carol-old', id: expect.any(String), member: 'carol-example', state: 'removed' },
        { kind: 'token', name: 'dave-company', id: expect.any(String), member: 'dave-example', state: 'disabled' },
      ]);
      expect(c.message).not.toContain('bob-revoked');
      expect(c.message).not.toContain('alice');
      expect(c.fix!.argv).toEqual(['gbrain', 'access', 'check', '--client', 'bob-client']);
      expect(c.message).toContain('gbrain auth revoke');
      const remote = await check('access_disabled_member_credentials', true);
      expect(remote.details).toEqual({ count: 4 });
      expect(JSON.stringify(remote)).not.toMatch(/bob-agent|bob-laptop|carol-old|dave-company/);
      expect(await stateHash(engine)).toBe(before);
    }, 60_000);

  });
}

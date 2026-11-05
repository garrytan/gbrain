/**
 * GBRA-218 A1 identity: the members and groups service and the read-only
 * `gbrain access` checks, on a repo-less brain (in-memory PGLite, no git
 * checkout; Postgres too when DATABASE_URL is set).
 *
 * 1. Protects: member ids are never reused (rm tombstones, add and enable
 *    refuse a removed id), rm is preview-first and names bound credentials and
 *    pages, group membership drives who-can-read, and access check reports one
 *    credential's own grant axes next to its member identity.
 * 2. Fails when: a removed id can be added or enabled again, a preview writes,
 *    an ill-formed or unknown id is accepted, who-can-read admits a member the
 *    readers do not name, or two credentials of one member report the same
 *    grant when their grants differ.
 * 3. Existing coverage: test/member-read-access.test.ts (the read matrix, with
 *    members inserted by SQL).
 * 4. Real seams: the members service over the real schema; tokens minted by
 *    the token service; who-can-read reads live frontmatter.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import {
  addGroup, addMember, bindCredential, disableMember, enableMember, getMember, listGroups, listMembers, memberIdentity,
  parseMayActFor, previewRemoveGroup, previewRemoveMember, removeGroup, removeGroupMembers, removeMember,
} from '../src/core/access/members.ts';
import { accessCheck, whoCanRead } from '../src/commands/access.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DIMS = 1536;
const SRC = 'source-a';

async function refusal(p: Promise<unknown>): Promise<{ code: string; reason?: string }> {
  try { await p; } catch (e) {
    if (e instanceof OperationError) return { code: e.code, ...(e.reason ? { reason: e.reason } : {}) };
    throw e;
  }
  throw new Error('expected a refusal');
}

for (const kind of testBackends()) {
  describe(`access members (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, 'notes/alice-plan', '---\ntype: note\ntitle: Alice plan\nreadable_by: [alice-example, group:team-a]\n---\n# Alice plan\n\nPlanning notes.', { sourceId: SRC });
      await importFromContent(engine, 'notes/quiet-plan', '---\ntype: note\ntitle: Quiet plan\nreadable_by: alice-example\nvisibility: private\n---\n# Quiet plan\n\nQuiet notes.', { sourceId: SRC });
      await importFromContent(engine, 'notes/open-plan', '---\ntype: note\ntitle: Open plan\n---\n# Open plan\n\nOpen notes.', { sourceId: SRC });
    }, 120_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('add creates a member and its groups; ids are validated; an existing id is not edited', async () => {
      const added = await addMember(engine, 'alice-example', { name: 'Alice Example', groups: ['team-b'] });
      expect(added.member).toMatchObject({ id: 'alice-example', display_name: 'Alice Example', status: 'enabled', groups: ['team-b'] });
      expect(added.groups_created).toEqual(['team-b']);
      await addMember(engine, 'bob-example');
      await addMember(engine, 'carol-example');
      expect(await refusal(addMember(engine, 'Not Valid!'))).toEqual({ code: 'access_member_invalid', reason: 'ill_formed' });
      expect(await refusal(addMember(engine, 'dan-example', { groups: ['bad group'] }))).toEqual({ code: 'access_member_invalid', reason: 'ill_formed' });
      expect(await getMember(engine, 'dan-example')).toBeNull();
      expect(await refusal(addMember(engine, 'alice-example'))).toEqual({ code: 'access_member_invalid', reason: 'exists' });
      const [row] = await engine.executeRaw<{ value: string }>("SELECT value FROM config WHERE key = 'access.restrictions_present'");
      expect(row?.value).toBe('1');
    });

    test('groups: add with members, remove members, and a preview-first group removal', async () => {
      const team = await addGroup(engine, 'team-a', ['bob-example', 'carol-example']);
      expect(team).toEqual({ group: { id: 'team-a', members: ['bob-example', 'carol-example'] }, created: true });
      expect(await removeGroupMembers(engine, 'team-a', ['carol-example'])).toEqual({ id: 'team-a', members: ['bob-example'] });
      expect(await refusal(addGroup(engine, 'team-a', ['nobody-example']))).toEqual({ code: 'access_member_invalid', reason: 'unknown' });
      expect(await refusal(removeGroupMembers(engine, 'team-z', ['bob-example']))).toEqual({ code: 'access_member_invalid', reason: 'unknown_group' });
      const preview = await previewRemoveGroup(engine, 'team-b');
      expect(preview.group).toEqual({ id: 'team-b', members: ['alice-example'] });
      expect((await listGroups(engine)).map(g => g.id)).toContain('team-b');
      await removeGroup(engine, 'team-b');
      expect((await listGroups(engine)).map(g => g.id)).not.toContain('team-b');
      expect((await getMember(engine, 'alice-example'))!.groups).toEqual([]);
      expect((await previewRemoveGroup(engine, 'team-a')).pages).toEqual([{ slug: 'notes/alice-plan', source_id: SRC }]);
    });

    test('who-can-read names the readers, the privacy layer and the enabled members they admit', async () => {
      const [alice] = await whoCanRead(engine, 'notes/alice-plan');
      expect(alice).toMatchObject({ source_id: SRC, readers: ['group:team-a', 'member:alice-example'], private: false, members: ['alice-example', 'bob-example'] });
      const [quiet] = await whoCanRead(engine, 'notes/quiet-plan', SRC);
      expect(quiet).toMatchObject({ readers: ['member:alice-example'], private: true, members: ['alice-example'] });
      expect((await whoCanRead(engine, 'notes/open-plan'))[0]).toMatchObject({ readers: null, members: 'every_source_reader' });
      expect(await refusal(whoCanRead(engine, 'notes/missing-plan'))).toEqual({ code: 'not_found' });
    });

    test('disable and enable are reversible; a disabled member gives no identity and no longer counts as a reader', async () => {
      expect((await disableMember(engine, 'bob-example')).status).toBe('disabled');
      expect(await refusal(memberIdentity(engine, 'bob-example'))).toEqual({ code: 'access_member_invalid', reason: 'disabled' });
      expect((await whoCanRead(engine, 'notes/alice-plan'))[0]!.members).toEqual(['alice-example']);
      expect((await enableMember(engine, 'bob-example')).status).toBe('enabled');
      expect(await memberIdentity(engine, 'bob-example')).toEqual({ member: 'bob-example', groups: ['team-a'], identity: ['group:team-a', 'member:bob-example'] });
      expect(await refusal(memberIdentity(engine, 'nobody-example'))).toEqual({ code: 'access_member_invalid', reason: 'unknown' });
    });

    test('rm previews bound credentials and pages without writing, then tombstones; the id is never reused', async () => {
      await addMember(engine, 'erin-example', { groups: ['team-a'] });
      await importFromContent(engine, 'notes/erin-plan', '---\ntype: note\ntitle: Erin plan\nreadable_by: [erin-example]\n---\n# Erin plan\n\nErin notes.', { sourceId: SRC });
      const minted = await mintLegacyToken(engine, { name: 'erin-laptop', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      await bindCredential(engine, { kind: 'token', id: minted.id }, { member: 'erin-example' });
      const preview = await previewRemoveMember(engine, 'erin-example');
      expect(preview.member.status).toBe('enabled');
      expect(preview.bound_credentials).toEqual([{ kind: 'token', id: minted.id, name: 'erin-laptop' }]);
      expect(preview.pages).toEqual([{ slug: 'notes/erin-plan', source_id: SRC }]);
      expect(preview.note).toContain('can never be reused');
      expect((await getMember(engine, 'erin-example'))!.status).toBe('enabled');
      const removed = await removeMember(engine, 'erin-example');
      expect(removed.member).toMatchObject({ status: 'removed', groups: [] });
      expect((await listMembers(engine)).map(m => m.id)).not.toContain('erin-example');
      expect((await listMembers(engine, { includeRemoved: true })).find(m => m.id === 'erin-example')?.status).toBe('removed');
      expect(await refusal(addMember(engine, 'erin-example'))).toEqual({ code: 'access_member_id_retired' });
      expect(await refusal(enableMember(engine, 'erin-example'))).toEqual({ code: 'access_member_id_retired' });
      expect(await refusal(addGroup(engine, 'team-a', ['erin-example']))).toEqual({ code: 'access_member_id_retired' });
      expect(await refusal(memberIdentity(engine, 'erin-example'))).toEqual({ code: 'access_member_invalid', reason: 'removed' });
    });

    test('bindings: an unknown or disabled member is refused, none unbinds, may_act_for normalizes', async () => {
      const minted = await mintLegacyToken(engine, { name: 'bind-probe', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      expect(await refusal(bindCredential(engine, { kind: 'token', id: minted.id }, { member: 'nobody-example' }))).toEqual({ code: 'access_member_invalid', reason: 'unknown' });
      await disableMember(engine, 'carol-example');
      expect(await refusal(bindCredential(engine, { kind: 'token', id: minted.id }, { member: 'carol-example' }))).toEqual({ code: 'access_member_invalid', reason: 'disabled' });
      await enableMember(engine, 'carol-example');
      const mayActFor = parseMayActFor('Bob-Example, group:team-a, guest');
      expect(mayActFor).toEqual(['group:team-a', 'guest', 'member:bob-example']);
      expect(await bindCredential(engine, { kind: 'token', id: minted.id }, { member: 'carol-example', mayActFor })).toEqual({ member: 'carol-example', may_act_for: mayActFor, changed: true });
      expect(await bindCredential(engine, { kind: 'token', id: minted.id }, { member: 'carol-example' }, { dryRun: true })).toMatchObject({ changed: false });
      expect(await bindCredential(engine, { kind: 'token', id: minted.id }, { member: null, mayActFor: null }, { dryRun: true })).toEqual({ member: null, may_act_for: null, changed: true });
      const [still] = await engine.executeRaw<{ member_id: string | null }>('SELECT member_id FROM access_tokens WHERE id = $1::uuid', [minted.id]);
      expect(still?.member_id).toBe('carol-example');
      await bindCredential(engine, { kind: 'token', id: minted.id }, { member: null, mayActFor: null });
      const [cleared] = await engine.executeRaw<{ member_id: string | null; may_act_for: string[] | null }>('SELECT member_id, may_act_for FROM access_tokens WHERE id = $1::uuid', [minted.id]);
      expect(cleared).toEqual({ member_id: null, may_act_for: null });
      expect(() => parseMayActFor('alice-example, not valid')).toThrow(OperationError);
    });

    test('access check: two credentials of one member read as the same identity but keep their own grants', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT (id) DO NOTHING");
      const laptop = await mintLegacyToken(engine, { name: 'alice-laptop', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
      const phone = await mintLegacyToken(engine, { name: 'alice-phone', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['source-b'] });
      for (const t of [laptop, phone]) await bindCredential(engine, { kind: 'token', id: t.id }, { member: 'alice-example' });
      const a = await accessCheck(engine, { token: 'alice-laptop' });
      const b = await accessCheck(engine, { token: 'alice-phone' });
      expect(a.identity).toEqual(['member:alice-example']);
      expect(b.identity).toEqual(a.identity);
      expect(a.verdict).toBe('reads_as_member');
      expect(a.grant.scopes).not.toEqual(b.grant.scopes);
      expect(a.grant.sources).not.toEqual(b.grant.sources);
      await disableMember(engine, 'alice-example');
      try {
        expect(await accessCheck(engine, { token: 'alice-laptop' })).toMatchObject({ verdict: 'refused', identity: [], member: { id: 'alice-example', status: 'disabled' } });
      } finally {
        await enableMember(engine, 'alice-example');
      }
      const unbound = await accessCheck(engine, { token: 'bind-probe' });
      expect(unbound).toMatchObject({ verdict: 'unbound', member: null, identity: [] });
      expect(await refusal(accessCheck(engine, { token: 'alice-laptop', as: 'nobody-example' }))).toEqual({ code: 'access_member_invalid', reason: 'unknown' });
      expect((await accessCheck(engine, { token: 'alice-laptop', as: 'bob-example,group:team-a' })).audience).toEqual([
        { principal: 'member:bob-example', covered_by_may_act_for: false }, { principal: 'group:team-a', covered_by_may_act_for: false }]);
    });
  });
}

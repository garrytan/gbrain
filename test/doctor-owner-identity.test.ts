/**
 * GST-3216 PR 1: the owner_identity doctor check warns only on real ambiguity and never prints an identifier.
 * Repo-less brains, on PGLite and Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { ownerIdentityCheck } from '../src/commands/doctor/checks/owner-identity.ts';
import { renderIdentity } from '../src/commands/identity.ts';
import { ownerIdentity } from '../src/core/identity/owner.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const OWNER_MAIL = 'alice@example.com';

for (const kind of testBackends()) {
  describe(`owner_identity doctor check (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pg = new PGLiteEngine(); await pg.connect({ engine: 'pglite' } as never); await pg.initSchema(); engine = pg; close = () => pg.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    beforeEach(async () => {
      for (const sql of [
        'DELETE FROM access_member_links', 'DELETE FROM access_member_sources', 'DELETE FROM access_group_members',
        'DELETE FROM access_members', 'DELETE FROM pages', "DELETE FROM sources WHERE id <> 'default'", "DELETE FROM config WHERE key = 'access.owner_member'",
      ]) await engine.executeRaw(sql);
    });

    test('a fresh keyless brain is ok and names the reserved owner page', async () => {
      const c = await ownerIdentityCheck(engine);
      expect(c.status).toBe('ok');
      expect(c.message).toContain('No owner identifier yet');
      expect(c.message).toContain('The owner page is memory/owner.');
      expect(c.details).toMatchObject({ owner_member_set: false, identifiers: 0, entity_basis: 'reserved_page' });
    });

    test('an owner with an email is ok, and the email never reaches the check', async () => {
      await addMember(engine, 'owner-example', { email: OWNER_MAIL });
      await setOwner(engine, 'owner-example');
      const c = await ownerIdentityCheck(engine);
      expect(c.status).toBe('ok');
      expect(c.details).toMatchObject({ owner_member_set: true, identifiers: 1, identifier_kinds: ['member_email'], entity_basis: 'member_page' });
      expect(JSON.stringify(c)).not.toContain(OWNER_MAIL);
    });

    test('an identifier two members claim warns, points at gbrain identity, and still prints no identifier', async () => {
      await addMember(engine, 'owner-example', { email: OWNER_MAIL });
      await addMember(engine, 'bob-example');
      await setOwner(engine, 'owner-example');
      await engine.executeRaw("INSERT INTO access_member_links (system, external_id, member_id) VALUES ('telegram', '1001', 'owner-example'), ('slack', 'U1', 'bob-example')");
      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('mail-b', 'mail-b', jsonb_build_object('kind', 'google', 'g_account', $1::text))", [OWNER_MAIL]);
      await engine.executeRaw("INSERT INTO access_member_sources (member_id, source_id) VALUES ('bob-example', 'mail-b')");
      const id = await ownerIdentity(engine);
      expect(id.conflicts.some(x => x.kind === 'identifier_shared')).toBe(true);
      const c = await ownerIdentityCheck(engine);
      expect(c.status).toBe('warn');
      expect(c.fix?.argv).toEqual(['gbrain', 'identity', '--json']);
      expect(c.fix?.consent).toEqual([]);
      expect((c.details as { identifier_shared: number }).identifier_shared).toBeGreaterThan(0);
      expect(JSON.stringify(c)).not.toContain(OWNER_MAIL);
      expect(renderIdentity(id)).toContain(`Conflict: ${OWNER_MAIL} is claimed by`);
    });

    test('two person pages carrying the owner email are ok: each counts as the owner', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('mail-a', 'mail-a', jsonb_build_object('kind', 'google', 'g_account', $1::text))", [OWNER_MAIL]);
      for (const slug of ['people/alice-example', 'people/alice-example-work']) {
        await engine.putPage(slug, { type: 'person', title: 'Alice Example', compiled_truth: 'A person.', frontmatter: { email: OWNER_MAIL } });
      }
      const c = await ownerIdentityCheck(engine);
      expect(c.status).toBe('ok');
      expect(c.details).toMatchObject({ several_pages: true, entity_basis: 'reserved_page' });
      expect(c.message).toContain('2 person pages carry an owner email; each counts as the owner.');
      expect(JSON.stringify(c)).not.toContain(OWNER_MAIL);
    });

    test('an unloadable schema pack warns instead of reporting ok', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('mail-a', 'mail-a', jsonb_build_object('kind', 'google', 'g_account', $1::text))", [OWNER_MAIL]);
      await engine.setConfig('schema_pack', 'unavailable-fixture');
      try {
        const c = await ownerIdentityCheck(engine);
        expect(c.status).toBe('warn');
        expect(c.details).toMatchObject({ person_types_unavailable: true });
        expect(c.message).toContain('person types could not be loaded');
      } finally {
        await engine.executeRaw("DELETE FROM config WHERE key = 'schema_pack'");
      }
    });
  });
}

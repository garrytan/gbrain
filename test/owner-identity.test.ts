/**
 * GST-3216 PR 1: the owner identity is derived from stored state, never from a name, and never merges two members.
 * Repo-less brains (no git checkout), on PGLite and Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addMember, setMemberEmail } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindMemberSource } from '../src/core/access/member-sources.ts';
import { ownerIdentity, RESERVED_OWNER_SLUG } from '../src/core/identity/owner.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const OWNER_MAIL = 'alice@example.com';

async function googleSource(engine: BrainEngine, id: string, account: string) {
  await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ($1, $1, jsonb_build_object('kind', 'google', 'g_account', $2::text))", [id, account]);
}

async function person(engine: BrainEngine, slug: string, title: string, frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, { type: 'person', title, compiled_truth: `${title} is a person.`, frontmatter });
}

for (const kind of testBackends()) {
  describe(`owner identity (${kind}, repo-less)`, () => {
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
        'DELETE FROM access_members', "DELETE FROM pages", "DELETE FROM sources WHERE id <> 'default'", "DELETE FROM config WHERE key = 'access.owner_member'",
      ]) await engine.executeRaw(sql);
    });

    test('a personal brain with no members: the Google account proves the owner page by its email', async () => {
      await googleSource(engine, 'mail-a', OWNER_MAIL);
      await person(engine, 'people/alice-example', 'Alice Example', { email: OWNER_MAIL });
      await person(engine, 'people/bob-example', 'Bob Example', { email: 'bob@example.com' });
      const id = await ownerIdentity(engine);
      expect(id.member).toBeNull();
      expect(id.identifiers).toEqual([{ kind: 'google_account', value: OWNER_MAIL, source_id: 'mail-a' }]);
      expect(id.entity).toEqual({ slug: 'people/alice-example', source_id: 'default', basis: 'identifier_page' });
      expect(id.conflicts).toEqual([]);
    });

    test('a name alone never proves the owner: a same-name page without the email is not chosen', async () => {
      await googleSource(engine, 'mail-a', OWNER_MAIL);
      await person(engine, 'people/alice-example', 'Alice Example');
      await person(engine, 'people/alice-example-2', 'alice@example.com');
      const id = await ownerIdentity(engine);
      expect(id.entity).toEqual({ slug: RESERVED_OWNER_SLUG, source_id: null, basis: 'reserved_page' });
    });

    test('no identifiers at all: the reserved page, with nothing to conflict', async () => {
      await person(engine, 'people/alice-example', 'Alice Example', { email: OWNER_MAIL });
      const id = await ownerIdentity(engine);
      expect(id).toEqual({ member: null, identifiers: [], entity: { slug: RESERVED_OWNER_SLUG, source_id: null, basis: 'reserved_page' }, conflicts: [], skipped_sources: [] });
    });

    test('an owner member falls back to its own member page and carries its email and links', async () => {
      await addMember(engine, 'owner-example', { email: OWNER_MAIL });
      await setOwner(engine, 'owner-example');
      await engine.executeRaw("INSERT INTO access_member_links (system, external_id, member_id) VALUES ('telegram', '1001', 'owner-example')");
      const id = await ownerIdentity(engine);
      expect(id.member).toBe('owner-example');
      expect(id.identifiers).toEqual([{ kind: 'member_email', value: OWNER_MAIL }, { kind: 'member_link', system: 'telegram', value: '1001' }]);
      expect(id.entity).toEqual({ slug: 'memory/members/owner-example', source_id: null, basis: 'member_page' });
    });

    test('a company brain: an unbound mailbox is nobody\'s, and a bound one belongs only to its member', async () => {
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
      await setOwner(engine, 'alice-example');
      await googleSource(engine, 'team-mail', 'team@example.com');
      await googleSource(engine, 'bob-mail', 'bob@example.com');
      await bindMemberSource(engine, 'bob-example', 'bob-mail');
      const alice = await ownerIdentity(engine);
      expect(alice.identifiers).toEqual([]);
      expect(alice.skipped_sources).toEqual([
        { source_id: 'bob-mail', reason: 'bound_to_other_member' },
        { source_id: 'team-mail', reason: 'unbound_on_shared_brain' },
      ]);
      const bob = await ownerIdentity(engine, { member: 'bob-example' });
      expect(bob.identifiers).toEqual([{ kind: 'google_account', value: 'bob@example.com', source_id: 'bob-mail' }]);
      expect(bob.entity.slug).toBe('memory/members/bob-example');
    });

    test('an identifier two members claim counts for neither', async () => {
      await addMember(engine, 'alice-example', { email: OWNER_MAIL });
      await addMember(engine, 'bob-example');
      await setOwner(engine, 'alice-example');
      await googleSource(engine, 'bob-mail', OWNER_MAIL);
      await bindMemberSource(engine, 'bob-example', 'bob-mail');
      await person(engine, 'people/alice-example', 'Alice Example', { email: OWNER_MAIL });
      for (const m of ['alice-example', 'bob-example']) {
        const id = await ownerIdentity(engine, { member: m });
        expect(id.identifiers).toEqual([]);
        expect(id.conflicts).toEqual([{ kind: 'identifier_shared', value: OWNER_MAIL, members: ['alice-example', 'bob-example'] }]);
        expect(id.entity.basis).toBe('member_page');
      }
    });

    test('several pages carrying an owner email are a conflict and fall back', async () => {
      await googleSource(engine, 'mail-a', OWNER_MAIL);
      await person(engine, 'people/alice-example', 'Alice Example', { email: OWNER_MAIL });
      await person(engine, 'people/alice-old', 'Alice Old', { emails: ['old@example.com', OWNER_MAIL] });
      const id = await ownerIdentity(engine);
      expect(id.entity.basis).toBe('reserved_page');
      expect(id.conflicts).toEqual([{ kind: 'several_pages', pages: [{ slug: 'people/alice-example', source_id: 'default' }, { slug: 'people/alice-old', source_id: 'default' }] }]);
    });

    test('the owner picture follows edits at once (no cache)', async () => {
      await googleSource(engine, 'mail-a', OWNER_MAIL);
      expect((await ownerIdentity(engine)).entity.basis).toBe('reserved_page');
      await person(engine, 'people/alice-example', 'Alice Example', { email: OWNER_MAIL });
      expect((await ownerIdentity(engine)).entity.basis).toBe('identifier_page');
    });

    test('setMemberEmail on the owner adds the identifier', async () => {
      await addMember(engine, 'owner-example');
      await setOwner(engine, 'owner-example');
      expect((await ownerIdentity(engine)).identifiers).toEqual([]);
      await setMemberEmail(engine, 'owner-example', OWNER_MAIL);
      expect((await ownerIdentity(engine)).identifiers).toEqual([{ kind: 'member_email', value: OWNER_MAIL }]);
    });

    test('an account stored with capitals still proves the page that spells it the same way', async () => {
      await googleSource(engine, 'mail-a', 'Alice@Example.com');
      await person(engine, 'people/alice-example', 'Alice Example', { email: 'Alice@Example.com' });
      const id = await ownerIdentity(engine);
      expect(id.identifiers).toEqual([{ kind: 'google_account', value: OWNER_MAIL, source_id: 'mail-a' }]);
      expect(id.entity).toEqual({ slug: 'people/alice-example', source_id: 'default', basis: 'identifier_page' });
    });

    test('pages titled like the owner email never crowd out the pages that carry it', async () => {
      await googleSource(engine, 'mail-a', OWNER_MAIL);
      for (let i = 0; i < 55; i++) await person(engine, `a-title/flood-${String(i).padStart(2, '0')}`, OWNER_MAIL);
      await person(engine, 'people/alice-example', 'Alice Example', { email: OWNER_MAIL });
      await person(engine, 'people/alice-work', 'Alice Work', { email: OWNER_MAIL });
      const id = await ownerIdentity(engine);
      expect(id.conflicts).toEqual([{ kind: 'several_pages', pages: [{ slug: 'people/alice-example', source_id: 'default' }, { slug: 'people/alice-work', source_id: 'default' }] }]);
    }, 60_000);

    test('an unloadable schema pack is reported, not answered silently', async () => {
      await googleSource(engine, 'mail-a', OWNER_MAIL);
      await person(engine, 'people/alice-example', 'Alice Example', { email: OWNER_MAIL });
      await engine.setConfig('schema_pack', 'unavailable-fixture');
      try {
        const id = await ownerIdentity(engine);
        expect(id.degraded).toBe('person_types_unavailable');
        expect(id.entity.basis).toBe('reserved_page');
      } finally {
        await engine.executeRaw("DELETE FROM config WHERE key = 'schema_pack'");
      }
      expect((await ownerIdentity(engine)).degraded).toBeUndefined();
    });
  });
}

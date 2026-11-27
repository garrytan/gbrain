/**
 * #10450: a contact whose display name has no ASCII letters or digits (张三, Иван) slugged to nothing, and the
 * contacts sweep dropped it even with an email or phone, while the sync reported success. Such a contact now keeps the
 * stable id path nameless phone contacts already use, with its own name on the page. The shared Google and Apple apply
 * step also checks the path it finally renders: one another contact still owns refuses the contact before anything is
 * written or retired, and a hand-authored page there is left alone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { applyContactPage, type ContactPageIO } from '../src/core/contact-page-apply.ts';
import { contactIdSlug, personSlugFromContact, renderPersonPage } from '../src/core/google/google-render.ts';
import type { ContactData } from '../src/core/google/types.ts';
import { appleBaseSlug, appleContactRender, appleTombstoneSlugs, renderAppleContactPage } from '../src/core/apple-contacts/render.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, withGoogleAccount, settleConnectorWrites } from './helpers/connector-fixture.ts';

const DIR = 'contacts';
const contact = (over: Partial<ContactData> = {}): ContactData => ({ resourceName: 'people/c10450', displayName: '张三', emails: ['zhang@example.com'],
  phones: [], organization: null, title: null, groups: [], deleted: false, ...over });

describe('non-ASCII contact names render (#10450)', () => {
  for (const displayName of ['张三', '山田太郎', 'Иван Петров', '🙂', '   ']) {
    for (const reach of [{ emails: ['zhang@example.com'], phones: [] }, { emails: [], phones: ['+12025550123'] }]) {
      test(`${JSON.stringify(displayName)} with ${reach.emails.length ? 'an email' : 'only a phone'} keeps the id path and its name`, () => {
        const c = contact({ displayName, ...reach });
        const path = contactIdSlug(c.resourceName, DIR);
        expect(personSlugFromContact(c, false, DIR)).toBe(path);
        const page = renderPersonPage(c, false, DIR);
        expect(page?.relPath).toBe(`${path}.md`);
        expect(page!.markdown).toContain(`google_contact_id: "${c.resourceName}"`);
        if (displayName.trim()) expect(page!.markdown).toContain(displayName);
        expect(renderPersonPage(c, false, DIR)).toEqual(page);
      });
    }
  }

  test('two contacts with the same non-ASCII name get two pages; a rename keeps the path', () => {
    const first = contact();
    const second = contact({ resourceName: 'people/c10451', emails: ['zhang.other@example.com'] });
    expect(personSlugFromContact(first, false, DIR)).not.toBe(personSlugFromContact(second, false, DIR));
    expect(personSlugFromContact({ ...first, displayName: '李四' }, false, DIR)).toBe(personSlugFromContact(first, false, DIR));
  });

  test('ASCII names keep their paths, and a contact with neither email nor phone still has no page', () => {
    expect(personSlugFromContact(contact({ displayName: 'Alice Example' }), false, DIR)).toBe(`${DIR}/alice-example`);
    expect(personSlugFromContact(contact({ displayName: 'Zoë 张' }), false, DIR)).toBe(`${DIR}/zo`);
    expect(personSlugFromContact(contact({ displayName: null }), false, DIR)).toBe(`${DIR}/zhang`);
    expect(personSlugFromContact(contact({ emails: [], phones: [] }), false, DIR)).toBeNull();
    expect(renderPersonPage(contact({ emails: [], phones: [] }), false, DIR)).toBeNull();
  });
});

/** An in-memory contacts directory behind the shared apply step, driven by the real Google or Apple renderer. */
function directory(provider: 'google' | 'apple', id: string, name = '张三') {
  const data = contact({ resourceName: id, displayName: name, phones: ['+12025550123'] });
  const apple = appleContactRender({ id, givenName: name, familyName: null, nickname: null, emails: [{ value: 'zhang@example.com', label: 'work' }],
    phones: [{ value: '+12025550123', label: 'mobile' }], organization: null, jobTitle: null, groups: [] });
  const pages = new Map<string, { owner: string; body: string }>();
  const writes: string[] = [];
  const removes: string[] = [];
  const skipped: string[] = [];
  const render = (collides: boolean) => provider === 'google' ? renderPersonPage(data, collides, DIR) : renderAppleContactPage(apple, collides, DIR);
  const io: ContactPageIO = {
    existingPath: async () => [...pages].find(([, p]) => p.owner === id)?.[0] ?? null,
    owner: async (relPath) => pages.get(relPath)?.owner ?? null,
    baseSlug: () => provider === 'google' ? personSlugFromContact(data, false, DIR) : appleBaseSlug(apple, DIR),
    tombstoneSlugs: () => provider === 'google' ? [contactIdSlug(id, DIR)] : appleTombstoneSlugs(id, DIR),
    render,
    write: async (relPath, body) => { writes.push(relPath); pages.set(relPath, { owner: id, body }); },
    remove: async (relPath) => { removes.push(relPath); pages.delete(relPath); },
    skippedHandAuthored: (relPath) => { skipped.push(relPath); },
    applied: () => {},
  };
  return { pages, writes, removes, skipped, io, path: `${contactIdSlug(id, DIR)}.md` };
}

for (const provider of ['google', 'apple'] as const) {
  describe(`${provider} contact apply with a non-ASCII name (#10450)`, () => {
    const id = provider === 'google' ? 'people/c10450' : 'apple-10450';

    test('lands on the id path, retires the page it owned before, and a repeat changes nothing', async () => {
      const d = directory(provider, id);
      d.pages.set(`${DIR}/old-name.md`, { owner: id, body: 'old' });
      await applyContactPage(id, false, d.io);
      expect([...d.pages.keys()]).toEqual([d.path]);
      expect(d.pages.get(d.path)!.body).toContain('张三');
      await applyContactPage(id, false, d.io);
      expect(d.pages.size).toBe(1);
      await applyContactPage(id, true, d.io);
      expect(d.pages.size).toBe(0);
    });

    test('refuses a path another contact owns before writing or retiring anything', async () => {
      const d = directory(provider, id);
      d.pages.set(d.path, { owner: 'someone-else', body: 'keep this' });
      d.pages.set(`${DIR}/old-name.md`, { owner: id, body: 'old' });
      const before = structuredClone([...d.pages]);
      await expect(applyContactPage(id, false, d.io)).rejects.toThrow(/belongs to another contact/);
      expect([...d.pages]).toEqual(before);
      expect(d.writes).toEqual([]);
      expect(d.removes).toEqual([]);
    });

    test('refuses a disambiguated path another contact also owns, keeping both pages and its own', async () => {
      const d = directory(provider, id, 'Alice Example');
      d.pages.set(`${DIR}/alice-example.md`, { owner: 'alice-one', body: 'first Alice' });
      d.pages.set(d.io.render(true)!.relPath, { owner: 'alice-two', body: 'second Alice' });
      d.pages.set(`${DIR}/old-name.md`, { owner: id, body: 'old' });
      const before = structuredClone([...d.pages]);
      await expect(applyContactPage(id, false, d.io)).rejects.toThrow(/belongs to another contact/);
      expect([...d.pages]).toEqual(before);
      expect(d.writes).toEqual([]);
    });

    test('leaves a hand-authored page at the id path alone', async () => {
      const d = directory(provider, id);
      d.pages.set(d.path, { owner: 'hand-authored', body: 'my notes' });
      await applyContactPage(id, false, d.io);
      expect(d.pages.get(d.path)).toEqual({ owner: 'hand-authored', body: 'my notes' });
      expect(d.writes).toEqual([]);
      expect(d.skipped).toEqual([d.path]);
    });
  });
}

describe('the managed contacts sweep imports non-ASCII names (#10450)', () => {
  const { engines, env, boundSource, setup, teardown } = createConnectorFixture();
  beforeAll(setup, 120_000);
  afterAll(teardown);
  const config = { ...googleConfig, g_services: 'contacts', g_contacts_dir: DIR };
  const people = [
    { resourceName: 'people/c1', names: [{ displayName: '张三' }], emailAddresses: [{ value: 'zhang@example.com' }] },
    { resourceName: 'people/c2', names: [{ displayName: '李四' }], phoneNumbers: [{ value: '+12025550123' }] },
    { resourceName: 'people/c3', names: [{ displayName: 'Alice Example' }], emailAddresses: [{ value: 'alice@example.com' }] },
    { resourceName: 'people/c4', names: [{ displayName: '王五' }] },
  ];
  const fetcher = withGoogleAccount(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/people/me/connections')) return json({ connections: people, nextSyncToken: 'ppl-1' });
    if (u.pathname.endsWith('/contactGroups')) return json({ contactGroups: [] });
    return json({ error: { message: 'unexpected fixture route' } }, 400);
  });

  test('every contact with an email or phone gets a page under its own name', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const f = await boundSource(engine, config);
      const cfg = parseGoogleSourceConfig(config, f.dir);
      await runGoogleSync(engine, f.id, cfg, options, fetcher);
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
      const rows = await engine.executeRaw<{ slug: string; title: string }>('SELECT slug, title FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id]);
      expect(rows.sort((a, b) => a.title < b.title ? -1 : 1)).toEqual([
        { slug: `${DIR}/alice-example`, title: 'Alice Example' },
        { slug: contactIdSlug('people/c1', DIR), title: '张三' },
        { slug: contactIdSlug('people/c2', DIR), title: '李四' },
      ].sort((a, b) => a.title < b.title ? -1 : 1));
    }
  }), 120_000);
});

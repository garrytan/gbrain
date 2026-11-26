import { describe, expect, test } from 'bun:test';
import { applyContactPage, type ContactPageIO } from '../src/core/contact-page-apply.ts';
import { contactIdSlug, personSlugFromContact, renderPersonPage } from '../src/core/google/google-render.ts';
import { appleContactRender, appleBaseSlug, appleTombstoneSlugs, renderAppleContactPage } from '../src/core/apple-contacts/render.ts';

// Synthetic storage; run the real shared apply function and both real renderers.
for (const provider of ['google', 'apple'] as const) {
  const id = 'synthetic-contact-10450';
  const dir = `contacts/${provider}`;
  const data = { resourceName: id, displayName: '张三', emails: ['example@example.com'], phones: ['+12025550123'],
    organization: 'Example', title: 'Engineer', groups: [], deleted: false };
  const apple = appleContactRender({ id, givenName: '张三', familyName: null, nickname: null,
    emails: [{ value: 'example@example.com', label: 'work' }], phones: [{ value: '+12025550123', label: 'mobile' }],
    organization: 'Example', jobTitle: 'Engineer', groups: ['Friends'] });
  const render = (d: boolean) => provider === 'google' ? renderPersonPage(data, d, dir) : renderAppleContactPage(apple, d, dir);
  const base = `${contactIdSlug(id, dir)}.md`;
  function fixture() {
    const pages = new Map<string, { owner: string; body: string }>();
    const writes: string[] = [];
    const io: ContactPageIO = {
      existingPath: async () => [...pages].find(([, p]) => p.owner === id)?.[0] ?? null,
      owner: async p => pages.get(p)?.owner ?? null,
      baseSlug: () => provider === 'google' ? personSlugFromContact(data, false, dir) : appleBaseSlug(apple, dir),
      tombstoneSlugs: () => provider === 'google' ? [contactIdSlug(id, dir)] : appleTombstoneSlugs(id, dir),
      render,
      write: async (p, body) => { writes.push(p); pages.set(p, { owner: id, body }); },
      remove: async p => { pages.delete(p); }, skippedHandAuthored: () => {}, applied: () => {},
    };
    return { pages, writes, io };
  }
  describe(`${provider} CJK ownership`, () => {
    test('preserves another contact at the base path, repeats without duplicates, deletes only its own page', async () => {
      const { pages, io } = fixture();
      const other = { owner: 'other-contact', body: 'Keep exactly this body' };
      pages.set(base, other);
      await applyContactPage(id, false, io);
      expect(pages.get(base)).toEqual(other);
      expect(pages.size).toBe(2);
      const own = [...pages].find(([, p]) => p.owner === id)!;
      expect(own[1].body).toContain('张三');
      if (provider === 'apple') {
        expect(own[1].body).toContain('apple_contact_id:');
        expect(own[1].body).toContain('visibility: private');
        expect(own[1].body).toContain('tags:');
        expect(own[1].body).toContain('(mobile)');
        expect(own[1].body).not.toContain('google_contact_id:');
      }
      await applyContactPage(id, false, io);
      expect(pages.size).toBe(2);
      expect(pages.get(own[0])).toEqual(own[1]);
      await applyContactPage(id, true, io);
      expect([...pages]).toEqual([[base, other]]);
    });
    test('refuses an occupied disambiguated path without deleting the old owned page', async () => {
      const { pages, writes, io } = fixture();
      pages.set(base, { owner: 'other-base', body: 'base unchanged' });
      pages.set(render(true)!.relPath, { owner: 'other-suffix', body: 'suffix unchanged' });
      pages.set(`${dir}/old.md`, { owner: id, body: 'old unchanged' });
      const before = [...pages];
      await expect(applyContactPage(id, false, io)).rejects.toThrow('Contact page path is owned by another contact');
      expect([...pages]).toEqual(before);
      expect(writes).toEqual([]);
    });
    test('preserves hand-authored pages at either candidate', async () => {
      for (const collides of [false, true]) {
        const { pages, writes, io } = fixture();
        if (collides) pages.set(base, { owner: 'other-contact', body: 'other' });
        pages.set(render(collides)!.relPath, { owner: 'hand-authored', body: 'manual notes' });
        const before = [...pages];
        await applyContactPage(id, false, io);
        expect([...pages]).toEqual(before);
        expect(writes).toEqual([]);
      }
    });
  });
}

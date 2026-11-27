/**
 * GST-3747: the personal-source fixture shared by test/access-member-personal-sources.test.ts and its serial twin:
 * one page in each of three members' personal sources (owner, pat, quin) and one in a shared source, every source
 * federated (the `gbrain sources add` default).
 */
export const PERSONAL_PAGES = {
  owner: { source: 'dm-owner-example', slug: 'chats/owner-dm', canary: 'zebracanaryowner', member: 'owner-example' },
  pat: { source: 'dm-pat-example', slug: 'chats/pat-dm', canary: 'zebracanarypat', member: 'pat-example' },
  quin: { source: 'dm-quin-example', slug: 'chats/quin-dm', canary: 'zebracanaryquin', member: 'quin-example' },
  team: { source: 'team-example', slug: 'chats/team-notes', canary: 'zebracanaryteam', member: null },
} as const;

export type PersonalKey = keyof typeof PERSONAL_PAGES;
export const PERSONAL_KEYS = Object.keys(PERSONAL_PAGES).sort() as PersonalKey[];
export const OWNER_MEMBER = 'owner-example';

export function personalPageText(key: PersonalKey): string {
  const p = PERSONAL_PAGES[key];
  return `---\ntype: note\ntitle: ${p.slug}\n---\n# Chat\n\nThe plan ${p.canary} is late.\n`;
}

/** Every read path the fix covers, as [label, op, params]; each returns the page text (find_pages: its slug) when read. */
export function personalReads(key: PersonalKey): Array<[string, string, Record<string, unknown>]> {
  const p = PERSONAL_PAGES[key];
  return [
    ['get_page named', 'get_page', { slug: p.slug, source_id: p.source }],
    ['get_page', 'get_page', { slug: p.slug }],
    ['search', 'search', { query: p.canary, match: 'keyword', fields: 'full' }],
    ['search __all__', 'search', { query: p.canary, match: 'keyword', fields: 'full', source_id: '__all__' }],
    ['query', 'query', { query: p.canary, fields: 'full' }],
    ['find_pages', 'find_pages', { pattern: 'chats/' }],
    ['find_pages __all__', 'find_pages', { pattern: 'chats/', source_id: '__all__' }],
  ];
}

/** The read paths of personalReads as CLI arguments, with the same labels. */
export function personalCliReads(key: PersonalKey): Array<[string, string[]]> {
  const p = PERSONAL_PAGES[key];
  return [
    ['get_page named', ['get', p.slug, '--source', p.source]],
    ['get_page', ['get', p.slug]],
    ['search', ['search', p.canary]],
    ['search __all__', ['search', p.canary, '--source', '__all__']],
    ['query', ['query', p.canary]],
    ['find_pages', ['find', 'chats/']],
    ['find_pages __all__', ['find', 'chats/', '--source', '__all__']],
  ];
}

/** What a read returned names `key`'s page: its canary, or for find its slug. */
export function readNames(label: string, text: string, key: PersonalKey): boolean {
  return text.includes(label.startsWith('find_pages') ? PERSONAL_PAGES[key].slug : PERSONAL_PAGES[key].canary);
}

/** The map every read path gives when a caller reads exactly `keys`. */
export function readingExactly(keys: PersonalKey[]): Record<string, PersonalKey[]> {
  return Object.fromEntries(personalReads('team').map(([label]) => [label, [...keys].sort()]));
}

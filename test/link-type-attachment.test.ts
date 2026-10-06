/**
 * Per-edge verb attachment in link-type inference: a verb that belongs to
 * another link in the same context window does not type this link, and
 * "joined [X] as <role>" reads as works_at. Pure, no engine.
 */
import { expect, test } from 'bun:test';
import { extractPageLinks, inferLinkType, type SlugResolver } from '../src/core/link-extraction.ts';

const nullResolver: SlugResolver = { resolve: async () => null };
const types = async (content: string) => (await extractPageLinks('people/dana-example', content, {}, 'person', nullResolver, { skipFrontmatter: true }))
  .candidates.map(c => [c.targetSlug, c.linkType]);

test('two links with different verbs in one sentence each get their own verb', async () => {
  expect(await types('Dana works at [Acme](companies/acme-example) on payments and also advises [Widget](companies/widget-co) on pricing.'))
    .toEqual([['companies/acme-example', 'works_at'], ['companies/widget-co', 'advises']]);
  expect(await types('She co-founded [Beta](companies/beta-co) in 2019, and she works at [Acme](companies/acme-example) today.'))
    .toEqual([['companies/beta-co', 'founded'], ['companies/acme-example', 'works_at']]);
});

test('a compound role keeps precedence: founder and CEO of [X] is founded', async () => {
  expect(await types('Dana is the founder and CEO of [Apex](companies/apex-example), an infrastructure company.'))
    .toEqual([['companies/apex-example', 'founded']]);
});

test('a timeline line "Joined [X] as engineer" is works_at on a page whose prose never names X', async () => {
  expect(await types('A short bio.\n\n## Timeline\n\n- **2024-03-01** | linkedin — Joined [Acme](companies/acme-example) as engineer'))
    .toEqual([['companies/acme-example', 'works_at']]);
  expect(inferLinkType('person', 'joined [Acme](companies/acme-example) as a senior engineer', undefined, 'companies/acme-example')).toBe('works_at');
});

test('without a locatable link, plain precedence applies as before', () => {
  expect(inferLinkType('person', 'works at Acme and advises Widget')).toBe('advises');
});

test('the verb is read at this link, not at an earlier mention of the same target in the window', () => {
  const body = [
    'Alice is CTO of [Acme](../companies/acme-example).',
    '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co)',
    '- **2025-03-02** | note — works at [Widget](../companies/widget-co)',
  ].join('\n');
  const at = body.lastIndexOf('[Widget]');
  const window = body.slice(Math.max(0, at - 120), at + 120).replace(/\s+/g, ' ').trim();
  const anchor = body.slice(Math.max(0, at - 120), at).replace(/\s+/g, ' ').trimStart().length;
  expect(inferLinkType('person', window, undefined, 'companies/widget-co', undefined, anchor)).toBe('works_at');
  expect(inferLinkType('person', window, undefined, 'companies/widget-co')).toBe('mentions');
});

test('links joined by "and" share the verb before the first: works at [A] and at [B]', async () => {
  const content = 'Alice works at [Acme](companies/acme-example) and at [Widget](companies/widget-co).';
  const window = content.replace(/\s+/g, ' ');
  expect(inferLinkType('person', window, undefined, 'companies/widget-co', undefined, window.indexOf('[Widget]'))).toBe('works_at');
  expect(inferLinkType('person', 'Alice works at [Acme](companies/acme-example) and also advises [Widget](companies/widget-co).', undefined, 'companies/widget-co')).toBe('advises');
});

test('a verb right before a preposition and the next link belongs to that link: "Took an advisory role with [X]"', async () => {
  const content = 'Alice works at [Beta](companies/beta-example).\n\n## Timeline\n\n- **2024-03-01** | linkedin — Took an advisory role with [Acme](companies/acme-example)';
  const r = await extractPageLinks('people/alice-example', content, {}, 'person', { resolve: async () => null } as SlugResolver, {});
  expect(r.candidates.map(c => [c.targetSlug, c.linkType])).toEqual([['companies/beta-example', 'works_at'], ['companies/acme-example', 'advises']]);
});

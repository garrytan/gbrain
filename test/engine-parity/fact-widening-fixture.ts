/**
 * The shared fixture of the fact visibility widening parity cases (fact-visibility-widening, fact-trajectory-widening and
 * fact-pool-widening): member pages that name their member, open and private pages, and one private fact for each rule
 * of a widened world-only list, plus the restricted callers that read them.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { MEMBER_PAGE_PREFIX } from '../../src/core/access/principals.ts';

export const ENTITY = 'people/a-example';
export const SESSION = 'session-widening';
export const ALICE_PAGE = `${MEMBER_PAGE_PREFIX}alice-example`;
export const BOB_PAGE = `${MEMBER_PAGE_PREFIX}bob-example`;

const page = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note', title, compiled_truth: title, timeline: '', frontmatter });

/** Member pages that name their member, open and private pages, and one fact for each rule of the widened list. */
export async function fixture(engine: BrainEngine) {
  await engine.putPage(ENTITY, { type: 'person', title: 'A', compiled_truth: 'A', timeline: '' });
  await engine.putPage('people/b-example', { type: 'person', title: 'B', compiled_truth: 'B', timeline: '', frontmatter: { visibility: 'private' } });
  await engine.putPage('notes/open', page('Open'));
  await engine.putPage('notes/private', page('Private', { visibility: 'private' }));
  await engine.putPage('notes/readers', page('Readers', { readable_by: ['member:alice-example'] }));
  await engine.putPage('notes/quarantined', page('Quarantined', { quarantine: { reason: 'test' } }));
  await engine.putPage(ALICE_PAGE, page('alice-example', { readable_by: ['member:alice-example'] }));
  await engine.putPage(BOB_PAGE, page('bob-example', { readable_by: ['member:bob-example'] }));
  await engine.putPage('notes/open', page('Open other'), { sourceId: 'other' });
  const rows: Array<Record<string, unknown>> = [
    { fact: 'world fact', source_markdown_slug: 'notes/open', visibility: 'world' },
    { fact: 'own member fact', source_markdown_slug: ALICE_PAGE },
    { fact: 'other member fact', source_markdown_slug: BOB_PAGE },
    { fact: 'granted fact', source_markdown_slug: 'notes/open' },
    { fact: 'private holding fact', source_markdown_slug: 'notes/private' },
    { fact: 'readers holding fact', source_markdown_slug: 'notes/readers' },
    { fact: 'quarantined holding fact', source_markdown_slug: 'notes/quarantined' },
    { fact: 'missing holding fact', source_markdown_slug: 'notes/gone' },
    { fact: 'unpaged fact', source_markdown_slug: null },
    { fact: 'transcript fact', source_markdown_slug: 'notes/open', source: 'transcript:chat' },
    { fact: 'private provenance fact', source_markdown_slug: 'notes/open', source: 'mcp:put_page', context: 'notes/private.md extracted' },
    { fact: 'member provenance fact', source_markdown_slug: 'notes/open', source: 'mcp:put_page', context: `${ALICE_PAGE} saved` },
    { fact: 'private entity fact', source_markdown_slug: 'notes/open', entity_slug: 'people/b-example' },
  ];
  await engine.insertFacts(rows.map((r, i) => ({
    entity_slug: ENTITY, visibility: 'private', source: 'fence', ...r, row_num: i + 1, kind: 'fact', source_session: SESSION,
    valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
  })) as never, { source_id: 'default' });
  await engine.insertFacts([{
    fact: 'other source fact', entity_slug: ENTITY, source_markdown_slug: 'notes/open', visibility: 'private', source: 'fence',
    row_num: 1, kind: 'fact', source_session: SESSION, valid_from: new Date(Date.UTC(2026, 5, 1)),
  }] as never, { source_id: 'other' });
}

/** Restricted callers (a page names readers): plain, the member, a grant on `default`, a grant on `other`, and both. */
export const CALLERS = {
  plain: { identity: [], hidePrivate: true },
  alice: { identity: ['member:alice-example'], hidePrivate: true },
  granted: { identity: [], privateFactSources: ['default'], hidePrivate: true },
  grantedOther: { identity: [], privateFactSources: ['other'], hidePrivate: true },
  aliceGranted: { identity: ['member:alice-example'], privateFactSources: ['default'], hidePrivate: true },
} as const;

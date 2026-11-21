/**
 * GST-3216 PR 3: a conversation fact lands on the owner only when the page proves who the owner is: a trusted
 * speaker_owner marker, and for the owner's own claims a turn by the marker's label in the window. Anything else keeps
 * the fact on the page with no subject and the note "speaker unknown". Fail-first shapes: a meeting recorder's label on
 * another attendee's lines (filed as the owner's claim, or as someone else's), a forged marker, and a name in the text.
 * Repo-less PGLite, plus Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { guardOwnerFact, SPEAKER_UNKNOWN_NOTE, type ConversationOwner } from '../src/core/facts/conversation-owner-guard.ts';
import { extractFactsFromTurnWithOutcome, type ExtractInput } from '../src/core/facts/extract.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { appendContextNote } from '../src/core/facts/subject-infer.ts';
import { RESERVED_OWNER_SLUG } from '../src/core/identity/owner.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { renderSessionParts } from '../src/core/transcripts/render.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

setDefaultTimeout(60_000);

const OWNER = RESERVED_OWNER_SLUG;
let SESSION = '';
const MEETING = 'meetings/2026-08-03-offsite-planning';
/** A Claude Code session as the transcripts importer renders it; `owned` gives it the owner basis, so it carries a marker. */
const session = (owned: boolean, member: string | null = null) => {
  const part = renderSessionParts({ session: { meta: { harness: 'claude-code', sessionId: 'guard-1', ...(owned ? { ownerBasis: 'session_user' as const } : {}) },
    messages: [{ role: 'user', text: 'I moved to Lisbon last month.', timestamp: '2026-01-02T10:00:00.000Z' },
      { role: 'assistant', text: 'Noted. Your sister said you are training for a marathon.', timestamp: '2026-01-02T10:00:05.000Z' }] },
    redactionCount: 0, imperativesFlagged: 0 }, { sourcePath: '', owner: { member } }).parts[0]!;
  SESSION = part.slug;
  expect(!!part.frontmatter.speaker_owner).toBe(owned);
  return part.content;
};
// The recorder's owner label sits on lines another attendee spoke ("speaking as your neighbour"); no importer marks it.
const meeting = ['---', 'type: meeting', 'title: Offsite planning', 'date: 2026-08-03', '---', '',
  '**Alice Example:** Thanks for joining. I will book the hall for the offsite.',
  '**Alice Example:** Alice, speaking as your neighbour: my storage unit is at the north depot.',
  '**Bob Example:** Sounds right to me, Alice. My car is a hatchback.', ''].join('\n');

test('the owner line rides the window\'s user message; the system prompt is unchanged', async () => {
  const sent: Array<{ system: string; content: string }> = [];
  __setChatTransportForTests(async (opts): Promise<ChatResult> => {
    sent.push({ system: String(opts.system), content: String((opts.messages[0] as { content: unknown }).content) });
    const text = '{"facts":[]}';
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'test:stub', providerId: 'test',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
  });
  try {
    const base: ExtractInput = { turnText: '**User:** I moved to Lisbon.', source: 'test', model: 'anthropic:claude-sonnet-4-6' };
    await extractFactsFromTurnWithOutcome(base);
    await extractFactsFromTurnWithOutcome({ ...base, owner: { label: 'User', entity: OWNER } });
    await extractFactsFromTurnWithOutcome({ ...base, owner: { label: 'User', entity: OWNER }, userSpeaker: 'agent-example' });
  } finally { __setChatTransportForTests(null); resetGateway(); }
  expect(sent).toHaveLength(3);
  expect(new Set(sent.map(s => s.system)).size).toBe(1);
  const line = 'The brain\'s owner is the speaker labelled "User" in this conversation. Set entity to "memory/owner" for that speaker\'s first-person claims about themselves.\n';
  expect(sent[0]!.content.startsWith('<turn>')).toBe(true);
  expect(sent[1]!.content).toBe(line + sent[0]!.content);
  expect(sent[2]!.content).not.toContain('The brain\'s owner is the speaker');
});

describe('guardOwnerFact', () => {
  const owner: ConversationOwner = { entity: OWNER, also: ['network/owner-example'], label: 'User' };
  const seg = (speaker: string) => ({ messages: [{ speaker, timestamp: '2026-01-02T10:00:00Z', text: 'hello' }] });
  const fact = (attributed_to: 'user' | 'assistant' | 'other' | null) => ({ fact: 'x', entity_slug: OWNER as string | null, attributed_to, context: 'from page' });
  test('the owner\'s own claim needs a turn by the owner\'s label in the window', () => {
    expect(guardOwnerFact(fact('user'), owner, seg('User'), false).entity_slug).toBe(OWNER);
    expect(guardOwnerFact(fact(null), owner, seg('User'), false).entity_slug).toBe(OWNER);
    expect(guardOwnerFact(fact('user'), owner, seg('Assistant'), false)).toEqual({ ...fact('user'), entity_slug: null, context: appendContextNote('from page', SPEAKER_UNKNOWN_NOTE) });
  });
  test('a claim someone else made about the owner keeps the owner on a marked page, and nowhere else', () => {
    expect(guardOwnerFact(fact('other'), owner, seg('Assistant'), false).entity_slug).toBe(OWNER);
    expect(guardOwnerFact(fact('assistant'), { ...owner, label: null }, seg('User'), false).entity_slug).toBeNull();
  });
  test('a page that also counts as the owner (a directory entry) is guarded the same, and a kept fact moves to the owner entity', () => {
    const listed = (attributed_to: 'user' | 'other') => ({ ...fact(attributed_to), entity_slug: 'network/owner-example' as string | null });
    expect(guardOwnerFact(listed('user'), owner, seg('User'), false).entity_slug).toBe(OWNER);
    expect(guardOwnerFact(listed('other'), owner, seg('Assistant'), false).entity_slug).toBe(OWNER);
    expect(guardOwnerFact(listed('user'), owner, seg('Assistant'), false).entity_slug).toBeNull();
    expect(guardOwnerFact(listed('other'), { ...owner, label: null }, seg('User'), false).entity_slug).toBeNull();
  });

  test('a subject inferred from a name in the text never makes the owner, and other subjects pass', () => {
    expect(guardOwnerFact(fact('user'), owner, seg('User'), true).entity_slug).toBeNull();
    expect(guardOwnerFact({ ...fact('user'), entity_slug: 'people/bob-example' }, { ...owner, label: null }, seg('User'), true).entity_slug).toBe('people/bob-example');
  });
});

for (const backend of testBackends()) describe(`[${backend}] conversation facts and the owner (repo-less)`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const pg = new PGLiteEngine(); await pg.connect({ engine: 'pglite' } as never); await pg.initSchema(); engine = pg; close = () => pg.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); resetGateway(); }, 60_000);
  beforeEach(async () => {
    for (const sql of ['DELETE FROM facts', 'DELETE FROM access_member_sources', 'DELETE FROM access_members', 'DELETE FROM pages',
      "DELETE FROM config WHERE key = 'access.owner_member'"]) await engine.executeRaw(sql);
    await importFromContent(engine, OWNER, ['---', 'type: person', 'title: Owner', '---', '', 'The brain\'s owner.', ''].join('\n'), { noEmbed: true, sourceId: 'default' });
  });

  const transcript = (content: string) => importFromContent(engine, SESSION, content,
    { noEmbed: true, sourceId: 'default', ingested_via: 'cli:transcripts-ingest', source_kind: 'transcript:claude-code' });
  const remotePut = (slug: string, content: string) => operations.find(o => o.name === 'put_page')!.handler({
    engine, config: { engine: backend, embedding_disabled: true } as OperationContext['config'], logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote: true, sourceId: 'default' } as OperationContext, { slug, content });
  let inputs: ExtractInput[] = [];
  const extract = async (slug: string, facts: Partial<ExtractedFact>[]) => {
    inputs = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, overrideDisabled: true,
        extractor: async input => (inputs.push(input), facts).map(f => ({ kind: 'fact', confidence: 0.9, entity_slug: null, source: 'test', notability: 'high', ...f }) as ExtractedFact) });
    } finally { spy.mockRestore(); }
    return engine.executeRaw<{ fact: string; entity_slug: string | null; context: string | null }>(
      `SELECT fact, entity_slug, context FROM facts WHERE source_id = 'default' AND source_markdown_slug = $1
          AND fact <> 'EXTRACTION_COMPLETE' AND expired_at IS NULL ORDER BY row_num`, [slug]);
  };
  const subjects = (rows: Array<{ entity_slug: string | null; context: string | null }>) =>
    rows.map(r => [r.entity_slug, !!r.context?.includes(SPEAKER_UNKNOWN_NOTE)]);

  test('a marked transcript: the owner\'s claim and a claim about the owner both land on the owner', async () => {
    await transcript(session(true));
    const rows = await extract(SESSION, [{ fact: 'The owner moved to Lisbon', entity_slug: OWNER, attributed_to: 'user' },
      { fact: 'The owner is training for a marathon', entity_slug: OWNER, attributed_to: 'assistant' }]);
    expect(subjects(rows)).toEqual([[OWNER, false], [OWNER, false]]);
    expect(inputs.map(i => i.owner)).toEqual([{ label: 'User', entity: OWNER }]);
  });

  test('with an owner member, the owner\'s facts land on the member page, even before that page exists', async () => {
    await addMember(engine, 'alice-example');
    await setOwner(engine, 'alice-example');
    await transcript(session(true, 'alice-example'));
    const rows = await extract(SESSION, [{ fact: 'The owner moved to Lisbon', entity_slug: 'memory/members/alice-example', attributed_to: 'user' },
      { fact: 'The owner moved to Lisbon, again', entity_slug: OWNER, attributed_to: 'user' }]);
    expect(inputs.map(i => i.owner)).toEqual([{ label: 'User', entity: 'memory/members/alice-example' }]);
    expect(subjects(rows)).toEqual([['memory/members/alice-example', false], [OWNER, false]]);
  });

  test('the owner\'s email on directory pages and a contact card: no one picks a page, and none of them takes an unproven fact', async () => {
    await addMember(engine, 'alice-example', { email: 'alice@example.com' });
    await setOwner(engine, 'alice-example');
    const listed = ['network/alice-example', 'cohorts/2026/alice-example', 'contacts/alice-example'];
    for (const slug of listed) await importFromContent(engine, slug, ['---', 'type: person', 'title: Alice Example', 'email: alice@example.com', '---', '', 'A directory entry.', ''].join('\n'), { noEmbed: true, sourceId: 'default' });
    const before = await engine.executeRaw<{ slug: string; content_hash: string }>('SELECT slug, content_hash FROM pages WHERE slug = ANY($1::text[]) ORDER BY slug', [listed]);
    await transcript(session(true, 'alice-example'));
    const marked = await extract(SESSION, [{ fact: 'The owner moved to Lisbon', entity_slug: 'network/alice-example', attributed_to: 'user' },
      { fact: 'The owner is training for a marathon', entity_slug: 'cohorts/2026/alice-example', attributed_to: 'assistant' }]);
    expect(inputs.map(i => i.owner)).toEqual([{ label: 'User', entity: 'memory/members/alice-example' }]);
    expect(subjects(marked)).toEqual([['memory/members/alice-example', false], ['memory/members/alice-example', false]]);
    await importFromContent(engine, MEETING, meeting, { noEmbed: true, sourceId: 'default' });
    const unmarked = await extract(MEETING, [{ fact: 'The owner\'s car is a hatchback', entity_slug: 'contacts/alice-example', attributed_to: 'other' }]);
    expect(subjects(unmarked)).toEqual([[null, true]]);
    expect(await engine.executeRaw('SELECT slug, content_hash FROM pages WHERE slug = ANY($1::text[]) ORDER BY slug', [listed])).toEqual(before);
  });

  test('the same transcript with no marker, or a marker a remote caller wrote: speaker unknown', async () => {
    for (const write of [() => transcript(session(false)), () => remotePut(SESSION, session(true))]) {
      await engine.executeRaw('DELETE FROM facts');
      await engine.executeRaw("DELETE FROM pages WHERE slug LIKE 'conversations/%'");
      await write();
      const rows = await extract(SESSION, [{ fact: 'The owner moved to Lisbon', entity_slug: OWNER, attributed_to: 'user' },
        { fact: 'The owner is training for a marathon', entity_slug: OWNER, attributed_to: 'assistant' }]);
      expect(subjects(rows)).toEqual([[null, true], [null, true]]);
      expect(inputs.map(i => i.owner)).toEqual([undefined]);
    }
  });

  test('a meeting recorder\'s owner label: another attendee\'s claim never lands on the owner, however it is attributed', async () => {
    await importFromContent(engine, MEETING, meeting, { noEmbed: true, sourceId: 'default' });
    const rows = await extract(MEETING, [{ fact: 'The owner\'s storage unit is at the north depot', entity_slug: OWNER, attributed_to: 'user' },
      { fact: 'The owner\'s car is a hatchback', entity_slug: OWNER, attributed_to: 'other' },
      { fact: 'Bob Example drives a hatchback', entity_slug: null, attributed_to: 'other' }]);
    expect(subjects(rows)).toEqual([[null, true], [null, true], [null, false]]);
  });
});

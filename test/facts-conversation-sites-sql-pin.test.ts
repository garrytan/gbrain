/**
 * The conversation publication and relink statements (src/core/engine-sql/facts-conversation.ts) sent through `executeRaw` at
 * base commit 5e22f0c134 from src/core/facts/{conversation-publication,relink-publish,conversation-memo,conversation-relink,
 * conversation-entity-hints,conversation-incremental,conversation-relink-carry,relink}.ts. A text or bind drift changes a query
 * plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each typed member sends the statement text and the binds its caller sent before the move, byte for byte (the texts
 * are in test/helpers/facts-conversation-base-sql.ts, copied from the base commit), and answers the caller's old coercion. Also
 * protects the drift guard of the members that spell a helper's text out (a static string, because its placeholders are out of
 * order or sit in an `IN (...)` list): the helper (`outcomeMarkerSql`, `unbackedEntitySql`, `CONVERSATION_SLOT_SQL`,
 * `retiredPageSql`, `folderRestrictedSql`, the audit source lists) still produces the text the member carries.
 * Fails when a member reorders a clause, renumbers a placeholder, binds a value differently or changes what it returns, and when
 * a helper changes without the member that stands in for it. No database: the engine runs on the recording fake.
 */
import { describe, expect, test } from 'bun:test';
import { makeEngineWithFake, withPinnedSqlEnvironment } from './helpers/postgres-engine-sql-cases.ts';
import { BASE_CLEAR, BASE_SQL } from './helpers/facts-conversation-base-sql.ts';
import { AUDIT_ROW_SOURCES, CONVERSATION_FACTS_SOURCE_PREFIX, NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE, outcomeMarkerSql } from '../src/core/facts/audit-sources.ts';
import { unbackedEntitySql } from '../src/core/facts/withdrawal-schema.ts';
import { CONVERSATION_SLOT_SQL } from '../src/core/chronicle/ontology.ts';
import { retiredPageSql } from '../src/core/entities/resolve.ts';
import { folderRestrictedSql } from '../src/core/search/private-visibility.ts';
import { LABEL_RETIRED_MARKER, RELINKED_DERIVED_ROW } from '../src/core/engine-sql/facts-conversation.ts';

const SRC = 'src-a';
const SLUG = 'conversations/c1';
const AUDIT = [...AUDIT_ROW_SOURCES];
const WINDOW_KEY = `(f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha')`;

/** Runs `fn` on a fresh engine over the recording fake, with `rows` as every statement's answer; returns the statements and the value. */
async function record<T>(rows: unknown[], fn: (engine: any) => Promise<T>): Promise<{ statements: Array<{ text: string; params: unknown[] }>; value: T }> {
  return withPinnedSqlEnvironment(undefined, async () => {
    const { engine, fake } = makeEngineWithFake([[/./, rows]]);
    const value = await fn(engine);
    return { statements: fake.statements().map(s => ({ text: s.text, params: s.params })), value };
  });
}

interface Case {
  name: string;
  /** What the engine answers each statement of the case with. */
  rows: unknown[];
  run: (engine: any) => Promise<unknown>;
  /** The statements the member must send: the base text of `BASE_SQL[text]` with these binds. */
  sends: Array<{ text: string; params: unknown[] }>;
  /** What the member returns for `rows`. */
  returns: unknown;
}

const at = '2026-03-01T10:00:00.000Z';
const CASES: Case[] = [
  { name: 'readNewestConversationFactId', rows: [{ id: 7 }], run: e => e.readNewestConversationFactId(SRC, SLUG),
    sends: [{ text: BASE_SQL.readNewestConversationFactId!, params: [SRC, SLUG] }], returns: 7 },
  { name: 'findSpentConversationRequest', rows: [{ request_id: 'r1' }], run: e => e.findSpentConversationRequest('local_cli', 'writer-1', 'r1', 'd1'),
    sends: [{ text: BASE_SQL.findSpentConversationRequest!, params: ['local_cli', 'writer-1', 'r1', 'd1'] }], returns: { request_id: 'r1' } },
  { name: 'listConversationBatchRequests', rows: [{ id: 'i1', request_id: 'r1', state: 'pending', error_code: null, members: null }],
    run: e => e.listConversationBatchRequests('local_cli', 'writer-1', SRC, SLUG),
    sends: [{ text: BASE_SQL.listConversationBatchRequests!, params: ['local_cli', 'writer-1', SRC, SLUG] }],
    returns: [{ id: 'i1', request_id: 'r1', state: 'pending', error_code: null, members: null }] },
  { name: 'readStoredConversationEntry', rows: [{ entry: { slug: SLUG, generation: 'g1' } }], run: e => e.readStoredConversationEntry('id1', 'g1'),
    sends: [{ text: BASE_SQL.readStoredConversationEntry!, params: ['id1', 'g1'] }], returns: { slug: SLUG, generation: 'g1' } },
  { name: 'readPrincipalCounters', rows: [{ outstanding_count: 1, terminal_bytes: 2, lifetime_ids: 3 }], run: e => e.readPrincipalCounters('principal:local_cli:writer-1'),
    sends: [{ text: BASE_SQL.readPrincipalCounters!, params: ['principal:local_cli:writer-1'] }], returns: { outstanding_count: 1, terminal_bytes: 2, lifetime_ids: 3 } },
  { name: 'countConversationPagesToExtract', rows: [{ n: '4' }], run: e => e.countConversationPagesToExtract(SRC, ['note', 'meeting'], false),
    sends: [{ text: BASE_SQL.countConversationPagesToExtract!, params: [SRC, ['note', 'meeting'], false, TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE] }], returns: 4 },
  { name: 'listMergedEntityAliases', rows: [{ alias_slug: 'people/a', canonical_slug: 'people/b' }], run: e => e.listMergedEntityAliases(SRC, ['people/a', 'people/a', 'people/c']),
    sends: [{ text: BASE_SQL.listMergedEntityAliases!, params: [SRC, ['people/a', 'people/c']] }], returns: [{ alias_slug: 'people/a', canonical_slug: 'people/b' }] },
  { name: 'moveConversationSourceWindows', rows: [], run: e => e.moveConversationSourceWindows(SRC, SLUG, [{ from: 'o:1:x', to: { occurrence_id: 'o', window_ordinal: 2 } }]),
    sends: [{ text: BASE_SQL.moveConversationSourceWindows!, params: [SRC, SLUG, '[{"k":"o:1:x","w":{"occurrence_id":"o","window_ordinal":2}}]'] }], returns: undefined },
  { name: 'stampConversationSourceWindows', rows: [], run: e => e.stampConversationSourceWindows([{ id: 5, w: { occurrence_id: 'o' } }, { id: 6, w: null }]),
    sends: [{ text: BASE_SQL.stampConversationSourceWindows!, params: ['[{"id":5,"w":{"occurrence_id":"o"}},{"id":6,"w":null}]'] }], returns: undefined },
  { name: 'countActiveConversationFacts', rows: [{ n: 3 }], run: e => e.countActiveConversationFacts(SRC, SLUG),
    sends: [{ text: BASE_SQL.countActiveConversationFacts!, params: [SRC, SLUG, AUDIT] }], returns: 3 },
  { name: 'readConversationSlotValueHash', rows: [{ value_hash: 'h1' }], run: e => e.readConversationSlotValueHash(SRC, 'people/a', 'role', at),
    sends: [{ text: BASE_SQL.readConversationSlotValueHash!, params: [SRC, 'people/a', 'role', at] }], returns: { value_hash: 'h1' } },
  { name: 'deleteConversationOutcomeRows', rows: [{ id: 9 }], run: e => e.deleteConversationOutcomeRows(SRC, SLUG),
    sends: [{ text: BASE_SQL.deleteConversationOutcomeRows!, params: [SRC, SLUG, AUDIT] }], returns: [{ id: 9 }] },
  { name: 'listPurgeTombstoneMatches', rows: [{ ord: '2' }],
    run: e => e.listPurgeTombstoneMatches(SRC, { facts: ['a', 'b'], visibilities: ['world', 'private'], entitySlugs: ['people/a', null], sources: ['s', null] }),
    sends: [{ text: BASE_SQL.listPurgeTombstoneMatches!, params: [SRC, ['a', 'b'], ['world', 'private'], ['people/a', null], ['s', null]] }], returns: [{ ord: '2' }] },
  { name: 'maxConversationRowNum', rows: [{ n: '12' }], run: e => e.maxConversationRowNum(SRC, SLUG),
    sends: [{ text: BASE_SQL.maxConversationRowNum!, params: [SRC, SLUG] }], returns: '12' },
  { name: 'listHeldFactSlots', rows: [{ entity_slug: 'people/a', dimension: 'role', value_hash: 'h', valid_from: at }], run: e => e.listHeldFactSlots(SRC, SLUG),
    sends: [{ text: BASE_SQL.listHeldFactSlots!, params: [SRC, SLUG] }], returns: [{ entity_slug: 'people/a', dimension: 'role', value_hash: 'h', valid_from: at }] },
  { name: 'countPageConversationFacts', rows: [{ count: '5' }], run: e => e.countPageConversationFacts(SRC, SLUG),
    sends: [{ text: BASE_SQL.countPageConversationFacts!, params: [SRC, SLUG, AUDIT] }], returns: 5 },
  { name: 'countConversationWindowFacts', rows: [{ count: '6' }], run: e => e.countConversationWindowFacts(SRC, SLUG, 'o:1:x'),
    sends: [{ text: BASE_SQL.countConversationWindowFacts!, params: [SRC, SLUG, 'o:1:x'] }], returns: 6 },
  { name: 'countConversationFactsOutsideWindows', rows: [{ count: '7' }], run: e => e.countConversationFactsOutsideWindows(SRC, SLUG, ['o:1:x', 'o:2:y']),
    sends: [{ text: BASE_SQL.countConversationFactsOutsideWindows!, params: [SRC, SLUG, AUDIT, ['o:1:x', 'o:2:y']] }], returns: 7 },
  { name: 'findSameClaimFenceRow', rows: [{ id: 3, visibility: 'world' }], run: e => e.findSameClaimFenceRow(SRC, SLUG, 'Prefers email', null),
    sends: [{ text: BASE_SQL.findSameClaimFenceRow!, params: [SRC, SLUG, 'Prefers email', null] }], returns: { id: 3, visibility: 'world' } },
  { name: 'findOntologyTwin', rows: [{ id: 4 }], run: e => e.findOntologyTwin(SRC, SLUG, 8),
    sends: [{ text: BASE_SQL.findOntologyTwin!, params: [SRC, SLUG, 8] }], returns: { id: 4 } },
  // relink-publish.ts reads the next row number through the existing maxFenceRowNum, whose text is the old inline statement.
  { name: 'maxFenceRowNum (relink publication)', rows: [{ n: 4 }], run: e => e.maxFenceRowNum(SRC, SLUG),
    sends: [{ text: BASE_SQL.maxFenceRowNum!, params: [SRC, SLUG] }], returns: 4 },
  { name: 'readRelinkSource', rows: [{ incarnation: 'i', archived: false, local_path: null, kind: 'git' }], run: e => e.readRelinkSource(SRC),
    sends: [{ text: BASE_SQL.readRelinkSource!, params: [SRC] }], returns: { incarnation: 'i', archived: false, local_path: null, kind: 'git' } },
  { name: 'factRelinkAttemptsTableExists', rows: [{ t: 'fact_relink_attempts' }], run: e => e.factRelinkAttemptsTableExists(),
    sends: [{ text: BASE_SQL.factRelinkAttemptsTableExists!, params: [] }], returns: true },
  { name: 'readReextractOutcomeRow', rows: [{ id: 2, hash: 'abc' }], run: e => e.readReextractOutcomeRow(SRC, SLUG),
    sends: [{ text: BASE_SQL.readReextractOutcomeRow!, params: [SRC, SLUG, TERMINAL_AUDIT_SOURCE] }], returns: { id: 2, hash: 'abc' } },
  { name: 'listUnbackedConversationRows', rows: [{ id: 1, fact: 'f', context: null, visibility: 'private', slug: SLUG, attributed_to: null, entity_slug: 'alice' }],
    run: e => e.listUnbackedConversationRows(SRC, [SLUG]),
    sends: [{ text: BASE_SQL.listUnbackedConversationRows!, params: [SRC, [SLUG], AUDIT] }],
    returns: [{ id: 1, fact: 'f', context: null, visibility: 'private', slug: SLUG, attributed_to: null, entity_slug: 'alice' }] },
  { name: 'listUnlinkedConversationRows', rows: [{ id: 1, fact: 'f', context: null, visibility: 'private', slug: SLUG, attributed_to: null }],
    run: e => e.listUnlinkedConversationRows(SRC, [SLUG]),
    sends: [{ text: BASE_SQL.listUnlinkedConversationRows!, params: [SRC, [SLUG], AUDIT] }],
    returns: [{ id: 1, fact: 'f', context: null, visibility: 'private', slug: SLUG, attributed_to: null }] },
  { name: 'listEntityHintPages', rows: [{ slug: 'people/a', type: 'person', frontmatter: {}, retired: false, folder_restricted: false }],
    run: e => e.listEntityHintPages(SRC, ['people/a']),
    sends: [{ text: BASE_SQL.listEntityHintPages!, params: [SRC, ['people/a']] }],
    returns: [{ slug: 'people/a', type: 'person', frontmatter: {}, retired: false, folder_restricted: false }] },
  { name: 'lockPageById', rows: [], run: e => e.lockPageById(11),
    sends: [{ text: BASE_SQL.lockPageById!, params: [11] }], returns: undefined },
  { name: 'listClearedRelinkedFacts', rows: [{ fact: 'f', entity_slug: 'people/a', context: 'entity relinked from x' }], run: e => e.listClearedRelinkedFacts(SRC, SLUG),
    sends: [{ text: BASE_SQL.listClearedRelinkedFacts!, params: [SRC, SLUG] }], returns: [{ fact: 'f', entity_slug: 'people/a', context: 'entity relinked from x' }] },
  { name: 'countEmbeddedFactsAmong', rows: [{ n: '2' }], run: e => e.countEmbeddedFactsAmong(SRC, [1, 2, 3]),
    sends: [{ text: BASE_SQL.countEmbeddedFactsAmong!, params: [SRC, [1, 2, 3]] }], returns: 2 },
];

describe('conversation publication and relink members send the statements their callers sent before the move', () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const { statements, value } = await record(c.rows, c.run);
      expect(statements).toEqual(c.sends);
      expect(value).toEqual(c.returns);
    });
  }

  test('the members answer the empty cases the callers coerce', async () => {
    const empty = await record([], async e => ({
      newest: await e.readNewestConversationFactId(SRC, SLUG), spent: await e.findSpentConversationRequest('k', 'p', 'r', 'd'),
      stored: await e.readStoredConversationEntry('i', 'g'), counters: await e.readPrincipalCounters('k'),
      toExtract: await e.countConversationPagesToExtract(SRC, [], true), active: await e.countActiveConversationFacts(SRC, SLUG),
      slot: await e.readConversationSlotValueHash(SRC, 'e', 'd', at), top: await e.maxConversationRowNum(SRC, SLUG),
      page: await e.countPageConversationFacts(SRC, SLUG), window: await e.countConversationWindowFacts(SRC, SLUG, 'k'),
      outside: await e.countConversationFactsOutsideWindows(SRC, SLUG, []), same: await e.findSameClaimFenceRow(SRC, SLUG, 'f', null),
      twin: await e.findOntologyTwin(SRC, SLUG, 1), source: await e.readRelinkSource(SRC), table: await e.factRelinkAttemptsTableExists(),
      outcome: await e.readReextractOutcomeRow(SRC, SLUG), embedded: await e.countEmbeddedFactsAmong(SRC, []),
    }));
    expect(empty.value).toEqual({
      newest: null, spent: null, stored: null, counters: null, toExtract: 0, active: 0, slot: null, top: null, page: 0, window: 0, outside: 0,
      same: null, twin: null, source: null, table: false, outcome: null, embedded: 0,
    });
  });

  test('a null table name answers false', async () => {
    expect((await record([{ t: null }], e => e.factRelinkAttemptsTableExists())).value).toBe(false);
  });

  test('clearConversationPageFacts sends the five base statements of a whole-page clear and sums the three counts', async () => {
    const { statements, value } = await record([{ count: '2' }], e => e.clearConversationPageFacts(SRC, SLUG));
    expect(statements).toEqual(BASE_CLEAR.plain);
    expect(value).toBe(6);
  });

  test('clearConversationPageFacts sends the five base statements of a window clear, binding keys, flags and audit sources in order', async () => {
    const windows = { keys: ['a:1:x', 'b:2:y'], keep: true, unanchored: false };
    const { statements, value } = await record([{ count: '2' }], e => e.clearConversationPageFacts(SRC, SLUG, windows));
    expect(statements).toEqual(BASE_CLEAR.windows);
    expect(statements.every(s => s.params.length === 6)).toBe(true);
    expect(value).toBe(6);
  });

  test('clearConversationPageFacts counts nothing when the statements answer no rows', async () => {
    expect((await record([], e => e.clearConversationPageFacts(SRC, SLUG))).value).toBe(0);
  });
});

describe('the members that spell a helper out still carry the helper\'s text', () => {
  const texts = () => Object.values(BASE_SQL).join('\n');

  test('the conversation source prefix, slot test and window key', () => {
    expect(CONVERSATION_FACTS_SOURCE_PREFIX).toBe('cli:extract-conversation-facts');
    expect(CONVERSATION_SLOT_SQL).toBe(`COALESCE(source, '') LIKE 'cli:extract-conversation-facts%'`);
    expect(texts()).toContain(WINDOW_KEY);
    expect(texts()).toContain(CONVERSATION_SLOT_SQL);
  });

  test('the audit sources the purge-tombstone and page-count members spell out', () => {
    expect(AUDIT).toEqual(['cli:extract-conversation-facts:terminal:v2', 'cli:extract-conversation-facts:non-extractable:v2', 'cli:extract-conversation-facts:terminal']);
    expect(TERMINAL_AUDIT_SOURCE).toBe('cli:extract-conversation-facts:terminal:v2');
    expect(NON_EXTRACTABLE_AUDIT_SOURCE).toBe('cli:extract-conversation-facts:non-extractable:v2');
    expect(outcomeMarkerSql('n')).toBe(`(n.source IN ('cli:extract-conversation-facts:terminal:v2','cli:extract-conversation-facts:non-extractable:v2','cli:extract-conversation-facts:terminal') AND n.fact IN ('EXTRACTION_COMPLETE','EXTRACTION_NOT_APPLICABLE'))`);
    expect(BASE_SQL.listPurgeTombstoneMatches).toContain(outcomeMarkerSql('n'));
  });

  test('the unbacked-entity test of the purge-tombstone member', () => {
    expect(BASE_SQL.listPurgeTombstoneMatches).toContain(unbackedEntitySql('n', '$1'));
    expect(unbackedEntitySql('n', '$1')).toContain('unbacked_page.source_id = $1');
  });

  test('the relinked-row predicate and the retired-label marker', () => {
    expect(RELINKED_DERIVED_ROW).toBe(`f.entity_slug IS NOT NULL AND COALESCE(f.context, '') LIKE '%entity relinked from %'`);
    expect(LABEL_RETIRED_MARKER).toBe('retired: conversation-labels');
    expect(BASE_CLEAR.plain.map(s => s.text).join('\n')).toContain(RELINKED_DERIVED_ROW);
    expect(BASE_CLEAR.plain[4]!.text).toContain(`NOT LIKE '%${LABEL_RETIRED_MARKER}%'`);
  });

  test('the retired-page and folder-restricted tests of the entity-hint member', () => {
    expect(BASE_SQL.listEntityHintPages).toContain(`${retiredPageSql('p')} AS retired, ${folderRestrictedSql('p')} AS folder_restricted`);
  });
});

/**
 * Shadow follow, serving-process side (src/shadow/follow.ts, write-map.ts, sql-writes.ts, invalidations.ts): every
 * committed primary write becomes one invalidation batch published after the outermost commit.
 *
 * Protects: a transaction publishes once, after commit, with the rows its writes touched; a rolled-back transaction or
 * savepoint publishes nothing; a standalone write publishes at once and a rejected one publishes the relation-level
 * answer; a delete carries the keys of the rows it removed; raw SQL write targets are parsed (CTE, quoted,
 * schema-qualified, DDL); a new engine write member fails the pin test until it is mapped or ignored; with shadow off
 * no pre-read runs; a failing pre-read or sink never changes what the caller sees.
 * Regression it catches: a batch published before commit or for rolled-back work, a delete the follower cannot see,
 * a write member that silently escapes the map, and an invalidation path that can fail a primary write.
 * Postgres twin: test/e2e/shadow-follow-producer.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { failedPreReadKeepsTransaction, followHarness, PAGE, restoreFollowProbes } from './helpers/follow-producer.ts';
import { mergeItems, type Invalidation } from '../src/shadow/invalidations.ts';
import { isShadowReadMember, SHADOW_TRANSACTION_MEMBERS } from '../src/shadow/reads.ts';
import { sqlWrites } from '../src/shadow/sql-writes.ts';
import { IGNORED_MEMBERS, READ_ONLY_MEMBERS, UNMAPPED_WRITE_MEMBERS, memberKind, RAW_MEMBERS, SCHEMA_MEMBERS, WRITE_MAP } from '../src/shadow/write-map.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  restoreFollowProbes();
  await engine.disconnect();
});

beforeEach(async () => {
  restoreFollowProbes();
  await resetPgliteState(engine);
});

const rows = (items: Invalidation[], relation: string) => items.filter((i) => i.kind === 'rows' && i.relation === relation) as Extract<Invalidation, { kind: 'rows' }>[];
const pageId = async (slug: string): Promise<string> => String((await engine.getPage(slug))!.id);

describe('committed writes publish once after commit', () => {
  test('a transaction publishes one batch with the rows its writes touched', async () => {
    const h = followHarness(engine);
    let insideCount = -1;
    await h.engine.transaction(async (tx) => {
      await tx.putPage('people/alice', PAGE('Alice'));
      await tx.putPage('companies/acme', PAGE('Acme'));
      await tx.addLink('people/alice', 'companies/acme', 'works at', 'works_at');
      await tx.addTag('people/alice', 'team');
      await tx.insertFact({ fact: 'Alice likes tea', entity_slug: 'people/alice', source: 'mcp:remember' }, { source_id: 'default' });
      insideCount = h.batches.length;
    });
    expect(insideCount).toBe(0);
    expect(h.batches).toHaveLength(1);
    const batch = h.batches[0]!;
    const alice = await pageId('people/alice');
    const acme = await pageId('companies/acme');
    expect(rows(batch.items, 'pages').map((i) => i.selector)).toEqual(expect.arrayContaining([
      { source_id: 'default', slug: 'people/alice' }, { source_id: 'default', slug: 'companies/acme' },
    ]));
    expect(rows(batch.items, 'links').map((i) => i.selector)).toEqual([{ from_page_id: alice, to_page_id: acme }]);
    expect(rows(batch.items, 'tags').map((i) => i.selector)).toEqual([{ page_id: alice, tag: 'team' }]);
    const facts = rows(batch.items, 'facts');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.selector.id).toMatch(/^\d+$/);
    expect(batch.items.filter((i) => i.kind === 'invalid')).toEqual([]);
    expect(rows(batch.items, 'pages').every((i) => i.before_keys === null)).toBe(true);
  });

  test('a standalone write publishes right after it resolves; seq rises by one', async () => {
    const h = followHarness(engine);
    await h.engine.putPage('people/bob', PAGE('Bob'));
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]!.items).toEqual([
      { kind: 'rows', relation: 'pages', selector: { source_id: 'default', slug: 'people/bob' }, before_keys: null },
      { kind: 'rows', relation: 'config', selector: { key: 'access.restrictions_present' }, before_keys: null }, // a readable_by page sets it
    ]);
    await h.engine.putPage('people/bob', PAGE('Bob again'));
    expect(h.batches[1]!.seq).toBe(h.batches[0]!.seq + 1);
    expect(h.batches[1]!.committed_at).toBeGreaterThan(0);
  });

  test('deletePage carries the key of the row it removed as before_keys', async () => {
    await engine.putPage('people/carol', PAGE('Carol'));
    const carol = await pageId('people/carol');
    const h = followHarness(engine);
    await h.engine.deletePage('people/carol');
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(h.batches).toHaveLength(1);
    expect(rows(h.batches[0]!.items, 'pages')).toEqual([
      { kind: 'rows', relation: 'pages', selector: { source_id: 'default', slug: 'people/carol' }, before_keys: [[carol]] },
    ]);
  });

  test('removeTag reads the tag row key first and still marks the page', async () => {
    await engine.putPage('people/dan', PAGE('Dan'));
    await engine.addTag('people/dan', 'vip');
    const dan = await pageId('people/dan');
    const [tag] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM tags WHERE page_id = $1::bigint', [dan]);
    const h = followHarness(engine);
    await h.engine.removeTag('people/dan', 'vip');
    const items = h.batches[0]!.items;
    expect(rows(items, 'tags')[0]!.before_keys).toEqual([[tag!.id]]);
    expect(rows(items, 'pages')).toHaveLength(1);
  });

  test('a write that touches nothing the follower copies publishes nothing', async () => {
    const h = followHarness(engine);
    await h.engine.logIngest({ source_type: 'test', source_ref: 'x', pages_updated: [], summary: 'noise' });
    expect(h.batches).toEqual([]);
  });
});

describe('rollbacks publish nothing', () => {
  test('a rolled-back transaction publishes nothing', async () => {
    const h = followHarness(engine);
    await expect(h.engine.transaction(async (tx) => {
      await tx.putPage('people/erin', PAGE('Erin'));
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(h.batches).toEqual([]);
    expect(await engine.getPage('people/erin')).toBeNull();
  });

  test('a rolled-back savepoint inside a committed transaction publishes only the outer writes', async () => {
    const h = followHarness(engine);
    await h.engine.transaction(async (tx) => {
      await tx.putPage('people/gina', PAGE('Gina'));
      await tx.transaction(async (inner) => {
        await inner.putPage('people/hank', PAGE('Hank'));
        throw new Error('inner abort');
      }).catch(() => {});
    });
    expect(h.batches).toHaveLength(1);
    expect(rows(h.batches[0]!.items, 'pages').map((i) => i.selector.slug)).toEqual(['people/gina']);
    expect(await engine.getPage('people/hank')).toBeNull();
  });

  test('a committed savepoint merges into the outer batch', async () => {
    const h = followHarness(engine);
    await h.engine.transaction(async (tx) => {
      await tx.putPage('people/ivy', PAGE('Ivy'));
      await tx.transaction(async (inner) => { await inner.putPage('people/jack', PAGE('Jack')); });
    });
    expect(h.batches).toHaveLength(1);
    expect(rows(h.batches[0]!.items, 'pages').map((i) => i.selector.slug).sort()).toEqual(['people/ivy', 'people/jack']);
  });

  test('a rejected standalone write publishes the relation-level answer and rethrows the original error', async () => {
    const h = followHarness(engine);
    await expect(h.engine.putPage('', PAGE('Nobody'))).rejects.toThrow(/Invalid slug/);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]!.items).toEqual([{ kind: 'relation', relation: 'pages', reason: 'write_rejected' }, { kind: 'relation', relation: 'config', reason: 'write_rejected' }]);
  });
});

describe('raw SQL and unmapped writes', () => {
  test('executeRaw publishes the tables the statement writes, and nothing for a SELECT', async () => {
    const h = followHarness(engine);
    await h.engine.executeRaw(`INSERT INTO config (key, value) VALUES ('follow_probe', '1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    expect(h.batches[0]!.items).toEqual([{ kind: 'relation', relation: 'config', reason: 'raw_sql' }]);
    await h.engine.executeRaw('SELECT 1 AS one');
    expect(h.batches).toHaveLength(1);
  });

  test('raw SQL inside a transaction publishes with the commit, not before', async () => {
    const h = followHarness(engine);
    let insideCount = -1;
    await h.engine.transaction(async (tx) => {
      await tx.executeRaw(`UPDATE config SET value = 'x' WHERE key = 'follow_probe'`);
      insideCount = h.batches.length;
    });
    expect(insideCount).toBe(0);
    expect(h.batches[0]!.items).toEqual([{ kind: 'relation', relation: 'config', reason: 'raw_sql' }]);
  });

  test('raw SQL on a reserved connection publishes when the callback ends', async () => {
    const h = followHarness(engine);
    let insideCount = -1;
    await h.engine.withReservedConnection(async (conn) => {
      await conn.executeRaw(`DELETE FROM config WHERE key = 'follow_probe'`);
      insideCount = h.batches.length;
    });
    expect(insideCount).toBe(0);
    expect(h.batches[0]!.items).toEqual([{ kind: 'relation', relation: 'config', reason: 'raw_sql' }]);
  });

  test('a migration publishes an invalid item', async () => {
    const calls: unknown[] = [];
    const fake = { kind: 'pglite', runMigration: async (...a: unknown[]) => { calls.push(a); }, registerBeforeDisconnect() {} };
    const h = followHarness(fake as never);
    await (h.engine as unknown as { runMigration(v: number): Promise<void> }).runMigration(1);
    expect(h.batches[0]!.items).toEqual([{ kind: 'invalid', reason: 'schema_change:runMigration' }]);
  });

  test('a write member missing from the map publishes unmapped_write', async () => {
    const fake = { kind: 'pglite', mysteryMutate: async () => 'done', registerBeforeDisconnect() {} };
    const h = followHarness(fake as never);
    expect(await (h.engine as unknown as { mysteryMutate(): Promise<string> }).mysteryMutate()).toBe('done');
    expect(h.batches[0]!.items).toEqual([{ kind: 'invalid', reason: 'unmapped_write:mysteryMutate' }]);
  });
});

describe('the shadow never changes what the caller sees', () => {
  test('shadow off runs no pre-read and publishes nothing', async () => {
    await engine.putPage('people/kate', PAGE('Kate'));
    const h = followHarness(engine);
    h.setShadowActive(true);
    await h.engine.putPage('people/kate-probe', PAGE('Kate probe'));
    await h.engine.addTag('people/kate-probe', 'x');
    expect(h.rawCalls.length).toBeGreaterThan(0);
    h.rawCalls.length = 0;
    h.batches.length = 0;
    h.setShadowActive(false);
    await h.engine.deletePage('people/kate');
    await h.engine.addTag('people/kate', 'x').catch(() => {});
    await h.engine.executeRaw('SELECT 1');
    expect(h.rawCalls).toEqual([]);
    expect(h.batches).toEqual([]);
  });

  test('a failing pre-read becomes a relation-level item and the write still succeeds', async () => {
    await engine.putPage('people/liam', PAGE('Liam'));
    const h = followHarness(engine, { failRawWith: new Error('pre-read down') });
    await h.engine.deletePage('people/liam');
    expect(await engine.getPage('people/liam')).toBeNull();
    expect(h.batches[0]!.items).toEqual([{ kind: 'relation', relation: 'pages', reason: 'pre_read_failed' }, { kind: 'relation', relation: 'owner_only_marks', reason: 'pre_read_failed' }]);
  });

  test('a sink that throws does not fail the write', async () => {
    const h = followHarness(engine, { publish: () => { throw new Error('sink down'); } });
    const page = await h.engine.putPage('people/mia', PAGE('Mia'));
    expect(page.slug).toBe('people/mia');
  });
});

describe('invalidation items and lines', () => {
  test('mergeItems drops duplicates, unions before_keys and lets a relation item stand for its rows', () => {
    const merged = mergeItems([
      { kind: 'rows', relation: 'tags', selector: { page_id: '1' }, before_keys: [['5']] },
      { kind: 'rows', relation: 'tags', selector: { page_id: '1' }, before_keys: [['5'], ['6']] },
      { kind: 'rows', relation: 'links', selector: { from_page_id: '1' }, before_keys: null },
      { kind: 'relation', relation: 'links', reason: 'raw_sql' },
      { kind: 'relation', relation: 'links', reason: 'raw_sql' },
    ]);
    expect(merged).toEqual([
      { kind: 'rows', relation: 'tags', selector: { page_id: '1' }, before_keys: [['5'], ['6']] },
      { kind: 'relation', relation: 'links', reason: 'raw_sql' },
    ]);
  });
});

describe('a failed pre-read', () => {
  test('does not abort the transaction around it', async () => { await failedPreReadKeepsTransaction(engine); });
});

describe('raw SQL write targets', () => {
  const rel = (...relations: string[]) => relations.map((relation) => ({ kind: 'relation', relation }));
  const cases: Array<[string, string, unknown[]]> = [
    ['insert', 'INSERT INTO pages (slug) VALUES ($1)', rel('pages')],
    ['insert with conflict update', 'INSERT INTO tags (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2', rel('tags')],
    ['update', 'UPDATE ONLY pages SET title = $1 WHERE id = $2', rel('pages')],
    ['delete', 'DELETE FROM links WHERE id = ANY($1)', rel('links')],
    ['merge', 'MERGE INTO facts f USING src s ON f.id = s.id WHEN MATCHED THEN UPDATE SET fact = s.fact WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)', rel('facts')],
    ['truncate list', 'TRUNCATE TABLE tags, links', rel('tags', 'links')],
    ['data-modifying CTE', 'WITH gone AS (DELETE FROM links WHERE id = 1 RETURNING id) INSERT INTO takes SELECT * FROM gone', rel('links', 'takes')],
    ['quoted identifier', 'INSERT INTO "Odd Table" (a) VALUES (1)', rel('Odd Table')],
    ['schema-qualified public', 'UPDATE public.pages SET title = 1', rel('pages')],
    ['schema-qualified other', 'DELETE FROM audit.entries', rel('audit.entries')],
    ['two statements', 'UPDATE a SET x = 1; DELETE FROM b', rel('a', 'b')],
    ['keyword inside a string and a comment', `SELECT 'DELETE FROM pages' AS t /* UPDATE pages */ -- INSERT INTO pages`, []],
    ['dollar-quoted text', `SELECT $q$ INSERT INTO pages $q$`, []],
    ['comment markers inside a string', `SELECT '--'; DELETE FROM facts WHERE id = 1`, rel('facts')],
    ['block comment marker inside a string', `SELECT '/*' AS a; UPDATE facts SET fact = 'x'; SELECT '*/'`, rel('facts')],
    ['doubled quote inside a string', `SELECT 'it''s -- not a comment'; DELETE FROM tags`, rel('tags')],
    ['backslash escape in an E string', `SELECT E'a\\'--'; DELETE FROM links`, rel('links')],
    ['a backslash is plain in a normal string', `SELECT 'a\\'; DELETE FROM links`, rel('links')],
    ['dollar quote with a tag around a comment marker', `SELECT $t$ -- $t$; DELETE FROM takes`, rel('takes')],
    ['a $1 parameter is not a dollar quote', `UPDATE pages SET title = $1 WHERE id = $2; DELETE FROM tags WHERE a = $1`, rel('pages', 'tags')],
    ['nested block comment', `/* a /* DELETE FROM pages */ still comment */ DELETE FROM tags`, rel('tags')],
    ['comment marker inside a quoted name', `DELETE FROM "a--b"`, rel('a--b')],
    ['unterminated string', `SELECT 'oops; DELETE FROM facts`, [{ kind: 'invalid', reason: 'unparsable:error' }]],
    ['unterminated block comment', `SELECT 1 /* DELETE FROM facts`, [{ kind: 'invalid', reason: 'unparsable:error' }]],
    ['unterminated dollar quote', `SELECT $q$ DELETE FROM facts`, [{ kind: 'invalid', reason: 'unparsable:error' }]],
    ['unterminated quoted name', `DELETE FROM "facts`, [{ kind: 'invalid', reason: 'unparsable:error' }]],
    ['plain select', 'SELECT * FROM pages WHERE id = 1', []],
    ['select for update', 'SELECT id FROM pages WHERE id = 1 FOR UPDATE', []],
    ['select for no key update', 'SELECT id FROM pages FOR NO KEY UPDATE SKIP LOCKED', []],
    ['transaction control', 'BEGIN', []],
    ['ddl create', 'CREATE TABLE x (a int)', [{ kind: 'invalid', reason: 'ddl:create' }]],
    ['ddl alter', 'ALTER TABLE pages ADD COLUMN z int', [{ kind: 'invalid', reason: 'ddl:alter' }]],
    ['ddl drop', 'DROP INDEX foo', [{ kind: 'invalid', reason: 'ddl:drop' }]],
    ['truncate cascade', 'TRUNCATE pages CASCADE', [{ kind: 'relation', relation: 'pages' }, { kind: 'invalid', reason: 'truncate_cascade' }]],
    ['select into', 'SELECT * INTO copy FROM pages', [{ kind: 'invalid', reason: 'select_into' }]],
    ['call', 'CALL do_things()', [{ kind: 'invalid', reason: 'unparsable:call' }]],
    ['copy', 'COPY pages FROM STDIN', [{ kind: 'invalid', reason: 'unparsable:copy' }]],
  ];
  for (const [name, sql, expected] of cases) {
    test(`${name}`, () => {
      expect(sqlWrites(sql)).toEqual(expected as never);
    });
  }
});

describe('selectors match the real schema', () => {
  test('every selector column and key column the write map uses exists on its relation', async () => {
    const used: Record<string, string[]> = {
      pages: ['id', 'source_id', 'slug'], tags: ['id', 'page_id', 'tag'], content_chunks: ['id', 'page_id'],
      links: ['id', 'from_page_id', 'to_page_id', 'origin_page_id', 'link_source'], wanted_links: ['id', 'origin_page_id'],
      timeline_entries: ['id', 'page_id'], facts: ['id', 'source_id', 'source_markdown_slug', 'entity_slug'], takes: ['id', 'page_id', 'row_num'],
      synthesis_evidence: ['synthesis_page_id', 'take_page_id', 'take_row_num'], raw_data: ['id', 'page_id', 'source'], files: ['id', 'source_id', 'storage_path'],
      config: ['key'], page_aliases: ['id', 'source_id', 'slug'], page_versions: ['id', 'page_id'], sources: ['id'],
    };
    for (const [relation, columns] of Object.entries(used)) {
      await engine.executeRaw(`SELECT ${columns.map((c) => `"${c}"::text`).join(', ')} FROM "${relation}" LIMIT 0`);
    }
  });

  test('members that delete rows pre-read real keys on a populated brain', async () => {
    await engine.putPage('people/nina', PAGE('Nina'));
    await engine.putPage('companies/orbit', PAGE('Orbit'));
    await engine.upsertChunks('people/nina', [{ chunk_index: 0, chunk_text: 'Nina text', chunk_source: 'compiled_truth' }]);
    await engine.addLink('people/nina', 'companies/orbit', 'ctx', 'works_at');
    await engine.addTag('people/nina', 'team');
    await engine.addTimelineEntry('people/nina', { date: '2026-01-02', source: 'm', summary: 's' });
    await engine.putRawData('people/nina', 'crm', { a: 1 });
    await engine.setConfig('follow_key', 'v');
    await engine.setPageAliases('people/nina', 'default', ['nina']);
    const h = followHarness(engine);
    await h.engine.deleteChunks('people/nina');
    await h.engine.removeLink('people/nina', 'companies/orbit');
    await h.engine.pruneFrontmatterTags('people/nina', []);
    await h.engine.unsetConfig('follow_key');
    await h.engine.setPageAliases('people/nina', 'default', []);
    await h.engine.deleteFactsForPage('people/nina', 'default');
    await h.engine.deletePages(['people/nina', 'companies/orbit'], { sourceId: 'default' });
    const items = h.batches.flatMap((b) => b.items);
    // Only the relation-level items for what triggers and cleanup write (owner marks, slug stores); every row item has keys or none to read.
    expect([...new Set(items.filter((i) => i.kind !== 'rows').map((i) => (i as { relation: string }).relation))].sort())
      .toEqual(['open_loops', 'owner_only_marks', 'page_aliases', 'slug_aliases', 'slug_rename_history']);
    const withKeys = (relation: string) => rows(items, relation).flatMap((i) => i.before_keys ?? []);
    expect(withKeys('content_chunks').length).toBe(1);
    expect(withKeys('links').length).toBe(1);
    expect(withKeys('tags').length).toBe(1);
    expect(withKeys('config')).toEqual([['follow_key']]);
    expect(withKeys('page_aliases').length).toBe(1);
    expect(withKeys('pages').length).toBe(2);
  });
});

describe('members that write more than their arguments name', () => {
  const relations = (items: Array<{ relation?: string }>) => [...new Set(items.map((i) => i.relation))];

  test('a rename also reports the page versions, facts, withdrawals, page aliases and owner marks it rewrites', async () => {
    await engine.putPage('people/rena', PAGE('Rena'));
    await engine.insertFact({ fact: 'Rena builds boats', entity_slug: 'people/rena', source: 'mcp:remember' }, { source_id: 'default' });
    const h = followHarness(engine);
    await h.engine.updateSlug('people/rena', 'people/rena-new');
    const items = h.batches.flatMap((b) => b.items) as Array<{ relation?: string }>;
    expect(relations(items)).toEqual(expect.arrayContaining(['pages', 'slug_aliases', 'slug_rename_history', 'page_versions', 'page_aliases', 'facts', 'fact_withdrawals', 'owner_only_marks']));
    expect(await engine.getPage('people/rena-new')).not.toBeNull();
  });

  test('the writers N3 added report the rows they touch: open loops, a page timeline, a source path', async () => {
    await engine.putPage('people/tess', PAGE('Tess'));
    const h = followHarness(engine);
    await h.engine.upsertOpenLoop({ sourceId: 'default', dedupKey: 'follow-key', loopType: 'unanswered_inbound', summary: 'Reply to Tess', evidence: [], detector: 'manual' });
    await h.engine.closeOpenLoop('default', 987654, 'done', 'test');
    await h.engine.deleteTimelineRows(Number(await pageId('people/tess')), []);
    await h.engine.attachSourcePath('default', '/tmp/follow-source');
    const items = h.batches.flatMap((b) => b.items) as Array<{ relation?: string }>;
    expect(relations(items)).toEqual(expect.arrayContaining(['open_loops', 'timeline_entries', 'sources', 'owner_only_marks']));
  });

  test('the decide store members report the relation each one writes', async () => {
    const h = followHarness(engine);
    await h.engine.upsertDecideState('follow_key', 'v');
    await h.engine.ensureDecideState('follow_key_2', 'v');
    await h.engine.deleteDecideState('follow_key');
    await h.engine.pruneDecideReceipts(30);
    const items = h.batches.flatMap((b) => b.items) as Array<{ relation?: string }>;
    expect(relations(items).sort()).toEqual(['decide_spend', 'decide_state', 'decision_receipts']);
  });

  test('deleting pages also reports the owner marks and the slug stores it scrubs', async () => {
    await engine.putPage('people/sven', PAGE('Sven'));
    const h = followHarness(engine);
    await h.engine.deletePages(['people/sven'], { sourceId: 'default' });
    const items = h.batches.flatMap((b) => b.items) as Array<{ relation?: string }>;
    expect(relations(items)).toEqual(expect.arrayContaining(['pages', 'owner_only_marks', 'slug_aliases', 'page_aliases', 'slug_rename_history', 'open_loops']));
  });
});

describe('write map coverage', () => {
  const protoMembers = (): string[] => {
    const names = new Set<string>();
    for (let p: object | null = PGLiteEngine.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const key of Object.getOwnPropertyNames(p)) {
        if (key === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(p, key)!;
        if (typeof d.value === 'function') names.add(key);
      }
    }
    return [...names].sort();
  };

  test('every PGLite engine member is a mirrored read, a transaction, raw, ignored, read-named or mapped', () => {
    const tx = new Set<string>(SHADOW_TRANSACTION_MEMBERS);
    const unclassified = protoMembers().filter((name) => !isShadowReadMember(name) && !tx.has(name) && memberKind(name) === 'unmapped');
    // Typed writes the map does not cover are listed by name (UNMAPPED_WRITE_MEMBERS): the list is exact.
    expect(unclassified).toEqual([...UNMAPPED_WRITE_MEMBERS].sort());
  });

  test('the 12 members the N3 step added are classified: six writers mapped or ignored, six reads read-only', () => {
    for (const name of ['attachSourcePath', 'closeOpenLoop', 'upsertOpenLoop', 'deleteTimelineRows']) expect(memberKind(name)).toBe('mapped');
    for (const name of ['expireMemoryProposals', 'purgeMemoryProposals']) expect(memberKind(name)).toBe('ignored');
    for (const name of ['normalizeFenceLines', 'notifierCoverageRecorded', 'sampleEffectiveDates', 'sampleEffectiveDateSources', 'sharedSkillPackTablePresent', 'storedTimelineRowsByPageIds']) {
      expect(memberKind(name)).toBe('read_name');
    }
  });

  test('every mapped, ignored, raw, schema and read-named-write entry names a real engine member', () => {
    const real = new Set(protoMembers());
    const listed = [...Object.keys(WRITE_MAP), ...IGNORED_MEMBERS, ...RAW_MEMBERS, ...SCHEMA_MEMBERS, ...READ_ONLY_MEMBERS, ...UNMAPPED_WRITE_MEMBERS, 'withReservedConnection'];
    expect(listed.filter((name) => !real.has(name))).toEqual([]);
  });

  test('a mapped member is never also ignored, and a map entry with no plan says which tables it writes', () => {
    for (const name of Object.keys(WRITE_MAP)) {
      expect(IGNORED_MEMBERS.has(name)).toBe(false);
      expect(WRITE_MAP[name]!.tables.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The statements engine-sql/doctor-access.ts moved out of doctor access_pages_read_by_nobody and owner_identity: the
 * folder-rule read writes out `ruleCoversSql('slug', '$2')` as one literal, so pin it against that composition, and run
 * both page reads and the binding read on PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ruleCoversSql } from '../src/core/access/folder-rules.ts';
import { ACCESS_MEMBER_SOURCES_SQL, PAGES_READ_BY_NOBODY_SQL } from '../src/core/engine-sql/doctor-access.ts';
import { addMember } from '../src/core/access/members.ts';
import { bindMemberSource } from '../src/core/access/member-sources.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('doctor access SQL', () => {
  test('the folder-rule read is the composition the check built with ruleCoversSql', () => {
    expect(PAGES_READ_BY_NOBODY_SQL.rule).toBe(
      'SELECT source_id, slug, page_readers AS readers FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND ' + ruleCoversSql('slug', '$2') +
      ' AND NOT starts_with(slug, $5) AND (page_readers IS NULL OR NOT ($4 = ANY(page_readers))) AND ($3::int = 0 OR (page_readers IS NOT NULL AND NOT (page_readers && $6::text[])))');
    expect(ACCESS_MEMBER_SOURCES_SQL).toBe('SELECT member_id, source_id FROM access_member_sources ORDER BY source_id COLLATE "C", member_id COLLATE "C"');
  });

  test('PGLite answers the labelled read, the folder-rule read and the binding read', async () => {
    await engine.putPage('notes/leaver', { type: 'note', title: 'leaver', compiled_truth: 'b', frontmatter: { readable_by: ['member:bob'] } });
    await engine.putPage('notes/alice', { type: 'note', title: 'alice', compiled_truth: 'b', frontmatter: { readable_by: ['member:alice'] } });
    await engine.putPage('deals/open', { type: 'note', title: 'open', compiled_truth: 'b' });
    await addMember(engine, 'alice', { kind: 'person' });
    await addMember(engine, 'bob', { kind: 'person' });
    await bindMemberSource(engine, 'bob', 'default');
    const labelled = await engine.listPagesReadByNobody({ by: 'labelled', live: ['member:alice'] }, { timeoutMs: 5000 });
    const rule = await engine.listPagesReadByNobody({ by: 'rule', sourceId: 'default', prefix: 'deals/', admitted: [] });
    expect({ labelled, rule, bindings: await engine.listAccessMemberSources() }).toEqual({
      labelled: [{ source_id: 'default', slug: 'notes/leaver', readers: ['member:bob'] }],
      rule: [{ source_id: 'default', slug: 'deals/open', readers: null }],
      bindings: [{ member_id: 'bob', source_id: 'default' }],
    });
  });
});

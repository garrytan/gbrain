/**
 * Pins the extract_atoms ledger and transcript-key statements (engine-sql/extract-atoms-state.ts) to master's text:
 * the strings cycle/extract-atoms-page-state.ts, cycle/extract-atoms-input.ts, cycle/extract-atoms.ts,
 * cycle/extract-atoms-generation.ts and transcripts/discover.ts sent through `executeRaw` at a4a64b90a4, byte for
 * byte, with master's parameters. The page-state write is the sync-21 text (b97c100e43, GST-4020 #10542: the
 * input_sha256 digest and the read-clock updated_at of a complete scan), captured from that commit's writeAtomPageState
 * with its ten parameters.
 */
import { expect, test } from 'bun:test';
import * as X from '../src/core/engine-sql/extract-atoms-state.ts';

const MASTER = {
  identity: "SELECT p.id, s.incarnation, p.knowledge_revision FROM pages p JOIN sources s ON s.id=p.source_id\n      WHERE p.source_id=$1 AND p.slug=$2 AND p.content_hash=$3 AND p.deleted_at IS NULL",
  pageState: "INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned, input_sha256, updated_at)\n      SELECT s.incarnation, p.id, p.content_hash, $7::integer, $8::boolean, $9::text, CASE WHEN $8::boolean THEN COALESCE($10::timestamptz, now()) ELSE now() END\n      FROM pages p JOIN sources s ON s.id=p.source_id\n      WHERE p.id=$1 AND s.incarnation=$2::uuid AND p.source_id=$3 AND p.slug=$4\n        AND p.content_hash=$5 AND p.knowledge_revision=$6::uuid AND p.deleted_at IS NULL\n      FOR SHARE OF p, s\n      ON CONFLICT (source_incarnation, page_id, content_hash) DO UPDATE\n        SET fail_count=extract_atoms_page_state.fail_count + EXCLUDED.fail_count,\n            tombstoned=EXCLUDED.tombstoned, input_sha256=EXCLUDED.input_sha256,\n            updated_at=CASE WHEN EXCLUDED.tombstoned THEN EXCLUDED.updated_at ELSE extract_atoms_page_state.updated_at END\n      RETURNING fail_count",
  pagePartial: "INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned, partial_input_chars)\n      SELECT s.incarnation, p.id, p.content_hash, 0, false, $7::integer\n      FROM pages p JOIN sources s ON s.id=p.source_id\n      WHERE p.id=$1 AND s.incarnation=$2::uuid AND p.source_id=$3 AND p.slug=$4\n        AND p.content_hash=$5 AND p.knowledge_revision=$6::uuid AND p.deleted_at IS NULL\n      FOR SHARE OF p, s\n      ON CONFLICT (source_incarnation, page_id, content_hash) DO UPDATE\n        SET partial_input_chars=EXCLUDED.partial_input_chars, updated_at=now()\n      RETURNING page_id",
  transcriptPartial: "INSERT INTO extract_atoms_transcript_state (source_id, file_path, content_hash, fail_count, tombstoned, partial_input_chars, updated_at)\n       VALUES ($1, $2, $3, 0, FALSE, $4, now())\n       ON CONFLICT (source_id, file_path, content_hash) DO UPDATE SET partial_input_chars=EXCLUDED.partial_input_chars, updated_at=now()",
  tombstone: "INSERT INTO extract_atoms_transcript_state (source_id, file_path, content_hash, fail_count, tombstoned, updated_at)\n       VALUES ($1, $2, $3, 0, TRUE, now())\n       ON CONFLICT (source_id, file_path, content_hash) DO UPDATE SET tombstoned = TRUE, updated_at = now()",
  strike: "INSERT INTO extract_atoms_transcript_state\n             (source_id, file_path, content_hash, fail_count, updated_at)\n           VALUES ($1, $2, $3, 1, now())\n           ON CONFLICT (source_id, file_path, content_hash)\n           DO UPDATE SET fail_count = extract_atoms_transcript_state.fail_count + 1,\n                         updated_at = now()\n           RETURNING fail_count AS cnt",
  liveTranscripts: "SELECT id, owner_key, locator, input_pin FROM derived_generations WHERE source_id=$1 AND kind=$2 AND state='live' AND owner_key LIKE $3",
  moveLocator: "UPDATE derived_generations SET locator=$2, updated_at=now() WHERE id=$1",
  heldSourcePath: "SELECT frontmatter->>'source_path' AS source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL",
  liveLocator: "SELECT locator FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'",
  conversation: "SELECT slug, frontmatter FROM pages\n     WHERE type = 'conversation' AND source_id = $1 AND deleted_at IS NULL",
};

function recorder(answer: unknown[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return { calls, raw: { executeRaw: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return answer; } } as never };
}

const pin = { pageId: 7, sourceIncarnation: 'inc', sourceId: 'src-a', slug: 'meetings/m', contentHash: 'hash', revision: 'rev' };

test('the page ledger statements are master\'s, with master\'s parameters', async () => {
  const { calls, raw } = recorder([{ id: 7, incarnation: 'inc', knowledge_revision: 'rev', fail_count: '2', page_id: 7 }]);
  expect(await X.readAtomPageIdentity(raw, 'src-a', 'meetings/m', 'hash')).toMatchObject({ id: 7 });
  expect(await X.writeAtomPageState(raw, pin, 1, false)).toBe(2);
  expect(await X.writeAtomPageState(raw, pin, 0, true, 'sha', '2026-11-28T00:00:00Z')).toBe(2);
  expect(await X.recordAtomPagePartial(raw, pin, 500)).toBe(true);
  expect(calls).toEqual([
    { sql: MASTER.identity, params: ['src-a', 'meetings/m', 'hash'] },
    { sql: MASTER.pageState, params: [7, 'inc', 'src-a', 'meetings/m', 'hash', 'rev', 1, false, null, null] },
    { sql: MASTER.pageState, params: [7, 'inc', 'src-a', 'meetings/m', 'hash', 'rev', 0, true, 'sha', '2026-11-28T00:00:00Z'] },
    { sql: MASTER.pagePartial, params: [7, 'inc', 'src-a', 'meetings/m', 'hash', 'rev', 500] },
  ]);
});

test('a page that changed under the pin answers null and false', async () => {
  const { raw } = recorder([]);
  expect(await X.writeAtomPageState(raw, pin, 1, false)).toBeNull();
  expect(await X.recordAtomPagePartial(raw, pin, 500)).toBe(false);
  expect(await X.readAtomPageIdentity(raw, 'src-a', 'meetings/m', 'hash')).toBeNull();
});

test('the transcript ledger statements are master\'s', async () => {
  const { calls, raw } = recorder([{ cnt: '3' }]);
  await X.recordAtomTranscriptPartial(raw, 'src-a', '/a.txt', 'h16', 500);
  await X.stampAtomTranscriptTombstone(raw, 'src-a', '/a.txt', 'h16');
  expect(await X.strikeAtomTranscript(raw, 'src-a', '/a.txt', 'h16')).toBe(3);
  expect(calls).toEqual([
    { sql: MASTER.transcriptPartial, params: ['src-a', '/a.txt', 'h16', 500] },
    { sql: MASTER.tombstone, params: ['src-a', '/a.txt', 'h16'] },
    { sql: MASTER.strike, params: ['src-a', '/a.txt', 'h16'] },
  ]);
});

test('the transcript-key, slug and page-index reads are master\'s', async () => {
  const { calls, raw } = recorder([{ locator: '/x', source_path: '/y' }]);
  await X.listLiveTranscriptGenerations(raw, 'src-a', 'atom', 'transcript:');
  await X.moveGenerationLocator(raw, 9, '/new.txt');
  expect(await X.readLivePageSourcePath(raw, 'src-a', 'atoms/a')).toEqual({ locator: '/x', source_path: '/y' } as never);
  await X.readLiveGenerationLocator(raw, 'src-a', 'atom', 'transcript:k');
  await X.listConversationPageFrontmatter(raw, 'src-a');
  expect(calls).toEqual([
    { sql: MASTER.liveTranscripts, params: ['src-a', 'atom', 'transcript:%'] },
    { sql: MASTER.moveLocator, params: [9, '/new.txt'] },
    { sql: MASTER.heldSourcePath, params: ['src-a', 'atoms/a'] },
    { sql: MASTER.liveLocator, params: ['src-a', 'atom', 'transcript:k'] },
    { sql: MASTER.conversation, params: ['src-a'] },
  ]);
});

/**
 * Pins the extract_atoms phase's statements (engine-sql/extract-atoms-reads.ts) to master's text: the strings
 * cycle/extract-atoms.ts and cycle/extract-atoms-input.ts sent through `executeRaw` at f3fc6664a4, byte for byte,
 * with master's parameters. Discovery's four shapes are the composed texts master built (with and without the
 * connector opt-out, with and without the affected-slug filter); the connector lists must stay the ones
 * connector-atoms.ts names.
 */
import { expect, test } from 'bun:test';
import * as X from '../src/core/engine-sql/extract-atoms-reads.ts';
import { CONNECTOR_ATOM_PAGE_TYPES } from '../src/core/cycle/connector-atoms.ts';
import { CONNECTOR_SOURCE_KINDS } from '../src/core/persistence/connector-identity.ts';

const MASTER = {
  discovery: "\n    SELECT p.id, p.knowledge_revision,\n           (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,\n           p.slug,\n           p.compiled_truth,\n           p.content_hash\n    FROM pages p\n    WHERE p.source_id = $1\n      AND p.type = ANY($2::text[])\n      AND p.deleted_at IS NULL\n      AND p.content_hash IS NOT NULL\n      AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'\n      AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'\n      AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))\n      AND (octet_length(p.compiled_truth) >= 4 * $3 OR (octet_length(p.compiled_truth) >= $3 AND length(p.compiled_truth) >= $3))\n      AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac\n  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id\n    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)\n    AND ac.completed_keys->0->>'kind'='page'\n    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash\n    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true'))\n      AND NOT EXISTS (\n  SELECT 1 FROM extract_atoms_page_state scan\n  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)\n    AND scan.page_id=p.id AND scan.content_hash=p.content_hash\n    AND (scan.tombstoned OR scan.partial_input_chars IS NOT NULL)\n)\n      AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false'\n      \n      AND NOT EXISTS (\n        SELECT 1\n        FROM pages atom\n        WHERE atom.type = 'atom'\n          AND atom.source_id = $1\n          AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)\n          AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'\n          AND atom.deleted_at IS NULL\n      )\n    ORDER BY p.updated_at DESC\n    LIMIT $4\n  ",
  discoveryFiltered: "\n    SELECT p.id, p.knowledge_revision,\n           (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,\n           p.slug,\n           p.compiled_truth,\n           p.content_hash\n    FROM pages p\n    WHERE p.source_id = $1\n      AND p.type = ANY($2::text[])\n      AND p.deleted_at IS NULL\n      AND p.content_hash IS NOT NULL\n      AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'\n      AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'\n      AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))\n      AND (octet_length(p.compiled_truth) >= 4 * $3 OR (octet_length(p.compiled_truth) >= $3 AND length(p.compiled_truth) >= $3))\n      AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac\n  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id\n    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)\n    AND ac.completed_keys->0->>'kind'='page'\n    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash\n    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true'))\n      AND NOT EXISTS (\n  SELECT 1 FROM extract_atoms_page_state scan\n  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)\n    AND scan.page_id=p.id AND scan.content_hash=p.content_hash\n    AND (scan.tombstoned OR scan.partial_input_chars IS NOT NULL)\n)\n      AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false'\n      AND p.slug = ANY($5::text[])\n      AND NOT EXISTS (\n        SELECT 1\n        FROM pages atom\n        WHERE atom.type = 'atom'\n          AND atom.source_id = $1\n          AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)\n          AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'\n          AND atom.deleted_at IS NULL\n      )\n    ORDER BY p.updated_at DESC\n    LIMIT $4\n  ",
  discoveryConnectorsOut: "\n    SELECT p.id, p.knowledge_revision,\n           (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,\n           p.slug,\n           p.compiled_truth,\n           p.content_hash\n    FROM pages p\n    WHERE p.source_id = $1\n      AND p.type = ANY($2::text[])\n      AND p.deleted_at IS NULL\n      AND p.content_hash IS NOT NULL\n      AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'\n      AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'\n      AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))\n      AND (octet_length(p.compiled_truth) >= 4 * $3 OR (octet_length(p.compiled_truth) >= $3 AND length(p.compiled_truth) >= $3))\n      AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac\n  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id\n    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)\n    AND ac.completed_keys->0->>'kind'='page'\n    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash\n    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true'))\n      AND NOT EXISTS (\n  SELECT 1 FROM extract_atoms_page_state scan\n  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)\n    AND scan.page_id=p.id AND scan.content_hash=p.content_hash\n    AND (scan.tombstoned OR scan.partial_input_chars IS NOT NULL)\n)\n      AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false' AND NOT (p.type IN ('email','meeting') AND EXISTS (SELECT 1 FROM sources cs\n        WHERE cs.id = p.source_id AND cs.config->>'kind' IN ('google','github','meetings','slack','imessage','apple-contacts')))\n      \n      AND NOT EXISTS (\n        SELECT 1\n        FROM pages atom\n        WHERE atom.type = 'atom'\n          AND atom.source_id = $1\n          AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)\n          AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'\n          AND atom.deleted_at IS NULL\n      )\n    ORDER BY p.updated_at DESC\n    LIMIT $4\n  ",
  discoveryConnectorsOutFiltered: "\n    SELECT p.id, p.knowledge_revision,\n           (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,\n           p.slug,\n           p.compiled_truth,\n           p.content_hash\n    FROM pages p\n    WHERE p.source_id = $1\n      AND p.type = ANY($2::text[])\n      AND p.deleted_at IS NULL\n      AND p.content_hash IS NOT NULL\n      AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'\n      AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'\n      AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))\n      AND (octet_length(p.compiled_truth) >= 4 * $3 OR (octet_length(p.compiled_truth) >= $3 AND length(p.compiled_truth) >= $3))\n      AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac\n  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id\n    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)\n    AND ac.completed_keys->0->>'kind'='page'\n    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash\n    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true'))\n      AND NOT EXISTS (\n  SELECT 1 FROM extract_atoms_page_state scan\n  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)\n    AND scan.page_id=p.id AND scan.content_hash=p.content_hash\n    AND (scan.tombstoned OR scan.partial_input_chars IS NOT NULL)\n)\n      AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false' AND NOT (p.type IN ('email','meeting') AND EXISTS (SELECT 1 FROM sources cs\n        WHERE cs.id = p.source_id AND cs.config->>'kind' IN ('google','github','meetings','slack','imessage','apple-contacts')))\n      AND p.slug = ANY($5::text[])\n      AND NOT EXISTS (\n        SELECT 1\n        FROM pages atom\n        WHERE atom.type = 'atom'\n          AND atom.source_id = $1\n          AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)\n          AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'\n          AND atom.deleted_at IS NULL\n      )\n    ORDER BY p.updated_at DESC\n    LIMIT $4\n  ",
  hashes: "SELECT frontmatter->>'source_hash' AS h\n         FROM pages\n        WHERE type = 'atom'\n          AND source_id = $1\n          AND deleted_at IS NULL\n          AND COALESCE(frontmatter->>'managed_extraction', '') <> 'true'\n          AND frontmatter->>'source_hash' = ANY($2::text[])",
  tombstones: "SELECT file_path, content_hash\n         FROM extract_atoms_transcript_state\n        WHERE source_id = $1\n          AND (tombstoned OR partial_input_chars IS NOT NULL)\n          AND content_hash = ANY($2::text[])",
  titles: "SELECT slug, title FROM pages WHERE type = 'atom' AND deleted_at IS NULL AND source_id = $1 AND frontmatter->>'source_slug' = $2",
  release: ["UPDATE extract_atoms_page_state scan SET partial_input_chars=NULL, updated_at=now()\n         FROM sources s WHERE s.id=$1 AND scan.source_incarnation=s.incarnation AND scan.partial_input_chars < $2", "UPDATE extract_atoms_transcript_state SET partial_input_chars=NULL, updated_at=now()\n        WHERE source_id=$1 AND partial_input_chars < $2", "DELETE FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1\n         AND (completed_keys->0->>'partial')::integer < $2"] as const,
};

function recorder(answer: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return { calls, raw: { executeRaw: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return answer; } } };
}

const types = ['meeting', 'note'];

test('discovery sends master\'s four composed statements and parameters', async () => {
  const { calls, raw } = recorder();
  const q = { sourceId: 'src-a', types, minChars: 500, limit: 7 };
  await X.listExtractablePages(raw, { ...q, affectedSlugs: null, connectorExclusion: null });
  await X.listExtractablePages(raw, { ...q, affectedSlugs: ['a/b'], connectorExclusion: null });
  await X.listExtractablePages(raw, { ...q, affectedSlugs: [], connectorExclusion: { pageTypes: [], sourceKinds: [] } });
  await X.listExtractablePages(raw, { ...q, affectedSlugs: ['a/b'], connectorExclusion: { pageTypes: [], sourceKinds: [] } });
  expect(calls).toEqual([
    { sql: MASTER.discovery, params: ['src-a', types, 500, 7] },
    { sql: MASTER.discoveryFiltered, params: ['src-a', types, 500, 7, ['a/b']] },
    { sql: MASTER.discoveryConnectorsOut, params: ['src-a', types, 500, 7] },
    { sql: MASTER.discoveryConnectorsOutFiltered, params: ['src-a', types, 500, 7, ['a/b']] },
  ]);
});

test('the connector opt-out names the page types and source kinds connector-atoms.ts lists', () => {
  const list = (v: readonly string[]) => v.map(x => `'${x}'`).join(',');
  const clause = `NOT (p.type IN (${list(CONNECTOR_ATOM_PAGE_TYPES)}) AND EXISTS (SELECT 1 FROM sources cs\n        WHERE cs.id = p.source_id AND cs.config->>'kind' IN (${list(CONNECTOR_SOURCE_KINDS)})))`;
  expect(X.EXTRACTABLE_PAGES_CONNECTORS_OUT_SQL).toContain(clause);
  expect(X.EXTRACTABLE_PAGES_CONNECTORS_OUT_FILTERED_SQL).toContain(clause);
});

test('the idempotency, tombstone and title reads send master\'s statements', async () => {
  const { calls, raw } = recorder([{ h: 'x' }]);
  expect(await X.listAtomSourceHashes(raw, 'src-a', ['h1', 'h2'])).toEqual(['x']);
  await X.listTombstonedTranscripts(raw, 'src-a', ['h1']);
  await X.listSourcePageAtomTitles(raw, 'src-a', 'meetings/m1');
  expect(calls).toEqual([
    { sql: MASTER.hashes, params: ['src-a', ['h1', 'h2']] },
    { sql: MASTER.tombstones, params: ['src-a', ['h1']] },
    { sql: MASTER.titles, params: ['src-a', 'meetings/m1'] },
  ]);
});

test('the release sends master\'s three statements in order', async () => {
  const { calls, raw } = recorder();
  await X.releasePartialAtomDispositions(raw, 'src-a', 1000);
  expect(calls).toEqual(MASTER.release.map(sql => ({ sql, params: ['src-a', 1000] })));
});

/**
 * The composed doctor statements of src/core/engine-sql/doctor-derived.ts match the composers they were built from.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a statement that doctor checks used to assemble from other modules' SQL composers (the privacy-label and
 *    edge-trim predicates, the writer-owned page filter, the purge holds, the derived-visibility fragments, the tiling and
 *    chunk-generation filters, the budget filter, the atom provenance CTE) is the constant text the composers produce today.
 *  - Regression: a composer changes (a new privacy alias, a fence bump, a new purge hold) and the baked constant keeps the
 *    old text, so doctor counts a different set of pages than the rest of the code treats as private, held or live.
 *  - Why existing coverage misses it: the parity cases run the constants against seeded rows, which only exercise the
 *    cases they seed.
 *  - Seam: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import { COMPOSED_SQL, withEmbeddingColumn } from '../src/core/engine-sql/doctor-derived.ts';
import { ignoredPrivacyLabelSql, privacyLabelKeySql, PRIVACY_LABEL_KEYS, SCAN_CAP } from '../src/core/search/ignored-privacy-labels.ts';
import { edgeTrimSql } from '../src/core/edge-whitespace.ts';
import { SAFE_FENCE_CHUNKER_VERSION, chunkGenerationFilter } from '../src/core/search/safe-chunks.ts';
import { WRITER_OWNED_PAGE_SQL } from '../src/core/schema-pack/type-usage.ts';
import { identityDowngradePurgeHold } from '../src/core/sync-identity-downgrades.ts';
import { ATOM_RESTORE_HOLD_DAYS, atomRetirementPurgeHold, atomRetirementsSql } from '../src/core/persistence/atom-retirement-hold.ts';
import { derivedRetirementPurgeHold } from '../src/core/persistence/derived-retirement-hold.ts';
import { derivedOriginPurgeHold } from '../src/core/persistence/derived-origin-hold.ts';
import { derivationPrivateSql, folderRestrictedSql, privateSnapshotFilterFragment } from '../src/core/search/private-visibility.ts';
import { aliasOnlyPagesSql } from '../src/core/repair/visibility.ts';
import { atomMovedOriginPrivateSql, atomOriginSlugSql, atomOriginSlugsSql } from '../src/core/persistence/atom-origin.ts';
import { untiledSql, liveTilingSql } from '../src/core/page-body/schema.ts';
import { budgetRowAppliesFilter } from '../src/core/page-size-policy.ts';
import { ATOM_PROVENANCE_CTE } from '../src/commands/doctor/checks/atom-body-recheck.ts';
import { NOT_CONVERSATION_SLOT_SQL } from '../src/core/chronicle/ontology.ts';
import { DUPLICATE_SQL, EXPIRY_TEXT } from '../src/core/repair/ontology-facts.ts';

/** SQL whitespace outside string literals carries no meaning, and the constants are indented for reading. */
const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const holds = (sql: string, ...fragments: string[]): void => {
  for (const f of fragments) expect(flat(sql)).toContain(flat(f));
};

describe('doctor-derived composed SQL', () => {
  test('the privacy-label scan holds the key, ignored-value and trim predicates', () => {
    const values = PRIVACY_LABEL_KEYS.map(key => `('${key}', p.frontmatter->>'${key}', jsonb_typeof(p.frontmatter->'${key}') = 'string')`).join(', ');
    for (const sql of [COMPOSED_SQL.PRIVACY_LABEL_SQL, COMPOSED_SQL.PRIVACY_LABEL_SCOPED_SQL]) {
      holds(sql, privacyLabelKeySql('p'), ignoredPrivacyLabelSql('p'), `NULLIF(${edgeTrimSql('l.raw')}, '')`, `VALUES ${values}`, `LIMIT ${SCAN_CAP + 1}`);
    }
  });

  test('the safe-index and credential counts use the safe fence version', () => {
    expect(SAFE_FENCE_CHUNKER_VERSION).toBe(4);
    holds(COMPOSED_SQL.SAFE_INDEX_SQL, `p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION}`);
    holds(COMPOSED_SQL.SAFE_INDEX_SCOPED_SQL, `p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION} AND p.source_id=ANY($1::text[])`);
  });

  test('the type-owner count holds the writer-owned page filter', () => {
    for (const sql of [COMPOSED_SQL.PAGE_TYPE_OWNER_SQL, COMPOSED_SQL.PAGE_TYPE_OWNER_SCOPED_SQL]) {
      holds(sql, `${WRITER_OWNED_PAGE_SQL} AS own`);
    }
  });

  test('the recorded tombstone read holds every purge hold', () => {
    holds(COMPOSED_SQL.RECORDED_TOMBSTONES_SQL, identityDowngradePurgeHold('p'), atomRetirementPurgeHold('p'), derivedRetirementPurgeHold('p'), derivedOriginPurgeHold('p'));
  });

  test('the derived-visibility count holds the visibility fragments', () => {
    holds(COMPOSED_SQL.DERIVED_VISIBILITY_SQL, privateSnapshotFilterFragment('o'), folderRestrictedSql('o'), folderRestrictedSql('ao'), atomOriginSlugSql('d'),
      atomOriginSlugsSql('a'), atomMovedOriginPrivateSql('d'), atomMovedOriginPrivateSql('a'), derivationPrivateSql('o'), aliasOnlyPagesSql('ap'));
  });

  test('the untiled read holds the live tiling and untiled predicates', () => {
    holds(COMPOSED_SQL.UNTILED_SQL, `CROSS JOIN LATERAL (${liveTilingSql('p')}) t`, `AND ${untiledSql('p', 't')}`);
  });

  test('the budget and backlog reads hold the chunk-generation and budget filters', () => {
    for (const sql of [COMPOSED_SQL.BUDGET_LIMITED_SQL, COMPOSED_SQL.BUDGET_LIMITED_SOURCE_SQL]) {
      holds(sql, chunkGenerationFilter('p', 'cc'), budgetRowAppliesFilter('b', 'p'));
    }
    holds(COMPOSED_SQL.BUDGET_AGE_SQL, budgetRowAppliesFilter('b', 'p'));
    holds(COMPOSED_SQL.BACKLOG_AGE_SQL, 'cc."__COL__" IS NULL');
  });

  test('the retirement reads are built from atomRetirementsSql', () => {
    const scoped = atomRetirementsSql('p.source_id=ANY($1::text[])');
    holds(COMPOSED_SQL.ATOM_RETIREMENTS_SQL, `FROM (${scoped}) c JOIN pages p ON p.id=c.id`, `interval '${ATOM_RESTORE_HOLD_DAYS} days'`);
    holds(COMPOSED_SQL.ATOM_RETIREMENTS_COVERED_SQL, `FROM (${scoped}) c WHERE c.restorable AND c.ledger_generation IS NOT NULL`);
  });

  test('the ontology facts read holds the expiry text and duplicate predicate', () => {
    holds(COMPOSED_SQL.ONTOLOGY_FACTS_SQL, EXPIRY_TEXT('f.expired_at'), `${DUPLICATE_SQL('f')} AS duplicate`, NOT_CONVERSATION_SLOT_SQL);
  });

  test('the atom provenance read starts with the shared CTE', () => {
    holds(COMPOSED_SQL.ATOM_PROVENANCE_SQL, `WITH ${ATOM_PROVENANCE_CTE}`);
  });

  test('withEmbeddingColumn substitutes only a plain column name', () => {
    expect(withEmbeddingColumn('SELECT cc."__COL__"', 'embedding')).toBe('SELECT cc."embedding"');
    expect(() => withEmbeddingColumn('SELECT cc."__COL__"', 'x"; DROP TABLE pages; --')).toThrow();
  });
});

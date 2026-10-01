/**
 * W2 schema generator (refactor wave 1, EO12): scripts/build-schema.ts.
 *
 * Protects: one copy of schema text. The committed src/schema.sql regions,
 * schema-embedded.generated.ts and the PGLite template are exactly what the
 * chain generates; unknown constructs, unclassified DO blocks, stale PGLite
 * rules and broken regions exit non-zero with FAIL/Why/Fix/See; the template
 * keeps its runtime placeholders and policy anchors. The catalog-level proof
 * (E4 goldens, upgrade replay) lives in test/schema-catalog-golden.test.ts and
 * test/pglite-upgrade-replay.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  EMBEDDED_PATH,
  FRAGMENTS,
  PGLITE_DO_BLOCKS,
  PGLITE_PATH,
  PGLITE_RULES,
  SCHEMA_SQL_PATH,
  SchemaBuildError,
  buildAll,
  endMarker,
  renderPgliteTemplateSql,
  renderSchemaSql,
} from '../../scripts/build-schema.ts';
import { PERSISTENCE_DATABASE_PENDING_INDEX_SQL } from '../../src/core/persistence/schema.ts';

const REPO = resolve(import.meta.dir, '..', '..');
// test-reads-source-ok[structural]: generated-file freshness contract.
const committed = (p: string) => readFileSync(join(REPO, p), 'utf8');
const schemaSql = committed(SCHEMA_SQL_PATH);

function buildError(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SchemaBuildError) return e.message;
    throw e;
  }
  throw new Error('expected a SchemaBuildError');
}

describe('committed outputs are exactly the generated chain', () => {
  const out = buildAll(schemaSql);
  for (const p of [SCHEMA_SQL_PATH, EMBEDDED_PATH, PGLITE_PATH]) {
    test(p, () => expect(out[p]).toBe(committed(p)));
  }

  test('a hand edit inside a generated region is overwritten from the fragment', () => {
    const edited = schemaSql.replace('CREATE INDEX IF NOT EXISTS idx_oauth_grant_audit_client', 'CREATE INDEX IF NOT EXISTS idx_oauth_grant_audit_hand_edit');
    expect(edited).not.toBe(schemaSql);
    expect(renderSchemaSql(edited)).toBe(schemaSql);
  });
});

describe('fragment regions', () => {
  test('every fragment has exactly one BEGIN/END GENERATED region naming its source', () => {
    for (const f of FRAGMENTS) {
      expect(schemaSql.split(`-- BEGIN GENERATED from ${f.source} (${f.expr}).`).length - 1).toBe(1);
      expect(schemaSql.split(endMarker(f)).length - 1).toBe(1);
    }
  });

  test('Postgres omits the CONCURRENTLY-built persistence index; PGLite creates it inline', () => {
    const idx = PERSISTENCE_DATABASE_PENDING_INDEX_SQL.trim();
    expect(schemaSql).not.toContain(idx);
    expect(renderPgliteTemplateSql(schemaSql)).toContain(idx);
  });

  test('a missing END marker, an unknown fragment, or a missing region fails', () => {
    const f = FRAGMENTS[0]!;
    const last = FRAGMENTS[FRAGMENTS.length - 1]!;
    expect(buildError(() => renderSchemaSql(schemaSql.replace(endMarker(last), '')))).toContain('has no matching END marker');
    expect(buildError(() => renderSchemaSql(schemaSql.replace(`${endMarker(f)}\n`, '')))).toContain('nested BEGIN GENERATED marker');
    expect(buildError(() => renderSchemaSql(schemaSql.replace(`from ${f.source} (${f.expr}).`, `from src/core/nope.ts (${f.expr}).`)))).toContain('names an unknown fragment');
    const start = schemaSql.indexOf(`-- BEGIN GENERATED from ${f.source}`);
    const end = schemaSql.indexOf(endMarker(f)) + endMarker(f).length;
    expect(buildError(() => renderSchemaSql(schemaSql.slice(0, start) + schemaSql.slice(end)))).toContain(`has no generated region for ${f.source}`);
  });
});

describe('PGLite template', () => {
  const template = renderPgliteTemplateSql(schemaSql);

  test('keeps the runtime placeholders and policy anchors for getPGLiteSchema(dims, model)', () => {
    expect(template).toContain('vector(__EMBEDDING_DIMS__)');
    expect(template).toContain("DEFAULT '__EMBEDDING_MODEL__'");
    expect(template).toContain("('embedding_dimensions', '__EMBEDDING_DIMS__')");
    expect(template).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);');
    expect(template).toContain("to_tsvector('english',");
    expect(template).not.toContain('vector(1536)');
  });

  test('an unknown construct exits non-zero', () => {
    const msg = buildError(() => renderPgliteTemplateSql(`${schemaSql}\nCREATE POLICY p ON pages USING (true);\n`));
    expect(msg).toContain('does not recognize');
    for (const label of ['Why:', 'Fix:', 'See:  docs/ENGINES.md#canonical-schema-sources']) expect(msg).toContain(label);
  });

  test('an unclassified DO block exits non-zero', () => {
    expect(buildError(() => renderPgliteTemplateSql(`${schemaSql}\nDO $$ BEGIN PERFORM 1; END $$;\n`))).toContain('is not classified for PGLite');
  });

  test('a rule whose statement disappeared exits non-zero', () => {
    const msg = buildError(() => renderPgliteTemplateSql(schemaSql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '')));
    expect(msg).toContain('rule extension:pgcrypto');
  });

  test('every capability rule and DO classification carries a reason', () => {
    for (const r of PGLITE_RULES) expect(r.reason.length).toBeGreaterThan(10);
    for (const c of Object.values(PGLITE_DO_BLOCKS)) expect(c.reason.length).toBeGreaterThan(10);
  });

  test('no SQL comments outside function bodies reach the template', () => {
    expect(template).not.toContain('-- BEGIN GENERATED');
    expect(template).not.toMatch(/^\s*-- v0\./m);
  });
});

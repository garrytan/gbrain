/**
 * Refactor wave 1 E4 / EO12 / T-G13 — PGLite catalog goldens.
 *
 * Pins the full PGLite schema end state (columns incl. ordinal position,
 * defaults, indexes, constraints incl. CHECK text, triggers, function
 * signature + body hash, views, policies, grants, RLS flags, sequences,
 * extensions) captured on master, so W2's generated PGLite bootstrap must
 * reproduce it byte for byte.
 *
 * Two init paths x three configs (see CATALOG_CONFIGS in
 * test/helpers/schema-catalog.ts):
 *   - engine init: `connect({})` + `initSchema()` (bootstrap + blob + all
 *     migrations), cold (GBRAIN_PGLITE_SNAPSHOT unset).
 *   - schema blob: forward-reference bootstrap + `getPGLiteSchema(dims,
 *     model)` with NO migrations. PGLite has no production standalone path
 *     equivalent to Postgres `db.initSchema()`; this is the closest analogue
 *     and is exactly what the W2 generator emits, before migrations could mask
 *     a generator error (EO12).
 * Plus: a snapshot-restored engine (GBRAIN_PGLITE_SNAPSHOT, the unit-lane fast
 * path) reaches the same catalog as a cold boot, and the non-default configs
 * provably take the other policy branch.
 *
 * Every capture runs twice (`expectNormalizerStable`), proving the
 * `schema-catalog-lines-v1` normalizer. Regenerate deliberately with
 * `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/schema-catalog-golden.test.ts`.
 * The Postgres counterpart is test/e2e/schema-catalog-golden.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { expectNormalizerStable } from './helpers/golden.ts';
import {
  CATALOG_CONFIGS,
  type CatalogConfig,
  capturePgliteBlobCatalog,
  capturePgliteEngineCatalog,
  capturePgliteSnapshotRestoredCatalog,
  catalogGoldenNormalizer,
  catalogGoldenView,
  expectCatalogGolden,
  flattenGoldenView,
  withCatalogConfig,
} from './helpers/schema-catalog.ts';
import { type CatalogSnapshot, buildCatalogSnapshot, diffCatalogSnapshots, formatCatalogDiffForFailure } from './helpers/schema-diff.ts';
import { buildPgliteSnapshot, snapshotProfile } from '../scripts/build-pglite-snapshot.ts';

const CAPTURE_TIMEOUT = 120_000;
const captured = new Map<string, CatalogSnapshot>();

async function captureStable(config: CatalogConfig, capture: () => Promise<CatalogSnapshot>): Promise<CatalogSnapshot> {
  return withCatalogConfig(config, () => expectNormalizerStable(capture, catalogGoldenNormalizer));
}

function requireCaptured(key: string): CatalogSnapshot {
  const snap = captured.get(key);
  if (!snap) throw new Error(`capture ${key} did not run (an earlier test in this file failed)`);
  return snap;
}

function indexNames(snap: CatalogSnapshot): Set<string> {
  return new Set(snap.indexes.map((i) => i.name));
}

describe('PGLite catalog goldens (E4)', () => {
  for (const config of CATALOG_CONFIGS) {
    test(`engine init, ${config.name}`, async () => {
      const snap = await captureStable(config, capturePgliteEngineCatalog);
      captured.set(`engine:${config.name}`, snap);
      expectCatalogGolden(`catalog/pglite-engine-init-${config.name}`, snap);
    }, CAPTURE_TIMEOUT);

    test(`schema blob without migrations, ${config.name}`, async () => {
      const snap = await captureStable(config, capturePgliteBlobCatalog);
      captured.set(`blob:${config.name}`, snap);
      expectCatalogGolden(`catalog/pglite-schema-blob-${config.name}`, snap);
    }, CAPTURE_TIMEOUT);
  }

  test('snapshot-restored engine reaches the cold-boot catalog (default config)', async () => {
    const profile = snapshotProfile('legacy');
    await buildPgliteSnapshot('legacy', { log: () => {} });
    const { catalog: restored, snapshotLoaded } = await capturePgliteSnapshotRestoredCatalog(profile.tar);
    expect(snapshotLoaded).toBe(true);
    const cold = requireCaptured('engine:default');
    const diff = diffCatalogSnapshots(cold, restored, { compareOrdinals: true });
    if (diff.length > 0) throw new Error(`snapshot restore differs from cold boot:\n${formatCatalogDiffForFailure(diff)}`);
    expect(diff).toEqual([]);
  }, CAPTURE_TIMEOUT);

  test('high-dims config takes the other chunk-embedding and halfvec index branch', () => {
    for (const path of ['engine', 'blob'] as const) {
      const dflt = indexNames(requireCaptured(`${path}:default`));
      const high = indexNames(requireCaptured(`${path}:high-dims`));
      expect(dflt.has('idx_chunks_embedding')).toBe(true);
      expect(high.has('idx_chunks_embedding')).toBe(false);
    }
    const dflt = indexNames(requireCaptured('engine:default'));
    const high = indexNames(requireCaptured('engine:high-dims'));
    for (const name of ['idx_facts_embedding_hnsw', 'idx_query_cache_embedding_hnsw']) {
      expect(dflt.has(name)).toBe(true);
      expect(high.has(name)).toBe(false);
    }
    const embedding = requireCaptured('engine:high-dims').tables
      .find((t) => t.name === 'content_chunks')!.columns.find((c) => c.name === 'embedding')!;
    expect(embedding.udtName).toBe('vector');
  });

  test('non-default FTS language changes only function bodies (search_vector triggers)', () => {
    for (const path of ['engine', 'blob'] as const) {
      const diff = diffCatalogSnapshots(requireCaptured(`${path}:default`), requireCaptured(`${path}:fts-portuguese`));
      expect(diff.length).toBeGreaterThan(0);
      expect([...new Set(diff.map((d) => d.section))]).toEqual(['functions']);
      expect(diff.every((d) => d.kind === 'changed')).toBe(true);
    }
  });
});

describe('schema-catalog-lines-v1 normalizer', () => {
  const empty = {
    currentRole: [{ role: 'postgres' }], relations: [], columns: [], indexes: [], constraints: [], triggers: [],
    functions: [], views: [], policies: [], grants: [], sequences: [], extensions: [],
  };

  test('renders one line per catalog object keyed by identity', () => {
    const view = catalogGoldenView(buildCatalogSnapshot({
      ...empty,
      relations: [{ name: 'pages', relkind: 'r', row_security: true, force_row_security: false }],
      columns: [{ table_name: 'pages', column_name: 'id', ordinal_position: 1, data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: "nextval('pages_id_seq'::regclass)" }],
      indexes: [{ name: 'idx_pages_slug', table_name: 'pages', definition: 'CREATE INDEX idx_pages_slug ON public.pages USING btree (slug)' }],
      grants: [{ table_name: 'pages', grantor: 'postgres', grantee: 'postgres', privilege: 'SELECT', is_grantable: 'YES' }],
    }));
    expect(view.tables).toEqual({
      pages: { flags: 'relkind=r rls=true force_rls=false', columns: ["1 id integer/int4 NOT NULL DEFAULT nextval('pages_id_seq'::regclass)"] },
    });
    expect(view.indexes).toEqual({ idx_pages_slug: 'CREATE INDEX idx_pages_slug ON public.pages USING btree (slug)' });
    expect(view.grants).toEqual({ pages: ['<current_role> -> <current_role> WITH GRANT OPTION: SELECT'] });
    expect(flattenGoldenView(view).get('tables.pages.columns[0]')).toBe("1 id integer/int4 NOT NULL DEFAULT nextval('pages_id_seq'::regclass)");
  });

  test('a duplicate object key is an error, not a silent overwrite', () => {
    const snap = buildCatalogSnapshot({
      ...empty,
      indexes: [
        { name: 'dup', table_name: 'a', definition: 'CREATE INDEX dup ON public.a (x)' },
        { name: 'dup', table_name: 'b', definition: 'CREATE INDEX dup ON public.b (x)' },
      ],
    });
    expect(() => catalogGoldenView(snap)).toThrow('duplicate key dup');
  });
});

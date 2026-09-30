/**
 * Refactor wave 1 E4 / EO12 / T-G13: shared plumbing for the catalog goldens.
 *
 * - `CATALOG_CONFIGS`: the three schema configurations every init path is
 *   captured at. `default` is the unit-test embedding shape (legacy
 *   OpenAI/1536, English FTS). `high-dims` uses 4096 dimensions, which takes
 *   the other branch of BOTH embedding index policies: the content_chunks
 *   HNSW index is skipped (> PGVECTOR_HNSW_VECTOR_MAX_DIMS = 2000,
 *   `applyChunkEmbeddingIndexPolicy`) and the halfvec HNSW indexes on facts /
 *   query_cache are skipped (> PGVECTOR_HNSW_HALFVEC_MAX_DIMS = 4000,
 *   migrations v40/v45 family). `fts-portuguese` sets GBRAIN_FTS_LANGUAGE,
 *   which `applyFtsLanguagePolicy` and migration v123 read.
 * - `withCatalogConfig`: applies a config (gateway + env + FTS cache) for the
 *   duration of fn and restores the prior state in `finally`.
 * - `catalogGoldenNormalizer`: the named normalizer every catalog golden goes
 *   through. The snapshot itself holds no volatile values (no OIDs, sequence
 *   positions, timestamps; the connecting role is already placeholdered by
 *   `buildCatalogSnapshot`), so the normalizer only reshapes it into one line
 *   per catalog object so a golden diff names the exact object that changed.
 * - `capturePgliteEngineCatalog` / `capturePgliteBlobCatalog`: the two PGLite
 *   init paths (engine init with migrations; bootstrap + schema blob only).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { getPGLiteSchema } from '../../src/core/pglite-schema.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { configureGateway, getEmbeddingDimensions, getEmbeddingModel, resetGateway } from '../../src/core/ai/gateway.ts';
import { resetFtsLanguageCache } from '../../src/core/fts-language.ts';
import { withEnv } from './with-env.ts';
import { withColdPglite, withSnapshotValue } from './with-snapshot.ts';
import { defineNormalizer, expectGolden, GOLDENS_DIR } from './golden.ts';
import { LEGACY_EMBEDDING_CONFIG } from './legacy-embedding-config.ts';
import {
  type CatalogColumn,
  type CatalogSnapshot,
  type CatalogQueryFn,
  snapshotCatalog,
} from './schema-diff.ts';

export interface CatalogConfig {
  name: 'default' | 'high-dims' | 'fts-portuguese';
  embeddingModel: string;
  embeddingDimensions: number;
  /** undefined = GBRAIN_FTS_LANGUAGE unset (english). */
  ftsLanguage: string | undefined;
}

export const CATALOG_CONFIGS: readonly CatalogConfig[] = [
  {
    name: 'default',
    embeddingModel: LEGACY_EMBEDDING_CONFIG.embedding_model,
    embeddingDimensions: LEGACY_EMBEDDING_CONFIG.embedding_dimensions,
    ftsLanguage: undefined,
  },
  {
    name: 'high-dims',
    embeddingModel: 'litellm:schema-golden-4096d',
    embeddingDimensions: 4096,
    ftsLanguage: undefined,
  },
  {
    name: 'fts-portuguese',
    embeddingModel: LEGACY_EMBEDDING_CONFIG.embedding_model,
    embeddingDimensions: LEGACY_EMBEDDING_CONFIG.embedding_dimensions,
    ftsLanguage: 'portuguese',
  },
];

/** Apply `config` to the gateway, GBRAIN_FTS_LANGUAGE and the FTS cache for fn's scope. */
export async function withCatalogConfig<T>(config: CatalogConfig, fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_FTS_LANGUAGE: config.ftsLanguage }, async () => {
    resetFtsLanguageCache();
    configureGateway({
      embedding_model: config.embeddingModel,
      embedding_dimensions: config.embeddingDimensions,
      env: { ...process.env },
    });
    try {
      return await fn();
    } finally {
      resetGateway();
      resetFtsLanguageCache();
    }
  });
}

export function pgliteCatalogQuery(engine: PGLiteEngine): CatalogQueryFn {
  return async (sql) => (await engine.db.query(sql)).rows as Array<Record<string, unknown>>;
}

/** Postgres adapter: postgres.js `unsafe` returns the row array directly. */
export function postgresCatalogQuery(conn: { unsafe: (sql: string) => Promise<unknown> }): CatalogQueryFn {
  return async (sql) => (await conn.unsafe(sql)) as Array<Record<string, unknown>>;
}

/** Raw `prosrc` of gbrain's own public functions, keyed like the catalog (`name(identity args)`). */
export const FUNCTION_BODIES_SQL = `
  SELECT p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS key,
         COALESCE(p.prosrc, '') AS body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
   ORDER BY 1`;

export async function pgliteFunctionBodies(engine: PGLiteEngine): Promise<Map<string, string>> {
  const { rows } = await engine.db.query<{ key: string; body: string }>(FUNCTION_BODIES_SQL);
  return new Map(rows.map((r) => [r.key, r.body]));
}

/** Fresh in-memory PGLite, cold (no GBRAIN_PGLITE_SNAPSHOT), full `initSchema()`: catalog + function bodies. */
export async function capturePgliteFreshInstall(): Promise<{ catalog: CatalogSnapshot; functionBodies: Map<string, string> }> {
  return withColdPglite(async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      return { catalog: await snapshotCatalog(pgliteCatalogQuery(engine)), functionBodies: await pgliteFunctionBodies(engine) };
    } finally {
      await engine.disconnect();
    }
  });
}

/** Fresh in-memory PGLite, cold (no GBRAIN_PGLITE_SNAPSHOT), full `initSchema()`. */
export async function capturePgliteEngineCatalog(): Promise<CatalogSnapshot> {
  return (await capturePgliteFreshInstall()).catalog;
}

/**
 * Fresh in-memory PGLite, cold, full `initSchema()`, then the recorded
 * schema_version is rewound to `checkpoint` and `runMigrations` replays every
 * later migration (W3 replay-from-checkpoint arm).
 */
export async function capturePgliteReplayCatalog(checkpoint: number): Promise<{ catalog: CatalogSnapshot; applied: number; current: number }> {
  return withColdPglite(async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      await engine.setConfig('version', String(checkpoint));
      const { applied, current } = await runMigrations(engine);
      return { catalog: await snapshotCatalog(pgliteCatalogQuery(engine)), applied, current };
    } finally {
      await engine.disconnect();
    }
  });
}

/**
 * In-memory PGLite restored from the schema snapshot at `tarPath` (the unit
 * lane's GBRAIN_PGLITE_SNAPSHOT fast path), then `initSchema()` (a no-op when
 * the snapshot loaded). Reports whether the snapshot was actually used.
 */
export async function capturePgliteSnapshotRestoredCatalog(tarPath: string): Promise<{ catalog: CatalogSnapshot; snapshotLoaded: boolean }> {
  return withSnapshotValue(tarPath, async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      const snapshotLoaded = (engine as unknown as { _snapshotLoaded: boolean })._snapshotLoaded;
      await engine.initSchema();
      return { catalog: await snapshotCatalog(pgliteCatalogQuery(engine)), snapshotLoaded };
    } finally {
      await engine.disconnect();
    }
  });
}

/**
 * PGLite analogue of Postgres `db.initSchema()`: forward-reference bootstrap +
 * the policy-applied schema blob, WITHOUT the migration chain. No production
 * caller runs this sequence on PGLite (PGLiteEngine.initSchema always runs
 * migrations), but it is exactly the state the W2 generated template must
 * reproduce before migrations can mask a generator error. Mirrors the first
 * half of `PGLiteEngine.initSchema()` on a fresh engine (no stored identity,
 * so dims/model come from the gateway).
 */
export async function capturePgliteBlobCatalog(): Promise<CatalogSnapshot> {
  return withColdPglite(async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await (engine as unknown as { applyForwardReferenceBootstrap(): Promise<void> }).applyForwardReferenceBootstrap();
      await engine.db.exec(getPGLiteSchema(getEmbeddingDimensions(), getEmbeddingModel()));
      return await snapshotCatalog(pgliteCatalogQuery(engine));
    } finally {
      await engine.disconnect();
    }
  });
}

// ─── Golden normalizer ──────────────────────────────────────────────────

function columnLine(c: CatalogColumn): string {
  const nullability = c.isNullable ? 'NULL' : 'NOT NULL';
  const dflt = c.columnDefault === null ? '' : ` DEFAULT ${c.columnDefault}`;
  return `${c.ordinal} ${c.name} ${c.dataType}/${c.udtName} ${nullability}${dflt}`;
}

/** One line per catalog object, keyed by object identity. */
export function catalogGoldenView(snap: CatalogSnapshot): Record<string, unknown> {
  const keyed = <T>(items: T[], key: (x: T) => string, line: (x: T) => string) => {
    const out: Record<string, string> = {};
    for (const x of items) {
      const k = key(x);
      if (k in out) throw new Error(`catalog golden: duplicate key ${k}`);
      out[k] = line(x);
    }
    return out;
  };
  const tables: Record<string, { flags: string; columns: string[] }> = {};
  for (const t of snap.tables) {
    tables[t.name] = {
      flags: `relkind=${t.relkind} rls=${t.rowSecurity} force_rls=${t.forceRowSecurity}`,
      columns: t.columns.map(columnLine),
    };
  }
  const viewColumns: Record<string, string[]> = {};
  for (const v of snap.viewColumns) viewColumns[v.view] = v.columns.map(columnLine);
  const grants: Record<string, string[]> = {};
  for (const g of snap.grants) {
    (grants[g.table] ??= []).push(`${g.grantor} -> ${g.grantee}${g.grantable ? ' WITH GRANT OPTION' : ''}: ${g.privileges.join(',')}`);
  }
  return {
    tables,
    viewColumns,
    indexes: keyed(snap.indexes, (i) => i.name, (i) => i.definition),
    constraints: keyed(snap.constraints, (c) => `${c.table}.${c.name}`, (c) => `${c.type} ${c.definition}`),
    triggers: keyed(snap.triggers, (t) => `${t.table}.${t.name}`, (t) => t.definition),
    functions: keyed(
      snap.functions,
      (f) => `${f.name}(${f.identityArguments})`,
      (f) => `RETURNS ${f.result} kind=${f.kind} lang=${f.language} volatility=${f.volatility} secdef=${f.securityDefiner} config=[${f.config.join('; ')}] body_sha256=${f.bodySha256}`,
    ),
    views: keyed(snap.views, (v) => v.name, (v) => `relkind=${v.kind} definition_sha256=${v.definitionSha256}`),
    policies: keyed(
      snap.policies,
      (p) => `${p.table}.${p.name}`,
      (p) => `${p.permissive} ${p.command} TO ${p.roles.join(',')} USING ${p.using ?? '-'} WITH CHECK ${p.withCheck ?? '-'}`,
    ),
    grants,
    sequences: keyed(
      snap.sequences,
      (s) => s.name,
      (s) => `${s.dataType} start=${s.start} min=${s.min} max=${s.max} increment=${s.increment} cycle=${s.cycle} cache=${s.cache} owned_by=${s.ownedBy ?? '-'}`,
    ),
    extensions: snap.extensions,
  };
}

export const catalogGoldenNormalizer = defineNormalizer<CatalogSnapshot>('schema-catalog-lines-v1', catalogGoldenView);

/** Flatten a golden view into `path -> line` so failures name the object. */
export function flattenGoldenView(view: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(view)) {
    view.forEach((v, i) => {
      if (typeof v === 'string') out.set(`${prefix}[${i}]`, v);
      else for (const [k, s] of flattenGoldenView(v, `${prefix}[${i}]`)) out.set(k, s);
    });
    return out;
  }
  if (view && typeof view === 'object') {
    for (const [k, v] of Object.entries(view as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') out.set(p, v);
      else for (const [kk, s] of flattenGoldenView(v, p)) out.set(kk, s);
    }
    return out;
  }
  out.set(prefix, String(view));
  return out;
}

/**
 * Human-readable diff of `actual` against the committed golden `name`
 * (empty string when identical or when the golden is missing / being
 * regenerated; expectGolden reports those cases itself).
 */
export function describeCatalogGoldenDrift(name: string, actual: CatalogSnapshot): string {
  const file = join(GOLDENS_DIR, `${name}.json`);
  if (!existsSync(file)) return '';
  const expected = flattenGoldenView((JSON.parse(readFileSync(file, 'utf8')) as { golden: unknown }).golden);
  const got = flattenGoldenView(JSON.parse(JSON.stringify(catalogGoldenView(actual))));
  const lines: string[] = [];
  for (const [k, v] of expected) {
    if (!got.has(k)) lines.push(`  - MISSING ${k}: ${v}`);
    else if (got.get(k) !== v) lines.push(`  ~ CHANGED ${k}\n      golden: ${v}\n      actual: ${got.get(k)}`);
  }
  for (const [k, v] of got) if (!expected.has(k)) lines.push(`  + UNEXPECTED ${k}: ${v}`);
  return lines.length === 0 ? '' : `catalog drift vs golden ${name}:\n${lines.slice(0, 200).join('\n')}${lines.length > 200 ? `\n  ... ${lines.length - 200} more` : ''}`;
}

/** Compare with the golden, failing first with an object-level drift report. */
export function expectCatalogGolden(name: string, actual: CatalogSnapshot): void {
  if (process.env.GBRAIN_TEST_UPDATE_GOLDENS !== '1') {
    const drift = describeCatalogGoldenDrift(name, actual);
    if (drift) throw new Error(drift);
  }
  expectGolden(name, actual, catalogGoldenNormalizer);
}

/**
 * Unit tests for `test/helpers/schema-diff.ts`.
 *
 * The pure diff function is the load-bearing piece of the v0.26.3 drift gate
 * (issue #588). If it has bugs, the gate is a paper gate. These tests use
 * synthetic snapshots so they run without a database, and they include the
 * D3 negative case: the v0.26.1 token_ttl regression that motivated the
 * issue in the first place.
 */

import { describe, test, expect } from 'bun:test';
import {
  type SchemaSnapshot,
  type ColumnInfo,
  diffSnapshots,
  formatDiffForFailure,
  isCleanDiff,
  snapshotSchema,
} from './schema-diff.ts';
import { createHash } from 'node:crypto';
import {
  type CatalogSnapshot,
  type RawCatalogRows,
  CATALOG_CURRENT_ROLE,
  CATALOG_QUERIES,
  buildCatalogSnapshot,
  diffCatalogSnapshots,
  formatCatalogDiffForFailure,
  snapshotCatalog,
} from './schema-diff.ts';

function col(partial: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    dataType: partial.dataType ?? 'text',
    udtName: partial.udtName ?? 'text',
    isNullable: partial.isNullable ?? true,
    columnDefault: partial.columnDefault ?? null,
  };
}

function makeSnap(tables: Record<string, Record<string, ColumnInfo>>): SchemaSnapshot {
  const snap: SchemaSnapshot = new Map();
  for (const [table, cols] of Object.entries(tables)) {
    const m = new Map<string, ColumnInfo>();
    for (const [name, info] of Object.entries(cols)) m.set(name, info);
    snap.set(table, m);
  }
  return snap;
}

const NO_ALLOWLIST = { allowlistPgOnlyTables: [] };

describe('diffSnapshots', () => {
  test('identical snapshots produce a clean diff', () => {
    const a = makeSnap({ pages: { id: col({ udtName: 'uuid' }), title: col() } });
    const b = makeSnap({ pages: { id: col({ udtName: 'uuid' }), title: col() } });
    const diff = diffSnapshots(a, b, NO_ALLOWLIST);
    expect(isCleanDiff(diff)).toBe(true);
  });

  test('column missing in PGLite reports the exact column name', () => {
    const pg = makeSnap({ oauth_clients: { client_id: col(), token_ttl: col({ udtName: 'int4' }) } });
    const pglite = makeSnap({ oauth_clients: { client_id: col() } });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(diff.columnsMissingInPGLite).toEqual([{ table: 'oauth_clients', columns: ['token_ttl'] }]);
    expect(diff.columnsMissingInPostgres).toEqual([]);
    expect(isCleanDiff(diff)).toBe(false);
  });

  test('column present only on PGLite reports columnsMissingInPostgres', () => {
    const pg = makeSnap({ pages: { id: col({ udtName: 'uuid' }) } });
    const pglite = makeSnap({ pages: { id: col({ udtName: 'uuid' }), pglite_only: col() } });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(diff.columnsMissingInPostgres).toEqual([{ table: 'pages', columns: ['pglite_only'] }]);
  });

  test('table missing in PGLite reports tablesMissingInPGLite', () => {
    const pg = makeSnap({ pages: {}, mcp_request_log: { id: col() } });
    const pglite = makeSnap({ pages: {} });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(diff.tablesMissingInPGLite).toEqual(['mcp_request_log']);
  });

  test('table on allowlist is excluded from tablesMissingInPGLite', () => {
    const pg = makeSnap({ files: { id: col() }, pages: { id: col() } });
    const pglite = makeSnap({ pages: { id: col() } });
    const diff = diffSnapshots(pg, pglite, { allowlistPgOnlyTables: ['files'] });
    expect(diff.tablesMissingInPGLite).toEqual([]);
    expect(isCleanDiff(diff)).toBe(true);
  });

  test('udt_name mismatch is reported as type mismatch', () => {
    // The exact codex-flagged regression: access_tokens.id is UUID on Postgres,
    // TEXT on PGLite.
    const pg = makeSnap({ access_tokens: { id: col({ dataType: 'uuid', udtName: 'uuid' }) } });
    const pglite = makeSnap({ access_tokens: { id: col({ dataType: 'text', udtName: 'text' }) } });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(diff.typeMismatches).toHaveLength(1);
    expect(diff.typeMismatches[0]).toMatchObject({
      table: 'access_tokens',
      column: 'id',
      reason: 'udt_name',
    });
  });

  test('array element type mismatch is caught via udt_name', () => {
    // information_schema reports `ARRAY` for both `text[]` and `int[]` in
    // data_type but distinguishes them via udt_name (`_text` vs `_int4`).
    // udt_name catches this; data_type alone would not.
    const pg = makeSnap({ t: { x: col({ dataType: 'ARRAY', udtName: '_text' }) } });
    const pglite = makeSnap({ t: { x: col({ dataType: 'ARRAY', udtName: '_int4' }) } });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(diff.typeMismatches).toHaveLength(1);
    expect(diff.typeMismatches[0].reason).toBe('udt_name');
  });

  test('nullable mismatch is reported when udt_name matches', () => {
    const pg = makeSnap({ t: { x: col({ udtName: 'text', isNullable: false }) } });
    const pglite = makeSnap({ t: { x: col({ udtName: 'text', isNullable: true }) } });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(diff.typeMismatches).toHaveLength(1);
    expect(diff.typeMismatches[0].reason).toBe('is_nullable');
  });

  test('default mismatch is reported when udt_name and nullable match', () => {
    const pg = makeSnap({ t: { x: col({ udtName: 'text', columnDefault: "'a'" }) } });
    const pglite = makeSnap({ t: { x: col({ udtName: 'text', columnDefault: "'b'" }) } });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(diff.typeMismatches).toHaveLength(1);
    expect(diff.typeMismatches[0].reason).toBe('column_default');
  });

  test('default normalisation: ::text type cast is stripped before comparing', () => {
    // Postgres often renders string defaults with `::text`, PGLite without.
    const pg = makeSnap({ t: { x: col({ udtName: 'text', columnDefault: "'hello'::text" }) } });
    const pglite = makeSnap({ t: { x: col({ udtName: 'text', columnDefault: "'hello'" }) } });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(isCleanDiff(diff)).toBe(true);
  });

  test('default normalisation: whitespace + ::jsonb cast collapsed', () => {
    const pg = makeSnap({ t: { meta: col({ udtName: 'jsonb', columnDefault: "  '{}'::jsonb  " }) } });
    const pglite = makeSnap({ t: { meta: col({ udtName: 'jsonb', columnDefault: "'{}'" }) } });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(isCleanDiff(diff)).toBe(true);
  });

  test('multiple issues across multiple tables are all reported', () => {
    const pg = makeSnap({
      a: { x: col({ udtName: 'int4' }), y: col({ udtName: 'text' }) },
      b: { z: col({ udtName: 'uuid' }) },
      c: { only_on_pg: col() },
    });
    const pglite = makeSnap({
      a: { x: col({ udtName: 'int8' }) }, // udt mismatch + missing y
      b: { z: col({ udtName: 'uuid' }), only_on_pglite: col() },
    });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    expect(diff.tablesMissingInPGLite).toEqual(['c']);
    expect(diff.columnsMissingInPGLite).toEqual([{ table: 'a', columns: ['y'] }]);
    expect(diff.columnsMissingInPostgres).toEqual([{ table: 'b', columns: ['only_on_pglite'] }]);
    expect(diff.typeMismatches).toHaveLength(1);
    expect(diff.typeMismatches[0]).toMatchObject({ table: 'a', column: 'x', reason: 'udt_name' });
  });
});

describe('formatDiffForFailure', () => {
  test('clean diff renders as "no diff"', () => {
    const diff = diffSnapshots(makeSnap({ pages: {} }), makeSnap({ pages: {} }), NO_ALLOWLIST);
    expect(formatDiffForFailure(diff)).toBe('no diff');
  });

  test('column missing names the column with a copy-paste hint', () => {
    const pg = makeSnap({ oauth_clients: { token_ttl: col({ udtName: 'int4' }) } });
    const pglite = makeSnap({ oauth_clients: {} });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    const out = formatDiffForFailure(diff);
    expect(out).toContain('oauth_clients.token_ttl');
    expect(out).toContain('src/schema.sql');
    expect(out).toContain('bun run build:schema');
  });

  test('udt mismatch shows both sides', () => {
    const pg = makeSnap({ access_tokens: { id: col({ dataType: 'uuid', udtName: 'uuid' }) } });
    const pglite = makeSnap({ access_tokens: { id: col({ dataType: 'text', udtName: 'text' }) } });
    const diff = diffSnapshots(pg, pglite, NO_ALLOWLIST);
    const out = formatDiffForFailure(diff);
    expect(out).toContain('access_tokens.id');
    expect(out).toContain('uuid');
    expect(out).toContain('text');
  });
});

describe('D3 regression: oauth_clients.token_ttl drift (the v0.26.1 incident)', () => {
  // The bug that motivated issue #588: prod Postgres got `token_ttl` and
  // `deleted_at` via manual ALTER TABLE; PGLite did not. All unit tests
  // broke with `column "token_ttl" does not exist`. If this gate had
  // existed at v0.26.1 it would have caught the divergence at PR time
  // (the prod ALTER and the PGLite update would have travelled together
  // through CI).
  test('drift gate would have caught the v0.26.1 token_ttl + deleted_at bug', () => {
    const pgSide = makeSnap({
      oauth_clients: {
        client_id: col({ udtName: 'text', isNullable: false }),
        token_ttl: col({ udtName: 'int4' }),
        deleted_at: col({ udtName: 'timestamptz' }),
      },
    });
    const pgliteSide = makeSnap({
      oauth_clients: {
        client_id: col({ udtName: 'text', isNullable: false }),
        // token_ttl + deleted_at MISSING — exactly the v0.26.1 state
      },
    });
    const diff = diffSnapshots(pgSide, pgliteSide, NO_ALLOWLIST);
    expect(diff.columnsMissingInPGLite).toHaveLength(1);
    expect(diff.columnsMissingInPGLite[0].table).toBe('oauth_clients');
    expect(diff.columnsMissingInPGLite[0].columns).toEqual(['token_ttl', 'deleted_at']);
    const message = formatDiffForFailure(diff);
    expect(message).toContain('token_ttl');
    expect(message).toContain('deleted_at');
    expect(message).toContain('oauth_clients');
  });
});

describe('snapshotSchema', () => {
  test('aggregates rows from the query callback into a Map<table, Map<column>>', async () => {
    const fakeRows = [
      { table_name: 'pages', column_name: 'id',    data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO',  column_default: 'gen_random_uuid()' },
      { table_name: 'pages', column_name: 'title', data_type: 'text', udt_name: 'text', is_nullable: 'YES', column_default: null },
      { table_name: 'tags',  column_name: 'tag',   data_type: 'text', udt_name: 'text', is_nullable: 'NO',  column_default: null },
    ];
    const snap = await snapshotSchema(async () => fakeRows);
    expect(snap.get('pages')!.get('id')).toEqual({
      dataType: 'uuid',
      udtName: 'uuid',
      isNullable: false,
      columnDefault: 'gen_random_uuid()',
    });
    expect(snap.get('pages')!.get('title')!.isNullable).toBe(true);
    expect(snap.get('tags')!.get('tag')!.columnDefault).toBeNull();
  });
});

// ─── Refactor wave 1 E4 / T-G13: catalog-level snapshot ───────────────

function rawCatalog(partial: Partial<RawCatalogRows> = {}): RawCatalogRows {
  return {
    currentRole: [{ role: 'ci_superuser' }],
    relations: [],
    columns: [],
    indexes: [],
    constraints: [],
    triggers: [],
    functions: [],
    views: [],
    policies: [],
    grants: [],
    sequences: [],
    extensions: [],
    ...partial,
  };
}

function column(table: string, name: string, ordinal: number, extra: Record<string, unknown> = {}) {
  return { table_name: table, column_name: name, ordinal_position: ordinal, data_type: 'text', udt_name: 'text', is_nullable: 'YES', column_default: null, ...extra };
}

describe('buildCatalogSnapshot', () => {
  test('orders tables by name and columns by ordinal, regardless of row order', () => {
    const snap = buildCatalogSnapshot(rawCatalog({
      relations: [
        { name: 'tags', relkind: 'r', row_security: false, force_row_security: false },
        { name: 'pages', relkind: 'r', row_security: 't', force_row_security: 'f' },
      ],
      columns: [column('pages', 'title', 2), column('tags', 'tag', 1), column('pages', 'id', 1, { is_nullable: 'NO', udt_name: 'int4' })],
    }));
    expect(snap.tables.map((t) => t.name)).toEqual(['pages', 'tags']);
    expect(snap.tables[0]).toEqual({
      name: 'pages',
      relkind: 'r',
      rowSecurity: true,
      forceRowSecurity: false,
      columns: [
        { name: 'id', ordinal: 1, dataType: 'text', udtName: 'int4', isNullable: false, columnDefault: null },
        { name: 'title', ordinal: 2, dataType: 'text', udtName: 'text', isNullable: true, columnDefault: null },
      ],
    });
  });

  test('view columns are reported under viewColumns, not tables', () => {
    const snap = buildCatalogSnapshot(rawCatalog({
      relations: [{ name: 'page_links', relkind: 'v', row_security: false, force_row_security: false }],
      columns: [column('page_links', 'slug', 1)],
      views: [{ name: 'page_links', kind: 'v', definition: ' SELECT 1;' }],
    }));
    expect(snap.tables).toEqual([]);
    expect(snap.viewColumns).toEqual([{ view: 'page_links', columns: [{ name: 'slug', ordinal: 1, dataType: 'text', udtName: 'text', isNullable: true, columnDefault: null }] }]);
    expect(snap.views).toEqual([{ name: 'page_links', kind: 'v', definitionSha256: createHash('sha256').update(' SELECT 1;').digest('hex') }]);
  });

  test('function bodies are pinned by sha256; config lines split; booleans coerced', () => {
    const body = 'BEGIN RETURN NEW; END;';
    const snap = buildCatalogSnapshot(rawCatalog({
      functions: [{
        name: 'touch', identity_arguments: '', result: 'trigger', kind: 'f', language: 'plpgsql',
        volatility: 'v', security_definer: 't', config: 'search_path=pg_catalog, public\nwork_mem=64kB', body,
      }],
    }));
    expect(snap.functions).toEqual([{
      name: 'touch', identityArguments: '', result: 'trigger', kind: 'f', language: 'plpgsql', volatility: 'v',
      securityDefiner: true, config: ['search_path=pg_catalog, public', 'work_mem=64kB'],
      bodySha256: createHash('sha256').update(body).digest('hex'),
    }]);
  });

  test('the connecting role is placeholdered in grants and policies; other roles are kept', () => {
    const snap = buildCatalogSnapshot(rawCatalog({
      grants: [
        { table_name: 'pages', grantor: 'ci_superuser', grantee: 'ci_superuser', privilege: 'SELECT', is_grantable: 'YES' },
        { table_name: 'pages', grantor: 'ci_superuser', grantee: 'ci_superuser', privilege: 'INSERT', is_grantable: 'YES' },
        { table_name: 'pages', grantor: 'ci_superuser', grantee: 'PUBLIC', privilege: 'SELECT', is_grantable: 'NO' },
      ],
      policies: [{ table_name: 'pages', name: 'p_read', permissive: 'PERMISSIVE', roles: 'ci_superuser\nreader_example', command: 'SELECT', using_expr: 'true', with_check: null }],
    }));
    expect(snap.grants).toEqual([
      { table: 'pages', grantor: CATALOG_CURRENT_ROLE, grantee: CATALOG_CURRENT_ROLE, grantable: true, privileges: ['INSERT', 'SELECT'] },
      { table: 'pages', grantor: CATALOG_CURRENT_ROLE, grantee: 'PUBLIC', grantable: false, privileges: ['SELECT'] },
    ]);
    expect(snap.policies[0].roles).toEqual([CATALOG_CURRENT_ROLE, 'reader_example']);
    expect(snap.policies[0].withCheck).toBeNull();
  });

  test('extensions and sequences are sorted; constraints keep CHECK text verbatim', () => {
    const snap = buildCatalogSnapshot(rawCatalog({
      extensions: [{ name: 'vector' }, { name: 'pg_trgm' }],
      sequences: [
        { name: 'z_seq', data_type: 'bigint', start_value: '1', min_value: '1', max_value: '9', increment_by: '1', cycle: false, cache_size: '1', owned_by: null },
        { name: 'a_seq', data_type: 'integer', start_value: '1', min_value: '1', max_value: '9', increment_by: '1', cycle: 't', cache_size: '1', owned_by: 'pages.id' },
      ],
      constraints: [{ name: 'pages_kind_check', table_name: 'pages', type: 'c', definition: "CHECK ((kind = ANY (ARRAY['a'::text, 'b'::text])))" }],
    }));
    expect(snap.extensions).toEqual(['pg_trgm', 'vector']);
    expect(snap.sequences.map((s) => [s.name, s.cycle, s.ownedBy])).toEqual([['a_seq', true, 'pages.id'], ['z_seq', false, null]]);
    expect(snap.constraints[0].definition).toBe("CHECK ((kind = ANY (ARRAY['a'::text, 'b'::text])))");
  });
});

describe('snapshotCatalog', () => {
  test('runs every catalog section query exactly once through the callback', async () => {
    const seen: string[] = [];
    const snap = await snapshotCatalog(async (sql) => {
      seen.push(sql);
      if (sql === CATALOG_QUERIES.currentRole) return [{ role: 'postgres' }];
      if (sql === CATALOG_QUERIES.extensions) return [{ name: 'plpgsql' }];
      return [];
    });
    expect(seen).toEqual(Object.values(CATALOG_QUERIES));
    expect(snap.extensions).toEqual(['plpgsql']);
  });

  test('queries exclude extension-owned objects and internal triggers', () => {
    expect(CATALOG_QUERIES.functions).toContain("d.deptype = 'e'");
    expect(CATALOG_QUERIES.relations).toContain("d.deptype = 'e'");
    expect(CATALOG_QUERIES.triggers).toContain('NOT tg.tgisinternal');
  });
});

describe('diffCatalogSnapshots (T-G13: ordinals only for same-engine comparisons)', () => {
  function snapWithColumns(order: Array<[string, number]>): CatalogSnapshot {
    return buildCatalogSnapshot(rawCatalog({
      relations: [{ name: 'pages', relkind: 'r', row_security: false, force_row_security: false }],
      columns: order.map(([name, ordinal]) => column('pages', name, ordinal)),
    }));
  }

  test('identical snapshots diff clean', () => {
    const a = snapWithColumns([['id', 1], ['title', 2]]);
    expect(diffCatalogSnapshots(a, snapWithColumns([['id', 1], ['title', 2]]), { compareOrdinals: true })).toEqual([]);
    expect(formatCatalogDiffForFailure([])).toBe('no diff');
  });

  test('a column reorder is invisible name-based and reported with compareOrdinals', () => {
    const master = snapWithColumns([['id', 1], ['title', 2]]);
    const branch = snapWithColumns([['title', 1], ['id', 2]]);
    expect(diffCatalogSnapshots(master, branch)).toEqual([]);
    const strict = diffCatalogSnapshots(master, branch, { compareOrdinals: true });
    expect(strict.map((d) => [d.section, d.key, d.kind])).toEqual([
      ['tables', 'pages.id', 'changed'],
      ['tables', 'pages.title', 'changed'],
    ]);
    expect(formatCatalogDiffForFailure(strict)).toContain('pages.id changed');
  });

  test('missing and unexpected objects are reported per section', () => {
    const a = buildCatalogSnapshot(rawCatalog({ indexes: [{ name: 'idx_a', table_name: 'pages', definition: 'CREATE INDEX idx_a ON public.pages (a)' }] }));
    const b = buildCatalogSnapshot(rawCatalog({ indexes: [{ name: 'idx_b', table_name: 'pages', definition: 'CREATE INDEX idx_b ON public.pages (b)' }] }));
    const diff = diffCatalogSnapshots(a, b);
    expect(diff.map((d) => [d.section, d.key, d.kind])).toEqual([
      ['indexes', 'idx_a', 'missing_in_actual'],
      ['indexes', 'idx_b', 'unexpected_in_actual'],
    ]);
  });

  test('existing cross-engine diffSnapshots stays name-based (column order ignored)', () => {
    const pg = makeSnap({ pages: { id: col({ udtName: 'int4' }), title: col() } });
    const pglite = makeSnap({ pages: { title: col(), id: col({ udtName: 'int4' }) } });
    expect(isCleanDiff(diffSnapshots(pg, pglite, NO_ALLOWLIST))).toBe(true);
  });
});

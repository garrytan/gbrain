/**
 * SQL twins of TypeScript predicates normalize a value the same way the TypeScript side does. JavaScript's `trim`
 * strips every WhiteSpace and LineTerminator character; Postgres `btrim(x)` strips spaces only, and `lower()` follows
 * the database collation. Each twin here trims with edgeTrimSql (and the privacy aliases lowercase ASCII only), so:
 *
 * - the privacy aliases (`access`, `confidentiality`) give the same answer row-side and in SQL for every edge
 *   whitespace character, and remote list and search reads hide an aliased page whatever whitespace its value carries
 *   (a YAML block scalar keeps a trailing newline);
 * - the frontmatter trust caps, the local stdio member binding and the database-only page predicate agree with their
 *   TypeScript sides on the same inputs.
 *
 * PGLite and Postgres (DATABASE_URL); synthetic names.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { EDGE_WHITESPACE, edgeTrimSql } from '../src/core/edge-whitespace.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { databaseOnlyPageSql, isDatabaseOnlyPage } from '../src/core/persistence/unbound-pages.ts';
import { memberIdentityFor, stdioMemberId, STDIO_MEMBER_KEY } from '../src/core/access/caller.ts';
import { addMember } from '../src/core/access/members.ts';
import { privacyClass } from '../src/core/persistence/git-declared.ts';
import {
  PRIVACY_ALIASES, __resetPrivateVisibilityCacheForTests, isPrivacyPrivatePage, privacyAliasSql,
  privatePagesFilterFastForCaller, privatePagesFilterForCaller, privatePagesFilterFragment, privatePagesFilterFragmentFast,
} from '../src/core/search/private-visibility.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const EDGES = [...EDGE_WHITESPACE];
const engines: Array<{ name: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      engines.push({ name: backend, engine });
    } else {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push({ name: backend, engine: isolated.engine });
      closePostgres = isolated.close;
    }
  }
}, 120_000);
afterAll(async () => {
  for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});

test('EDGE_WHITESPACE is exactly what String.prototype.trim strips', () => {
  const stripped: string[] = [];
  for (let code = 0; code <= 0xffff; code++) {
    const c = String.fromCharCode(code);
    if (`x${c}`.trim() === 'x') stripped.push(c);
  }
  expect(EDGES.sort()).toEqual(stripped.sort());
});

test('edgeTrimSql is ASCII SQL with no Unicode escape above U+007F', () => {
  const sql = edgeTrimSql('v');
  expect(/^[\x20-\x7e]*$/.test(sql)).toBe(true);
  expect(sql.match(/\\u[0-9a-f]{4}/gi)?.filter(e => parseInt(e.slice(2), 16) > 0x7f) ?? []).toEqual([]);
});

test.skipIf(!process.env.DATABASE_URL)('edgeTrimSql runs on SQL_ASCII and LATIN1 databases and trims their ASCII edges', async () => {
  assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
  const admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  try {
    for (const encoding of ['SQL_ASCII', 'LATIN1']) {
      const name = `gbrain_test_edges_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING '${encoding}' LC_COLLATE 'C' LC_CTYPE 'C'`);
      const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
      const db = postgres(url.toString(), { max: 1, prepare: false });
      try {
        const [row] = await db.unsafe(`SELECT current_setting('server_encoding') AS encoding, ${edgeTrimSql('v')} AS t FROM (VALUES ($1::text)) AS x(v)`, ['\t a b \n\r']);
        expect({ encoding: row!.encoding, t: row!.t }).toEqual({ encoding, t: 'a b' });
      } finally {
        await db.end();
        await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      }
    }
  } finally {
    await admin.end();
  }
}, 60_000);

describe.each(testBackends())('%s', (backend) => {
  const engine = () => engines.find(e => e.name === backend)!.engine;

  test('edgeTrimSql matches trim on every edge character', async () => {
    const values = EDGES.flatMap(c => [`${c}a b${c}`, `${c}${c}x`, `y${c}`, c, `${c} ${c}`]);
    const rows = await engine().executeRaw<{ v: string; t: string }>(`SELECT v, ${edgeTrimSql('v')} AS t FROM unnest($1::text[]) AS v`, [values]);
    for (const row of rows) expect({ v: row.v, t: row.t }).toEqual({ v: row.v, t: row.v.trim() });
  });

  test('privacy aliases: the SQL twin agrees with the row-side check on edge whitespace and case', async () => {
    __resetPrivateVisibilityCacheForTests();
    const words = ['private', 'restricted', 'confidential', 'secret', 'public', 'internal', 'privates', ''];
    const shapes = (w: string) => [w, w.toUpperCase(), `${w[0]?.toUpperCase() ?? ''}${w.slice(1)}`, ...EDGES.flatMap(c => [`${c}${w}`, `${w}${c}`, `${c}${w.toUpperCase()}${c}`])];
    const frontmatters: Array<Record<string, unknown>> = Object.keys(PRIVACY_ALIASES).flatMap(key => words.flatMap(w => shapes(w).map(v => ({ [key]: v }))));
    frontmatters.push({ access: 'PR\u0130VATE' }, { access: 'pri\u200bvate' }, { confidentiality: 'SECRET\u212a' }, { access: ['private'] }, { access: 1 });
    const rows = await engine().executeRaw<{ i: number; private: boolean }>(
      `SELECT i, ${privacyAliasSql('p')} AS private FROM jsonb_array_elements($1::text::jsonb) WITH ORDINALITY AS t(frontmatter, i), LATERAL (SELECT t.frontmatter) AS p`,
      [JSON.stringify(frontmatters)]);
    expect(rows).toHaveLength(frontmatters.length);
    for (const row of rows) {
      const fm = frontmatters[Number(row.i) - 1]!;
      expect({ fm, private: row.private }).toEqual({ fm, private: isPrivacyPrivatePage({ type: 'note', frontmatter: fm }) });
    }
    expect(isPrivacyPrivatePage({ type: 'note', frontmatter: { access: 'private\n' } })).toBe(true);
  });

  test('remote list and search hide an aliased page whatever edge whitespace its value carries; local reads see it', async () => {
    __resetPrivateVisibilityCacheForTests();
    const sourceId = `ws-${randomUUID().slice(0, 8)}`;
    await engine().executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const ctx = (remote: boolean) => ({ engine: engine(), config: { engine: engine().kind, embedding_disabled: true }, remote, sourceId, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
    const pages: Record<string, string> = {
      'meetings/block-example': 'access: |\n  private',
      'meetings/tab-example': 'access: "restricted\\t"',
      'meetings/nbsp-example': 'confidentiality: "secret\\u00a0"',
      'meetings/open-example': 'access: public',
    };
    for (const [slug, field] of Object.entries(pages)) {
      await operationsByName.put_page!.handler(ctx(false), { slug, content: `---\ntype: meeting\ntitle: ${slug}\n${field}\n---\n# ${slug}\n\nQuillmarrow synthetic agenda.\n` });
    }
    const listed = async (c: OperationContext) => {
      const out = await operationsByName.list_pages!.handler(c, { type: 'meeting' }) as unknown;
      return ((Array.isArray(out) ? out : (out as { pages: unknown[] }).pages) as Array<{ slug: string }>).map(r => r.slug).sort();
    };
    const searched = async (c: OperationContext) =>
      [...new Set((await operationsByName.search!.handler(c, { query: 'Quillmarrow' }) as Array<{ slug: string }>).map(r => r.slug))].sort();
    expect(await listed(ctx(true))).toEqual(['meetings/open-example']);
    expect(await searched(ctx(true))).toEqual(['meetings/open-example']);
    expect(await listed(ctx(false))).toEqual(Object.keys(pages).sort());
    expect(await searched(ctx(false))).toEqual(Object.keys(pages).sort());
  }, 120_000);

  test('the fast page filters hide exactly what the full filters hide', async () => {
    __resetPrivateVisibilityCacheForTests();
    const sourceId = `fast-${randomUUID().slice(0, 8)}`;
    await engine().executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const types = ['note', 'meeting', 'question', 'atom', 'concept', 'event'];
    const frontmatters: Array<Record<string, unknown>> = [{}, { pinned_question: 'q' }, { visibility: 'private' }, { visibility: 'world' }, { access: 'private\n' },
      { confidentiality: 'internal' }, { derived_from: 'notes/none-example' }, { readable_by: ['alice-example'] }, { synthesized_by: 'x' }];
    let n = 0;
    for (const type of types) for (const frontmatter of frontmatters) {
      await engine().executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,source_id,frontmatter) VALUES($1,$2,'T','body',$3,$4::text::jsonb)`,
        [`fast/p${n++}`, type, sourceId, JSON.stringify(frontmatter)]);
    }
    const visible = async (filter: string) => (await engine().executeRaw<{ slug: string }>(
      `SELECT p.slug FROM pages p WHERE p.source_id = $1 AND ${filter} ORDER BY p.slug`, [sourceId])).map(r => r.slug);
    expect(await visible(privatePagesFilterFragmentFast('p'))).toEqual(await visible(privatePagesFilterFragment('p')));
    expect(await visible(privatePagesFilterFastForCaller('p'))).toEqual(await visible(privatePagesFilterForCaller('p')));
  });

  test('privacyClass keeps a question page with a private synthesized input out of Git, as remote reads hide it', async () => {
    __resetPrivateVisibilityCacheForTests();
    const sourceId = `lineage-${randomUUID().slice(0, 8)}`;
    await engine().executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const insert = async (slug: string, type: string, frontmatter: Record<string, unknown>) => Number((await engine().executeRaw<{ id: number }>(
      `INSERT INTO pages(slug,type,title,compiled_truth,source_id,frontmatter) VALUES($1,$2,'T','body',$3,$4::text::jsonb) RETURNING id`,
      [slug, type, sourceId, JSON.stringify(frontmatter)]))[0]!.id);
    const input = await insert('atoms/input-example', 'atom', { visibility: 'private' });
    const question = await insert('questions/q-example', 'question', { visibility: 'world' });
    await engine().executeRaw("INSERT INTO links (from_page_id,to_page_id,link_type,link_source) VALUES ($1,$2,'synthesized_from','concept-provenance')", [question, input]);
    const [row] = await engine().executeRaw<{ visible: boolean }>(`SELECT ${privatePagesFilterFragment('p')} AS visible FROM pages p WHERE p.id = $1`, [question]);
    expect(row!.visible).toBe(false);
    expect(await privacyClass(engine(), sourceId, { id: question, slug: 'questions/q-example', type: 'question', frontmatter: { visibility: 'world' } })).toBe('lineage_private');
  });

  test('the stdio member binding trims like stdioMemberId', async () => {
    await addMember(engine(), 'carol-example');
    try {
      for (const c of EDGES) {
        await engine().setConfig(STDIO_MEMBER_KEY, `carol-example${c}`);
        expect({ c, id: await stdioMemberId(engine()) }).toEqual({ c, id: 'carol-example' });
        expect({ c, identity: await memberIdentityFor(engine(), { principal: { kind: 'local_stdio', id: 'stdio' } }) }).toEqual({ c, identity: ['member:carol-example'] });
      }
    } finally {
      await engine().setConfig(STDIO_MEMBER_KEY, '');
    }
  });

  test('databaseOnlyPageSql agrees with isDatabaseOnlyPage on edge-whitespace paths', async () => {
    const rows = await engine().executeRaw<{ source_path: string; matched: boolean }>(
      `SELECT p.source_path, (${databaseOnlyPageSql('p')}) AS matched FROM (SELECT v AS source_path, NULL::text AS source_uri, 'unbound_source'::text AS database_only_reason FROM unnest($1::text[]) AS v) AS p`,
      [EDGES.flatMap(c => [c, `${c}${c}`, `${c}notes/a.md`])]);
    for (const row of rows) {
      expect({ path: row.source_path, matched: row.matched }).toEqual({ path: row.source_path,
        matched: isDatabaseOnlyPage({ source_path: row.source_path, source_uri: null, database_only_reason: 'unbound_source' }) });
    }
  });
});

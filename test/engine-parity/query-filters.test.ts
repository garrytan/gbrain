/**
 * BrainEngine parity — `gbrain query` and `gbrain search` with a source and a frontmatter `where` filter, through the
 * CLI (`--json`) and MCP.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with two sources, `query --source team` answers only that source's pages; `query` and
 *    `search` with a frontmatter `where` keep only pages whose frontmatter holds every key (no row when no page
 *    matches), on the keyword-only lexical path, the keyword page path (`match: "keyword"`) and the hybrid anchoring
 *    path of the search op, and on the query op's fill path; a source and a `where` together narrow by both. Every
 *    engine arm answers the same JSON, CLI and MCP alike (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), with the per-arm row ids (`page_id`, `chunk_id`) left out.
 *  - Regression: on the Rust engine the `where` check on finished rows (search/frontmatter-where.ts
 *    keepFrontmatterMatches) sent raw SQL, so every filtered `query` and `search` stopped on an
 *    engine_capability_missing (raw_sql) refusal; and `query --source` stopped on the explicit source check
 *    (ops/context.ts assertExplicitSourceLive, typed by readSourceRow).
 *  - Why existing coverage misses it: test/search-frontmatter-where.test.ts and
 *    test/e2e/search-frontmatter-where-parity.test.ts run PGLite and Postgres only.
 *  - Seam: none. Real engines, the real op handlers (the CLI's local caller) and the real MCP dispatcher; no
 *    embedding provider, so every read takes the keyword-only fallback.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const TEXT = 'The harbor ledger moved to the north pier.';

/** Drop the keys whose values are per-arm row ids; everything else is compared as the caller sees it. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'page_id' && k !== 'chunk_id')
      .map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-query-filters-'));
  try { return await withEnv({ GBRAIN_HOME: home }, run); } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Two sources, three pages each answering the query; `status` and `cycle` differ. */
async function fixture(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'team');
  const pages: Array<[string, string, Record<string, unknown>]> = [
    ['notes/pier-a', 'default', { status: 'active', cycle: 2024 }],
    ['notes/pier-b', 'default', { status: 'archived', cycle: 2023 }],
    ['notes/pier-c', 'default', { status: ['active', 'review'] }],
    ['notes/pier-d', 'team', { status: 'active', cycle: 2024 }],
    ['notes/pier-e', 'team', { status: 'archived' }],
    ['notes/pier-f', 'team', {}],
  ];
  for (const [slug, sourceId, frontmatter] of pages) {
    await seedPage(engine, { slug, input: { type: 'note', title: slug, compiled_truth: TEXT, timeline: '', frontmatter }, chunks: [chunk(0, TEXT)] }, { sourceId });
  }
}

/** The CLI's `--json` answer: the op handler under the trusted local caller, as JSON. */
async function cli(engine: BrainEngine, op: 'query' | 'search', params: Record<string, unknown>): Promise<unknown> {
  const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
  try {
    return stable(JSON.parse(JSON.stringify(await operationsByName[op]!.handler(ctx, params))));
  } catch (e) {
    return { error: (e as { code?: string }).code ?? (e as Error).message };
  }
}

/** The MCP answer: the dispatcher under a remote caller granted both sources. */
async function mcp(engine: BrainEngine, op: 'query' | 'search', params: Record<string, unknown>): Promise<unknown> {
  const auth = { token: 'parity', clientId: 'parity', clientName: 'parity', scopes: ['read'], allowedSources: ['default', 'team'], hasSourceGrant: true } as never;
  const result = await dispatchToolCall(engine, op, params, { remote: true, sourceId: 'default', auth });
  const parts = result.content.map(part => (part as { text?: string }).text ?? '');
  if (result.isError) return { error: /"code"\s*:\s*"([a-z_]+)"/.exec(parts.join(''))?.[1] ?? parts.join('').slice(0, 160) };
  // The rows, then the notices as text.
  return { results: stable(JSON.parse(parts[0]!)), notices: parts.slice(1) };
}

/** `source_id:slug` per row, the order kept. */
function slugs(answer: unknown): unknown {
  const rows = Array.isArray(answer) ? answer : (answer as { results?: unknown[] })?.results;
  return Array.isArray(rows) ? rows.map(r => `${(r as { source_id: string }).source_id}:${(r as { slug: string }).slug}`) : answer;
}

describe('engine parity: query and search with a source and a frontmatter where filter', () => {
  parityTest('(a) query --source team answers only that source, CLI and MCP',
    { methods: ['readSourceRow', 'searchKeyword'], timeout: 120_000 }, async (engine, backend) => withHome(async () => {
      await fixture(engine, backend);
      const params = { query: 'harbor ledger', source_id: 'team' };
      const out = { cli: await cli(engine, 'query', params), mcp: await mcp(engine, 'query', params) };
      const all = ['team:notes/pier-d', 'team:notes/pier-e', 'team:notes/pier-f'];
      expect({ cli: [...(slugs(out.cli) as string[])].sort(), mcp: [...(slugs(out.mcp) as string[])].sort() }).toEqual({ cli: all, mcp: all });
      return out;
    }));

  parityTest('(b) query with where keeps the pages whose frontmatter holds the key, and none when no page does',
    { methods: ['filterPageIdsByFrontmatter', 'searchKeyword'], timeout: 120_000 }, async (engine, backend) => withHome(async () => {
      await fixture(engine, backend);
      const out: Record<string, unknown> = {};
      for (const [name, where] of [['active', { status: 'active' }], ['cycle', { cycle: '2024' }], ['none', { status: 'missing' }]] as const) {
        const params = { query: 'harbor ledger', where, source_id: '__all__' };
        out[name] = { cli: await cli(engine, 'query', params), mcp: await mcp(engine, 'query', params) };
      }
      const view = (k: string) => ({ cli: slugs((out[k] as { cli: unknown }).cli), mcp: slugs((out[k] as { mcp: unknown }).mcp) });
      const both = (rows: string[]) => ({ cli: rows, mcp: rows });
      expect(view('active').cli).toEqual(expect.arrayContaining(['default:notes/pier-a', 'default:notes/pier-c', 'team:notes/pier-d']));
      expect((view('active').cli as string[]).length).toBe(3);
      expect(view('active').mcp).toEqual(view('active').cli);
      expect(view('cycle').cli).toEqual(expect.arrayContaining(['default:notes/pier-a', 'team:notes/pier-d']));
      expect((view('cycle').cli as string[]).length).toBe(2);
      expect(view('none')).toEqual(both([]));
      return out;
    }));

  parityTest('(c) search with where filters the lexical, the keyword page and the hybrid anchoring paths',
    { methods: ['filterPageIdsByFrontmatter', 'searchKeyword', 'searchKeywordPages'], timeout: 120_000 }, async (engine, backend) => withHome(async () => {
      await fixture(engine, backend);
      const where = { status: 'active' };
      const out: Record<string, unknown> = {};
      // The hybrid path: rows through the anchoring stage, then the where check (ops/search.ts anchoring).
      out.hybrid = { cli: await cli(engine, 'search', { query: 'harbor ledger', where }), mcp: await mcp(engine, 'search', { query: 'harbor ledger', where }) };
      // The keyword page path (`match: "keyword"`), then the keyword-only lexical path (search.mcp_keyword_only).
      out.page = { cli: await cli(engine, 'search', { query: 'harbor ledger', where, match: 'keyword' }), mcp: await mcp(engine, 'search', { query: 'harbor ledger', where, match: 'keyword' }) };
      await engine.setConfig('search.mcp_keyword_only', 'true');
      out.lexical = { cli: await cli(engine, 'search', { query: 'harbor ledger', where }), mcp: await mcp(engine, 'search', { query: 'harbor ledger', where }) };
      for (const path of ['hybrid', 'page', 'lexical']) {
        const got = out[path] as { cli: unknown; mcp: unknown };
        expect({ path, cli: [...(slugs(got.cli) as string[])].sort(), mcp: [...(slugs(got.mcp) as string[])].sort() })
          // The CLI reads its own source; the MCP caller is granted both.
          .toEqual({ path, cli: ['default:notes/pier-a', 'default:notes/pier-c'], mcp: ['default:notes/pier-a', 'default:notes/pier-c', 'team:notes/pier-d'] });
      }
      return out;
    }));

  parityTest('(d) query --source team with where narrows by both',
    { methods: ['readSourceRow', 'filterPageIdsByFrontmatter', 'searchKeyword'], timeout: 120_000 }, async (engine, backend) => withHome(async () => {
      await fixture(engine, backend);
      const params = { query: 'harbor ledger', source_id: 'team', where: { status: 'active' } };
      const out = { cli: await cli(engine, 'query', params), mcp: await mcp(engine, 'query', params) };
      expect({ cli: slugs(out.cli), mcp: slugs(out.mcp) }).toEqual({ cli: ['team:notes/pier-d'], mcp: ['team:notes/pier-d'] });
      return out;
    }));
});

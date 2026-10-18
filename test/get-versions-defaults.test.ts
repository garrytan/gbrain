/**
 * Large pages (Wave A): get_versions defaults to metadata only and the
 * newest 20 versions.
 *
 * 1. Protects: a history read of a large, often-edited page no longer ships
 *    every snapshot's whole body. Without params it returns the newest 20
 *    versions without compiled_truth/timeline; MCP callers are capped at 100
 *    per call; the trusted local CLI honors any explicit limit;
 *    include_body: true still returns bodies, remote-sanitized as before; a
 *    cut history says so (_meta.pagination, the listing_truncated notice for
 *    remote callers, one stderr line for a local call with no limit).
 * 2. Fails when: bodies come back by default, the default or cap changes
 *    silently, include_body: true stops sanitizing remote bodies, or a cut
 *    history reads as complete.
 * 3. No new seam: the real handler over PGLite.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { formatResult } from '../src/cli/main.ts';

const SLUG = 'people/alice-example';
const SHORT = 'notes/short-history';
const VERSIONS = 105;
const TAKES = '<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | private hunch about acme-example | hunch | brain | 0.6 | 2026-01 | x |\n<!--- gbrain:takes:end -->';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page = await engine.putPage(SLUG, { type: 'person', title: 'Alice', compiled_truth: 'current body' });
  await engine.executeRaw(
    `INSERT INTO page_versions (page_id, compiled_truth, timeline, frontmatter, snapshot_at, title)
     SELECT $1, 'body v' || g || E'\\n\\n' || $2, 'timeline v' || g, '{}'::jsonb, '2026-01-01'::timestamptz + g * interval '1 hour', 'title v' || g
     FROM generate_series(1, ${VERSIONS}) g`,
    [page.id, TAKES]);
  const short = await engine.putPage(SHORT, { type: 'note', title: 'Short', compiled_truth: 'short body' });
  await engine.executeRaw(
    `INSERT INTO page_versions (page_id, compiled_truth, frontmatter, title) VALUES ($1, 'only version', '{}'::jsonb, 'only')`, [short.id]);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

interface Captured { notices: Notice[]; meta: Record<string, unknown> }
const fresh = (): Captured => ({ notices: [], meta: {} });

function ctx(remote: boolean, c?: Captured): OperationContext {
  return {
    engine, config: { engine: 'pglite' } as never, sourceId: 'default', remote, dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    ...(c ? { emitNotice: (n: Notice) => { c.notices.push(n); }, emitResponseMeta: (k: string, v: unknown) => { c.meta[k] = v; } } : {}),
  } as OperationContext;
}

const versions = (remote: boolean, params: Record<string, unknown>, c?: Captured) =>
  operationsByName.get_versions.handler(ctx(remote, c), params) as Promise<Array<Record<string, unknown>>>;

describe('get_versions defaults', () => {
  test('no params: the newest 20 versions, metadata only, for remote and local callers', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const remote of [true, false]) {
        const rows = await versions(remote, { slug: SLUG });
        expect(rows.map(r => r.title)).toEqual(Array.from({ length: 20 }, (_, i) => `title v${VERSIONS - i}`));
        for (const row of rows) {
          expect(Object.hasOwn(row, 'compiled_truth')).toBe(false);
          expect(Object.hasOwn(row, 'timeline')).toBe(false);
          expect(typeof row.id).toBe('number');
        }
      }
    } finally { err.mockRestore(); }
  });

  test('a cut history is reported: _meta.pagination and a listing_truncated notice whose fix widens to 100', async () => {
    const c = fresh();
    await versions(true, { slug: SLUG }, c);
    expect(c.meta.pagination).toEqual({ limit: 20, truncated: true });
    expect(c.notices).toHaveLength(1);
    expect(c.notices[0].code).toBe('listing_truncated');
    expect(c.notices[0].fix?.mcp).toEqual({ tool: 'get_versions', arguments: { slug: SLUG, limit: 100 } });
  });

  test('a complete history carries truncated: false and no notice', async () => {
    const c = fresh();
    expect(await versions(true, { slug: SHORT }, c)).toHaveLength(1);
    expect(c.meta.pagination).toEqual({ limit: 20, truncated: false });
    expect(c.notices).toEqual([]);
  });

  test('remote limit is capped at 100; the notice says one call cannot return more; local honors any explicit limit', async () => {
    const c = fresh();
    expect(await versions(true, { slug: SLUG, limit: 500 }, c)).toHaveLength(100);
    expect(c.meta.pagination).toEqual({ limit: 100, truncated: true, clamped_from: 500 });
    expect(c.notices[0].fix).toBeUndefined();
    expect(c.notices[0].why).toContain('limit 500 was capped at 100');
    expect(await versions(false, { slug: SLUG, limit: 500 })).toHaveLength(VERSIONS);
  });

  test('include_body: true returns bodies; remote bodies are sanitized, local bodies keep the takes fence', async () => {
    const [remote] = await versions(true, { slug: SLUG, include_body: true, limit: 1 });
    expect(remote.compiled_truth).toContain(`body v${VERSIONS}`);
    expect(remote.compiled_truth).not.toContain('private hunch');
    expect(remote.compiled_truth).not.toContain('gbrain:takes:begin');
    expect(remote.timeline).toBe(`timeline v${VERSIONS}`);
    const [local] = await versions(false, { slug: SLUG, include_body: true, limit: 1 });
    expect(local.compiled_truth).toContain('private hunch');
  });

  test('trusted local: a default-cut history writes one stderr line naming --limit; an explicit limit is silent', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = fresh();
      await versions(false, { slug: SLUG }, c);
      expect(c.notices).toEqual([]);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain('--limit');
      await versions(false, { slug: SLUG, limit: 5 });
      expect(err).toHaveBeenCalledTimes(1);
    } finally { err.mockRestore(); }
  });

  test('gbrain history renders metadata-only rows with the version title', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = formatResult('get_versions', await versions(false, { slug: SLUG, limit: 2 }), {});
      const lines = out.trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^#\d+ {2}\S.* {2}title v105$/);
    } finally { err.mockRestore(); }
  });
});

describe('get_versions metadata default never leaks a body', () => {
  test('an engine adapter that ignores includeBody still returns no body fields by default', async () => {
    const stub = { ...ctx(true), engine: Object.assign(Object.create(engine), {
      getVersions: async () => [{ id: 1, page_id: 1, title: 't', compiled_truth: `secret ${TAKES}`, timeline: 'tl', frontmatter: {}, snapshot_at: new Date() }],
    }) } as OperationContext;
    const [row] = await operationsByName.get_versions.handler(stub, { slug: SLUG }) as Array<Record<string, unknown>>;
    expect(Object.hasOwn(row, 'compiled_truth')).toBe(false);
    expect(Object.hasOwn(row, 'timeline')).toBe(false);
    expect(row.title).toBe('t');
  });
});

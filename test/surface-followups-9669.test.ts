/**
 * #9669 follow-ups on the starter surface.
 *
 * 1. Protects: request_tools {tools} describes a tool with only the parameters dispatch accepts on the caller's surface
 *    (a starter caller is not shown include_deleted, and keeps the reviewed exceptions such as cursor), and the
 *    listing_truncated fix for list_pages carries the caller's slug_prefix, where and source_ids filters, so the next
 *    page continues the filtered listing instead of the unfiltered one.
 * 2. Fails when: the descriptor names a parameter the caller's surface refuses, or a filtered listing's next-page call
 *    drops a filter.
 * 3. Real seams: dispatchToolCall over stdio on in-memory PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { allowedOpNames, createStdioSurfaceState, type McpSurface } from '../src/mcp/surface.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const stdio = (surface: McpSurface) => ({ remote: true, transport: 'stdio' as const, surface, allowedOps: allowedOpNames(operations, surface), sourceId: 'default' });

for (const kind of testBackends()) {
  describe(`starter descriptor and listing continuation (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const slug of ['notes/a-example', 'notes/b-example', 'notes/c-example', 'other/d-example']) {
        await engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: 'Example notes.', timeline: '', frontmatter: { status: 'active' } });
      }
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('request_tools describes only the parameters this surface may pass', async () => {
      const props = async (surface: McpSurface) => {
        const res = await dispatchToolCall(engine, 'request_tools', { tools: ['get_page'] }, stdio(surface));
        return Object.keys((JSON.parse(res.content[0]!.text) as { tools: Array<{ inputSchema: { properties: object } }> }).tools[0]!.inputSchema.properties);
      };
      const starter = await props('starter');
      expect(starter).not.toContain('include_deleted');
      expect(starter).not.toContain('include_quarantined');
      expect(starter).toContain('cursor');
      expect(starter).toContain('slug');
      expect(await props('full')).toContain('include_deleted');
    });

    test('request_tools {surface, tools} describes the tools on the surface the call just widened to', async () => {
      const session = createStdioSurfaceState(operations, { surface: 'starter', source: 'flag', readOnly: false });
      const res = await dispatchToolCall(engine, 'request_tools', { surface: 'full', tools: ['get_page'] }, {
        remote: true, transport: 'stdio', sourceId: 'default', ...(session.allowedOps ? { allowedOps: session.allowedOps } : {}),
        surface: session.surface, surfaceCeiling: session.surface, stdioSurface: session,
      });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0]!.text) as { tools: Array<{ inputSchema: { properties: object } }>; surface_change: { surface: string } };
      expect(body.surface_change.surface).toBe('full');
      expect(Object.keys(body.tools[0]!.inputSchema.properties)).toContain('include_deleted');
    });

    test('the listing_truncated fix keeps slug_prefix, where and source_ids', async () => {
      const args = { slug_prefix: 'notes/', where: { status: 'active' }, source_ids: ['default'], limit: 1 };
      const res = await dispatchToolCall(engine, 'list_pages', args, stdio('starter'));
      expect(res.isError).toBeFalsy();
      const notice = (res._meta?.gbrain_notices as Array<{ code: string; fix: { mcp: { arguments: Record<string, unknown> } } }>).find(n => n.code === 'listing_truncated')!;
      expect(notice.fix.mcp.arguments).toEqual({ ...args, offset: 1 });
      const next = await dispatchToolCall(engine, 'list_pages', notice.fix.mcp.arguments, stdio('starter'));
      const slugs = (JSON.parse(next.content[0]!.text) as Array<{ slug: string }>).map(row => row.slug);
      expect(slugs.length).toBe(1);
      expect(slugs[0]!.startsWith('notes/')).toBe(true);
    });
  });
}

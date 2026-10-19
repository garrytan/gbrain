/**
 * Protects source-qualified timeline reads across same-slug pages, including
 * grant/liveness refusals and unchanged unqualified reads. Dropping the
 * selector or its guards must fail these runtime assertions. Existing timeline
 * coverage exercises ambient scopes only. No production-only test seam is used.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { parseOpArgs, validateCommandFlags } from '../src/cli/main.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { TimelineEntry } from '../src/core/types.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const slug = 'notes/shared';
const timeline = operationsByName.get_timeline;
const page = operationsByName.get_page;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine, config: { engine: 'pglite' }, logger: console, dryRun: false, remote: true,
    sourceId: 'alpha',
    auth: { token: 'fixture', clientId: 'fixture', scopes: ['read'], allowedSources: ['alpha', 'beta'] },
    ...overrides,
  };
}

async function summaries(ctx: OperationContext, params: Record<string, unknown> = {}) {
  const rows = await timeline.handler(ctx, { slug, ...params }) as TimelineEntry[];
  return rows.map(row => row.summary);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  for (const sourceId of ['alpha', 'beta']) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [sourceId]);
    await engine.putPage(slug, { type: 'note', title: sourceId, compiled_truth: 'Fixture body' }, { sourceId });
    for (const [date, suffix] of [['2026-04-01', 'old'], ['2026-04-02', 'new']]) {
      await engine.addTimelineEntry(slug, { date, summary: `${sourceId}-${suffix}`, source: 'fixture', detail: '' }, { sourceId });
    }
  }
});

describe('get_timeline source_id', () => {
  test('pins the same concrete page as get_page across a federated grant', async () => {
    for (const sourceId of ['alpha', 'beta']) {
      const selected = await page.handler(ctxOf(), { slug, source_id: sourceId, include_timeline_entries: true }) as { timeline_entries: TimelineEntry[] };
      const entries = await timeline.handler(ctxOf(), { slug, source_id: sourceId }) as TimelineEntry[];
      expect(entries.map(row => row.id)).toEqual(selected.timeline_entries.map(row => row.id));
      expect(entries.map(row => row.summary)).toEqual([`${sourceId}-new`, `${sourceId}-old`]);
    }
  });

  test('keeps the federated union for __all__ and for an omitted selector', async () => {
    const expected = ['alpha-new', 'alpha-old', 'beta-new', 'beta-old'];
    expect((await summaries(ctxOf(), { source_id: '__all__' })).sort()).toEqual(expected);
    expect((await summaries(ctxOf())).sort()).toEqual(expected);
    expect(await summaries(ctxOf({ auth: { token: 'fixture', clientId: 'fixture', scopes: ['read'], allowedSources: ['alpha'] } }), { source_id: '__all__' }))
      .toEqual(['alpha-new', 'alpha-old']);
  });

  test('keeps the old scalar ambient scope even when the transport offers federation', async () => {
    const ctx = ctxOf({ auth: undefined, localFederatedSourceIds: ['alpha', 'beta'] });
    expect(await summaries(ctx)).toEqual(['alpha-new', 'alpha-old']);
    expect(await summaries(ctx, { source_id: 'beta' })).toEqual(['beta-new', 'beta-old']);
  });

  test('admits an explicit read from a bound stdio connection like get_page', async () => {
    const ctx = ctxOf({ auth: undefined, explicitReadBinding: {
      sourceId: 'alpha', via: 'GBRAIN_SOURCE', sourceIds: ['alpha', 'beta'], optedOut: [],
    } });
    expect(await summaries(ctx, { source_id: 'beta' })).toEqual(['beta-new', 'beta-old']);
  });

  test('applies date aliases and limits within the selected source', async () => {
    expect(await summaries(ctxOf(), { source_id: 'beta', since: '2026-04-01', until: '2026-04-01', limit: 1 }))
      .toEqual(['beta-old']);
    expect(await summaries(ctxOf(), { source_id: 'alpha', after: '2026-04-02', before: '2026-04-02', limit: 1 }))
      .toEqual(['alpha-new']);
  });

  test('refuses sources outside a remote grant before checking their liveness', async () => {
    const ctx = ctxOf({ auth: { token: 'fixture', clientId: 'fixture', scopes: ['read'], allowedSources: ['alpha'] } });
    await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'beta'");
    for (const sourceId of ['beta', 'missing']) {
      for (const op of [page, timeline]) {
        await expect(op.handler(ctx, { slug, source_id: sourceId })).rejects.toMatchObject({ code: 'permission_denied' });
      }
    }
  });

  test('refuses archived and removed explicit sources like get_page, locally and remotely', async () => {
    await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'beta'");
    for (const ctx of [ctxOf(), ctxOf({ remote: false, auth: undefined })]) {
      for (const op of [page, timeline]) {
        await expect(op.handler(ctx, { slug, source_id: 'beta' })).rejects.toMatchObject({ code: 'unknown_source' });
      }
    }
    await engine.executeRaw("DELETE FROM sources WHERE id = 'beta'");
    await expect(timeline.handler(ctxOf(), { slug, source_id: 'beta' })).rejects.toMatchObject({ code: 'unknown_source' });
  });

  test('rejects malformed selectors instead of ignoring them', async () => {
    for (const sourceId of ['', 'INVALID', '../beta', 7]) {
      await expect(timeline.handler(ctxOf(), { slug, source_id: sourceId })).rejects.toMatchObject({ code: 'invalid_params' });
    }
  });

  test('keeps private and missing timelines empty with an explicit live source', async () => {
    await engine.executeRaw("UPDATE pages SET frontmatter = '{\"visibility\":\"private\"}'::jsonb WHERE source_id = 'beta'");
    expect(await summaries(ctxOf(), { source_id: 'beta' })).toEqual([]);
    expect(await summaries(ctxOf({ remote: false, auth: undefined }), { source_id: 'beta' })).toEqual(['beta-new', 'beta-old']);
    for (const params of [{}, { source_id: 'alpha' }, { source_id: '__all__' }]) {
      expect(await timeline.handler(ctxOf(), { slug: 'notes/absent', ...params })).toEqual([]);
    }
  });

  test('the CLI selector and MCP dispatch return only the requested source', async () => {
    const args = [slug, '--source-id', 'beta'];
    expect(validateCommandFlags('timeline', args)).toBeNull();
    const params = parseOpArgs(timeline, args);
    expect(params).toEqual({ slug, source_id: 'beta' });
    const result = await dispatchToolCall(engine, 'get_timeline', params, { remote: true, sourceId: 'alpha', localFederatedSourceIds: ['alpha', 'beta'] });
    expect(result.isError).not.toBe(true);
    expect((JSON.parse(result.content[0].text) as TimelineEntry[]).map(row => row.summary)).toEqual(['beta-new', 'beta-old']);
  });
});

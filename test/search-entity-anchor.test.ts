/**
 * Entity-anchored retrieval (search/entity-anchor.ts, `search.entity_anchoring`):
 * deterministic detection (current-state cue + exactly one named entity),
 * anchored order (entity page, then linking/naming pages newest first), the
 * row-count and token-budget contract, read safety for remote callers, and
 * the off path. PGLite, keyword-only, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { applyEntityAnchoring, asksForCurrentState, entityAnchoringEnabled, namedEntity, ENTITY_ANCHORING_KEY } from '../src/core/search/entity-anchor.ts';
import type { SearchResult } from '../src/core/types.ts';
import { localCtx, newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

let engine: PGLiteEngine;
let sourceId: string;
const Q = 'Which city does acme-example build widgets in now?';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  await putPage(engine, sourceId, 'companies/acme-example', page('company', 'acme-example', 'acme-example builds widgets in Lisbon.'));
  await putPage(engine, sourceId, 'companies/beta-example', page('company', 'beta-example', 'beta-example builds widgets in Porto.'));
  await putPage(engine, sourceId, 'companies/acme-example-labs', page('company', 'acme-example labs', 'acme-example labs builds gadgets.', 'date: 2026-01-01\n'));
  for (let i = 1; i <= 8; i++) {
    const day = String(i).padStart(2, '0');
    await putPage(engine, sourceId, `notes/acme-update-${i}`, page('note', `update ${i}`, `As of 2026-03-${day}, acme-example builds widgets in City${i}. Widgets and cities and widgets.`, `date: 2026-03-${day}\n`));
  }
  await putPage(engine, sourceId, 'notes/acme-update-9', page('note', 'update 9', 'As of 2026-03-20, acme-example builds widgets in Secretville.', 'date: 2026-03-20\nvisibility: private\n'));
  for (let i = 1; i <= 12; i++) await putPage(engine, sourceId, `notes/widget-chatter-${i}`, page('note', `chatter ${i}`, `Which city builds widgets now? Widgets widgets widgets city ${i}.`));
}, 120_000);

afterAll(async () => { await engine?.disconnect(); }, 60_000);

const query = async (params: Record<string, unknown>) => await handleToolCall(engine, 'query', { query: Q, expand: false, use_cache: false, source_id: sourceId, ...params }) as SearchResult[];

describe('detection', () => {
  test('current-state cues', () => {
    for (const q of ['Where is acme-example based now?', 'What is the latest on acme-example?', 'Who currently leads acme-example?', 'Is acme-example still in Lisbon?']) expect(asksForCurrentState(q)).toBe(true);
    for (const q of ['Where was acme-example founded?', 'acme-example widgets', 'Nowhere near acme-example']) expect(asksForCurrentState(q)).toBe(false);
  });

  test('exactly one named entity page; a title inside a longer matched title is the same mention', async () => {
    expect((await namedEntity(engine, Q, { sourceId }))?.slug).toBe('companies/acme-example');
    expect((await namedEntity(engine, 'What does acme-example labs build now?', { sourceId }))?.slug).toBe('companies/acme-example-labs');
    expect(await namedEntity(engine, 'Do acme-example and beta-example build widgets now?', { sourceId })).toBeNull();
    expect(await namedEntity(engine, 'Which city builds widgets now?', { sourceId })).toBeNull();
  });
});

describe('query with search.entity_anchoring', () => {
  test('off (unset or false): no row is anchored and the rows are the same', async () => {
    expect(await entityAnchoringEnabled(engine)).toBe(false);
    const unset = await query({ limit: 8 });
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'false');
    const off = await query({ limit: 8 });
    expect(JSON.stringify(off)).toBe(JSON.stringify(unset));
    expect(unset.some(r => r.entity_anchored)).toBe(false);
  });

  test('on: the entity page, then the newest naming pages, within the same row count', async () => {
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'false');
    const off = await query({ limit: 8 });
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'true');
    const on = await query({ limit: 8 });
    expect(on).toHaveLength(off.length);
    expect(on.slice(0, 4).map(r => [r.slug, r.entity_anchored])).toEqual([
      ['companies/acme-example', 'entity'], ['notes/acme-update-9', 'linked'], ['notes/acme-update-8', 'linked'], ['notes/acme-update-7', 'linked']]);
    expect(on.filter(r => r.entity_anchored)).toHaveLength(Math.ceil(off.length / 2));
    expect(new Set(on.map(r => r.page_id)).size).toBe(on.length);
    for (let i = 1; i < on.length; i++) expect(on[i]!.score).toBeLessThanOrEqual(on[i - 1]!.score);
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'false');
  });

  test('on: the token budget still holds', async () => {
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'true');
    const on = await query({ limit: 8, token_budget: 60 });
    const used = on.reduce((n, r) => n + Math.ceil(((r.title ?? '').length + r.chunk_text.length) / 4), 0);
    expect(on.length).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(80);
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'false');
  });

  test('on: skipped with offset or a type filter', async () => {
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'true');
    expect((await query({ limit: 4, offset: 2 })).some(r => r.entity_anchored)).toBe(false);
    expect((await query({ limit: 4, types: ['note'] })).some(r => r.entity_anchored)).toBe(false);
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'false');
  });

  test('on, remote caller: a private page is never anchored in; search shares the path', async () => {
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'true');
    const auth = { token: 't', clientId: 'anchor-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] };
    for (const tool of ['query', 'search']) {
      const r = await dispatchToolCall(engine, tool, { query: Q, limit: 8, expand: false }, { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
      const text = r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
      expect(text).not.toContain('Secretville');
      expect(text).not.toContain('acme-update-9');
      expect(text).toContain('acme-update-8');
    }
    await engine.setConfig(ENTITY_ANCHORING_KEY, 'false');
  });

  test('a query that names no entity or asks no current state is unchanged', async () => {
    const organic = await query({ limit: 6 });
    const ctx = localCtx(engine, sourceId);
    for (const q of ['Which city builds widgets now?', 'Where was acme-example founded?']) {
      const out = await applyEntityAnchoring(ctx.engine, q, organic, { sourceId });
      expect(out.results).toBe(organic);
      expect(out.anchored).toBe(0);
    }
  });
});

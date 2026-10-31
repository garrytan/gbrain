/**
 * GST-359 item S: per-request `source_ids` on `recall` and `list_pages`.
 *
 * 1. Protects: an agent that narrows each call to the sources the asking
 *    member may read (#7481's `source_ids`) gets that narrowing on recall and
 *    list_pages too. The HARN-12 v0.3 pilot's told-scoped cells measured the
 *    gap: under a per-request scope, recall returned another member's DM page
 *    (2 events) and list_pages returned 57 pages outside the grant (3 events),
 *    because both ops ignored the list.
 * 2. Fails when: either op drops `source_ids`, any recall arm (question
 *    ranking, since, entity, session, the page-search arm) reads past the
 *    narrowed scope, an id outside a remote grant is not refused, or an empty
 *    intersection with `source_id` falls back to the ambient or full scope.
 * 3. search and query are pinned by test/search/search-source-ids.test.ts.
 * 4. No production seam: keyless brains (keyword arms only), as the harness runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { testBackends } from './helpers/test-backends.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { allowedOpNames } from '../src/mcp/surface.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { operations } from '../src/core/operations.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const CANARY = 'canarybravo';
const GRANTED_A = { token: 'gbrain_at_test', clientId: 'gbrain_cl_test', scopes: ['read'], allowedSources: ['source-a'] };
const GRANTED_ABC = { ...GRANTED_A, allowedSources: ['source-a', 'source-b', 'source-c'] };

for (const kind of testBackends()) {
  describe(`recall/list_pages source_ids (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    async function run(op: 'recall' | 'list_pages', params: Record<string, unknown>, ctxOver: Partial<OperationContext> = {}) {
      const notices: Array<{ code: string; why: string }> = [];
      const ctx = {
        engine, config: { engine: kind, embedding_disabled: true }, dryRun: false, remote: true, sourceId: 'source-a',
        auth: GRANTED_ABC,
        logger: { info() {}, warn() {}, error() {} },
        emitResponseMeta: () => {},
        emitNotice: (n: { code: string; why: string }) => { notices.push(n); },
        ...ctxOver,
      } as unknown as OperationContext;
      const out = await operationsByName[op].handler(ctx, params);
      return { out, wire: JSON.stringify(out), notices };
    }

    async function refusal(promise: Promise<unknown>): Promise<string> {
      try { await promise; } catch (e) { return (e as { code?: string }).code ?? String(e); }
      return 'no_error';
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const id of ['source-a', 'source-b', 'source-c']) {
        await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id]);
      }
      const pages: Array<[string, string, string]> = [
        ['source-a', 'chats/orchard-alpha', '# Zephyrblatt orchard\nZephyrblatt orchard harvest notes for the alpha team.'],
        ['source-b', 'chats/orchard-bravo', `# Zephyrblatt orchard\nZephyrblatt orchard harvest notes ${CANARY}.`],
        ['source-c', 'chats/orchard-charlie', '# Zephyrblatt orchard\nZephyrblatt orchard harvest notes for the charlie team.'],
      ];
      for (const [sourceId, slug, body] of pages) await importFromContent(engine, slug, body, { sourceId });
      const fact = (text: string, sourceId: string) => engine.insertFact({ fact: text, kind: 'fact', entity_slug: 'zephyrblatt-orchard', source: 'notes', visibility: 'world', valid_from: new Date('2026-07-01T00:00:00Z') }, { source_id: sourceId });
      await fact('Zephyrblatt orchard harvest moved to May for the alpha team.', 'source-a');
      await fact(`Zephyrblatt orchard harvest moved to June ${CANARY}.`, 'source-b');
    }, 180_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('the op contracts carry source_ids', () => {
      for (const op of ['recall', 'list_pages'] as const) {
        expect(operationsByName[op].params.source_ids).toMatchObject({ type: 'array', items: { type: 'string' } });
      }
    });

    test('fixture control: an unnarrowed read reaches source-b on both ops', async () => {
      expect((await run('recall', { question: 'zephyrblatt orchard harvest', query: 'zephyrblatt orchard harvest' })).wire).toContain(CANARY);
      expect((await run('list_pages', {})).wire).toContain('chats/orchard-bravo');
    });

    const recallShapes: Array<[string, Record<string, unknown>]> = [
      ['question ranking and the page arm', { question: 'zephyrblatt orchard harvest', query: 'zephyrblatt orchard harvest' }],
      ['since', { since: '2020-01-01T00:00:00Z' }],
      ['entity', { entity: 'zephyrblatt-orchard' }],
      ['page arm alone', { query: 'zephyrblatt orchard harvest' }],
    ];
    for (const [label, params] of recallShapes) {
      test(`recall (${label}): narrowing to source-a returns nothing from source-b or source-c`, async () => {
        const { wire } = await run('recall', { ...params, source_ids: ['source-a'] });
        expect(wire).not.toContain(CANARY);
        expect(wire).not.toContain('"source_id":"source-b"');
        expect(wire).not.toContain('charlie');
      });
    }

    test('recall: narrowing still returns source-a rows (the list narrows, it does not blank)', async () => {
      const { wire } = await run('recall', { question: 'zephyrblatt orchard harvest', query: 'zephyrblatt orchard harvest', source_ids: ['source-a'] });
      expect(wire).toContain('alpha team');
    });

    test('list_pages: narrowing to source-a and source-c lists exactly those sources', async () => {
      const { out, wire } = await run('list_pages', { source_ids: ['source-a', 'source-c'] });
      const rows = (Array.isArray(out) ? out : (out as { pages: unknown[] }).pages) as Array<{ slug: string; source_id: string }>;
      expect(rows.map(r => r.slug).sort()).toEqual(['chats/orchard-alpha', 'chats/orchard-charlie']);
      expect(wire).not.toContain('orchard-bravo');
    });

    test('an id outside a remote grant is refused on both ops, before any row is read', async () => {
      expect(await refusal(run('list_pages', { source_ids: ['source-b'] }, { auth: GRANTED_A } as never))).toBe('permission_denied');
      expect(await refusal(run('recall', { query: 'zephyrblatt', source_ids: ['source-b'] }, { auth: GRANTED_A } as never))).toBe('scope_denied');
    });

    test('an empty intersection with source_id reads no source on both ops', async () => {
      const list = await run('list_pages', { source_id: 'source-a', source_ids: ['source-c'] });
      expect(list.wire).not.toContain('orchard-');
      expect(list.notices.map(n => n.code)).toContain('empty_retrieval');
      const recall = await run('recall', { question: 'zephyrblatt orchard harvest', query: 'zephyrblatt orchard harvest', source_id: 'source-a', source_ids: ['source-c'] });
      expect(recall.wire).not.toContain('Zephyrblatt');
      expect(recall.notices.map(n => n.code)).toContain('empty_retrieval');
    });

    for (const extra of [{ supersessions: true }, { session_id: 's1' }, { include_pending: true, query: 'zephyrblatt', entity: 'zephyrblatt-orchard' }]) {
      test(`recall ${JSON.stringify(extra)}: an empty intersection reads nothing`, async () => {
        const { wire } = await run('recall', { ...extra, source_id: 'source-a', source_ids: ['source-c'] });
        expect(wire).not.toContain('Zephyrblatt');
        expect(wire).not.toContain(CANARY);
      });
    }

    describe('through dispatch on the starter surface', () => {
      const call = (name: string, args: Record<string, unknown>) => dispatchToolCall(engine, name, args, {
        remote: true, transport: 'http', sourceId: 'source-a', auth: GRANTED_ABC as never, surface: 'starter',
        allowedOps: allowedOpNames(operations as never, 'starter'), config: { engine: kind, embedding_disabled: true } as never,
        metaHook: getBrainHotMemoryMeta,
      } as never) as Promise<{ isError?: boolean; content: Array<{ text: string }>; _meta?: Record<string, unknown> }>;

      test('the hidden source_ids param still narrows recall and list_pages', async () => {
        const list = await call('list_pages', { source_ids: ['source-b'] });
        expect(list.content[0].text).toContain('chats/orchard-bravo');
        expect(list.content[0].text).not.toContain('orchard-alpha');
        const recall = await call('recall', { query: 'zephyrblatt orchard harvest', source_ids: ['source-b'] });
        expect(recall.content[0].text).toContain(CANARY);
        expect(recall.content[0].text).not.toContain('alpha team');
      });

      test('a call that names sources gets no ambient-source hot memory', async () => {
        __resetHotMemoryCacheForTests();
        const control = await call('list_pages', {});
        expect(JSON.stringify(control._meta?.brain_hot_memory ?? null)).toContain('alpha team');
        for (const [name, args] of [['list_pages', { source_ids: ['source-b'] }], ['search', { query: 'zephyrblatt', source_ids: ['source-b'] }], ['list_pages', { source_id: 'source-b' }]] as const) {
          const out = await call(name, args);
          expect(out.isError ?? false).toBe(false);
          expect(out._meta?.brain_hot_memory).toBeUndefined();
          expect(JSON.stringify(out)).not.toContain('alpha team');
        }
      });
    });

    test('an empty array behaves exactly like omitting it', async () => {
      const omitted = (await run('list_pages', {})).wire;
      expect((await run('list_pages', { source_ids: [] })).wire).toBe(omitted);
    });
  });
}

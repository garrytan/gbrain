/**
 * GBRA-156 item 3: per-request `source_ids` on the `search` and `query` ops.
 *
 * 1. Protects: a shared brain (one brain, several sources) lets an agent
 *    acting for one member narrow a single search/query to the sources that
 *    member may see. The request reads the intersection of `source_ids` and
 *    the caller's readable sources; each id is authorized exactly as an
 *    explicit `source_id` is (out-of-grant ids refuse with permission_denied
 *    for remote callers, non-live ids refuse with unknown_source). An empty
 *    list or blank string is absent (#5390); a non-empty list whose
 *    intersection with `source_id` is empty searches nothing.
 * 2. Fails when: the param is dropped or unknown (local callers read every
 *    source), any arm (keyword, vector, title, alias fan-out, entity
 *    anchoring, facts arm, saved facts, CRAG re-run, think escalation,
 *    evidence delivery, keyword paging) reads past the narrowed scope, an
 *    empty intersection falls back to the ambient or full scope, or an empty
 *    list stops behaving like an omitted one.
 * 3. Existing coverage pins only the scalar `source_id` (search-op-source-id).
 * 4. No production seam: the gateway embed transport stub and an engine proxy
 *    that records each search call's scope.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { parseOpArgs } from '../../src/cli/main.ts';
import * as think from '../../src/core/think/index.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const DIMS = 1536;
const CANARY = 'canarybravo';

function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

type Call = { method: string; opts: Record<string, unknown> | undefined };
type Outcome = { rows: Array<Record<string, unknown>>; meta: Record<string, unknown>; notices: Array<{ code: string; why: string }>; calls: Call[] };

const GRANTED_A = { token: 'gbrain_at_test', clientId: 'gbrain_cl_test', scopes: ['read'], allowedSources: ['source-a'] };
const GRANTED_AB = { ...GRANTED_A, allowedSources: ['source-a', 'source-b'] };

for (const kind of testBackends()) {
  describe(`search/query source_ids (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    /** Every engine search call the op makes, with the scope it passed. */
    function recording(calls: Call[]): BrainEngine {
      return new Proxy(engine, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          if (typeof key === 'string' && /^search/.test(key)) {
            return (...args: unknown[]) => {
              calls.push({ method: key, opts: args.find(a => a !== null && typeof a === 'object' && !(a instanceof Float32Array) && !Array.isArray(a)) as Record<string, unknown> | undefined });
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value.bind(target);
        },
      });
    }

    async function run(op: 'search' | 'query', params: Record<string, unknown>, ctxOver: Partial<OperationContext> = {}): Promise<Outcome> {
      const calls: Call[] = [];
      const meta: Record<string, unknown> = {};
      const notices: Array<{ code: string; why: string }> = [];
      const ctx = {
        engine: recording(calls), config: { engine: kind }, dryRun: false, remote: false, sourceId: 'source-a',
        localFederatedSourceIds: ['source-a', 'source-b', 'source-c'],
        logger: { info() {}, warn() {}, error() {} },
        emitResponseMeta: (k: string, v: unknown) => { meta[k] = v; },
        emitNotice: (n: { code: string; why: string }) => { notices.push(n); },
        ...ctxOver,
      } as unknown as OperationContext;
      const rows = await operationsByName[op].handler(ctx, op === 'query' ? { expand: false, ...params } : params) as Array<Record<string, unknown>>;
      return { rows, meta, notices, calls };
    }

    /** No source-b page, fact or text anywhere in the rows or the response meta, and every engine search call scoped inside `allowed`. */
    function expectNoSourceB(out: Outcome, allowed: string[] = ['source-a']): void {
      const wire = JSON.stringify({ rows: out.rows, meta: out.meta, notices: out.notices });
      expect(wire).not.toContain(CANARY);
      expect(wire).not.toContain('"source_id":"source-b"');
      for (const r of out.rows) expect(String(r.slug ?? r.page_slug ?? '')).not.toContain('bravo');
      for (const c of out.calls) {
        const ids = c.opts?.sourceIds as string[] | undefined;
        const id = c.opts?.sourceId as string | undefined;
        expect({ method: c.method, scoped: ids !== undefined || id !== undefined }).toEqual({ method: c.method, scoped: true });
        for (const s of ids ?? [id!]) expect(allowed).toContain(s);
      }
    }

    function slugs(out: Outcome): string[] {
      return out.rows.map(r => String(r.slug ?? r.page_slug ?? ''));
    }

    async function refusal(promise: Promise<unknown>): Promise<string> {
      try {
        await promise;
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
      return 'no_error';
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const id of ['source-a', 'source-b', 'source-c']) {
        await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id]);
      }
      await engine.executeRaw(`INSERT INTO sources (id, name, archived) VALUES ('source-gone', 'source-gone', true) ON CONFLICT (id) DO NOTHING`);
      const pages: Array<[string, string, string]> = [
        ['source-a', 'notes/orchard-alpha', '# Zephyrblatt orchard\nZephyrblatt orchard harvest notes for the alpha team.'],
        ['source-b', 'notes/orchard-bravo', `# Zephyrblatt orchard\nZephyrblatt orchard harvest notes ${CANARY}.`],
        ['source-b', 'notes/zephyrblatt-orchard-harvest-bravo', `# Zephyrblatt Orchard Harvest\nThe ${CANARY} harvest ledger.`],
        ['source-c', 'notes/orchard-charlie', '# Zephyrblatt orchard\nZephyrblatt orchard harvest notes for the charlie team.'],
        ['source-a', 'companies/acme-example', '# Customer: Acme Example\nAcme Example renewal terms. Account code: ZORBIX.'],
        ['source-a', 'notes/zorbix-alpha', '# Amendment alpha\nZORBIX renewal amendment for the alpha team.'],
        ['source-b', 'notes/zorbix-bravo', `# Amendment\nZORBIX renewal amendment ${CANARY}.`],
      ];
      for (const [sourceId, slug, body] of pages) await importFromContent(engine, slug, body, { sourceId });
      const fact = (text: string, sourceId: string) => engine.insertFact({ fact: text, kind: 'fact', entity_slug: 'zephyrblatt-orchard', source: 'notes', visibility: 'world', valid_from: new Date('2026-07-01T00:00:00Z') }, { source_id: sourceId });
      await fact('Zephyrblatt orchard harvest moved to May for the alpha team.', 'source-a');
      await fact(`Zephyrblatt orchard harvest moved to June ${CANARY}.`, 'source-b');
    }, 180_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('the op contracts carry source_ids', () => {
      for (const op of ['search', 'query'] as const) {
        expect(operationsByName[op].params.source_ids).toMatchObject({ type: 'array', items: { type: 'string' } });
      }
    });

    test('the CLI maps --source-ids to the array on both commands', () => {
      for (const op of ['search', 'query'] as const) {
        expect(parseOpArgs(operationsByName[op], ['zephyrblatt orchard', '--source-ids', 'source-a, source-b']).source_ids).toEqual(['source-a', 'source-b']);
      }
    });

    test('fixture control: an unnarrowed local read reaches source-b in every arm under test', async () => {
      const search = await run('search', { query: 'zephyrblatt orchard harvest', source_id: '__all__' });
      expect(slugs(search)).toContain('notes/orchard-bravo');
      const query = await run('query', { query: 'zephyrblatt orchard harvest', source_id: '__all__' });
      expect(JSON.stringify(query.rows)).toContain(CANARY);
      const fanout = await run('query', { query: 'Acme Example renewal', source_id: '__all__' });
      expect(slugs(fanout)).toContain('notes/zorbix-bravo');
      expect((fanout.meta.retrieval as { fanout?: { aliases_searched: Array<{ alias: string }> } }).fanout?.aliases_searched.map(a => a.alias)).toEqual(['ZORBIX']);
    });

    describe('local trusted caller', () => {
      for (const op of ['search', 'query'] as const) {
        test(`${op}: narrowing to one source returns zero cross-source pages`, async () => {
          const out = await run(op, { query: 'zephyrblatt orchard harvest', source_ids: ['source-a'] });
          expect(slugs(out)).toContain('notes/orchard-alpha');
          expectNoSourceB(out);
          expect(JSON.stringify(out.rows)).not.toContain('charlie');
        });

        test(`${op}: narrowing to two sources reads both and nothing else`, async () => {
          const out = await run(op, { query: 'zephyrblatt orchard harvest', source_ids: ['source-a', 'source-c'] });
          expect(slugs(out)).toEqual(expect.arrayContaining(['notes/orchard-alpha', 'notes/orchard-charlie']));
          expectNoSourceB(out, ['source-a', 'source-c']);
        });

        test(`${op}: the alias fan-out stays inside the narrowed scope`, async () => {
          const out = await run(op, { query: 'Acme Example renewal', source_ids: ['source-a'] });
          expect(slugs(out)).toContain('notes/zorbix-alpha');
          expect((out.meta.retrieval as { fanout?: { aliases_searched: Array<{ alias: string }> } }).fanout?.aliases_searched.map(a => a.alias)).toEqual(['ZORBIX']);
          expectNoSourceB(out);
        });

        test(`${op}: an empty array or blank string behaves exactly like omitting it`, async () => {
          const omitted = slugs(await run(op, { query: 'zephyrblatt orchard harvest' })).sort();
          expect(omitted).toEqual(expect.arrayContaining(['notes/orchard-alpha', 'notes/orchard-bravo', 'notes/orchard-charlie']));
          for (const sourceIds of [[], '', '  ']) {
            const out = await run(op, { query: 'zephyrblatt orchard harvest', source_ids: sourceIds });
            expect(slugs(out).sort()).toEqual(omitted);
            expect(out.notices.map(n => n.code)).not.toContain('empty_retrieval');
          }
        });

        test(`${op}: source_id intersects source_ids (disjoint pair searches nothing)`, async () => {
          const both = await run(op, { query: 'zephyrblatt orchard harvest', source_id: 'source-c', source_ids: ['source-a', 'source-c'] });
          expect(slugs(both)).toContain('notes/orchard-charlie');
          expect(slugs(both)).not.toContain('notes/orchard-alpha');
          expectNoSourceB(both, ['source-c']);
          const disjoint = await run(op, { query: 'zephyrblatt orchard harvest', source_id: 'source-b', source_ids: ['source-a'] });
          expect(disjoint.rows).toEqual([]);
          expect(disjoint.calls).toEqual([]);
          expect(disjoint.notices.map(n => n.code)).toContain('empty_retrieval');
          const all = await run(op, { query: 'zephyrblatt orchard harvest', source_id: '__all__', source_ids: ['source-a'] });
          expectNoSourceB(all);
        });

        test(`${op}: unknown, archived and malformed ids refuse`, async () => {
          expect(await refusal(run(op, { query: 'zephyrblatt', source_ids: ['source-a', 'source-missing'] }))).toBe('unknown_source');
          expect(await refusal(run(op, { query: 'zephyrblatt', source_ids: ['source-gone'] }))).toBe('unknown_source');
          expect(await refusal(run(op, { query: 'zephyrblatt', source_ids: ['Source-A'] }))).toBe('invalid_params');
          expect(await refusal(run(op, { query: 'zephyrblatt', source_ids: ['__all__'] }))).toBe('invalid_params');
          expect(await refusal(run(op, { query: 'zephyrblatt', source_ids: 'source-a' }))).toBe('invalid_params');
          expect(await refusal(run(op, { query: 'zephyrblatt', source_ids: [7] }))).toBe('invalid_params');
          expect(await refusal(run(op, { query: 'zephyrblatt', source_ids: [''] }))).toBe('invalid_params');
          expect(await refusal(run(op, { query: 'zephyrblatt', source_ids: ',' }))).toBe('invalid_params');
        });
      }

      test('search: keyword paging and the keyword-only opt-out honor the narrowed scope', async () => {
        expectNoSourceB(await run('search', { query: 'zephyrblatt orchard', match: 'keyword', source_ids: ['source-a'] }));
        await engine.setConfig('search.mcp_keyword_only', 'true');
        try {
          const out = await run('search', { query: 'zephyrblatt orchard', source_ids: ['source-a'] });
          expect(slugs(out)).toContain('notes/orchard-alpha');
          expectNoSourceB(out);
        } finally {
          await engine.setConfig('search.mcp_keyword_only', 'false');
        }
      });

      test('query: entity anchoring, evidence delivery and the facts arm honor the narrowed scope', async () => {
        await engine.setConfig('search.entity_anchoring', 'true');
        try {
          for (const params of [{}, { return_unit: 'page' }, { return_unit: 'window' }, { detail: 'high' }]) {
            const out = await run('query', { query: 'zephyrblatt orchard harvest', source_ids: ['source-a'], ...params });
            expect(slugs(out)).toContain('notes/orchard-alpha');
            expectNoSourceB(out);
          }
        } finally {
          await engine.setConfig('search.entity_anchoring', 'false');
        }
      });

      test('query: the CRAG re-run and think escalation read the narrowed scope', async () => {
        await engine.setConfig('search.crag_escalation', 'true');
        await engine.setConfig('search.crag_think', 'true');
        const thinkCalls: Array<Record<string, unknown>> = [];
        const spy = spyOn(think, 'runThink').mockImplementation((async (_engine: unknown, opts: Record<string, unknown>) => {
          thinkCalls.push(opts);
          return { answer: 'stub', citations: [], modelUsed: 'stub' };
        }) as never);
        try {
          const out = await run('query', { query: 'zxqv nonexistent quux', source_ids: ['source-a'] });
          const crag = (out.meta.retrieval as { crag?: { escalated?: boolean } }).crag;
          expect(crag?.escalated).toBe(true);
          expect(out.calls.filter(c => c.method === 'searchKeyword').length).toBeGreaterThan(1);
          expectNoSourceB(out);
          expect(thinkCalls).toHaveLength(1);
          expect(thinkCalls[0]!.allowedSources).toEqual(['source-a']);
          expect(thinkCalls[0]!.sourceId).toBeUndefined();
        } finally {
          spy.mockRestore();
          await engine.setConfig('search.crag_escalation', 'false');
          await engine.setConfig('search.crag_think', 'false');
        }
      }, 60_000);
    });

    describe('remote token narrowing inside its grant', () => {
      for (const op of ['search', 'query'] as const) {
        test(`${op}: a token granted source-a and source-b narrows to source-a`, async () => {
          const out = await run(op, { query: 'zephyrblatt orchard harvest', source_ids: ['source-a'], fields: 'full' }, { remote: true, auth: GRANTED_AB as never });
          expect(slugs(out)).toContain('notes/orchard-alpha');
          expectNoSourceB(out);
        });
      }
    });

    describe('adversarial widening: a token granted source-a only', () => {
      const remote = { remote: true, auth: GRANTED_A as never };
      const refused: Array<[string, Record<string, unknown>, string]> = [
        ['source-a plus source-b', { source_ids: ['source-a', 'source-b'] }, 'permission_denied'],
        ['source-b alone', { source_ids: ['source-b'] }, 'permission_denied'],
        ['the __all__ sentinel', { source_ids: ['__all__'] }, 'invalid_params'],
        ['source-b with a duplicate source-a', { source_ids: ['source-a', 'source-b', 'source-a'] }, 'permission_denied'],
        ['an upper-case variant', { source_ids: ['SOURCE-B'] }, 'invalid_params'],
        ['a whitespace variant', { source_ids: [' source-b '] }, 'permission_denied'],
        ['an embedded-space variant', { source_ids: ['source -b'] }, 'invalid_params'],
        ['source_id source-b with source_ids source-a', { source_id: 'source-b', source_ids: ['source-a'] }, 'permission_denied'],
        ['source_id source-a with source_ids source-b', { source_id: 'source-a', source_ids: ['source-b'] }, 'permission_denied'],
        ['source_id __all__ with source_ids source-b', { source_id: '__all__', source_ids: ['source-b'] }, 'permission_denied'],
      ];
      for (const op of ['search', 'query'] as const) {
        for (const [label, params, code] of refused) {
          test(`${op}: ${label} is refused (${code})`, async () => {
            expect(await refusal(run(op, { query: 'zephyrblatt orchard harvest', ...params }, remote))).toBe(code);
          });
        }

        const allowed: Array<[string, Record<string, unknown>]> = [
          ['duplicates of source-a', { source_ids: ['source-a', 'source-a'] }],
          ['a whitespace variant of source-a', { source_ids: [' source-a '] }],
          ['source_id __all__ with source_ids source-a', { source_id: '__all__', source_ids: ['source-a'] }],
          ['source_id source-a with source_ids source-a', { source_id: 'source-a', source_ids: ['source-a'] }],
        ];
        for (const [label, params] of allowed) {
          test(`${op}: ${label} reads source-a only`, async () => {
            const out = await run(op, { query: 'zephyrblatt orchard harvest', fields: 'full', ...params }, remote);
            expect(slugs(out)).toContain('notes/orchard-alpha');
            expectNoSourceB(out);
          });
        }

        test(`${op}: an empty array or blank string reads the grant, exactly like omitting it`, async () => {
          const omitted = await run(op, { query: 'zephyrblatt orchard harvest', fields: 'full' }, remote);
          expect(slugs(omitted)).toContain('notes/orchard-alpha');
          expectNoSourceB(omitted);
          for (const sourceIds of [[], '']) {
            const out = await run(op, { query: 'zephyrblatt orchard harvest', fields: 'full', source_ids: sourceIds }, remote);
            expect(slugs(out).sort()).toEqual(slugs(omitted).sort());
            expectNoSourceB(out);
          }
        });

        test(`${op}: the alias fan-out cannot reach source-b`, async () => {
          expectNoSourceB(await run(op, { query: 'Acme Example renewal', source_ids: ['source-a'], fields: 'full' }, remote));
        });
      }

      test('query: the CRAG re-run cannot reach source-b', async () => {
        await engine.setConfig('search.crag_escalation', 'true');
        try {
          const out = await run('query', { query: 'zxqv nonexistent quux', source_ids: ['source-a'] }, remote);
          expect((out.meta.retrieval as { crag?: { escalated?: boolean } }).crag?.escalated).toBe(true);
          expectNoSourceB(out);
        } finally {
          await engine.setConfig('search.crag_escalation', 'false');
        }
      }, 60_000);

      test('query: anchoring, evidence delivery and the facts arm cannot reach source-b', async () => {
        await engine.setConfig('search.entity_anchoring', 'true');
        try {
          for (const params of [{}, { return_unit: 'page' }, { return_unit: 'window' }]) {
            expectNoSourceB(await run('query', { query: 'zephyrblatt orchard harvest', source_ids: ['source-a'], fields: 'full', ...params }, remote));
          }
        } finally {
          await engine.setConfig('search.entity_anchoring', 'false');
        }
      });

      test('search: keyword paging cannot reach source-b', async () => {
        expectNoSourceB(await run('search', { query: 'zephyrblatt orchard', match: 'keyword', source_ids: ['source-a'], fields: 'full' }, remote));
      });
    });
  });
}

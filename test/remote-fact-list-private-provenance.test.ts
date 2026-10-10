/**
 * Remote fact-list reads follow the page-visibility policy on the provenance
 * page (#4352 class). A `visibility = 'world'` fact whose
 * `source_markdown_slug` page is `visibility: private` stays out of every
 * untrusted fact-list read: recall (entity, since, session, supersessions,
 * no filter), the entity card, delta, hot memory, find_trajectory, think's
 * trajectory block and get_write_attribution. Trusted local callers
 * (`remote: false`) see exactly the rows they saw before, and the operator
 * opt-out (`search.remote_private_pages=visible`) restores the old remote view.
 *
 * Both engines: PGLite always, Postgres through
 * test/e2e/remote-fact-list-private-provenance-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { REMOTE_PRIVATE_PAGES_KEY, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { runThink, type ThinkLLMClient } from '../src/core/think/index.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const ENTITY = 'people/alice-example';
const SESSION = 'sess-provenance';
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Sorted unique fact markers in a payload: every fact text starts with one. */
function markers(payload: unknown): string[] {
  const text = JSON.stringify(payload) ?? '';
  return [...new Set(text.match(/(?:SECRETPROV|OPENPROV|PRIVVIS)-[a-z]+/g) ?? [])].sort();
}

const ACTIVE_LOCAL = ['OPENPROV-beta', 'OPENPROV-epsilon', 'PRIVVIS-gamma', 'SECRETPROV-alpha'];
const ACTIVE_REMOTE = ['OPENPROV-beta', 'OPENPROV-epsilon'];

function stubThinkClient(): { client: ThinkLLMClient; prompts: string[] } {
  const prompts: string[] = [];
  const client: ThinkLLMClient = {
    create: async (params) => {
      const content = params.messages[0]?.content;
      prompts.push(typeof content === 'string' ? content : JSON.stringify(content));
      return {
        id: 'stub', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text: JSON.stringify({ answer: 'stub', citations: [], gaps: [] }) }],
      } as never;
    },
  };
  return { client, prompts };
}

for (const kind of testBackends()) {
  describe(`remote fact-list reads hide private-provenance facts (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let seededAt = '';
    const ids: Record<string, number> = {};

    const ctxOf = (remote: boolean | undefined, extra: Partial<OperationContext> = {}): OperationContext => ({
      engine, config: {} as GBrainConfig, logger: noopLogger, dryRun: false, remote: remote as boolean,
      transport: 'stdio', sourceId: 'default', ...extra,
    } as OperationContext);
    const local = (extra: Partial<OperationContext> = {}) => ctxOf(false, extra);
    // remote UNDEFINED is the fail-closed `ctx.remote !== false` shape.
    const untrusted = (extra: Partial<OperationContext> = {}) => [ctxOf(true, extra), ctxOf(undefined, extra)];

    async function fact(name: string, f: {
      text: string; kind?: string; visibility: 'world' | 'private'; provenance: string; hoursAgo: number;
      metric?: number; supersededBy?: number;
    }): Promise<void> {
      const [row] = await engine.executeRaw<{ id: string | number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, source, source_session,
                            source_markdown_slug, claim_metric, claim_value, expired_at, superseded_by)
         VALUES ('default', $1, $2, $3, $4, now() - ($5 || ' hours')::interval, 'test', $6, $7,
                 $8, $9, $10::timestamptz, $11)
         RETURNING id`,
        [ENTITY, f.text, f.kind ?? 'fact', f.visibility, String(f.hoursAgo), SESSION, f.provenance,
          f.metric === undefined ? null : 'mrr', f.metric ?? null,
          f.supersededBy === undefined ? null : new Date(Date.now() - 30 * 60_000).toISOString(), f.supersededBy ?? null],
      );
      ids[name] = Number(row.id);
    }

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      seededAt = new Date(Date.now() - 60_000).toISOString();
      await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice is a founder.' });
      await engine.putPage('meetings/open-sync', { type: 'meeting', title: 'open sync', compiled_truth: 'An open meeting.' });
      await engine.putPage('meetings/secret-sync', {
        type: 'meeting', title: 'secret sync', compiled_truth: 'A private meeting.', frontmatter: { visibility: 'private' },
      });
      // World facts are the leak shape: only the provenance page's privacy can hide them.
      await fact('alpha', { text: 'SECRETPROV-alpha commits to ship the launch', kind: 'commitment', visibility: 'world', provenance: 'meetings/secret-sync', hoursAgo: 2, metric: 100 });
      await fact('beta', { text: 'OPENPROV-beta commits to review the plan', kind: 'commitment', visibility: 'world', provenance: 'meetings/open-sync', hoursAgo: 3, metric: 200 });
      await fact('gamma', { text: 'PRIVVIS-gamma private note', visibility: 'private', provenance: 'meetings/open-sync', hoursAgo: 4, metric: 300 });
      await fact('epsilon', { text: 'OPENPROV-epsilon current role', visibility: 'world', provenance: 'meetings/open-sync', hoursAgo: 1 });
      await fact('delta', { text: 'SECRETPROV-delta earlier role', visibility: 'world', provenance: 'meetings/secret-sync', hoursAgo: 5, supersededBy: ids.epsilon });
      await fact('zeta', { text: 'OPENPROV-zeta earlier title', visibility: 'world', provenance: 'meetings/open-sync', hoursAgo: 6, supersededBy: ids.epsilon });
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(() => {
      __resetHotMemoryCacheForTests();
      __resetPrivateVisibilityCacheForTests();
    });

    const recall = async (ctx: OperationContext, p: R) => (await operationsByName.recall.handler(ctx, p)) as R;

    const recallArms: Array<[string, R, string[], string[]]> = [
      ['entity', { entity: ENTITY }, ACTIVE_LOCAL, ACTIVE_REMOTE],
      ['since', { since: '2d' }, ACTIVE_LOCAL, ACTIVE_REMOTE],
      ['since + entity', { since: '2d', entity: ENTITY }, ACTIVE_LOCAL, ACTIVE_REMOTE],
      ['session_id', { session_id: SESSION }, ACTIVE_LOCAL, ACTIVE_REMOTE],
      ['no filter', {}, ACTIVE_LOCAL, ACTIVE_REMOTE],
      ['supersessions', { supersessions: true }, ['OPENPROV-zeta', 'SECRETPROV-delta'], ['OPENPROV-zeta']],
    ];
    for (const [arm, params, localExpected, remoteExpected] of recallArms) {
      test(`recall ${arm}: local unchanged, remote hides the private-provenance world fact`, async () => {
        expect(markers((await recall(local(), params)).facts)).toEqual(localExpected);
        for (const c of untrusted()) {
          expect(markers((await recall(c, params)).facts)).toEqual(remoteExpected);
        }
      });
    }

    test('entity card: commitments and the active fact count skip private-provenance facts remotely', async () => {
      const card = async (ctx: OperationContext) => ((await operationsByName.entity.handler(ctx, { name: ENTITY })) as R).card;
      const localCard = await card(local());
      expect(markers(localCard.open_threads)).toEqual(['OPENPROV-beta', 'SECRETPROV-alpha']);
      expect(localCard.active_fact_count).toBe(4);
      for (const c of untrusted()) {
        const remoteCard = await card(c);
        expect(markers(remoteCard.open_threads)).toEqual(['OPENPROV-beta']);
        expect(remoteCard.active_fact_count).toBe(2);
      }
    });

    test('delta facts arm: include_private local unchanged; remote and the default world posture hide private-provenance facts', async () => {
      const del = async (ctx: OperationContext, p: R) => (await operationsByName.delta.handler(ctx, p)) as R;
      expect(markers((await del(local(), { since: seededAt, include_private: true })).facts)).toEqual(ACTIVE_LOCAL);
      expect(markers((await del(local(), { since: seededAt })).facts)).toEqual(ACTIVE_REMOTE);
      for (const c of untrusted()) {
        expect(markers((await del(c, { since: seededAt })).facts)).toEqual(ACTIVE_REMOTE);
      }
    });

    test('hot memory (session and recent windows): local unchanged, remote hides private-provenance facts', async () => {
      for (const extra of [{ sessionId: SESSION }, {}]) {
        __resetHotMemoryCacheForTests();
        const hot = async (ctx: OperationContext) => ((await getBrainHotMemoryMeta('search', ctx))?.brain_hot_memory as R | undefined)?.facts;
        expect(markers(await hot(local(extra)))).toEqual(ACTIVE_LOCAL);
        for (const c of untrusted(extra)) expect(markers(await hot(c))).toEqual(ACTIVE_REMOTE);
      }
    });

    test('find_trajectory: local unchanged, remote hides private-provenance points', async () => {
      const traj = async (ctx: OperationContext) => ((await operationsByName.find_trajectory.handler(ctx, { entity_slug: ENTITY })) as R).points;
      expect(markers(await traj(local()))).toEqual(ACTIVE_LOCAL);
      for (const c of untrusted()) {
        const points = await traj(c);
        expect(markers(points)).toEqual(ACTIVE_REMOTE);
        expect(JSON.stringify(points)).not.toContain('meetings/secret-sync');
      }
    });

    test('think trajectory block: local unchanged, remote omits private-provenance points', async () => {
      const prompt = async (remote: boolean | undefined) => {
        const { client, prompts } = stubThinkClient();
        await runThink(engine, { remote: remote as boolean, question: 'When did Alice Example last switch jobs?', client });
        expect(prompts.length).toBe(1);
        expect(prompts[0]).toContain('<trajectory entity="people/alice-example"');
        return prompts[0].slice(prompts[0].indexOf('<trajectory'));
      };
      expect(markers(await prompt(false))).toEqual(expect.arrayContaining(['OPENPROV-beta', 'SECRETPROV-alpha']));
      for (const remote of [true, undefined]) {
        const block = await prompt(remote);
        expect(markers(block)).toContain('OPENPROV-beta');
        expect(block).not.toContain('SECRETPROV');
      }
    });

    test('get_write_attribution: a private-provenance fact is not visible remotely', async () => {
      const attr = (ctx: OperationContext, id: number) => operationsByName.get_write_attribution.handler(ctx, { slug: ENTITY, fact: id }) as Promise<R>;
      expect((await attr(local(), ids.alpha)).target.id).toBe(ids.alpha);
      for (const c of untrusted()) {
        expect((await attr(c, ids.beta)).target.id).toBe(ids.beta);
        await expect(attr(c, ids.alpha)).rejects.toMatchObject({ code: 'fact_not_found' });
      }
    });

    test('operator opt-out restores the previous remote view', async () => {
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
      try {
        __resetPrivateVisibilityCacheForTests();
        expect(markers((await recall(ctxOf(true), { entity: ENTITY })).facts)).toEqual(['OPENPROV-beta', 'OPENPROV-epsilon', 'SECRETPROV-alpha']);
      } finally {
        await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, '');
        __resetPrivateVisibilityCacheForTests();
      }
    });
  });
}

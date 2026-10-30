/**
 * #7026 part 2: `context.hot_memory.session_only` (DB plane, default false).
 *
 * Hot memory for a session with no facts of its own falls back to the
 * source's newest 24h facts, which can come from other sessions. With the key
 * on, the turn_context and context_pack IPC handlers ask for this session's
 * facts only, so such a session gets no hot facts at all. The flag is part of
 * the hot-memory cache key, so a fallback payload is never served to a
 * session-only read and the reverse.
 *
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { turnContextWithBrief } from '../src/mcp/resolve-ipc-binding.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { testBackends } from './helpers/test-backends.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';

const KEY = 'context.hot_memory.session_only';
const OTHER_FACT = 'OTHER-SESSION-FACT prefers async standups';
const OWN_FACT = 'OWN-SESSION-FACT prefers written agendas';
const noop = { info: () => {}, warn: () => {}, error: () => {} };

const backends = testBackends();
const arms: Array<{ name: string; engine: BrainEngine; close: () => Promise<void> }> = [];
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    arms.push({ name: 'pglite', engine, close: () => engine.disconnect() });
  }
  if (backends.includes('postgres')) {
    template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
    const pg = await template.clone();
    arms.push({ name: 'postgres', engine: pg.engine, close: pg.close });
  }
}, 120_000);

afterAll(async () => {
  for (const arm of arms) await arm.close();
  await template?.dispose();
});

beforeEach(async () => {
  __resetHotMemoryCacheForTests();
  for (const { engine } of arms) {
    await engine.executeRaw('DELETE FROM facts');
    await engine.unsetConfig(KEY);
  }
});

async function seedFact(engine: BrainEngine, fact: string, session: string): Promise<void> {
  await engine.insertFact(
    { fact, kind: 'fact', entity_slug: 'people/alice-example', source: 'test', visibility: 'world', source_session: session },
    { source_id: 'default' },
  );
}

function metaCtx(engine: BrainEngine, sessionId: string): OperationContext {
  return {
    engine, config: {} as GBrainConfig, logger: noop, dryRun: false, remote: true,
    sourceId: 'default', sessionId, takesHoldersAllowList: ['world'],
  } as OperationContext;
}

const hotFacts = (meta: Record<string, unknown> | undefined): string[] =>
  ((meta?.brain_hot_memory as { facts?: Array<{ fact: string }> } | undefined)?.facts ?? []).map((f) => f.fact);

describe('getBrainHotMemoryMeta sessionOnly', () => {
  test('off: a session with no facts of its own still falls back to other sessions', async () => {
    for (const { name, engine } of arms) {
      await seedFact(engine, OTHER_FACT, 'sess-other');
      expect([name, hotFacts(await getBrainHotMemoryMeta('turn_context', metaCtx(engine, 'sess-new')))]).toEqual([name, [OTHER_FACT]]);
    }
  });

  test('on: a session with no facts of its own gets nothing', async () => {
    for (const { name, engine } of arms) {
      await seedFact(engine, OTHER_FACT, 'sess-other');
      const meta = await getBrainHotMemoryMeta('turn_context', metaCtx(engine, 'sess-new'), { sessionOnly: true });
      expect([name, meta]).toEqual([name, undefined]);
    }
  });

  test('on: a session with facts of its own gets only its own', async () => {
    for (const { name, engine } of arms) {
      await seedFact(engine, OTHER_FACT, 'sess-other');
      await seedFact(engine, OWN_FACT, 'sess-own');
      const meta = await getBrainHotMemoryMeta('turn_context', metaCtx(engine, 'sess-own'), { sessionOnly: true });
      expect([name, hotFacts(meta)]).toEqual([name, [OWN_FACT]]);
    }
  });

  test('the cache keeps the two answers apart in both orders', async () => {
    for (const { name, engine } of arms) {
      await seedFact(engine, OTHER_FACT, 'sess-other');
      // Fallback first: its cached payload is never served to the session-only read.
      expect([name, hotFacts(await getBrainHotMemoryMeta('turn_context', metaCtx(engine, 'sess-a')))]).toEqual([name, [OTHER_FACT]]);
      expect([name, await getBrainHotMemoryMeta('turn_context', metaCtx(engine, 'sess-a'), { sessionOnly: true })]).toEqual([name, undefined]);
      // Session-only first: its cached empty answer is never served to the fallback read.
      expect([name, await getBrainHotMemoryMeta('turn_context', metaCtx(engine, 'sess-b'), { sessionOnly: true })]).toEqual([name, undefined]);
      expect([name, hotFacts(await getBrainHotMemoryMeta('turn_context', metaCtx(engine, 'sess-b')))]).toEqual([name, [OTHER_FACT]]);
    }
  });
});

describe('IPC handlers read context.hot_memory.session_only', () => {
  const turn = (engine: BrainEngine, sessionId: string) => turnContextWithBrief(engine, 'default',
    { kind: 'turn_context', protocol: 2, secret: 'x', sessionId, window: [{ role: 'user', text: 'what should I prepare for today' }] });
  const pack = (engine: BrainEngine, sessionId: string) => makeContextPackIpcHandler(engine, 'default')(
    { kind: 'context_pack', protocol: 2, secret: 'x', sessionId });

  test('turn_context: unset keeps the fallback, true drops other sessions\' facts', async () => {
    for (const { name, engine } of arms) {
      await seedFact(engine, OTHER_FACT, 'sess-other');
      const off = await turn(engine, 'sess-turn');
      expect([name, off.factsCount, off.text.includes(OTHER_FACT)]).toEqual([name, 1, true]);
      await engine.setConfig(KEY, 'true');
      const on = await turn(engine, 'sess-turn');
      expect([name, on.factsCount, on.text.includes(OTHER_FACT)]).toEqual([name, 0, false]);
    }
  });

  test('context_pack: unset keeps the fallback, true drops other sessions\' facts', async () => {
    for (const { name, engine } of arms) {
      await seedFact(engine, OTHER_FACT, 'sess-other');
      const off = await pack(engine, 'sess-pack');
      expect([name, (off?.facts ?? []).map((f) => f.fact)]).toEqual([name, [OTHER_FACT]]);
      await engine.setConfig(KEY, 'true');
      const on = await pack(engine, 'sess-pack');
      expect([name, (on?.facts ?? []).map((f) => f.fact), on?.text.includes(OTHER_FACT)]).toEqual([name, [], false]);
    }
  });

  test('context_pack with the key on still carries the session\'s own facts', async () => {
    for (const { name, engine } of arms) {
      await seedFact(engine, OTHER_FACT, 'sess-other');
      await seedFact(engine, OWN_FACT, 'sess-pack-own');
      await engine.setConfig(KEY, 'true');
      const on = await pack(engine, 'sess-pack-own');
      expect([name, (on?.facts ?? []).map((f) => f.fact)]).toEqual([name, [OWN_FACT]]);
    }
  });
});

test('the key is registered, so gbrain config set accepts it', () => {
  expect(KNOWN_CONFIG_KEYS).toContain(KEY);
});

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsPipeline, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { factSourceContext } from '../src/core/facts/speaker-context.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const home = mkdtempSync(join(tmpdir(), 'gbrain-capture-context-'));
const entity = 'people/alice-example';
const sid = 'a1b2c3d4-1111-4222-8333-abcdefabcdef';

test('session display unwraps every corpus form without changing non-capture/page fallback policy', () => {
  for (const name of [
    `${sid}.txt`, `${sid}.src-default.txt`, `${sid}.seg-abcdefabcdef.src-default.txt`,
    `${sid}.wb-abcdefabcdef.src-default.txt`,
  ]) expect(factSourceContext({ source: 'sweep:corpus', sessionId: `sweep:corpus:${name}` })).toBe('session a1b2c3d4');
  expect(factSourceContext({ source: 'hook:compact', sessionId: 'short' })).toBe('session short');
  expect(factSourceContext({ source: 'hook:compact', sessionId: sid })).toBe('session a1b2c3d4');
  expect(factSourceContext({ source: 'hook:compact', sessionId: sid, sourceSlug: '' }, 'notes/fallback')).toBe('');
  expect(factSourceContext({ source: 'hook:compact', sessionId: null }, 'notes/fallback')).toBe('notes/fallback');
  expect(factSourceContext({ source: 'sync:import', sessionId: sid }, 'notes/fallback')).toBe('notes/fallback');
});

beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      engines.push(engine);
    } else {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push(isolated.engine);
      closePostgres = isolated.close;
    }
  }
}, 120_000);
afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  _resetWriteThroughCacheForTest();
});
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

const modes = ['legacy-file', 'thin-client', 'write-through-off', 'managed-db', 'managed-file'] as const;
type Mode = typeof modes[number];

async function exercise(engine: BrainEngine, mode: Mode, overrides: Partial<FactsBackstopCtx>, expected: string | null) {
  const sourceId = `context-${randomUUID()}`;
  const root = join(home, sourceId);
  mkdirSync(join(root, 'people'), { recursive: true });
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.putPage(entity, { type: 'person', title: 'Alice Example', compiled_truth: 'A registered person.', frontmatter: {} }, { sourceId });
  writeFileSync(join(root, `${entity}.md`), serializePageToMarkdown((await engine.getPage(entity, { sourceId }))!, []));
  const fileBacked = mode === 'legacy-file' || mode === 'managed-file' || mode === 'write-through-off';
  if (fileBacked) await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [sourceId, root]);
  await engine.setConfig('memory.auto_writeback', 'all');
  await engine.setConfig('sync.write_through', mode === 'write-through-off' ? 'false' : 'true');
  _resetWriteThroughCacheForTest();
  if (mode === 'managed-file') await claimWorktree(engine, sourceId, root);
  if (mode.startsWith('managed')) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
  let calls = 0;
  __setChatTransportForTests(async () => {
    calls++;
    return { text: JSON.stringify({ facts: [{ fact: 'Alice Example prefers weekly reports.', kind: 'preference', entity, confidence: 1, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' };
  });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => [1, ...Array(1535).fill(0)]) })) as never);
  const ctx: FactsBackstopCtx = { engine, sourceId, source: 'hook:writeback', sessionId: sid, requestId: randomUUID(),
    operationContext: { engine, sourceId, config: { engine: engine.kind }, remote: false, dryRun: false, logger: console }, ...overrides };
  const text = 'Alice Example said that she prefers weekly reports in a substantive synthetic conversation.';
  try {
    const result = await runFactsPipeline(text, ctx);
    expect(result.inserted).toBe(1);
    const rows = await engine.executeRaw<{ context: string | null; source_session: string | null; attributed_to: string | null }>(
      'SELECT context,source_session,attributed_to FROM facts WHERE source_id=$1 AND id=$2', [sourceId, result.fact_ids[0]]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_session).toBe(ctx.sessionId);
    expect(rows[0].context).toBe(expected);
    if (ctx.speaker) expect(rows[0].attributed_to).toBe('other');
    if (mode === 'legacy-file' || mode === 'managed-file' || mode === 'managed-db') {
      const body = mode === 'managed-db' ? (await engine.getPage(entity, { sourceId }))!.compiled_truth : readFileSync(join(root, `${entity}.md`), 'utf8');
      const parsed = parseFactsFence(body);
      expect(parsed.facts).toHaveLength(1);
      expect(parsed.facts[0].context || null).toBe(expected);
    }
    if (mode.startsWith('managed')) {
      const replay = await runFactsPipeline(text, ctx);
      expect(replay.fact_ids).toEqual(result.fact_ids);
      expect(calls).toBe(1);
      expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state='committed'", [sourceId])).not.toHaveLength(0);
    }
  } finally { await disposePersistenceConsumer(engine); }
}

for (const mode of modes) describe(`#9512 ${mode}`, () => {
  for (const source of ['hook:writeback', 'hook:compact', 'sweep:corpus'] as const) {
    test(`${source} preserves a readable session citation and speaker note`, async () => {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        for (const engine of engines) await exercise(engine, mode, {
          source, sessionId: source === 'sweep:corpus' ? `sweep:corpus:${sid}.src-default.txt` : sid,
          speaker: { principal: 'example-agent' },
        }, 'session a1b2c3d4 — speaker: agent example-agent, not the owner');
      });
    }, 120_000);
  }
  test('explicit source page wins; missing sessions and explicit writers retain existing context', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        await exercise(engine, mode, {}, 'session a1b2c3d4');
        await exercise(engine, mode, { sourceSlug: 'meetings/explicit-origin' }, 'meetings/explicit-origin');
        await exercise(engine, mode, { sessionId: null }, null);
        await exercise(engine, mode, { source: 'mcp:extract_facts' }, null);
      }
    });
  }, 120_000);
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { assembleContextPack, assembleTurnContext, TURN_CONTEXT_ENVELOPE } from '../src/core/context/turn-context.ts';
import { getBrainHotMemoryMeta, invalidateHotMemoryForEngine, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { parseTranscript } from '../src/core/transcripts/claude-code-jsonl.ts';
import { buildOperationContext } from '../src/mcp/dispatch.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { turnContextWithBrief } from '../src/mcp/resolve-ipc-binding.ts';

let engine: PGLiteEngine;
let dir: string;
const FACT = 'Use the synthetic amber checklist for this session.';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gb-session-start-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact({ fact: FACT, kind: 'fact', visibility: 'world', source: 'test', source_session: 'other-session' }, { source_id: 'default' });
  await engine.insertFact({ fact: 'PRIVATE-SESSION-FACT', kind: 'fact', visibility: 'private', source: 'test', source_session: 'returning-session' }, { source_id: 'default' });
  await engine.insertFact({ fact: 'RETURNING-SESSION-FACT', kind: 'fact', visibility: 'world', source: 'test', source_session: 'returning-session' }, { source_id: 'default' });
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { __resetHotMemoryCacheForTests(); });

function transcript(entries: unknown[]) {
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
  return parseTranscript(path);
}

test('SessionStart stdout contributes only its gbrain envelope, never core slugs or unrelated hook output', () => {
  const block = `${TURN_CONTEXT_ENVELOPE}\n\n## Hot memory (recent facts)\n- ${FACT} (0.90)`;
  const parsed = transcript([
    { type: 'hook_success', hookEvent: 'SessionStart', content: `Core memory mentions people/core-only\n${block}` },
    { type: 'hook_success', hookEvent: 'SessionStart', content: 'Foreign hook: people/foreign' },
    { type: 'hook_success', hookEvent: 'Stop', content: block },
    { type: 'hook_success', hookEvent: 'SessionStart', content: { text: block } },
    { type: 'user', message: { role: 'user', content: 'A genuine prompt' } },
  ]);
  expect(parsed.injectedContextBlocks).toEqual([block]);
  expect(parsed.turns.map(t => t.text)).toEqual(['A genuine prompt']);
});

test('a real boundary pack recorded as SessionStart is deduped on the first prompt', async () => {
  const pack = await assembleContextPack(engine, { sourceId: 'default', sessionId: 'other-session' });
  expect(pack.factsCount).toBe(1);
  const parsed = transcript([{ type: 'hook_success', hookEvent: 'SessionStart', content: `Core memory\n${pack.text}` }]);
  const first = await assembleTurnContext(engine, { sourceId: 'default', sessionId: 'other-session', window: [], priorContextText: parsed.injectedContextBlocks.join('\n') });
  expect(first.factsCount).toBe(0);
  expect(first.text).not.toContain(FACT);
});

test('session-only policy is cache-isolated in both call orders and refuses fallback without a session', async () => {
  const ctx = buildOperationContext(engine, {}, { remote: true, sourceId: 'default', sessionId: 'fresh-session' });
  for (const strictFirst of [false, true]) {
    __resetHotMemoryCacheForTests();
    for (const sessionOnly of [strictFirst, !strictFirst]) {
      const result = await getBrainHotMemoryMeta('search', ctx, { sessionOnly });
      if (sessionOnly) expect(result).toBeUndefined();
      else expect(JSON.stringify(result)).toContain(FACT);
    }
  }
  expect(await getBrainHotMemoryMeta('search', { ...ctx, sessionId: undefined }, { sessionOnly: true })).toBeUndefined();
});

test('both real IPC handlers honor session-only hot memory, while default callers retain fallback', async () => {
  const handler = makeContextPackIpcHandler(engine, 'default');
  const pack = await handler({ kind: 'context_pack', protocol: 2, secret: 'test', sessionId: 'fresh-session', sessionOnlyHotMemory: true });
  expect(pack?.factsCount).toBe(0);
  const turn = await turnContextWithBrief(engine, 'default', { kind: 'turn_context', protocol: 2, secret: 'test', window: [], sessionId: 'fresh-session', sessionOnlyHotMemory: true });
  expect(turn.factsCount).toBe(0);
  const legacy = await handler({ kind: 'context_pack', protocol: 2, secret: 'test', sessionId: 'fresh-session' });
  expect(legacy?.text).toContain(FACT);
});

test('session-only packs still deliver the current session world facts, never private or other-session rows', async () => {
  const result = await assembleContextPack(engine, { sourceId: 'default', sessionId: 'returning-session', sessionOnlyHotMemory: true });
  expect(result.factsCount).toBe(1);
  expect(result.text).toContain('RETURNING-SESSION-FACT');
  expect(result.text).not.toContain('PRIVATE-SESSION-FACT');
  expect(result.text).not.toContain(FACT);
});

test('a first session write invalidates the cached empty hook payload as well as the fallback payload', async () => {
  const ctx = buildOperationContext(engine, {}, { remote: true, sourceId: 'default', sessionId: 'first-write' });
  expect(await getBrainHotMemoryMeta('search', ctx, { sessionOnly: true })).toBeUndefined();
  expect(await getBrainHotMemoryMeta('search', ctx)).toBeDefined();
  await engine.insertFact({ fact: 'FIRST-SESSION-WRITE', kind: 'fact', visibility: 'world', source: 'test', source_session: 'first-write' }, { source_id: 'default' });
  invalidateHotMemoryForEngine(engine);
  for (const sessionOnly of [false, true]) {
    const result = await getBrainHotMemoryMeta('search', ctx, { sessionOnly });
    expect(JSON.stringify(result)).toContain('FIRST-SESSION-WRITE');
    expect(JSON.stringify(result)).not.toContain(FACT);
  }
});

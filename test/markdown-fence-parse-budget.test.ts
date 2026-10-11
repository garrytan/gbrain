/**
 * Fenced code in a page write parses under a short cap. A fence whose
 * tree-sitter parse runs long (a pathological Lua block in a chat history)
 * falls back to text chunks instead of eating the 30 s preparation budget,
 * and once a page's fence budget is spent the remaining fences stay in the
 * prose chunks. web-tree-sitter reports a timed-out parse as "Parsing failed";
 * that reads as a timeout, not as the language being unavailable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { ChunkerTimeoutError, parseWithTimeout } from '../src/core/chunkers/code.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const SLOW_LUA = 'if a then\n'.repeat(3000) + 'end\n'.repeat(3000);
const body = (fences: string[]) => `A chat about scripting.\n\n${fences.map(f => '```lua\n' + f + '```\n').join('\nAnd another one:\n\n')}\nThanks!\n`;

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(async () => { await disposePersistenceConsumer(engine); await resetPgliteState(engine); });

describe('fenced code parse budget', () => {
  test('a "Parsing failed" throw from the parser is a timeout', () => {
    const parser = { setTimeoutMicros() {}, parse() { throw new Error('Parsing failed'); } };
    expect(() => parseWithTimeout(parser, 'x', 5, 'fence.lua')).toThrow(ChunkerTimeoutError);
    const broken = { setTimeoutMicros() {}, parse() { throw new Error('something else'); } };
    expect(() => parseWithTimeout(broken, 'x', 5, 'fence.lua')).toThrow('something else');
  });

  test('a fence that overruns its cap falls back to text chunks quickly', async () => withEnv({ GBRAIN_FENCE_PARSE_TIMEOUT_MS: '1' }, async () => {
    const started = performance.now();
    const chunks = await prepareMarkdownChunks({ compiled_truth: body([SLOW_LUA]) });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(chunks.some(c => c.chunk_source === 'compiled_truth')).toBe(true);
    const fenced = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenced.length).toBeGreaterThan(0);
    expect(fenced.every(c => !c.symbol_name)).toBe(true);
  }));

  test('once the page fence budget is spent, later fences stay in the prose chunks', async () => withEnv({ GBRAIN_FENCE_PARSE_TIMEOUT_MS: '1', GBRAIN_FENCE_PARSE_BUDGET_MS: '1' }, async () => {
    const chunks = await prepareMarkdownChunks({ compiled_truth: body([SLOW_LUA, 'print("second")\n', 'print("third")\n']) });
    expect(chunks.filter(c => c.chunk_source === 'fenced_code' && c.chunk_text.includes('third'))).toHaveLength(0);
    expect(chunks.some(c => c.chunk_source === 'compiled_truth' && c.chunk_text.includes('third'))).toBe(true);
  }));

  test('put_pages lands a page whose Lua fence parses slowly', async () => withEnv({ GBRAIN_FENCE_PARSE_TIMEOUT_MS: '1' }, async () => {
    const ctx = { engine, config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const putPages = operations.find(op => op.name === 'put_pages')!;
    const result = await putPages.handler(ctx, { request_id: randomUUID(), pages: [
      { slug: 'chat/lua-session', content: `---\ntype: note\ntitle: Lua session\n---\n\n${body([SLOW_LUA])}` },
      { slug: 'chat/plain-session', content: '---\ntype: note\ntitle: Plain\n---\n\nNo code here.\n' },
    ] }) as { state: string; counts: { committed: number } };
    expect(result).toMatchObject({ state: 'committed', counts: { committed: 2 } });
    expect(await engine.readPageSnapshot('chat/lua-session', { sourceId: 'default' })).not.toBeNull();
  }), 30_000);
});

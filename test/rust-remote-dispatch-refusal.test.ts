/**
 * An engine that does not enforce the brain's access policy itself (the Rust engine reports no `access_control`
 * capability: no visibility, owner or folder filter in its store) must not answer a remote caller. MCP and HTTP
 * dispatch refuse such a call with `engine_capability_missing` before the engine is touched; the trusted local
 * CLI (`remote: false`) is not refused here.
 */
import { describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/** A Rust-like engine whose every member other than its kind and capability set records the touch and throws. */
function untouchableEngine(capabilities: ReadonlySet<string> | undefined, kind = 'rust') {
  const touched: string[] = [];
  const known: Record<string, unknown> = { kind, capabilities };
  const engine = new Proxy(known, {
    get(target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      if (key in target) return target[key];
      touched.push(key);
      throw new Error(`engine member touched: ${key}`);
    },
  }) as unknown as BrainEngine;
  return { engine, touched };
}

function body(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('remote dispatch on an engine without access control', () => {
  for (const remote of [true, undefined] as const) {
    test(`a remote call (remote: ${remote}) is refused before the engine is touched`, async () => {
      const { engine, touched } = untouchableEngine(new Set(['pages', 'keyword_search']));
      const result = await dispatchToolCall(engine, 'get_page', { slug: 'people/alice-example' }, remote === undefined ? {} : { remote });
      expect(result.isError).toBe(true);
      const answer = body(result);
      expect(answer.code ?? answer.error).toBe('engine_capability_missing');
      expect(answer.reason).toBe('access_control');
      expect(String(answer.message)).toContain('get_page for a remote caller');
      expect(String(answer.message)).toContain('so nothing ran');
      expect(touched).toEqual([]);
    });
  }

  test('a write from a remote caller is refused the same way', async () => {
    const { engine, touched } = untouchableEngine(new Set(['pages']));
    const result = await dispatchToolCall(engine, 'put_page', { slug: 'notes/x', content: '# X\n' }, { remote: true });
    expect(body(result).reason).toBe('access_control');
    expect(touched).toEqual([]);
  });

  test('a Rust engine with no capability set is refused too (fail closed)', async () => {
    const { engine, touched } = untouchableEngine(undefined);
    const result = await dispatchToolCall(engine, 'get_page', { slug: 'a' }, { remote: true });
    expect(body(result).reason).toBe('access_control');
    expect(touched).toEqual([]);
  });

  test('the trusted local caller is not refused by this check', async () => {
    const { engine } = untouchableEngine(new Set(['pages']));
    const result = await dispatchToolCall(engine, 'get_page', { slug: 'a' }, { remote: false }).catch((e: unknown) => e);
    const reason = result && typeof result === 'object' && 'content' in result
      ? body(result as { content: Array<{ text: string }> }).reason : undefined;
    expect(reason).not.toBe('access_control');
  });
});

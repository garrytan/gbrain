/**
 * F1 (agent operator contract v1): initialize instructions are generated from
 * the caller's effective callable set. Pins: every tool a surface's
 * instructions name is in that surface's tools/list; the memory loop, error
 * protocol and notice prefix ride every surface; the readiness tail names at
 * most two gaps and never a choice (`disabled_by_choice`); the budget; and the
 * per-initialize resolver the transports install on the SDK Server.
 */
import { describe, test, expect } from 'bun:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { operations } from '../src/core/operations.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { buildMcpInstructions, GBRAIN_MCP_INSTRUCTIONS, installInstructionsResolver } from '../src/mcp/instructions.ts';
import type { ReadinessEntry } from '../src/core/readiness.ts';

const SURFACES = ['verbs', 'starter', 'full'] as const;
const OP_NAMES = operations.map(o => o.name);

/** Op names an instruction text names: underscore names as whole words, plus any backticked op name. */
function namedTools(text: string): string[] {
  const named = new Set<string>();
  for (const name of OP_NAMES) {
    const word = new RegExp(`(^|[^a-z_])${name}([^a-z_]|$)`);
    if ((name.includes('_') && word.test(text)) || text.includes(`\`${name}\``)) named.add(name);
  }
  return [...named];
}

/**
 * The pre-F1 contract size (bytes): the static contract on master 566a242,
 * which already carries Cat 40's measured answering rule (#5932). F1's
 * readiness tail may add at most 1,200 on top; every surface's tail-free
 * contract stays within Lane I's +15% token-overhead gate.
 */
const PRE_F1_BYTES = 4042;
const LANE_I_CEILING = Math.floor(PRE_F1_BYTES * 1.15);

describe('F1 generated instructions', () => {
  for (const surface of SURFACES) {
    test(`${surface}: every tool named is in its tools/list; loop + error protocol present`, () => {
      const listed = new Set(filterOpsForSurface(operations, surface).map(o => o.name));
      const text = buildMcpInstructions({ tools: { callable: n => listed.has(n) } });
      for (const name of namedTools(text)) expect({ surface, name, listed: listed.has(name) }).toEqual({ surface, name, listed: true });
      expect(text).toContain('Follow `fix.next`');
      expect(text).toContain('[gbrain notice <code> kind=<kind>]');
      expect(text).toContain('call `context_pack` at session start');
      expect(text).toContain('`remember` what the user explicitly asks you to keep');
    });
  }

  test('a grant without write scope gets no remember/put_page clauses', () => {
    const readOnly = new Set(operations.filter(o => o.scope === 'read').map(o => o.name));
    const text = buildMcpInstructions({ tools: { callable: n => readOnly.has(n) } });
    expect(text).not.toContain('`remember`');
    expect(text).not.toContain('put_page');
    for (const name of namedTools(text)) expect(readOnly.has(name)).toBe(true);
  });

  test('volunteer_context is named only where callable', () => {
    expect(buildMcpInstructions({ tools: { callable: n => n !== 'volunteer_context' } })).not.toContain('volunteer_context');
    expect(GBRAIN_MCP_INSTRUCTIONS).toContain('call `volunteer_context` when the conversation shifts topic');
  });

  test('readiness tail: top two gaps only, never a by-choice state; budget holds', () => {
    const e = (capability: ReadinessEntry['capability'], state: ReadinessEntry['state'], why: string): ReadinessEntry =>
      ({ capability, state, reason: 'x', why, tier: 'config', http_visible: true });
    const readiness = [
      e('embeddings', 'disabled_by_choice', 'keyless by choice'),
      e('chat_llm', 'missing', 'No chat model key is configured. '.repeat(10)),
      e('worker', 'missing', '3 jobs are waiting and no worker is running.'),
      e('migrations', 'degraded', 'Schema is behind.'),
    ];
    const text = buildMcpInstructions({ tools: { callable: () => true, readiness } });
    expect(text).toContain('Setup now (details and fixes in gbrain://capabilities): chat_llm missing:');
    expect(text).toContain('worker missing: 3 jobs');
    expect(text).not.toContain('keyless by choice');
    expect(text).not.toContain('Schema is behind');
    expect(Buffer.byteLength(text) - PRE_F1_BYTES).toBeLessThanOrEqual(1200);
  });

  for (const surface of SURFACES) {
    test(`${surface}: tail-free contract stays within +15% of the pre-F1 contract`, () => {
      const listed = new Set(filterOpsForSurface(operations, surface).map(o => o.name));
      expect(Buffer.byteLength(buildMcpInstructions({ tools: { callable: n => listed.has(n) } }))).toBeLessThanOrEqual(LANE_I_CEILING);
    });
  }

  test('no tools and no writeback → the static contract', () => {
    expect(buildMcpInstructions()).toBe(GBRAIN_MCP_INSTRUCTIONS);
  });
});

describe('installInstructionsResolver', () => {
  async function handshake(compute: () => Promise<string>): Promise<string | undefined> {
    const server = new Server({ name: 'gbrain', version: 'test' }, { capabilities: { tools: {} }, instructions: 'static fallback' });
    installInstructionsResolver(server, compute);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    await client.connect(b);
    const out = client.getInstructions();
    await client.close();
    return out;
  }

  test('serves the per-initialize value', async () => {
    expect(await handshake(async () => 'computed at initialize')).toBe('computed at initialize');
  });

  test('keeps the constructor value when the resolver throws', async () => {
    expect(await handshake(async () => { throw new Error('boom'); })).toBe('static fallback');
  });
});

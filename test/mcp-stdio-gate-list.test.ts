/**
 * B1 (CLI→MCP gap-closure wave) — stdio tools/list honesty.
 *
 * stdio dispatches remote:true, and publish-gate enforcement
 * (assertPublishEnabled, the advisor inline gate) exempts only
 * ctx.remote === false — so the stdio ListTools handler must subtract
 * gate-off publish-gated ops or it advertises tools that deny at call time
 * (the listed-but-denied class the honest-catalog wave exists to kill).
 * localOnly ops stay listed: locality is the transport axis (D7), consent is
 * the gate axis. These tests pin stdioVisibleTools, the extracted per-request
 * list builder.
 */
import { describe, test, expect } from 'bun:test';
import { stdioVisibleTools } from '../src/mcp/server.ts';
import { operations } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const GATED = operations.filter(op => op.publishGateKey).map(op => op.name);
const LOCAL_ONLY = operations.filter(op => op.localOnly).map(op => op.name);

function engineWithGates(values: Record<string, string | null>): BrainEngine {
  return {
    getConfig: async (key: string) => values[key] ?? null,
  } as unknown as BrainEngine;
}

describe('stdioVisibleTools (B1)', () => {
  test('there are publish-gated ops to subtract (fixture sanity)', () => {
    expect(GATED.length).toBeGreaterThanOrEqual(4);
    expect(GATED).toContain('list_skills');
    expect(GATED).toContain('advisor');
  });

  test('gates off (DB plane false): every gated op is subtracted, localOnly ops stay', async () => {
    const engine = engineWithGates({ 'mcp.publish_skills': 'false', 'mcp.publish_advisor': 'false' });
    const visible = await stdioVisibleTools(engine, operations);
    const names = visible.map(op => op.name);
    for (const gated of GATED) expect(names).not.toContain(gated);
    // D7: stdio IS the local surface — localOnly ops remain listed.
    for (const local of LOCAL_ONLY) expect(names).toContain(local);
    expect(names).toContain('get_page');
  });

  test('one gate on: only that gate’s ops return', async () => {
    const engine = engineWithGates({ 'mcp.publish_skills': 'true', 'mcp.publish_advisor': 'false' });
    const names = (await stdioVisibleTools(engine, operations)).map(op => op.name);
    expect(names).toContain('list_skills');
    expect(names).toContain('get_skill');
    expect(names).not.toContain('advisor');
  });

  test('both gates on: full surfaced set returned unchanged', async () => {
    const engine = engineWithGates({ 'mcp.publish_skills': 'true', 'mcp.publish_advisor': 'true' });
    const visible = await stdioVisibleTools(engine, operations);
    expect(visible.length).toBe(operations.length);
  });

  test('gate resolver failure hides every gated op (fail-closed), never throws', async () => {
    const engine = {
      getConfig: async () => { throw new Error('config table unavailable'); },
    } as unknown as BrainEngine;
    const names = (await stdioVisibleTools(engine, operations)).map(op => op.name);
    // A failed read resolves false per publish-gates doctrine (hide-on-doubt).
    for (const gated of GATED) expect(names).not.toContain(gated);
    expect(names).toContain('get_page');
  });

  test('surfaced set without gated ops passes through untouched (no gate read needed)', async () => {
    const ungated = operations.filter(op => !op.publishGateKey);
    let reads = 0;
    const engine = {
      getConfig: async () => { reads += 1; return null; },
    } as unknown as BrainEngine;
    const visible = await stdioVisibleTools(engine, ungated);
    expect(visible.length).toBe(ungated.length);
    expect(reads).toBe(0);
  });
});

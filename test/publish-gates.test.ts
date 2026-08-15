/**
 * WP1 honest catalog: publish-gate resolution for tools/list
 * (src/mcp/publish-gates.ts) and the shared bound-client predicate
 * (opAllowedForBoundClient) that keeps the advertised list and the dispatch
 * fence from drifting.
 */

import { describe, test, expect } from 'bun:test';
import { disabledOpsForPublishGates, readPublishGate } from '../src/mcp/publish-gates.ts';
import { operations, opAllowedForBoundClient, CLIENT_FENCED_WRITE_OPS } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const GATED_OPS = ['list_skills', 'get_skill', 'list_brain_skillpack', 'advisor'];

function engineWithConfig(values: Record<string, string | null> | 'throws'): BrainEngine {
  return {
    getConfig: async (key: string) => {
      if (values === 'throws') throw new Error('config table unavailable');
      return values[key] ?? null;
    },
  } as unknown as BrainEngine;
}

describe('publish-gates: gate declaration', () => {
  test('exactly the four gated ops carry publishGateKey', () => {
    const declared = operations.filter(o => o.publishGateKey).map(o => o.name).sort();
    expect(declared).toEqual([...GATED_OPS].sort());
  });
});

describe('publish-gates: disabledOpsForPublishGates', () => {
  test('gates absent on both planes → all four hidden (default-off posture)', async () => {
    const disabled = await disabledOpsForPublishGates(engineWithConfig({}), null);
    for (const name of GATED_OPS) expect(disabled.has(name)).toBe(true);
  });

  test('DB plane true → visible; per-key independence', async () => {
    const disabled = await disabledOpsForPublishGates(
      engineWithConfig({ 'mcp.publish_skills': 'true' }), null,
    );
    expect(disabled.has('list_skills')).toBe(false);
    expect(disabled.has('get_skill')).toBe(false);
    expect(disabled.has('list_brain_skillpack')).toBe(false);
    // advisor rides a SEPARATE gate and stays hidden.
    expect(disabled.has('advisor')).toBe(true);
  });

  test('DB plane false wins over file plane true (DB > file)', async () => {
    const cfg = { engine: 'pglite', mcp: { publish_skills: true } } as unknown as GBrainConfig;
    const disabled = await disabledOpsForPublishGates(
      engineWithConfig({ 'mcp.publish_skills': 'false' }), cfg,
    );
    expect(disabled.has('list_skills')).toBe(true);
  });

  test('file plane fallback when DB plane is unset', async () => {
    const cfg = { engine: 'pglite', mcp: { publish_advisor: true } } as unknown as GBrainConfig;
    const disabled = await disabledOpsForPublishGates(engineWithConfig({}), cfg);
    expect(disabled.has('advisor')).toBe(false);
    expect(disabled.has('list_skills')).toBe(true);
  });

  test('gate READ FAILURE hides the gated ops and never throws (ENG-20)', async () => {
    const disabled = await disabledOpsForPublishGates(engineWithConfig('throws'), null);
    for (const name of GATED_OPS) expect(disabled.has(name)).toBe(true);
    // Only the gated ops are affected — a config hiccup never hides the catalog.
    expect(disabled.size).toBe(GATED_OPS.length);
  });

  test('read failure with file-plane true → visible (file plane still decides)', async () => {
    const cfg = { engine: 'pglite', mcp: { publish_skills: true } } as unknown as GBrainConfig;
    expect(await readPublishGate(engineWithConfig('throws'), cfg, 'mcp.publish_skills')).toBe(true);
  });
});

describe('opAllowedForBoundClient (ENG-3: list filter and fence share one predicate)', () => {
  const readOp = { name: 'get_page', scope: 'read' as const, mutating: undefined };
  const fencedWrite = { name: 'put_page', scope: 'write' as const, mutating: undefined };
  const unfencedWrite = { name: 'import', scope: 'write' as const, mutating: undefined };
  const mutatingRead = { name: 'sources_add', scope: 'sources_admin' as const, mutating: true };

  test('unbound client: everything allowed', () => {
    for (const op of [readOp, fencedWrite, unfencedWrite, mutatingRead]) {
      expect(opAllowedForBoundClient(undefined, op)).toBe(true);
      expect(opAllowedForBoundClient({}, op)).toBe(true);
    }
  });

  test('bound client: reads + fenced writes allowed, everything else denied', () => {
    const auth = { boundSlugPrefixes: ['wiki/agents/x'] };
    expect(opAllowedForBoundClient(auth, readOp)).toBe(true);
    expect(opAllowedForBoundClient(auth, fencedWrite)).toBe(true);
    expect(opAllowedForBoundClient(auth, unfencedWrite)).toBe(false);
    expect(opAllowedForBoundClient(auth, mutatingRead)).toBe(false);
    expect(CLIENT_FENCED_WRITE_OPS.has(fencedWrite.name)).toBe(true);
  });

  test('degraded projection: reads only (fenced writes also denied)', () => {
    const auth = { fenceProjectionDegraded: true };
    expect(opAllowedForBoundClient(auth, readOp)).toBe(true);
    expect(opAllowedForBoundClient(auth, fencedWrite)).toBe(false);
    expect(opAllowedForBoundClient(auth, unfencedWrite)).toBe(false);
  });
});

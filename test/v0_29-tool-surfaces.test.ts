/**
 * v0.29 — tool-surface contracts.
 *
 * Verifies two filter contracts that touch the v0.29 ops but live outside
 * the v0.29 source files (in serve-http.ts and brain-allowlist.ts):
 *
 * 1. `localOnly: true` on `get_recent_transcripts` is what hides it from
 *    the HTTP MCP tool-list. serve-http.ts:745 does
 *    `operations.filter(op => !op.localOnly)`. The v0.29 trust gate
 *    (in-handler `ctx.remote === true` reject) is defense-in-depth on top
 *    of this; if the filter ever drops the flag, the in-handler check is
 *    the last line. We assert both halves of the contract.
 *
 * 2. `buildBrainTools` (subagent registry) surfaces filtered salience as
 *    `brain_get_recent_salience` and excludes anomaly/transcript tools until
 *    they have a safe subagent boundary.
 *
 * Both filters are pure-function checks; no DB / engine / network needed.
 */

import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';

describe('v0.29 — serve-http localOnly filter', () => {
  // serve-http.ts:745 is the canonical filter expression.
  const mcpVisible = operations.filter(op => !op.localOnly);

  test('get_recent_transcripts is hidden from the HTTP MCP tool list', () => {
    const names = mcpVisible.map(o => o.name);
    expect(names).not.toContain('get_recent_transcripts');
  });

  test('get_recent_salience and find_anomalies stay visible', () => {
    const names = mcpVisible.map(o => o.name);
    expect(names).toContain('get_recent_salience');
    expect(names).toContain('find_anomalies');
  });

  test('get_recent_transcripts carries the localOnly: true flag', () => {
    const op = operations.find(o => o.name === 'get_recent_transcripts');
    expect(op).toBeDefined();
    expect(op!.localOnly).toBe(true);
  });

  test('get_recent_salience and find_anomalies do NOT carry localOnly', () => {
    // Read-only ops that subagents need; localOnly would block them from MCP.
    const sal = operations.find(o => o.name === 'get_recent_salience');
    const ano = operations.find(o => o.name === 'find_anomalies');
    expect(sal!.localOnly).toBeFalsy();
    expect(ano!.localOnly).toBeFalsy();
  });

  test('all three v0.29 ops carry scope: read', () => {
    // v0.26.0 contract: every op must annotate scope. Read-only is correct
    // for all three (no DB writes, no fs writes).
    for (const name of ['get_recent_salience', 'find_anomalies', 'get_recent_transcripts']) {
      const op = operations.find(o => o.name === name);
      expect(op!.scope).toBe('read');
    }
  });
});

describe('v0.29 — buildBrainTools subagent surfacing', () => {
  // buildBrainTools doesn't issue any SQL at registry-build time — it only
  // reads `engine.kind` for the put_page namespace-wrap branch. A minimal
  // fake-engine literal keeps the test pure (no PGLite WASM cold-start, no
  // connect/disconnect lifecycle, no test-isolation R3/R4 violations).
  // Cast through `unknown` because the BrainEngine surface is large and
  // we only touch one property.
  const fakeEngine = { kind: 'pglite' } as unknown as BrainEngine;
  const config: GBrainConfig = { engine: 'pglite' } as GBrainConfig;

  test('subagent registry includes brain_get_recent_salience', () => {
    const tools = buildBrainTools({ subagentId: 1, engine: fakeEngine, config });
    const names = tools.map(t => t.name);
    expect(names).toContain('brain_get_recent_salience');
  });

  test('subagent registry excludes brain_find_anomalies until it has a tier-safe result shape', () => {
    const tools = buildBrainTools({ subagentId: 1, engine: fakeEngine, config });
    const names = tools.map(t => t.name);
    expect(names).not.toContain('brain_find_anomalies');
  });

  test('subagent registry EXCLUDES brain_get_recent_transcripts (codex C3 footgun gate)', () => {
    // All subagent calls run with ctx.remote === true; the v0.29 trust gate
    // would always reject. Listing the op would be a footgun: subagent
    // calls it, gets permission_denied, looks like a bug. The cycle's
    // synthesize phase reaches transcripts via discoverTranscripts directly,
    // not via the op.
    const tools = buildBrainTools({ subagentId: 1, engine: fakeEngine, config });
    const names = tools.map(t => t.name);
    expect(names).not.toContain('brain_get_recent_transcripts');
  });

  test('the v0.29 salience op carries its description verbatim into the registry', () => {
    const tools = buildBrainTools({ subagentId: 1, engine: fakeEngine, config });
    const sal = tools.find(t => t.name === 'brain_get_recent_salience');
    const opSal = operations.find(o => o.name === 'get_recent_salience');
    expect(sal!.description).toBe(opSal!.description);
  });
});

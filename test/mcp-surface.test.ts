/**
 * MEMORY_VERBS v1 + WP4 — surface-mode tests.
 *
 *   - 'verbs' filters to EXACTLY the seven protocol verbs
 *   - 'starter' filters to STARTER_OPS (membership pinned; every member
 *     exists in operations)
 *   - monotonicity: allowedOpNames(verbs) ⊆ starter ⊆ full (ENG-1)
 *   - 'full' is the identity (existing installs unchanged)
 *   - dispatch-layer allowedOps is FAIL-CLOSED: a hidden op is uncallable
 *     (unknown_tool), not merely unlisted [c2]
 *   - flag parsing is strict (unknown value rejects loudly)
 *   - resolution: flag > config mcp_surface > 'full'
 *   - D2 ceiling: effective = min(ceiling, client row ?? default); the
 *     GBRAIN_MCP_FORCE_SURFACE kill switch is NARROW-ONLY (FOV-6a)
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { VERB_NAMES } from '../src/core/verbs.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';
import {
  filterOpsForSurface,
  allowedOpNames,
  parseSurfaceFlag,
  resolveSurface,
  STARTER_OPS,
  minSurface,
  clampSurface,
  effectiveSurfaceForClient,
  resolveClientRowSurface,
  __resetSurfaceWarnCachesForTests,
} from '../src/mcp/surface.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __setUsageLogPathForTests } from '../src/core/verbs/usage-log.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  // Sidecar writes go to a temp file via the test seam — no global env mutation.
  home = mkdtempSync(join(tmpdir(), 'gbrain-surface-test-'));
  __setUsageLogPathForTests(join(home, 'usage.jsonl'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setUsageLogPathForTests(null);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('filterOpsForSurface', () => {
  it("'verbs' returns exactly the seven protocol verbs", () => {
    const names = filterOpsForSurface(operations, 'verbs').map(o => o.name).sort();
    expect(names).toEqual([...VERB_NAMES].sort());
  });

  it("'full' is the identity — existing installs see every op", () => {
    expect(filterOpsForSurface(operations, 'full')).toEqual(operations);
  });

  it("'starter' returns exactly the ops whose name is in STARTER_OPS", () => {
    const names = filterOpsForSurface(operations, 'starter').map(o => o.name).sort();
    expect(names).toEqual(operations.filter(o => STARTER_OPS.has(o.name)).map(o => o.name).sort());
  });
});

describe('STARTER_OPS (WP4)', () => {
  it('every member exists in operations (membership pin)', () => {
    const known = new Set(operations.map(o => o.name));
    const missing = [...STARTER_OPS].filter(name => !known.has(name));
    expect(missing).toEqual([]);
  });

  it('is composed programmatically: verbs + FOV-6b fallback daily ops + whoami + request_tools', () => {
    // ENG-1: the verb slice is a spread of VERB_NAMES — all SEVEN post-#4028
    // verbs (context_pack/delta included), never a hand-count.
    for (const v of VERB_NAMES) expect(STARTER_OPS.has(v)).toBe(true);
    // FOV-6b fallback: the reviewed brain-tool allow-list, imported not copied.
    for (const name of BRAIN_TOOL_ALLOWLIST) expect(STARTER_OPS.has(name)).toBe(true);
    // FOV-4: the agent lane must not strand agent-scope clients.
    expect(STARTER_OPS.has('submit_agent')).toBe(true);
    expect(STARTER_OPS.has('get_agent_job')).toBe(true);
    expect(STARTER_OPS.has('whoami')).toBe(true);
    // D4: request_tools is listed on starter (+full) …
    expect(STARTER_OPS.has('request_tools')).toBe(true);
  });

  it('D4: request_tools is NOT on the verbs surface', () => {
    expect(allowedOpNames(operations, 'verbs').has('request_tools')).toBe(false);
    expect(allowedOpNames(operations, 'starter').has('request_tools')).toBe(true);
    expect(allowedOpNames(operations, 'full').has('request_tools')).toBe(true);
  });

  it('monotonicity (ENG-1): allowedOpNames(verbs) ⊆ starter ⊆ full', () => {
    const verbs = allowedOpNames(operations, 'verbs');
    const starter = allowedOpNames(operations, 'starter');
    const full = allowedOpNames(operations, 'full');
    for (const name of verbs) expect(starter.has(name)).toBe(true);
    for (const name of starter) expect(full.has(name)).toBe(true);
    // And the ladder is strictly widening at each step.
    expect(verbs.size).toBeLessThan(starter.size);
    expect(starter.size).toBeLessThan(full.size);
  });
});

describe('dispatch allowedOps — fail-closed [c2]', () => {
  it('a hidden op returns unknown_tool even when called by name', async () => {
    const allowed = allowedOpNames(operations, 'verbs');
    const res = await dispatchToolCall(engine, 'get_page', { slug: 'x' }, {
      remote: true,
      sourceId: 'default',
      allowedOps: allowed,
      surface: 'verbs',
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.error).toBe('unknown_tool');
  });

  it('a surfaced verb still dispatches under the same allowedOps set', async () => {
    const allowed = allowedOpNames(operations, 'verbs');
    const res = await dispatchToolCall(engine, 'entity', { name: 'zzz-nobody' }, {
      remote: true,
      sourceId: 'default',
      allowedOps: allowed,
      surface: 'verbs',
    });
    expect(res.isError ?? false).toBe(false);
    const body = JSON.parse(res.content[0].text);
    expect(body.found).toBe(false);
  });

  it('without allowedOps (full surface) every op stays callable — pre-existing behavior', async () => {
    const res = await dispatchToolCall(engine, 'get_stats', {}, {
      remote: true,
      sourceId: 'default',
    });
    expect(res.isError ?? false).toBe(false);
  });
});

describe('parseSurfaceFlag + resolveSurface', () => {
  it('parses verbs/starter/full, rejects unknown values loudly, requires a value', () => {
    expect(parseSurfaceFlag(['--surface', 'verbs'])).toBe('verbs');
    expect(parseSurfaceFlag(['--surface', 'starter'])).toBe('starter');
    expect(parseSurfaceFlag(['--surface', 'full'])).toBe('full');
    expect(parseSurfaceFlag(['serve'])).toBe(null);
    expect(() => parseSurfaceFlag(['--surface', 'all'])).toThrow(/Unknown --surface/);
    expect(() => parseSurfaceFlag(['--surface'])).toThrow(/requires a value/);
    expect(() => parseSurfaceFlag(['--surface', '--http'])).toThrow(/requires a value/);
  });

  it('resolution: flag > config mcp_surface > full', () => {
    expect(resolveSurface('verbs', { mcp_surface: 'full' })).toBe('verbs');
    expect(resolveSurface(null, { mcp_surface: 'verbs' })).toBe('verbs');
    expect(resolveSurface(null, { mcp_surface: 'starter' })).toBe('starter');
    expect(resolveSurface(null, {})).toBe('full');
    expect(resolveSurface(null, null)).toBe('full');
    expect(resolveSurface(null, { mcp_surface: 'bogus' as never })).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// WP4 — D2 ceiling resolution + GBRAIN_MCP_FORCE_SURFACE kill switch (FOV-6a)
// ---------------------------------------------------------------------------

describe('D2 ceiling resolution (effectiveSurfaceForClient)', () => {
  afterEach(() => {
    __resetSurfaceWarnCachesForTests();
  });

  it('minSurface orders verbs < starter < full', () => {
    expect(minSurface('verbs', 'full')).toBe('verbs');
    expect(minSurface('full', 'verbs')).toBe('verbs');
    expect(minSurface('starter', 'full')).toBe('starter');
    expect(minSurface('full', 'starter')).toBe('starter');
    expect(minSurface('verbs', 'starter')).toBe('verbs');
    expect(minSurface('full', 'full')).toBe('full');
  });

  it('D2 pin: a verbs-pinned server + full client row still serves verbs', () => {
    expect(effectiveSurfaceForClient({ ceiling: 'verbs', clientSurface: 'full', defaultSurface: null })).toBe('verbs');
  });

  it('client row narrows below the ceiling', () => {
    expect(effectiveSurfaceForClient({ ceiling: 'full', clientSurface: 'starter', defaultSurface: null })).toBe('starter');
    expect(effectiveSurfaceForClient({ ceiling: 'full', clientSurface: 'verbs', defaultSurface: null })).toBe('verbs');
  });

  it('NULL row surface falls to the config default, bounded by the ceiling', () => {
    expect(effectiveSurfaceForClient({ ceiling: 'full', clientSurface: null, defaultSurface: 'starter' })).toBe('starter');
    expect(effectiveSurfaceForClient({ ceiling: 'verbs', clientSurface: null, defaultSurface: 'full' })).toBe('verbs');
  });

  it('NULL row + unset default = the ceiling (pre-WP4 behavior, existing clients untouched)', () => {
    expect(effectiveSurfaceForClient({ ceiling: 'full', clientSurface: null, defaultSurface: null })).toBe('full');
    expect(effectiveSurfaceForClient({ ceiling: 'starter', clientSurface: null, defaultSurface: null })).toBe('starter');
  });

  // FOV-6a pins, deliberately NEXT to the D2 ceiling test above.
  it('kill switch narrows: force=verbs clamps a full resolution to verbs', async () => {
    await withEnv({ GBRAIN_MCP_FORCE_SURFACE: 'verbs' }, () => {
      expect(effectiveSurfaceForClient({ ceiling: 'full', clientSurface: 'full', defaultSurface: null })).toBe('verbs');
      expect(clampSurface('full')).toBe('verbs');
    });
  });

  it('kill switch can NEVER widen: force=full over a verbs ceiling still serves verbs', async () => {
    await withEnv({ GBRAIN_MCP_FORCE_SURFACE: 'full' }, () => {
      expect(effectiveSurfaceForClient({ ceiling: 'verbs', clientSurface: 'full', defaultSurface: null })).toBe('verbs');
      expect(clampSurface('verbs')).toBe('verbs');
      expect(clampSurface('starter')).toBe('starter');
    });
  });

  it('unknown kill-switch value is ignored (warn once), surface stays as configured', async () => {
    await withEnv({ GBRAIN_MCP_FORCE_SURFACE: 'everything' }, () => {
      const warnings: string[] = [];
      expect(clampSurface('starter', msg => warnings.push(msg))).toBe('starter');
      expect(clampSurface('starter', msg => warnings.push(msg))).toBe('starter');
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('GBRAIN_MCP_FORCE_SURFACE');
    });
  });
});

describe('resolveClientRowSurface (amendment 18)', () => {
  afterEach(() => __resetSurfaceWarnCachesForTests());

  it('threads known values, null/undefined = no per-client surface', () => {
    expect(resolveClientRowSurface('starter', 'c1')).toBe('starter');
    expect(resolveClientRowSurface('verbs', 'c1')).toBe('verbs');
    expect(resolveClientRowSurface('full', 'c1')).toBe('full');
    expect(resolveClientRowSurface(null, 'c1')).toBe(null);
    expect(resolveClientRowSurface(undefined, 'c1')).toBe(null);
  });

  it('unknown value → ignored + warn-logged once per client', () => {
    const warnings: string[] = [];
    const warn = (msg: string) => warnings.push(msg);
    expect(resolveClientRowSurface('tier-gold', 'client-a', warn)).toBe(null);
    expect(resolveClientRowSurface('tier-gold', 'client-a', warn)).toBe(null);
    expect(resolveClientRowSurface('tier-gold', 'client-b', warn)).toBe(null);
    expect(warnings.length).toBe(2); // once per client, not per request
    expect(warnings[0]).toContain('client-a');
    expect(warnings[1]).toContain('client-b');
  });
});

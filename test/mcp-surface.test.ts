/**
 * MEMORY_VERBS v1 — surface-mode tests (Cathedral 1).
 *
 *   - 'verbs' filters to EXACTLY the five protocol verbs
 *   - 'full' is the identity (existing installs unchanged)
 *   - dispatch-layer allowedOps is FAIL-CLOSED: a hidden op is uncallable
 *     (unknown_tool), not merely unlisted [c2]
 *   - flag parsing is strict (unknown value rejects loudly)
 *   - resolution: flag > config mcp_surface > 'full'
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { VERB_NAMES } from '../src/core/verbs.ts';
import {
  filterOpsForSurface,
  allowedOpNames,
  parseSurfaceFlag,
  resolveSurface,
} from '../src/mcp/surface.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __setUsageLogPathForTests } from '../src/core/verbs/usage-log.ts';

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
  it("'verbs' returns exactly the five protocol verbs", () => {
    const names = filterOpsForSurface(operations, 'verbs').map(o => o.name).sort();
    expect(names).toEqual([...VERB_NAMES].sort());
  });

  it("'full' is the identity — existing installs see every op", () => {
    expect(filterOpsForSurface(operations, 'full')).toEqual(operations);
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
  it('parses verbs/full, rejects unknown values loudly, requires a value', () => {
    expect(parseSurfaceFlag(['--surface', 'verbs'])).toBe('verbs');
    expect(parseSurfaceFlag(['--surface', 'full'])).toBe('full');
    expect(parseSurfaceFlag(['serve'])).toBe(null);
    expect(() => parseSurfaceFlag(['--surface', 'all'])).toThrow(/Unknown --surface/);
    expect(() => parseSurfaceFlag(['--surface'])).toThrow(/requires a value/);
    expect(() => parseSurfaceFlag(['--surface', '--http'])).toThrow(/requires a value/);
  });

  it('resolution: flag > config mcp_surface > full', () => {
    expect(resolveSurface('verbs', { mcp_surface: 'full' })).toBe('verbs');
    expect(resolveSurface(null, { mcp_surface: 'verbs' })).toBe('verbs');
    expect(resolveSurface(null, {})).toBe('full');
    expect(resolveSurface(null, null)).toBe('full');
    expect(resolveSurface(null, { mcp_surface: 'bogus' as never })).toBe('full');
  });
});

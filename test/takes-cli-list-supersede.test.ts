// #2078 + #2079 — `gbrain takes` CLI regressions:
//   #2078: cmdSupersede looked up its target with active:false, so
//          superseding any ACTIVE take failed "Row #N not found".
//   #2079: `gbrain takes list` parsed "list" as a page slug and printed
//          "No takes on list." — now a reserved subcommand.
//
// Hermetic: mock engine, no DB. Env-mutating (GBRAIN_HOME) via withEnv.

import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTakes } from '../src/commands/takes.ts';
import type { BrainEngine, Take, TakesListOpts } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeTake(overrides: Partial<Take> = {}): Take {
  return {
    id: 1, page_id: 11, page_slug: 'ideas/widget-co', row_num: 1,
    claim: 'widget-co will reach PMF', kind: 'bet', holder: 'self',
    weight: 0.6, since_date: null, until_date: null, source: null,
    superseded_by: null, active: true, resolved_at: null,
    resolved_outcome: null, resolved_quality: null, resolved_value: null,
    resolved_unit: null, resolved_source: null, resolved_by: null,
  } as Take;
}

function makeEngine() {
  const listCalls: TakesListOpts[] = [];
  const supersedeCalls: unknown[][] = [];
  const engine = {
    getConfig: async () => null,
    executeRaw: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sources WHERE id = $1')) return [{ id: params[0] as string }];
      if (sql.includes('FROM sources')) return [];
      if (sql.includes('FROM pages WHERE slug = $1 AND source_id = $2')) return [{ id: 11 }];
      if (sql.includes('FROM pages WHERE slug = $1 LIMIT 1')) return [{ id: 11 }];
      return [];
    },
    listTakes: async (opts: TakesListOpts = {}) => {
      listCalls.push(opts);
      // Only the ACTIVE row #1 exists (the #2078 scenario).
      return opts.active === true ? [fakeTake()] : [];
    },
    supersedeTake: async (...args: unknown[]) => {
      supersedeCalls.push(args);
      return { oldRow: 1, newRow: 2 };
    },
  } as unknown as BrainEngine;
  return { engine, listCalls, supersedeCalls };
}

describe('takes supersede targets ACTIVE rows (#2078)', () => {
  test('superseding an active take succeeds instead of "Row #N not found"', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-sup-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-sup-home-'));
    tmpRoots.push(brainDir, home);
    const { engine, listCalls, supersedeCalls } = makeEngine();
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('EXIT');
    }) as never);
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
        await runTakes(engine, [
          'supersede', 'ideas/widget-co', '--row', '1',
          '--claim', 'widget-co pivoted', '--dir', brainDir,
        ]);
      });
      // Target lookup must ask for ACTIVE takes.
      expect(listCalls[0]?.active).toBe(true);
      expect(supersedeCalls.length).toBe(1);
      expect(supersedeCalls[0]?.[0]).toBe(11); // pageId
      expect(supersedeCalls[0]?.[1]).toBe(1);  // rowNum
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('already-superseded row yields a clear error, not "not found"', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-sup2-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-sup2-home-'));
    tmpRoots.push(brainDir, home);
    const listCalls: TakesListOpts[] = [];
    const engine = {
      getConfig: async () => null,
      executeRaw: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM sources WHERE id = $1')) return [{ id: params[0] as string }];
        if (sql.includes('FROM sources')) return [];
        if (sql.includes('FROM pages WHERE slug = $1')) return [{ id: 11 }];
        return [];
      },
      listTakes: async (opts: TakesListOpts = {}) => {
        listCalls.push(opts);
        // Row #1 exists only in the superseded set.
        return opts.active === false ? [fakeTake({ active: false })] : [];
      },
      supersedeTake: async () => { throw new Error('must not be called'); },
    } as unknown as BrainEngine;
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('EXIT');
    }) as never);
    const errSpy = spyOn(console, 'error');
    try {
      await expect(withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
        await runTakes(engine, [
          'supersede', 'ideas/widget-co', '--row', '1',
          '--claim', 'newer claim', '--dir', brainDir,
        ]);
      })).rejects.toThrow('EXIT');
      const messages = errSpy.mock.calls.map(c => String(c[0]));
      expect(messages.some(m => m.includes('already superseded'))).toBe(true);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe('takes list is a reserved subcommand (#2079)', () => {
  test('`takes list` lists brain-wide, not a page named "list"', async () => {
    const { engine, listCalls } = makeEngine();
    await runTakes(engine, ['list', '--json']);
    expect(listCalls.length).toBe(1);
    expect(listCalls[0]?.page_slug).toBeUndefined();
    expect(listCalls[0]?.active).toBe(true);
  });

  test('`takes list <slug>` scopes to the page', async () => {
    const { engine, listCalls } = makeEngine();
    await runTakes(engine, ['list', 'ideas/widget-co', '--json']);
    expect(listCalls[0]?.page_slug).toBe('ideas/widget-co');
  });
});

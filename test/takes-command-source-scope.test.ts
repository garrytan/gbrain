import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTakes } from '../src/commands/takes.ts';
import type { BrainEngine, TakeBatchInput } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeEngine(opts: { knownSources?: string[] } = {}) {
  const added: TakeBatchInput[][] = [];
  const pageLookups: unknown[][] = [];
  const engine = {
    getConfig: async () => null,
    executeRaw: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sources WHERE id = $1')) {
        // Default (no `knownSources` override): every id "exists", matching
        // the original test's assumption. When `knownSources` is passed,
        // only ids in that list resolve — used to simulate a source that
        // was explicitly requested (via GBRAIN_SOURCE) but isn't registered.
        if (!opts.knownSources) return [{ id: params[0] as string }];
        return opts.knownSources.includes(params[0] as string) ? [{ id: params[0] as string }] : [];
      }
      if (sql.includes('FROM sources WHERE local_path IS NOT NULL AND id != ')) {
        // resolveSourceId tier 5.5 (sole-non-default-source). No registered
        // sources with a local_path in these tests.
        return [];
      }
      if (sql.includes('FROM sources WHERE local_path IS NOT NULL')) {
        // resolveSourceId tier 4 (registered source whose local_path
        // contains CWD). No registered sources in these tests.
        return [];
      }
      if (sql.includes('FROM pages WHERE slug = $1 AND source_id = $2')) {
        pageLookups.push(params);
        if (params[0] === 'shared/page' && params[1] === 'dept') return [{ id: 22 }];
        if (params[0] === 'shared/page' && params[1] === 'default') return [{ id: 11 }];
        return [];
      }
      if (sql.includes('FROM pages WHERE slug = $1 LIMIT 1')) {
        pageLookups.push(params);
        return [{ id: 11 }];
      }
      return [];
    },
    addTakesBatch: async (rows: TakeBatchInput[]) => {
      added.push(rows);
      return rows.length;
    },
  } as unknown as BrainEngine;
  return { engine, added, pageLookups };
}

describe('gbrain takes CLI source scoping', () => {
  test('add mirrors to the page in GBRAIN_SOURCE, not an arbitrary same-slug page (#2684)', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-source-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    const { engine, added, pageLookups } = makeEngine();

    await withEnv({ GBRAIN_SOURCE: 'dept', GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add',
        'shared/page',
        '--claim',
        'Dept-scoped claim',
        '--kind',
        'take',
        '--who',
        'self',
        '--dir',
        brainDir,
      ]);
    });

    expect(pageLookups).toEqual([['shared/page', 'dept']]);
    expect(added).toHaveLength(1);
    expect(added[0]![0]!.page_id).toBe(22);

    // P1-1 source isolation: a non-default source with no own local_path files
    // its pages under `.sources/<id>/` in the shared repo (mirrors write-through
    // topology), NOT the shared root — the old `<brainDir>/<slug>.md` clobbered a
    // same-slug file in the wrong tree.
    const written = join(brainDir, '.sources', 'dept', 'shared/page.md');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf-8')).toContain('Dept-scoped claim');
  });

  test('add with no source configuration at all still resolves cleanly (no regression)', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-source-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    const { engine, added, pageLookups } = makeEngine();

    // No GBRAIN_SOURCE, no dotfile, no registered local_path match, no
    // sources.default config, no sole non-default source — resolveSourceId
    // falls through every tier to the seeded 'default' source (tier 6) and
    // never throws. `resolveTakesSourceId` must resolve, not error.
    await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add',
        'shared/page',
        '--claim',
        'Unscoped-default claim',
        '--kind',
        'take',
        '--who',
        'self',
        '--dir',
        brainDir,
      ]);
    });

    expect(pageLookups).toEqual([['shared/page', 'default']]);
    expect(added).toHaveLength(1);
    expect(added[0]![0]!.page_id).toBe(11);
  });

  test('add fails closed (blocks the write) when GBRAIN_SOURCE names a source that does not resolve (#2684 residual)', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-source-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    // 'ghost' is a well-formed source id (passes SOURCE_ID_RE) but is not a
    // registered source — resolveSourceId's assertSourceExists throws.
    const { engine, added, pageLookups } = makeEngine({ knownSources: ['dept', 'default'] });

    await withEnv({ GBRAIN_SOURCE: 'ghost', GBRAIN_HOME: home }, async () => {
      await expect(
        runTakes(engine, [
          'add',
          'shared/page',
          '--claim',
          'Should never land',
          '--kind',
          'take',
          '--who',
          'self',
          '--dir',
          brainDir,
        ]),
      ).rejects.toThrow(/Source "ghost" not found/);
    });

    // Fail-closed: the write must be blocked entirely, not silently
    // downgraded to an unscoped cross-source lookup.
    expect(pageLookups).toHaveLength(0);
    expect(added).toHaveLength(0);
    expect(existsSync(join(brainDir, 'shared/page.md'))).toBe(false);
  });

  test('supersede inherits from the markdown fence row it is replacing (#2663, EV1 md-canonical)', async () => {
    // v0.46.x (EV1): supersede is fence-first — the target row is looked up in
    // the on-disk markdown (canonical), kind/holder inherit from that row, the
    // fence assigns the new row number, and the DB mirror is addTakesBatch's
    // upsert of both affected rows (the reconcile primitive). The pre-EV1
    // shape (engine.listTakes lookup + engine.supersedeTake DB numbering)
    // could disagree with a later md→DB reconcile.
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-supersede-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    const { renderTakesFence } = await import('../src/core/takes-fence.ts');
    mkdirSync(join(brainDir, 'shared'), { recursive: true });
    writeFileSync(
      join(brainDir, 'shared/page.md'),
      `# Shared page\n\n## Takes\n\n${renderTakesFence([{
        rowNum: 3, claim: 'Current claim', kind: 'take', holder: 'self',
        weight: 0.8, active: true,
      }])}\n`,
      'utf-8',
    );
    const batches: unknown[][] = [];
    const engine = {
      getConfig: async () => null,
      executeRaw: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM sources WHERE id = $1')) return [{ id: params[0] as string }];
        if (sql.includes('FROM sources WHERE local_path IS NOT NULL')) return [];
        if (sql.includes('FROM pages WHERE slug = $1 AND source_id = $2')) return [{ id: 11 }];
        return [];
      },
      addTakesBatch: async (rows: unknown[]) => { batches.push(rows); return rows.length; },
    } as unknown as BrainEngine;

    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_HOME: home }, async () => {
        await runTakes(engine, [
          'supersede',
          'shared/page',
          '--row',
          '3',
          '--claim',
          'Replacement claim',
          '--dir',
          brainDir,
        ]);
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.join('\n')).toContain('Superseded #3 → new #4 on shared/page.');
    // One mirror batch carrying both affected rows exactly as the fence states.
    expect(batches.length).toBe(1);
    const rows = batches[0] as Array<{ row_num: number; active: boolean; superseded_by: number | null; kind: string; holder: string }>;
    const oldRow = rows.find(r => r.row_num === 3);
    const newRow = rows.find(r => r.row_num === 4);
    expect(oldRow?.active).toBe(false);
    expect(oldRow?.superseded_by).toBe(4);
    // kind/holder inherited from the fence row.
    expect(newRow?.active).toBe(true);
    expect(newRow?.kind).toBe('take');
    expect(newRow?.holder).toBe('self');
  });
});

describe('gbrain takes update/resolve — md-canonical CLI lanes (EV1)', () => {
  test('update on a row missing from the md fence exits 1 with row-not-found; no DB write attempted', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-update-miss-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    const { renderTakesFence } = await import('../src/core/takes-fence.ts');
    mkdirSync(join(brainDir, 'shared'), { recursive: true });
    writeFileSync(
      join(brainDir, 'shared/page.md'),
      `# Shared page\n\n## Takes\n\n${renderTakesFence([{
        rowNum: 3, claim: 'Current claim', kind: 'take', holder: 'self',
        weight: 0.8, active: true,
      }])}\n`,
      'utf-8',
    );
    const batches: unknown[][] = [];
    const updates: unknown[] = [];
    const engine = {
      getConfig: async () => null,
      executeRaw: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM sources WHERE id = $1')) return [{ id: params[0] as string }];
        if (sql.includes('FROM sources WHERE local_path IS NOT NULL')) return [];
        if (sql.includes('FROM pages WHERE slug = $1 AND source_id = $2')) return [{ id: 11 }];
        return [];
      },
      addTakesBatch: async (rows: unknown[]) => { batches.push(rows); return rows.length; },
      updateTake: async (...args: unknown[]) => { updates.push(args); return true; },
    } as unknown as BrainEngine;

    const errs: string[] = [];
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    let exited: string | null = null;
    try {
      await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_HOME: home }, async () => {
        // Row 5 does not exist in the fence (only row 3 does).
        await runTakes(engine, ['update', 'shared/page', '--row', '5', '--weight', '0.9', '--dir', brainDir]);
      });
    } catch (e) {
      if (!(e as Error).message.startsWith('EXIT:')) throw e;
      exited = (e as Error).message;
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(exited).toBe('EXIT:1');
    expect(errs.join('\n')).toContain('Row #5 not found on shared/page');
    // EV1 refusal is refusal — no DB write of any kind was attempted.
    expect(batches).toHaveLength(0);
    expect(updates).toHaveLength(0);
    // And the on-disk fence is untouched.
    expect(readFileSync(join(brainDir, 'shared/page.md'), 'utf-8')).toContain('Current claim');
  });

  test('resolve --outcome true maps to quality=correct (back-compat alias lane)', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-resolve-outcome-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    const { renderTakesFence } = await import('../src/core/takes-fence.ts');
    mkdirSync(join(brainDir, 'shared'), { recursive: true });
    writeFileSync(
      join(brainDir, 'shared/page.md'),
      `# Shared page\n\n## Takes\n\n${renderTakesFence([{
        rowNum: 3, claim: 'Bet claim', kind: 'bet', holder: 'self',
        weight: 0.8, active: true,
      }])}\n`,
      'utf-8',
    );
    const resolves: Array<{ pageId: number; rowNum: number; args: Record<string, unknown> }> = [];
    const engine = {
      getConfig: async () => null,
      executeRaw: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM sources WHERE id = $1')) return [{ id: params[0] as string }];
        if (sql.includes('FROM sources WHERE local_path IS NOT NULL')) return [];
        if (sql.includes('FROM pages WHERE slug = $1 AND source_id = $2')) return [{ id: 11 }];
        return [];
      },
      addTakesBatch: async (rows: unknown[]) => rows.length,
      resolveTake: async (pageId: number, rowNum: number, args: Record<string, unknown>) => {
        resolves.push({ pageId, rowNum, args });
        return true;
      },
    } as unknown as BrainEngine;

    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {}); // swallow the [deprecated] alias warn
    try {
      await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_HOME: home }, async () => {
        await runTakes(engine, ['resolve', 'shared/page', '--row', '3', '--outcome', 'true', '--dir', brainDir]);
      });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    // The success line names the MAPPED quality, not the raw outcome flag.
    expect(logs.join('\n')).toContain('Resolved take #3 on shared/page: quality=correct');
    // And the DB mirror got quality 'correct' / outcome true.
    expect(resolves).toHaveLength(1);
    expect(resolves[0]!.args.quality).toBe('correct');
    expect(resolves[0]!.args.outcome).toBe(true);
    // Markdown mirror carries the resolution (md-first).
    expect(readFileSync(join(brainDir, 'shared/page.md'), 'utf-8')).toContain('correct');
  });
});

describe('gbrain takes add — page validated before markdown is written', () => {
  test('missing page leaves no orphaned .md on disk', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-orphan-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-orphan-home-'));
    tmpRoots.push(brainDir, home);
    const { engine, added } = makeEngine();

    // makeEngine returns [] for any slug other than shared/page, so getPageId
    // takes its not-found path and exits 1.
    const errs: string[] = [];
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    let exited: string | null = null;
    try {
      await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_HOME: home }, async () => {
        await runTakes(engine, [
          'add',
          'missing/page',
          '--claim',
          'Claim against a page that was never synced',
          '--kind',
          'bet',
          '--who',
          'council',
          '--dir',
          brainDir,
        ]);
      });
    } catch (e) {
      if (!(e as Error).message.startsWith('EXIT:')) throw e;
      exited = (e as Error).message;
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(exited).toBe('EXIT:1');
    expect(errs.join('\n')).toContain('Page not found in brain: missing/page');
    // Pre-fix the .md was written before getPageId ran, so the take survived
    // on disk with no DB row — invisible to scorecard, but real enough to
    // shift row numbering on the next add.
    expect(existsSync(join(brainDir, 'missing/page.md'))).toBe(false);
    expect(added).toEqual([]);
  });

  test('existing page still writes both markdown and DB', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-ok-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-ok-home-'));
    tmpRoots.push(brainDir, home);
    const { engine, added } = makeEngine();

    await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add',
        'shared/page',
        '--claim',
        'Claim against a real page',
        '--kind',
        'bet',
        '--who',
        'council',
        '--dir',
        brainDir,
      ]);
    });

    expect(existsSync(join(brainDir, 'shared/page.md'))).toBe(true);
    expect(readFileSync(join(brainDir, 'shared/page.md'), 'utf8')).toContain('Claim against a real page');
    expect(added.flat()).toHaveLength(1);
    expect(added.flat()[0]!.page_id).toBe(11);
  });
});

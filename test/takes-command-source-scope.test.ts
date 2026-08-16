import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTakes } from '../src/commands/takes.ts';
import type { BrainEngine, TakeBatchInput, TakesListOpts } from '../src/core/engine.ts';
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

    const written = join(brainDir, 'shared/page.md');
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

  test('supersede looks up the active row it is replacing (#2663)', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-supersede-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    const listCalls: TakesListOpts[] = [];
    const engine = {
      getConfig: async () => null,
      executeRaw: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM sources WHERE id = $1')) return [{ id: params[0] as string }];
        if (sql.includes('FROM sources WHERE local_path IS NOT NULL')) return [];
        if (sql.includes('FROM pages WHERE slug = $1 AND source_id = $2')) return [{ id: 11 }];
        return [];
      },
      listTakes: async (opts: TakesListOpts) => {
        listCalls.push(opts);
        return [{
          page_id: 11,
          row_num: 3,
          claim: 'Current claim',
          kind: 'take',
          holder: 'self',
          weight: 0.8,
          active: true,
        }];
      },
      supersedeTake: async () => ({ oldRow: 3, newRow: 4 }),
    } as unknown as BrainEngine;

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

    expect(listCalls).toEqual([{ page_id: 11, active: true, limit: 500 }]);
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

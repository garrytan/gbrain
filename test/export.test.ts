import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine, Page } from '../src/core/engine.ts';
import { runExport } from '../src/commands/export.ts';

function makePage(slug: string, type: Page['type'] = 'concept'): Page {
  return {
    id: 1,
    slug,
    type,
    title: slug.split('/').pop()!,
    compiled_truth: 'Body for ' + slug,
    timeline: '',
    frontmatter: {},
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-02'),
  };
}

function summaryLine(spy: ReturnType<typeof spyOn>): string | undefined {
  const found = spy.mock.calls.map(c => c[0]).find(
    s => typeof s === 'string' && s.startsWith('Exported '),
  );
  return found as string | undefined;
}

describe('runExport --slugs', () => {
  let outDir: string;
  let exitSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'gbrain-export-test-'));
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
    exitSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('one valid slug → exports md + .raw sidecar; nothing else', async () => {
    const engine = {
      getPage: async (slug: string) =>
        slug === 'people/alice' ? makePage('people/alice', 'person') : null,
      listPages: async () => {
        throw new Error('listPages must not run when --slugs is set');
      },
      getTags: async () => [],
      getRawData: async (slug: string) =>
        slug === 'people/alice'
          ? [{ source: 'linkedin', data: { foo: 'bar' }, fetched_at: new Date() }]
          : [],
    } as unknown as BrainEngine;

    await runExport(engine, ['--slugs', 'people/alice', '--dir', outDir]);

    expect(existsSync(join(outDir, 'people/alice.md'))).toBe(true);
    expect(existsSync(join(outDir, 'people/.raw/alice.json'))).toBe(true);
    expect(readdirSync(outDir)).toEqual(['people']);
    expect(summaryLine(logSpy)).toBe(`Exported 1 pages to ${outDir}/`);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('valid + missing → exports valid, warns on missing, exit 0', async () => {
    const engine = {
      getPage: async (slug: string) =>
        slug === 'people/alice' ? makePage('people/alice') : null,
      listPages: async () => {
        throw new Error('listPages must not run');
      },
      getTags: async () => [],
      getRawData: async () => [],
    } as unknown as BrainEngine;

    await runExport(engine, ['--slugs', 'people/alice,people/ghost', '--dir', outDir]);

    expect(existsSync(join(outDir, 'people/alice.md'))).toBe(true);
    expect(existsSync(join(outDir, 'people/ghost.md'))).toBe(false);
    const warnedGhost = warnSpy.mock.calls
      .flat()
      .some(s => typeof s === 'string' && s.includes('people/ghost'));
    expect(warnedGhost).toBe(true);
    expect(summaryLine(logSpy)).toBe(`Exported 1 pages to ${outDir}/`);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('all-missing → exit 1, stdout shows 0 succeeded', async () => {
    const engine = {
      getPage: async () => null,
      listPages: async () => {
        throw new Error('listPages must not run');
      },
      getTags: async () => [],
      getRawData: async () => [],
    } as unknown as BrainEngine;

    await expect(
      runExport(engine, ['--slugs', 'people/ghost', '--dir', outDir]),
    ).rejects.toThrow('__exit_1__');

    expect(summaryLine(logSpy)).toBe(`Exported 0 pages to ${outDir}/`);
  });

  it('empty --slugs "" → throws "expected at least one slug"', async () => {
    const engine = {
      getPage: async () => null,
      listPages: async () => {
        throw new Error('listPages must not run');
      },
      getTags: async () => [],
      getRawData: async () => [],
    } as unknown as BrainEngine;

    await expect(
      runExport(engine, ['--slugs', '', '--dir', outDir]),
    ).rejects.toThrow(/expected at least one slug/);
  });

  it('no flag → bulk list-all path unchanged (regression guard)', async () => {
    const pages = [makePage('people/alice'), makePage('companies/acme', 'company')];
    const engine = {
      getPage: async () => {
        throw new Error('getPage must not run for bulk export');
      },
      listPages: async () => pages,
      getTags: async () => [],
      getRawData: async () => [],
    } as unknown as BrainEngine;

    await runExport(engine, ['--dir', outDir]);

    expect(existsSync(join(outDir, 'people/alice.md'))).toBe(true);
    expect(existsSync(join(outDir, 'companies/acme.md'))).toBe(true);
    expect(summaryLine(logSpy)).toBe(`Exported 2 pages to ${outDir}/`);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('partial export failure → "Exported N pages, M failed", exit 0 if any succeeded', async () => {
    const engine = {
      getPage: async (slug: string) =>
        slug.startsWith('people/') ? makePage(slug, 'person') : null,
      listPages: async () => {
        throw new Error('not called');
      },
      getTags: async (slug: string) => {
        if (slug === 'people/bob') throw new Error('boom');
        return [];
      },
      getRawData: async () => [],
    } as unknown as BrainEngine;

    await runExport(engine, ['--slugs', 'people/alice,people/bob', '--dir', outDir]);

    expect(existsSync(join(outDir, 'people/alice.md'))).toBe(true);
    expect(existsSync(join(outDir, 'people/bob.md'))).toBe(false);
    const failedLog = errorSpy.mock.calls
      .flat()
      .some(s => typeof s === 'string' && s.includes('FAILED people/bob'));
    expect(failedLog).toBe(true);
    expect(summaryLine(logSpy)).toBe(`Exported 1 pages to ${outDir}/, 1 failed`);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function makeEngine() {
  const added: TakeBatchInput[][] = [];
  const pageLookups: unknown[][] = [];
  const engine = {
    getConfig: async () => null,
    executeRaw: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sources WHERE id = $1')) {
        return [{ id: params[0] as string }];
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
});

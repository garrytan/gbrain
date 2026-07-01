import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine, Take, TakeBatchInput, TakesListOpts } from '../src/core/engine.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { runTakes } from '../src/commands/takes.ts';

describe('takes CLI supersede', () => {
  test('looks up the active target row before superseding', async () => {
    const slug = 'notes/supersede-cli-example';
    const pageId = 123;
    const target: Take = {
      id: 1,
      page_id: pageId,
      page_slug: slug,
      row_num: 1,
      claim: 'Original active claim',
      kind: 'take',
      holder: 'brain',
      weight: 0.75,
      since_date: '2026-01',
      until_date: null,
      source: 'example-note',
      superseded_by: null,
      active: true,
      resolved_at: null,
      resolved_outcome: null,
      resolved_quality: null,
      resolved_value: null,
      resolved_unit: null,
      resolved_source: null,
      resolved_by: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };

    let listOpts: TakesListOpts | undefined;
    let newRow:
      | { claim: string; kind: string; holder: string; weight?: number; active?: boolean }
      | undefined;
    const engine = {
      executeRaw: async <T,>() => [{ id: pageId }] as T[],
      listTakes: async (opts: TakesListOpts) => {
        listOpts = opts;
        return [target];
      },
      supersedeTake: async (
        _pageId: number,
        oldRow: number,
        row: Omit<TakeBatchInput, 'page_id' | 'row_num' | 'superseded_by'>,
      ) => {
        expect(_pageId).toBe(pageId);
        expect(oldRow).toBe(1);
        newRow = row;
        return { oldRow, newRow: 2 };
      },
    } as unknown as BrainEngine;

    const dir = mkdtempSync(join(tmpdir(), 'gbrain-takes-cli-'));
    const path = join(dir, `${slug}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `# Supersede fixture\n\n${renderTakesFence([{
        rowNum: 1,
        claim: target.claim,
        kind: target.kind,
        holder: target.holder,
        weight: target.weight,
        sinceDate: target.since_date ?? undefined,
        source: target.source ?? undefined,
        active: true,
      }])}\n`,
      'utf-8',
    );

    const originalLog = console.log;
    let updated = '';
    console.log = () => {};
    try {
      await runTakes(engine, [
        'supersede',
        slug,
        '--row',
        '1',
        '--claim',
        'Replacement claim',
        '--dir',
        dir,
      ]);
      updated = readFileSync(path, 'utf-8');
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }

    expect(listOpts).toMatchObject({ page_id: pageId, active: true, limit: 500 });
    expect(newRow).toMatchObject({
      claim: 'Replacement claim',
      kind: target.kind,
      holder: target.holder,
      active: true,
    });
    expect(newRow?.weight).toBeCloseTo(0.65);

    expect(updated).toContain('~~Original active claim~~');
    expect(updated).toContain('Replacement claim');
  });
});

// Write-path audit C-15: every dream phase uses one calendar date per cycle,
// resolved by `resolveCycleDate` (cycle.timezone > host timezone > UTC),
// never the UTC day from `toISOString().slice(0, 10)`.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseDrift } from '../src/core/cycle/drift.ts';
import { shiftCalendarDate } from '../src/core/cycle/cycle-date.ts';
import { __testing } from '../src/core/cycle/synthesize.ts';

const ROOT = join(import.meta.dir, '..');

describe('cycle date lint', () => {
  test('no phase under src/core/cycle derives "today" from the UTC day', () => {
    const files = [
      join(ROOT, 'src/core/cycle.ts'),
      ...readdirSync(join(ROOT, 'src/core/cycle'), { recursive: true })
        .map(String).filter(f => f.endsWith('.ts')).map(f => join(ROOT, 'src/core/cycle', f)),
    ].filter(f => !f.endsWith('cycle-date.ts'));
    const offenders = files.flatMap(file => readFileSync(file, 'utf8').split('\n')
      .map((line, i) => ({ line, at: `${file.slice(ROOT.length + 1)}:${i + 1}` }))
      .filter(({ line }) => /toISOString\(\)\.slice\(0,\s*10\)/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .map(({ at }) => at));
    expect(offenders).toEqual([]);
  });

  test('shiftCalendarDate does calendar arithmetic on the date string', () => {
    expect(shiftCalendarDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftCalendarDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftCalendarDate('2026-09-29', -30)).toBe('2026-08-30');
  });
});

describe('phases take the cycle date', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
  });

  test('drift dates its report and lookback window by the cycle date', async () => {
    const page = await engine.putPage('people/erin-example', { title: 'Erin', type: 'person', compiled_truth: 'Erin' });
    await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Careful operator', kind: 'take', holder: 'brain', weight: 0.6 }]);
    await engine.addTimelineEntriesBatch([{ slug: 'people/erin-example', date: '2030-01-15', source: 'meeting', summary: 'Changed roles' }]);
    await engine.setConfig('dream.drift.enabled', 'true');
    await engine.setConfig('models.drift', 'anthropic:claude-sonnet-4-6');
    const r = await runPhaseDrift(engine, {
      dryRun: false,
      cycleDate: '2030-01-20',
      auditPath: join(tmpdir(), `drift-cycle-date-${process.pid}.jsonl`),
      judge: async () => ({ drifted: true, confidence: 0.9, reasoning: 'moved' }),
    });
    expect(r.status).toBe('complete');
    expect(await engine.getPage('reports/drift-2030-01-20')).not.toBeNull();
  }, 30_000);

  test('the synthesis prompt dates undated sources by the cycle date', () => {
    const prompt = __testing.buildSynthesisPrompt(
      { filePath: '/c/undated.txt', basename: 'undated', content: 'x', contentHash: 'a'.repeat(64) } as never,
      'chunk', 0, 1, '', 'wiki', '', '', [], undefined, undefined, 'oneshot', '2030-01-20',
    );
    expect(prompt).toContain('2030-01-20');
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeSummary, upgradeSummary } from '../src/core/upgrade-summary.ts';

const rows = [
  { since: '0.1.0.0', kind: 'breaking', text: 'Too old to show.' },
  { since: '0.1.1.0', kind: 'breaking', text: 'The --old flag is gone. Use --new instead.' },
  { since: '0.1.1.0', kind: 'action', text: 'Run `gbrain sync` once after upgrading.' },
  { since: '0.1.2.0', kind: 'default', text: 'Search now ranks recent pages first.' },
  { since: '0.1.2.0', kind: 'fix', text: 'A fix.' },
  { since: '0.1.2.0', kind: 'add', text: 'An addition.' },
  { since: '0.1.2.0', kind: 'add', text: 'Another addition.' },
  { since: '0.1.2.0', text: 'A row from before kinds.' },
  { since: '0.1.3.0', kind: 'breaking', text: 'Not released yet.' },
];

describe('changeSummary', () => {
  test('groups the rows after from, up to upTo, by kind', () => {
    expect(changeSummary(rows, '0.1.0.0', '0.1.2.0')).toEqual([
      'What changed since v0.1.0.0: 7 changes.',
      '',
      'Needs you (2):',
      '- The --old flag is gone.',
      '- Run `gbrain sync` once after upgrading.',
      '',
      'Behavior changes (1):',
      '- Search now ranks recent pages first.',
      '',
      'Plus 1 fix and 2 additions. 1 change is not classified yet. `gbrain doctor --only behavior_changes` lists every change in full.',
    ]);
  });

  test('omits empty groups and counts; null when nothing is in range', () => {
    expect(changeSummary([{ since: '0.2.0.0', text: 'Old row.' }], '0.1.0.0')).toEqual([
      'What changed since v0.1.0.0: 1 change.',
      '',
      '1 change is not classified yet. `gbrain doctor --only behavior_changes` lists every change in full.',
    ]);
    expect(changeSummary(rows, '0.1.3.0')).toBeNull();
  });

  test('cuts a long first sentence', () => {
    const line = changeSummary([{ since: '0.2.0.0', kind: 'action', text: `${'word '.repeat(80)}end.` }], '0.1.0.0')![3]!;
    expect(line.length).toBe(242);
    expect(line.endsWith('…')).toBe(true);
  });

  test('upgradeSummary reads this binary\'s table, function rows included', () => {
    const lines = upgradeSummary('0')!;
    expect(lines[0]).toMatch(/^What changed since v0: \d+ changes\.$/);
    expect(lines.at(-1)).toContain('gbrain doctor --only behavior_changes');
  });
});

describe('gbrain post-upgrade', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-summary-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('prints the header for the changes since the release it upgraded from', () => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'upgrade-state.json'), JSON.stringify({ last_upgrade: { from: '0' } }));
    const { DATABASE_URL: _d, GBRAIN_DATABASE_URL: _g, ...env } = process.env;
    const run = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'post-upgrade', '--no-autopilot-install'], {
      env: { ...env, GBRAIN_HOME: home, GBRAIN_NO_AUTOPILOT_INSTALL: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(run.stdout.toString()).toContain(upgradeSummary('0')!.join('\n'));
  }, 60_000);
});

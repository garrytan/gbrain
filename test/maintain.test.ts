import { describe, expect, test } from 'bun:test';
import {
  extractCycleFreshnessSourceIds,
  parseMaintainArgs,
} from '../src/commands/maintain.ts';
import type { Check } from '../src/commands/doctor.ts';

describe('maintain args', () => {
  test('defaults to dry-run unless --safe is explicit', () => {
    expect(parseMaintainArgs([])).toMatchObject({
      safe: false,
      dryRun: true,
      json: false,
    });
  });

  test('--safe enables mutating safe mode', () => {
    expect(parseMaintainArgs(['--safe', '--json'])).toMatchObject({
      safe: true,
      dryRun: false,
      json: true,
    });
  });

  test('--dry-run wins over --safe', () => {
    expect(parseMaintainArgs(['--safe', '--dry-run'])).toMatchObject({
      safe: true,
      dryRun: true,
    });
  });
});

describe('cycle freshness source extraction', () => {
  test('extracts stale source ids from doctor messages', () => {
    const checks: Check[] = [
      {
        name: 'cycle_freshness',
        status: 'fail',
        message: "Source 'brain-sync-remote-teffur' last cycled 40h ago. Run `gbrain dream --source <id>`.",
      },
      {
        name: 'cycle_freshness',
        status: 'fail',
        message: "Source 'wiki' last cycled 25h ago. Source 'wiki' last cycled 25h ago.",
      },
    ];

    expect(extractCycleFreshnessSourceIds(checks)).toEqual([
      'brain-sync-remote-teffur',
      'wiki',
    ]);
  });

  test('ignores ok and unrelated checks', () => {
    const checks: Check[] = [
      { name: 'cycle_freshness', status: 'ok', message: "Source 'fresh' last cycled recently." },
      { name: 'frontmatter_integrity', status: 'warn', message: "Source 'wiki' has frontmatter issues." },
    ];

    expect(extractCycleFreshnessSourceIds(checks)).toEqual([]);
  });
});

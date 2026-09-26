import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractCycleFreshnessSourceIds,
  parseMaintainArgs,
  runMaintain,
} from '../src/commands/maintain.ts';
import type { Check } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

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

// `gbrain maintain --json` owns the report: every embedded helper it runs must
// stay off stdout, or the JSON document is no longer parseable by the caller.
describe('runMaintain --json keeps stdout a single JSON document', () => {
  let engine: PGLiteEngine;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-maintain-json-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });

  test('the stale-extraction summary does not leak onto stdout in json mode', async () => {
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme builds widgets.' });
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice met [Acme](companies/acme) last week.' });
    await engine.executeRaw(`UPDATE pages SET links_extracted_at = NULL`);

    const out: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(' ')); });
    try {
      await withEnv({ GBRAIN_HOME: home }, () => runMaintain(engine, ['--safe', '--json']));
    } finally {
      spy.mockRestore();
    }
    const report = JSON.parse(out.join('\n')) as { actions: Array<{ name: string; status: string }> };
    expect(report.actions.some((a) => a.name === 'extract_stale' && a.status === 'applied')).toBe(true);
  });
});

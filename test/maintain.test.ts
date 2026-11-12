import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractCycleFreshnessSourceIds,
  MAINTAIN_SAFE_PHASES,
  maintainSafePhases,
  parseMaintainArgs,
  runMaintain,
} from '../src/commands/maintain.ts';
import type { CyclePhase } from '../src/core/cycle.ts';
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

// GST-2246: `--safe` once ran the whole dream cycle on the default source, page purge and paid phases included.
const UNSAFE_PHASES: CyclePhase[] = [
  'purge', 'embed', 'synthesize', 'patterns', 'extract_atoms', 'synthesize_concepts', 'propose_takes',
  'grade_takes', 'calibration_profile', 'edge_contradictions', 'claim_conflicts', 'drift', 'standing_questions',
  'chronicle', 'facts_drain', 'conversation_facts_backfill', 'enrich_thin', 'skillopt',
];
const NO_PROVIDERS = { embedding: false, decideConflict: false, fenceRepairModel: false, contentRepairModel: false };

describe('maintainSafePhases', () => {
  test('never includes the page purge or a paid phase', () => {
    expect(MAINTAIN_SAFE_PHASES.filter((phase) => UNSAFE_PHASES.includes(phase))).toEqual([]);
    for (const sourceId of ['default', 'wiki']) {
      expect(maintainSafePhases(sourceId, NO_PROVIDERS).phases.filter((phase) => UNSAFE_PHASES.includes(phase))).toEqual([]);
    }
  });

  test('a keyless brain runs the free fact and repair phases', () => {
    const { phases, held } = maintainSafePhases('default', NO_PROVIDERS);
    expect(phases).toEqual(expect.arrayContaining(['extract', 'extract_facts', 'fence_repair', 'content_repair', 'orphans']));
    expect(held).toEqual([]);
  });

  test('holds back each phase that would call a provider on this brain', () => {
    const { phases, held } = maintainSafePhases('default', { embedding: true, decideConflict: true, fenceRepairModel: true, contentRepairModel: true });
    expect(held).toEqual(['extract_facts', 'fence_repair', 'content_repair']);
    expect(phases.filter((phase) => held.includes(phase))).toEqual([]);
    expect(phases).toContain('extract');
  });

  test('an embedding provider alone holds the repair lanes too, whose publications embed', () => {
    const { held } = maintainSafePhases('default', { ...NO_PROVIDERS, embedding: true });
    expect(held).toEqual(['extract_facts', 'fence_repair', 'content_repair']);
  });

  test('a non-default source keeps its source-freshness subset', () => {
    expect(maintainSafePhases('wiki', NO_PROVIDERS).phases).toEqual(['lint', 'backlinks', 'sync', 'extract', 'extract_facts', 'recompute_emotional_weight']);
  });
});

describe('runMaintain --safe on a stale default source', () => {
  let engine: PGLiteEngine;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-maintain-safe-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });

  test('a page soft-deleted past the purge window survives, and no paid phase runs', async () => {
    await engine.putPage('notes/old', { type: 'concept', title: 'Old', compiled_truth: 'An old note.' });
    await engine.softDeletePage('notes/old');
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug = 'notes/old'`);
    const lastCycle = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1, config = config || jsonb_build_object('last_full_cycle_at', $2::text) WHERE id = 'default'`,
      [join(home, 'no-checkout'), lastCycle],
    );

    const out: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(' ')); });
    try {
      await withEnv({ GBRAIN_HOME: home }, () => runMaintain(engine, ['--safe', '--json']));
    } finally {
      spy.mockRestore();
    }
    const report = JSON.parse(out.join('\n')) as { actions: Array<{ name: string; status: string; details?: { source_id?: string; phases?: Array<{ phase: CyclePhase }> } }> };
    const cycle = report.actions.find((a) => a.name === 'cycle_freshness' && a.details?.source_id === 'default');
    expect(cycle?.status).toBe('applied');
    const rows = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE slug = 'notes/old' AND deleted_at IS NOT NULL`);
    expect(rows.map((r) => r.slug)).toEqual(['notes/old']);
    expect((cycle?.details?.phases ?? []).map((p) => p.phase).filter((phase) => UNSAFE_PHASES.includes(phase))).toEqual([]);
  });

  test('a keyless brain with the decide conflict slot on holds extract_facts, whose sweep calls the decision provider', async () => {
    const lastCycle = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    await engine.executeRaw(
      `UPDATE sources SET config = config || jsonb_build_object('last_full_cycle_at', $1::text) WHERE id = 'default'`,
      [lastCycle],
    );
    await engine.setConfig('decide.slots.conflict.mode', 'on');
    const out: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(' ')); });
    try {
      await withEnv({ GBRAIN_HOME: home }, () => runMaintain(engine, ['--json']));
    } finally {
      spy.mockRestore();
      await engine.unsetConfig('decide.slots.conflict.mode');
    }
    const report = JSON.parse(out.join('\n')) as { actions: Array<{ name: string; status: string; details?: { source_id?: string; phases?: CyclePhase[]; held_phases?: CyclePhase[] } }> };
    const cycle = report.actions.find((a) => a.name === 'cycle_freshness' && a.details?.source_id === 'default');
    expect(cycle?.status).toBe('would_apply');
    expect(cycle?.details?.held_phases).toContain('extract_facts');
    expect(cycle?.details?.phases).not.toContain('extract_facts');
  });
});

/** Named --only probes must not run another helper from the same integrity entry. */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { startDoctorDeadline } from '../src/commands/doctor/budget.ts';
import { runDoctorRegistry } from '../src/commands/doctor/registry.ts';
import { jsonbIntegrityEntry } from '../src/commands/doctor/checks/data-integrity.ts';

const NAMES = ['jsonb_integrity', 'takes_weight_grid', 'child_table_orphans', 'raw_provenance', 'source_config_shape'];
interface Probe { sql: string[]; heartbeats: string[] }

async function inspect(only: string[] | null, response?: (sql: string) => Promise<unknown[]>): Promise<{ probe: Probe; checks: Awaited<ReturnType<typeof runDoctorRegistry>> }> {
  const probe: Probe = { sql: [], heartbeats: [] };
  const engine = {
    kind: 'pglite',
    async executeRaw(sql: string) {
      probe.sql.push(sql);
      // This fake engine never connects, migrates, writes or invokes a provider.
      if (!/^SELECT\b/i.test(sql.trim())) throw new Error('read-only fake engine refuses non-SELECT');
      if (response) return response(sql);
      if (sql.includes('to_regclass')) return [{ exists: false }];
      if (sql.includes('AS off_grid')) return [{ total: 0, off_grid: 0 }];
      if (sql.includes('FROM sources')) return [];
      return [{ n: 0 }];
    },
  } as unknown as BrainEngine;
  const args = ['--json', '--budget-ms', '100', ...(only ? ['--only', only.join(',')] : [])];
  const ctx = {
    engine, args, jsonOutput: true, fastMode: false, doFix: false, dryRun: false,
    scope: 'brain', orphanRatioSourceId: undefined,
    progress: { heartbeat(name: string) { probe.heartbeats.push(name); }, finish() {} },
    skillsDirResolution: { dir: null, source: 'none' }, skillsDir: null,
    autoFixReport: null, schemaVersion: 0, connectionFailed: false,
    only: only ? new Set(only) : null, tier: 'standard', deadline: startDoctorDeadline(args),
  } as DoctorContext;
  return { probe, checks: await runDoctorRegistry(ctx, [jsonbIntegrityEntry]) };
}

function primaryHeartbeats(probe: Probe): string[] {
  return probe.heartbeats.filter(name => NAMES.includes(name));
}

function queriedHelpers(probe: Probe): string[] {
  return [...new Set(probe.sql.map(sql => {
    if (sql.includes('to_regclass')) return 'jsonb_integrity';
    if (sql.includes('AS off_grid')) return 'takes_weight_grid';
    if (sql.includes('FROM sources')) return 'source_config_shape';
    if (sql.includes('NOT EXISTS (SELECT 1 FROM pages p WHERE p.id =')) return 'child_table_orphans';
    if (sql.includes('FROM pages p WHERE')) return 'raw_provenance';
    throw new Error('unclassified fixture query');
  }))];
}

function cleanRows(sql: string): unknown[] {
  if (sql.includes('to_regclass')) return [{ exists: false }];
  if (sql.includes('AS off_grid')) return [{ total: 0, off_grid: 0 }];
  if (sql.includes('FROM sources')) return [];
  return [{ n: 0 }];
}

describe('doctor grouped integrity --only isolation', () => {
  for (const name of NAMES) {
    test(`--only ${name} reads only that helper`, async () => {
      const { probe, checks } = await inspect([name]);
      expect(primaryHeartbeats(probe)).toEqual([name]);
      expect(queriedHelpers(probe)).toEqual([name]);
      expect(checks.map(c => [c.name, c.status])).toEqual([[name, 'ok']]);
    });
  }

  test('a selected late check does not inherit an unselected JSONB query deadline', async () => {
    let unrelatedCalled = false;
    const { checks } = await inspect(['source_config_shape'], async sql => {
      if (sql.includes('to_regclass')) { unrelatedCalled = true; return new Promise(() => {}); }
      return cleanRows(sql);
    });
    expect(unrelatedCalled).toBe(false);
    expect(checks.map(c => [c.name, c.status])).toEqual([['source_config_shape', 'ok']]);
  });

  test('a selected subset preserves registry order and reads no other helper', async () => {
    const { probe, checks } = await inspect(['source_config_shape', 'takes_weight_grid']);
    expect(primaryHeartbeats(probe)).toEqual(['takes_weight_grid', 'source_config_shape']);
    expect(queriedHelpers(probe)).toEqual(['takes_weight_grid', 'source_config_shape']);
    expect(checks.map(c => c.name)).toEqual(['takes_weight_grid', 'source_config_shape']);
  });

  test('without --only the five original checks still run in order', async () => {
    const { probe, checks } = await inspect(null);
    expect(primaryHeartbeats(probe)).toEqual(NAMES);
    expect(queriedHelpers(probe)).toEqual(NAMES);
    expect(checks.map(c => [c.name, c.status])).toEqual(NAMES.map(name => [name, 'ok']));
  });

  test('selected off-grid takes still fail at the existing threshold', async () => {
    const { checks } = await inspect(['takes_weight_grid'], async sql => sql.includes('AS off_grid') ? [{ total: 10, off_grid: 2 }] : cleanRows(sql));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe('fail');
    expect(checks[0]!.message).toContain('2/10 takes off the 0.05 grid');
  });

  test('selected malformed source config remains a warning', async () => {
    const { checks } = await inspect(['source_config_shape'], async sql => sql.includes('FROM sources') ? [{ id: 'fixture-source', typ: 'string' }] : cleanRows(sql));
    expect(checks[0]!.status).toBe('warn');
    expect(checks[0]!.message).toContain('non-object config');
  });

  test('selected SQL errors remain visible instead of becoming clean', async () => {
    const { checks } = await inspect(['source_config_shape'], async sql => {
      if (sql.includes('FROM sources')) throw new Error('synthetic source probe refused');
      return cleanRows(sql);
    });
    expect(checks[0]!.status).toBe('warn');
    expect(checks[0]!.message).toContain('synthetic source probe refused');
  });

  test('a selected check that exhausts its own deadline remains unknown', async () => {
    const { checks } = await inspect(['source_config_shape'], async sql => sql.includes('FROM sources') ? new Promise(() => {}) : cleanRows(sql));
    expect(checks[0]!.status).toBe('warn');
    expect(checks[0]!.details).toMatchObject({ health: 'unknown', reason: 'budget', exact: false, budget_ms: 100 });
  });
});

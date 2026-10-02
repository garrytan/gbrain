/**
 * Explicit-only repair kinds (fix wave 5, ENG-O1(a) / DX-O4 / ENG-O13):
 * `stale-atoms` and `extractor-facts` are registered with `explicit_only`.
 * They run only when named; `gbrain repair --all`, the no-kind preview, the
 * remediation plan and the post-upgrade banner list them with their preview
 * command instead, and the runner refuses one that reaches it unnamed, so a
 * supplied remediation step cannot run it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { resolveRepairScope, runRepair, type RepairKind } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, EXPLICIT_REPAIR_REGISTRY, REPAIR_REGISTRY, repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { staleAtomsRepair } from '../src/core/repair/stale-atoms.ts';
import { planRepairSteps, runRepairSteps, type RepairPlanStep } from '../src/core/remediation/repairs.ts';
import { computeRemediationPlan } from '../src/core/remediation/index.ts';
import { classifyWaveFindings, renderRemediationPlanLines } from '../src/commands/doctor/remediate.ts';
import { bannerFindingLine } from '../src/commands/doctor/upgrade-banner.ts';
import type { WaveCheckSpec, WaveFinding } from '../src/commands/doctor/wave-checks.ts';
import { REPAIR_HELP, parseRepairArgs, runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const EXPLICIT: RepairKind[] = ['stale-atoms', 'extractor-facts'];
let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-explicit-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

async function captured(args: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await withEnv({ GBRAIN_HOME: home }, () => runRepairCommand(engine, args)); } finally { console.log = original; }
  return lines.join('\n');
}

/** A wave check whose findings an explicit-only kind clears (the lanes add the real check ids). */
function withExplicitCheck<T>(run: (spec: WaveCheckSpec) => T): T {
  const checks = repairSpec('stale-atoms').checks;
  checks.push('fixture_stale_atoms');
  const spec: WaveCheckSpec = { id: 'fixture_stale_atoms', resolution: 'repair', registration: 'wave', impact: 'fixture', count: d => Number(d.count ?? 0),
    run: async () => ({ name: 'fixture_stale_atoms', status: 'warn', message: 'stale atoms' }) };
  try { return run(spec); } finally { checks.pop(); }
}

describe('registry', () => {
  test('stale-atoms and extractor-facts are registered explicit-only and excluded from the --all set', () => {
    expect(EXPLICIT_REPAIR_REGISTRY.map(spec => spec.kind)).toEqual(EXPLICIT);
    for (const kind of EXPLICIT) expect(REPAIR_REGISTRY.map(spec => spec.kind)).toContain(kind);
    expect(AUTO_REPAIR_REGISTRY.some(spec => spec.explicit_only)).toBe(false);
    expect(AUTO_REPAIR_REGISTRY.length + EXPLICIT_REPAIR_REGISTRY.length).toBe(REPAIR_REGISTRY.length);
  });
});

describe('execution-time enforcement', () => {
  test('runRepair refuses an explicit-only handler that was not named, then previews it when named', async () => {
    const scope = await resolveRepairScope(engine);
    const ctx = { engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: true, remote: false } as unknown as OperationContext;
    const unnamed = await refusal(() => runRepair(ctx, staleAtomsRepair, scope, { apply: false }));
    expect(unnamed.toJSON()).toMatchObject({ error: 'explicit_kind_required', suggestion: 'Preview it on the brain host: gbrain repair stale-atoms',
      docs: 'docs/guides/repair.md#explicit-only-repair-kinds' });
    const named = await runRepair(ctx, staleAtomsRepair, scope, { apply: false, explicit: true });
    expect(named).toMatchObject({ kind: 'stale-atoms', mode: 'dry_run', affected: 0 });
  });

  test('the shared runner refuses an unnamed explicit-only kind', async () => {
    const runner = await repairRunner(engine, { apply: true, logger: { info() {}, warn() {}, error() {} } });
    const scope = await resolveRepairScope(engine);
    expect((await refusal(() => runner.run('extractor-facts', scope))).code).toBe('explicit_kind_required');
  });

  test('a supplied remediation step naming an explicit-only kind refuses the whole run before any step starts', async () => {
    const step = (kind: RepairPlanStep['kind'], n: number): RepairPlanStep => ({ step: n, id: `repair:${kind}`, kind, affected: 1, command: `gbrain repair ${kind} --apply`,
      requires_user_agreement: true, protected: true, paid: false, embeds: 'none', est_usd_cost: 0, lifetime_ids: 0, checks: [], rationale: 'supplied' });
    const started: string[] = [];
    for (const kind of EXPLICIT) {
      const error = await refusal(() => withEnv({ GBRAIN_HOME: home }, () => runRepairSteps(engine, [step('connector-checkpoints', 1), step(kind, 2)],
        { remote: false, remainingUsd: () => undefined, onStep: s => { started.push(s.kind); } })));
      expect(error.code).toBe('explicit_kind_required');
      expect(error.message).toContain(kind);
    }
    expect(started).toEqual([]);
  });
});

describe('surfaces that list instead of run', () => {
  test('gbrain repair --all and the no-kind preview never run explicit kinds and list their preview commands', async () => {
    for (const args of [['--all', '--json'], ['--json']]) {
      const out = JSON.parse(await captured(args)) as { results: Array<{ kind: string }>; explicit_kinds: Array<{ kind: string; code: string; preview_command: string }> };
      expect(out.results.map(r => r.kind)).toEqual(AUTO_REPAIR_REGISTRY.map(spec => spec.kind));
      expect(out.explicit_kinds).toEqual(EXPLICIT.map(kind => ({ kind, code: 'explicit_kind_required', preview_command: `gbrain repair ${kind}`,
        docs: 'docs/guides/repair.md#explicit-only-repair-kinds' })));
    }
    expect(await captured(['--all'])).toContain('Explicit-only kinds (not run without their name; preview each): gbrain repair stale-atoms; gbrain repair extractor-facts');
  });

  test('gbrain repair --all --apply exits 0 when explicit kinds are the only ones left', async () => {
    _resetCliExitVerdictForTests();
    const out = JSON.parse(await captured(['--all', '--apply', '--json'])) as { results: Array<{ kind: string; stopped?: unknown }> };
    expect(out.results.some(r => EXPLICIT.includes(r.kind as RepairKind))).toBe(false);
    expect(out.results.every(r => !r.stopped)).toBe(true);
    expect(currentExitCode()).toBe(0);
  });

  test('naming an explicit kind runs it (here: the extractor-facts preview) instead of explicit_kind_required', async () => {
    const out = JSON.parse(await captured(['extractor-facts', '--json'])) as { results: Array<{ kind: string; mode: string; affected: number }>; explicit_kinds?: unknown };
    expect(out.results).toMatchObject([{ kind: 'extractor-facts', mode: 'dry_run', affected: 0 }]);
    expect(out.explicit_kinds).toBeUndefined();
  });

  test('help marks explicit kinds with their preview and keeps them out of the --all list; --expect is accepted only for them', () => {
    expect(REPAIR_HELP).toContain('[explicit-only; preview: gbrain repair stale-atoms]');
    const allLine = REPAIR_HELP.split('\n').find(line => line.trimStart().startsWith('--all'))!;
    for (const kind of EXPLICIT) expect(allLine).not.toContain(kind);
    expect(parseRepairArgs(['stale-atoms', '--apply', '--expect', 'abc'])).toMatchObject({ kind: 'stale-atoms', apply: true, expect: 'abc' });
    expect(parseRepairArgs(['extractor-facts', '--include-ambiguous'])).toMatchObject({ includeAmbiguous: true });
    for (const args of [['timeline', '--expect', 'abc'], ['--all', '--expect', 'abc'], ['visibility', '--include-ambiguous']]) {
      expect(() => parseRepairArgs(args)).toThrow(/applies only to an explicit-only kind/);
    }
  });

  test('the remediation plan never plans explicit kinds and lists each with its preview command', async () => {
    expect((await planRepairSteps(engine)).some(step => EXPLICIT.includes(step.kind))).toBe(false);
    const plan = await withEnv({ GBRAIN_HOME: home }, () => computeRemediationPlan(engine, { repairs: {} }));
    expect(plan.repair_steps!.some(step => EXPLICIT.includes(step.kind))).toBe(false);
    expect(plan.explicit_repairs!.map(n => [n.kind, n.code, n.preview_command])).toEqual(EXPLICIT.map(kind => [kind, 'explicit_kind_required', `gbrain repair ${kind}`]));
    const text = renderRemediationPlanLines(plan, 90).join('\n');
    expect(text).toContain('Explicit-only repairs');
    expect(text).toContain('  stale-atoms: gbrain repair stale-atoms');
    expect(text).not.toContain('gbrain repair stale-atoms --apply');
  });

  test('the banner and the remediation classification report explicit_kind_required with the preview, never an apply', () => withExplicitCheck(spec => {
    const finding: WaveFinding = { spec, check: { name: spec.id, status: 'warn', message: 'stale atoms', details: { count: 3 } }, state: 'finding' };
    const line = bannerFindingLine(finding);
    expect(line).toBe('[AGENT]   fixture_stale_atoms: 3 (explicit_kind_required; preview with: gbrain repair stale-atoms)');
    expect(line).not.toContain('--apply');
    expect(classifyWaveFindings([finding], [finding], {})).toEqual([{ check_id: spec.id, message: 'stale atoms', class: 'explicit_kind_required',
      repair_kind: 'stale-atoms', command: 'gbrain repair stale-atoms' }]);
  }));
});

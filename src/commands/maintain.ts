/**
 * gbrain maintain — conservative self-healing maintenance.
 *
 * This command automates the safe parts of the operator runbook:
 *   - stale link/timeline extraction
 *   - stale per-source dream cycles when doctor reports cycle_freshness,
 *     limited to the free phases that never hard-delete (MAINTAIN_SAFE_PHASES)
 *
 * It deliberately does NOT mutate source files, apply schema-pack upgrades, or
 * invent semantic hub links. Those need review or a separate command with an
 * auditable proposal surface.
 */

import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import { isAvailable } from '../core/ai/gateway.ts';
import { fenceRepairLlmEnabled } from '../core/fence-repair/config.ts';
import { resolveFenceRepairModel } from '../core/fence-repair/model.ts';
import { resolveContentRepairModel } from '../core/content-repair/llm.ts';
import { loadConfigSnapshot } from '../core/config-snapshot.ts';
import { readDecideConfig } from '../core/ai/decide/config.ts';
import { hasTypesafeKey } from '../core/ai/decide/index.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { BrainHealth } from '../core/types.ts';
import { buildChecks, computeDoctorReport, type DoctorReport, type Check } from './doctor.ts';
import { extractStaleFromDB } from './extract.ts';
import { resolveCyclePhases, runCycle, type CycleReport, type CyclePhase } from '../core/cycle.ts';
import { ItemRun } from '../core/item-failure.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

type ActionStatus = 'ok' | 'would_apply' | 'applied' | 'blocked' | 'skipped';

export interface MaintenanceAction {
  name: string;
  status: ActionStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface MaintainOptions {
  json: boolean;
  safe: boolean;
  dryRun: boolean;
  help: boolean;
}

export interface MaintainReport {
  mode: 'dry-run' | 'safe';
  before: {
    health: BrainHealth;
    doctor: DoctorReport;
  };
  actions: MaintenanceAction[];
  after: {
    health: BrainHealth;
    doctor: DoctorReport;
  };
}

export function parseMaintainArgs(args: string[]): MaintainOptions {
  const safe = args.includes('--safe');
  return {
    json: args.includes('--json'),
    safe,
    dryRun: args.includes('--dry-run') || !safe,
    help: args.includes('--help') || args.includes('-h'),
  };
}

export function extractCycleFreshnessSourceIds(checks: Check[]): string[] {
  const ids = new Set<string>();
  for (const check of checks) {
    if (check.name !== 'cycle_freshness' || check.status === 'ok') continue;
    const re = /Source '([^']+)' last cycled/g;
    for (const match of check.message.matchAll(re)) {
      const id = match[1]?.trim();
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * The cycle phases `--safe` may run: free, and never hard-deleting. The page
 * purge and every phase that calls a model stay with `gbrain dream` and
 * `gbrain pages purge-deleted`.
 */
export const MAINTAIN_SAFE_PHASES: readonly CyclePhase[] = [
  'lint', 'backlinks', 'sync', 'fence_repair', 'content_repair', 'unindexed_files',
  'extract', 'extract_facts', 'resolve_symbol_edges', 'recompute_emotional_weight',
  'consolidate', 'orphans', 'schema-suggest',
];

/** Which providers a safe phase would call on this brain; those phases are held back. */
export interface SafePhaseProviders {
  embedding: boolean;
  decideConflict: boolean;
  fenceRepairModel: boolean;
  contentRepairModel: boolean;
}

export function maintainSafePhases(sourceId: string, providers: SafePhaseProviders): { phases: CyclePhase[]; held: CyclePhase[] } {
  const held: CyclePhase[] = [];
  if (providers.embedding || providers.decideConflict) held.push('extract_facts');
  if (providers.fenceRepairModel || providers.embedding) held.push('fence_repair');
  if (providers.contentRepairModel || providers.embedding) held.push('content_repair');
  const phases = resolveCyclePhases(undefined, sourceId)
    .filter((phase) => MAINTAIN_SAFE_PHASES.includes(phase) && !held.includes(phase));
  return { phases, held };
}

async function readSafePhaseProviders(engine: BrainEngine): Promise<SafePhaseProviders> {
  const repairLlm = await fenceRepairLlmEnabled(engine);
  return {
    embedding: isAvailable('embedding'),
    decideConflict: readDecideConfig(await loadConfigSnapshot(engine), { typesafeKey: hasTypesafeKey() }).slots.conflict.mode !== 'off',
    fenceRepairModel: repairLlm && (await resolveFenceRepairModel(engine)) !== null,
    contentRepairModel: repairLlm && (await resolveContentRepairModel(engine)) !== null,
  };
}

async function buildDoctorReport(engine: BrainEngine): Promise<DoctorReport> {
  const checks = await buildChecks(engine, ['--json', '--scope=brain']);
  return computeDoctorReport(checks);
}

async function runStaleExtraction(
  engine: BrainEngine,
  beforeHealth: BrainHealth,
  dryRun: boolean,
  json: boolean,
): Promise<MaintenanceAction> {
  if (beforeHealth.stale_pages <= 0) {
    return { name: 'extract_stale', status: 'ok', message: 'No stale pages.' };
  }

  if (dryRun) {
    return {
      name: 'extract_stale',
      status: 'would_apply',
      message: `Would run DB-backed stale extraction for ${beforeHealth.stale_pages} page(s).`,
      details: { stale_pages: beforeHealth.stale_pages },
    };
  }

  // maintain owns the report: in --json mode the helper's human summary must
  // stay off stdout or the JSON document stops parsing.
  const result = await extractStaleFromDB(engine, {
    dryRun: false,
    jsonMode: false,
    quiet: json,
    catchUp: false,
  });

  return {
    name: 'extract_stale',
    status: 'applied',
    message: `Processed ${result.pagesProcessed} stale page(s); ${result.staleRemaining} remain.`,
    details: {
      links_created: result.linksCreated,
      timeline_created: result.timelineCreated,
      pages_processed: result.pagesProcessed,
      stale_remaining: result.staleRemaining,
    },
  };
}

async function runCycleFreshnessMaintenance(
  engine: BrainEngine,
  beforeDoctor: DoctorReport,
  dryRun: boolean,
): Promise<MaintenanceAction[]> {
  const sourceIds = extractCycleFreshnessSourceIds(beforeDoctor.checks);
  if (sourceIds.length === 0) {
    return [{ name: 'cycle_freshness', status: 'ok', message: 'All sources cycled recently.' }];
  }

  const providers = await readSafePhaseProviders(engine);
  if (dryRun) {
    return sourceIds.map((sourceId) => {
      const { phases, held } = maintainSafePhases(sourceId, providers);
      return {
        name: 'cycle_freshness',
        status: 'would_apply',
        message: `Would run the free source cycle for ${sourceId} (no page purge, no paid phases).`,
        details: { source_id: sourceId, phases, held_phases: held },
      };
    });
  }

  const sources = await engine.listAllSources();
  const actions: MaintenanceAction[] = [];
  // One source's cycle throwing blocks that source only; a run-scoped error (abort, lost lock or connection) still stops maintain.
  const run = new ItemRun('maintain.cycle_sources');

  for (const sourceId of sourceIds) {
    const source = sources.find((s) => s.id === sourceId);
    const localPath = source?.local_path ?? null;
    // #7630: a relative local_path names whatever directory maintain runs from, so it is no checkout.
    const brainDir = localPath && isAbsolute(localPath) && existsSync(localPath) ? localPath : null;
    const { phases, held } = maintainSafePhases(sourceId, providers);
    let report: CycleReport;
    try {
      report = await runCycle(engine, {
        brainDir,
        dryRun: false,
        pull: false,
        sourceId,
        phases,
      });
      run.succeed();
    } catch (error) {
      const failure = run.fail(sourceId, error);
      actions.push({
        name: 'cycle_freshness',
        status: 'blocked',
        message: `Source-scoped dream cycle for ${sourceId} stopped with ${failure.code}: ${failure.message}`,
        details: { source_id: sourceId, brain_dir: brainDir, code: failure.code, error: failure.message, fix: { argv: ['gbrain', 'dream', '--source', sourceId], consent: ['paid'], actor: 'agent', requires_exclusive: false,
          why: `Reruns the source-scoped dream cycle for ${sourceId} once the cause above is fixed; its paid phases spend only within their configured caps.` } },
      });
      continue;
    }
    actions.push({
      name: 'cycle_freshness',
      status: report.status === 'failed' ? 'blocked' : 'applied',
      message: `Ran the free source cycle for ${sourceId}: ${report.status}.`,
      details: {
        source_id: sourceId,
        brain_dir: brainDir,
        cycle_status: report.status,
        phases: report.phases.map((p) => ({ phase: p.phase, status: p.status })),
        held_phases: held,
      },
    });
  }

  return actions;
}

export async function runMaintain(engine: BrainEngine, args: string[]): Promise<MaintainReport | void> {
  const opts = parseMaintainArgs(args);
  if (opts.help) {
    console.log(`Usage: gbrain maintain [--safe] [--dry-run] [--json]

Conservative self-healing maintenance.

Modes:
  --dry-run   Preview safe actions without writes. Default when --safe is absent.
  --safe      Apply safe actions: stale extraction and source cycle freshness.
  --json      Emit a structured before/action/after report.

Not auto-applied:
  source-file frontmatter fixes, schema-pack upgrades, atom-pack changes,
  semantic hub-link guesses, and destructive cleanup.
  The source cycle skips the page purge (\`gbrain pages purge-deleted\`) and
  every phase that calls a model (\`gbrain dream\`).
`);
    return;
  }

  const beforeHealth = await engine.getHealth();
  const beforeDoctor = await buildDoctorReport(engine);
  const actions: MaintenanceAction[] = [];

  actions.push(await runStaleExtraction(engine, beforeHealth, opts.dryRun, opts.json));
  actions.push(...await runCycleFreshnessMaintenance(engine, beforeDoctor, opts.dryRun));

  const afterHealth = await engine.getHealth();
  const afterDoctor = await buildDoctorReport(engine);
  const report: MaintainReport = {
    mode: opts.dryRun ? 'dry-run' : 'safe',
    before: { health: beforeHealth, doctor: beforeDoctor },
    actions,
    after: { health: afterHealth, doctor: afterDoctor },
  };
  if (actions.some((action) => action.status === 'blocked')) setCliExitVerdict(1);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printMaintainReport(report);
  }
  return report;
}

function printMaintainReport(report: MaintainReport): void {
  console.log(`GBrain maintain (${report.mode})`);
  console.log(
    `Before: brain_score=${Math.round(report.before.health.brain_score)}/100 ` +
    `stale=${report.before.health.stale_pages} islands=${report.before.health.orphan_pages} ` +
    `doctor=${report.before.doctor.status}`,
  );
  for (const action of report.actions) {
    console.log(`  ${action.status}: ${action.name} — ${action.message}`);
  }
  console.log(
    `After:  brain_score=${Math.round(report.after.health.brain_score)}/100 ` +
    `stale=${report.after.health.stale_pages} islands=${report.after.health.orphan_pages} ` +
    `doctor=${report.after.doctor.status}`,
  );
  if (report.mode === 'dry-run') {
    console.log('Run `gbrain maintain --safe` to apply safe actions.');
  }
}

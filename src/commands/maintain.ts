/**
 * gbrain maintain — conservative self-healing maintenance.
 *
 * This command automates the safe parts of the operator runbook:
 *   - stale link/timeline extraction
 *   - stale per-source dream cycles when doctor reports cycle_freshness
 *
 * It deliberately does NOT mutate source files, apply schema-pack upgrades, or
 * invent semantic hub links. Those need review or a separate command with an
 * auditable proposal surface.
 */

import { existsSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import type { BrainHealth } from '../core/types.ts';
import { buildChecks, computeDoctorReport, type DoctorReport, type Check } from './doctor.ts';
import { extractStaleFromDB } from './extract.ts';
import { runCycle, type CycleReport } from '../core/cycle.ts';

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

async function buildDoctorReport(engine: BrainEngine): Promise<DoctorReport> {
  const checks = await buildChecks(engine, ['--json', '--scope=brain']);
  return computeDoctorReport(checks);
}

async function runStaleExtraction(
  engine: BrainEngine,
  beforeHealth: BrainHealth,
  dryRun: boolean,
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

  const result = await extractStaleFromDB(engine, {
    dryRun: false,
    jsonMode: false,
    includeFrontmatter: false,
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

  if (dryRun) {
    return sourceIds.map((sourceId) => ({
      name: 'cycle_freshness',
      status: 'would_apply',
      message: `Would run source-scoped dream cycle for ${sourceId}.`,
      details: { source_id: sourceId },
    }));
  }

  const sources = await engine.listAllSources();
  const actions: MaintenanceAction[] = [];

  for (const sourceId of sourceIds) {
    const source = sources.find((s) => s.id === sourceId);
    const localPath = source?.local_path ?? null;
    const brainDir = localPath && existsSync(localPath) ? localPath : null;
    const report: CycleReport = await runCycle(engine, {
      brainDir,
      dryRun: false,
      pull: false,
      sourceId,
    });
    actions.push({
      name: 'cycle_freshness',
      status: report.status === 'failed' ? 'blocked' : 'applied',
      message: `Ran source-scoped dream cycle for ${sourceId}: ${report.status}.`,
      details: {
        source_id: sourceId,
        brain_dir: brainDir,
        cycle_status: report.status,
        phases: report.phases.map((p) => ({ phase: p.phase, status: p.status })),
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
`);
    return;
  }

  const beforeHealth = await engine.getHealth();
  const beforeDoctor = await buildDoctorReport(engine);
  const actions: MaintenanceAction[] = [];

  actions.push(await runStaleExtraction(engine, beforeHealth, opts.dryRun));
  actions.push(...await runCycleFreshnessMaintenance(engine, beforeDoctor, opts.dryRun));

  const afterHealth = await engine.getHealth();
  const afterDoctor = await buildDoctorReport(engine);
  const report: MaintainReport = {
    mode: opts.dryRun ? 'dry-run' : 'safe',
    before: { health: beforeHealth, doctor: beforeDoctor },
    actions,
    after: { health: afterHealth, doctor: afterDoctor },
  };

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

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
import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import type { BrainHealth } from '../core/types.ts';
import { buildChecks, computeDoctorReport, type DoctorReport, type Check } from './doctor.ts';
import { extractStaleFromDB } from './extract.ts';
import { runCycle, type CycleReport } from '../core/cycle.ts';
import { maintainSafePhases, readSafePhaseProviders, isValidRunnerName, runUnattendedMaintenance, type UpkeepOutcome } from '../core/maintenance/run.ts';
import { readUpkeepStatus } from '../core/maintenance/status.ts';
import { cliRenderContext, noticeBlock, renderAction, renderNotice, type Action } from '../core/agent-output.ts';
import { ItemRun } from '../core/item-failure.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { opError } from '../core/ops/contract.ts';
import { autoDetectSkillsDirReadOnly } from '../core/repo-root.ts';
import { skillHealthSummary } from '../core/skill-health.ts';

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
  unattended: boolean;
  runner: string;
  status: boolean;
  purge: boolean;
  yes: boolean;
  expect: string | null;
}

function flagValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i >= 0) return args[i + 1] ?? '';
  const eq = args.find((a) => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : null;
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
    unattended: args.includes('--unattended'),
    runner: flagValue(args, '--runner') ?? 'cli',
    status: args.includes('--status'),
    purge: args.includes('--purge'),
    yes: args.includes('--yes'),
    expect: flagValue(args, '--expect'),
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

// The step list --safe shares with unattended upkeep lives in the runner core.
export { MAINTAIN_SAFE_PHASES, maintainSafePhases, type SafePhaseProviders } from '../core/maintenance/run.ts';

async function buildDoctorReport(engine: BrainEngine): Promise<DoctorReport> {
  const checks = await buildChecks(engine, ['--json', '--scope=brain']);
  return computeDoctorReport(checks);
}

/** Read-only: skill size, growth and drift for the active skills folder; never edits a skill. */
async function reportSkillHealth(): Promise<MaintenanceAction> {
  const dir = autoDetectSkillsDirReadOnly().dir;
  if (!dir) return { name: 'skill_health', status: 'skipped', message: 'no skills folder found' };
  const { skillHealthFor } = await import('./skillpack/health.ts');
  const report = skillHealthFor(dir);
  const message = skillHealthSummary(report) + (report.findings.length ? '; run `gbrain skillpack health` for the fixes' : '');
  return { name: 'skill_health', status: 'ok', message, details: { scope: report.scope, totals: report.totals } };
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
       gbrain maintain --unattended [--runner <name>] [--json]
       gbrain maintain --status [--json]
       gbrain maintain --purge [--yes --expect <hash>] [--json]
       gbrain maintain --schedule [--yes | --dry-run] [--json]
       gbrain maintain --unschedule [--json]

Conservative self-healing maintenance.

Modes:
  --dry-run     Preview safe actions without writes. Default when --safe is absent.
  --safe        Apply safe actions: stale extraction and source cycle freshness.
                Skill health (size, growth, drift) is reported, never applied.
  --unattended  Run free upkeep once when it is due: links, timeline, facts index,
                bookkeeping GC and, with an embedding key, the embedding backlog
                within maintenance.embed_daily_usd (default $1 a day; 0 = off).
                Never purges a page or calls a chat model. Records
                maintenance.last_run; --runner names the caller (default cli).
  --status      Show the last upkeep run, the next due time and what waits for you.
  --purge       Preview the page purge (soft-deleted pages past purge.retention_hours);
                apply it with --yes --expect <hash> from the preview.
  --schedule    Opt in to an operating-system schedule (launchd, systemd user timer or
                crontab) that runs --unattended every 6 hours; --yes approves the
                install, --dry-run shows what it writes. A running gbrain serve
                already runs free upkeep while idle, so most installs need none.
  --unschedule  Remove that schedule.
  --json        Emit a structured before/action/after report.

Not auto-applied:
  source-file frontmatter fixes, schema-pack upgrades, atom-pack changes,
  semantic hub-link guesses, and destructive cleanup.
  The source cycle skips the page purge (\`gbrain pages purge-deleted\`) and
  every phase that calls a model (\`gbrain dream\`).
`);
    return;
  }
  if (opts.unattended) return void await runUnattendedCli(engine, opts);
  if (opts.status) return void await runStatusCli(engine, opts);
  if (opts.purge) return void await runPurgeCli(engine, opts);

  const beforeHealth = await engine.getHealth();
  const beforeDoctor = await buildDoctorReport(engine);
  const actions: MaintenanceAction[] = [];

  actions.push(await runStaleExtraction(engine, beforeHealth, opts.dryRun, opts.json));
  actions.push(...await runCycleFreshnessMaintenance(engine, beforeDoctor, opts.dryRun));
  actions.push(await reportSkillHealth());

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

function printNotice(code: string, why: string, fix: Action | undefined): void {
  process.stderr.write(noticeBlock(renderNotice({ code, kind: 'info', why, ...(fix ? { fix } : {}) }, cliRenderContext())) + '\n');
}

async function runUnattendedCli(engine: BrainEngine, opts: MaintainOptions): Promise<UpkeepOutcome | void> {
  if (!isValidRunnerName(opts.runner)) {
    console.error(`--runner must be a short lowercase name (letters, digits, - or _), got "${opts.runner}".`);
    setCliExitVerdict(2);
    return;
  }
  const outcome = await runUnattendedMaintenance(engine, { runner: opts.runner });
  if (outcome.exit) setCliExitVerdict(outcome.exit);
  if (opts.json) {
    console.log(JSON.stringify({ ...outcome, ...(outcome.fix ? { fix: renderAction(outcome.fix, cliRenderContext()) } : {}) }, null, 2));
    return outcome;
  }
  console.log(outcome.message);
  for (const step of outcome.record?.steps ?? []) {
    if (outcome.status !== 'ran') break;
    console.log(`  ${step.status}: ${step.name} (${step.scope})${step.code ? ` ${step.code}` : step.reason ? ` ${step.reason}` : ''}`);
  }
  if (outcome.status === 'skipped' && outcome.code) printNotice(outcome.code, outcome.message, outcome.fix);
  return outcome;
}

async function runStatusCli(engine: BrainEngine, opts: MaintainOptions): Promise<void> {
  const status = await readUpkeepStatus(engine);
  const { fix, alternative_fix: alternative, ...rest } = status;
  if (opts.json) {
    console.log(JSON.stringify({ ...rest, ...(fix ? { fix: renderAction(fix, cliRenderContext()) } : {}),
      ...(alternative ? { alternative_fix: renderAction(alternative, cliRenderContext()) } : {}) }, null, 2));
    return;
  }
  console.log(status.message);
  if (status.last_run) console.log(`Last run: ${status.last_run} (${status.runner}), next due: ${status.next_due_at}`);
  for (const p of status.parked) console.log(`Parked: ${p.key} since ${p.since} (${p.slices} slices)`);
  if (status.held.length) console.log(`Held back on this brain (they would call a provider): ${status.held.join(', ')}`);
  console.log(`Left for you (paid, opt-in; gbrain dream or an autopilot runs them): ${status.paid_phases_opt_in.join(', ')}`);
  if (fix) console.log(`Fix: ${fix.argv!.join(' ')}: ${fix.why}`);
  if (alternative) console.log(`Or: ${alternative.argv!.join(' ')}: ${alternative.why}`);
}

/** Hash of exactly what a purge would remove, so --expect binds the apply to the preview the person saw. */
export function purgePreviewHash(retentionHours: number, pages: ReadonlyArray<{ source_id?: string; slug: string }>): string {
  const keys = pages.map((p) => `${p.source_id ?? 'default'}/${p.slug}`).sort();
  return createHash('sha256').update(JSON.stringify({ retentionHours, keys })).digest('hex').slice(0, 12);
}

async function runPurgeCli(engine: BrainEngine, opts: MaintainOptions): Promise<void> {
  const [{ selectPurgeCandidates, purgeDeletedPagesCoordinated }, { readPurgeRetentionHours }] = await Promise.all([
    import('../core/persistence/purge-deleted.ts'), import('../core/sync-reconcile.ts')]);
  const retention = await readPurgeRetentionHours(engine);
  const selection = await selectPurgeCandidates(engine, retention, { automatic: true });
  const pages: Array<{ source_id: string; slug: string }> = (selection.managed ? selection.candidates : selection.pages ?? [])
    .map((p) => ({ source_id: p.source_id, slug: p.slug }));
  const hash = purgePreviewHash(retention, pages);
  const apply = ['gbrain', 'maintain', '--purge', '--yes', '--expect', hash];
  if (!opts.yes) {
    const preview = { mode: 'preview', retention_hours: retention, count: pages.length, pages: pages.slice(0, 50), blocked: selection.blocked.length, hash,
      ...(pages.length ? { apply: renderAction({ argv: apply, consent: ['destructive'], actor: 'agent', requires_exclusive: false,
        why: `Permanently deletes the ${pages.length} page(s) listed (soft-deleted more than ${retention}h ago); gbrain restore cannot bring them back.` }, cliRenderContext()) } : {}) };
    if (opts.json) { console.log(JSON.stringify(preview, null, 2)); return; }
    console.log(`${pages.length} soft-deleted page(s) are past the ${retention}h recovery window.`);
    for (const p of pages.slice(0, 50)) console.log(`  ${p.source_id}/${p.slug}`);
    if (pages.length > 50) console.log(`  ...and ${pages.length - 50} more`);
    if (pages.length) console.log(`Nothing was deleted. To purge exactly these, run: ${apply.join(' ')}`);
    return;
  }
  if (opts.expect !== hash) {
    const why = opts.expect ? `The purge set changed since the preview (expected ${opts.expect}, now ${hash}); nothing was deleted.` : 'A purge needs --expect <hash> from the preview; nothing was deleted.';
    const fix: Action = { argv: ['gbrain', 'maintain', '--purge'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the current purge set and its hash; it deletes nothing.' };
    setCliExitVerdict(writeCliError(opError('preview_changed', why, 'Preview again: gbrain maintain --purge', { fix, detail: `current hash ${hash}` }), 'maintain', { json: !!opts.json }));
    return;
  }
  const previewed = new Set(pages.map((p) => `${p.source_id}/${p.slug}`));
  const result = await purgeDeletedPagesCoordinated(engine, retention, { automatic: true, only: (p) => previewed.has(`${p.source_id}/${p.slug}`) });
  if (result.error) setCliExitVerdict(1);
  if (opts.json) { console.log(JSON.stringify({ mode: 'applied', purged: result.count, slugs: result.slugs, blocked: result.blocked, deferred: result.deferred, ...(result.error ? { error: result.error } : {}) }, null, 2)); return; }
  console.log(`Purged ${result.count} page(s).${result.blocked.length ? ` ${result.blocked.length} blocked; see --json.` : ''}`);
}

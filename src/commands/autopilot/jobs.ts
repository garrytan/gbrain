/**
 * #5195: one brain's autopilot job definitions on every install target.
 * Reads and replaces the launchd plist, systemd unit, ephemeral start script and
 * crontab lines that belong to a brain, judged by the job name it resolves
 * (`resolveAutopilotJob`) and by the wrapper path each definition runs. Split
 * out of src/commands/autopilot.ts, which installs, uninstalls and reports.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve as resolvePath } from 'path';
import { execSync } from '../../core/spawn.ts';
import {
  autopilotLaunchdLabel,
  autopilotWrapperOwner,
  DEFAULT_AUTOPILOT_SYSTEMD_UNIT,
  type AutopilotJob,
} from '../../core/autopilot-paths.ts';
import { errorFor } from '../../core/errors.ts';
import type { InstallTarget } from '../autopilot.ts';

export function plistPath(label: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- label is grammar-checked by autopilotLaunchdLabel(); HOME is the operator's own
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', `${label}.plist`);
}

export function systemdUnitPath(unit: string = DEFAULT_AUTOPILOT_SYSTEMD_UNIT): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- unit is a constant or derived from the hex install id
  return join(process.env.HOME || '', '.config', 'systemd', 'user', unit);
}

/** The pre-#5195 shared start script, which every brain used to overwrite. */
export function legacyStartScriptPath(): string {
  return join(process.env.HOME || '', '.gbrain', 'start-autopilot.sh');
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
export const unshellQuote = (s: string) => s.replace(/'\\''/g, "'");

/** The wrapper a launchd plist runs (its first ProgramArguments entry). */
export function plistWrapperPath(plist: string): string | null {
  const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist);
  if (!m) return null;
  return m[1].replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** The wrapper a systemd unit runs. */
export function unitWrapperPath(unit: string): string | null {
  return /^ExecStart=(.+)$/m.exec(unit)?.[1].trim() || null;
}

/** The autopilot wrapper a crontab line or start script names, if any. */
export function scriptWrapperPath(text: string): string | null {
  const quoted = /'((?:[^']|'\\'')*autopilot-run\.sh)'/.exec(text);
  if (quoted) return unshellQuote(quoted[1]);
  return /(\S*autopilot-run\.sh)/.exec(text)?.[1] ?? null;
}

/**
 * #5195: does this crontab line belong to this brain's job? A marked line
 * (`# gbrain-autopilot:<suffix>`) belongs to the brain with that suffix. An
 * unmarked line predates per-brain names: it belongs to the brain whose
 * wrapper it names, and to the default brain when it names none.
 */
export function cronLineBelongsToBrain(line: string, job: AutopilotJob): boolean {
  if (!crontabIndicatesAutopilotInstall(line)) return false;
  const marker = /#\s*gbrain-autopilot:([A-Za-z0-9]+)\s*$/.exec(line);
  if (marker) return job.suffix !== null && marker[1] === job.suffix;
  const wrapper = scriptWrapperPath(line);
  if (!wrapper) return job.kind === 'default';
  return autopilotWrapperOwner(wrapper, job.homeDir).owner === 'own';
}

/** `GBRAIN_HOME=<parent> gbrain autopilot <verb>` for the brain whose home is `brainHome`. */
export function brainCommand(brainHome: string, verb: string): string {
  const parent = dirname(brainHome);
  const defaultHome = join(process.env.HOME || '', '.gbrain');
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- path comparison only, no fs access
  return resolvePath(brainHome) === resolvePath(defaultHome)
    ? `gbrain autopilot ${verb}`
    : `GBRAIN_HOME=${shellQuote(parent)} gbrain autopilot ${verb}`;
}

/**
 * ENG-O11: before replacing a job, make sure its wrapper names this brain. A
 * job whose wrapper belongs to another live brain is that brain's supervision;
 * replacing it would silently stop it (the #5195 failure).
 */
export function refuseForeignJob(jobName: string, wrapperPath: string | null, job: AutopilotJob): void {
  const owner = autopilotWrapperOwner(wrapperPath, job.homeDir);
  if (owner.owner !== 'other') return;
  throw errorFor({
    class: 'AutopilotJobOwnedByOtherBrain',
    code: 'autopilot_job_owned_by_other_brain',
    message: `The autopilot job ${jobName} runs the brain at ${owner.home}, not this brain at ${job.homeDir}.`,
    hint: `Give that brain its own job first: ${brainCommand(owner.home, '--install')}; then re-run: ${brainCommand(job.homeDir, '--install')}`,
    docs_url: 'docs/guides/live-sync.md#several-brains-on-one-host',
  });
}

export function readIfExists(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

export function detectOpenClaw(): { detected: boolean; bootstrapCandidates: string[] } {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.OPENCLAW_HOME ? join(process.env.OPENCLAW_HOME, 'hooks', 'bootstrap', 'ensure-services.sh') : '',
    join(process.cwd(), 'hooks', 'bootstrap', 'ensure-services.sh'),
    join(home, '.claude', 'hooks', 'bootstrap', 'ensure-services.sh'),
  ].filter(Boolean) as string[];
  const existing = candidates.filter(p => existsSync(p));
  const signal = !!process.env.OPENCLAW_HOME
    || existsSync(join(process.cwd(), 'openclaw.json'))
    || existsSync(join(home, 'openclaw.json'))
    || existing.length > 0;
  return { detected: signal, bootstrapCandidates: existing };
}

export const BOOTSTRAP_MARKER = '# gbrain:autopilot v0.11.0';

/**
 * Remove the bootstrap lines that launch `scriptPath` (the marker line and the
 * `bash <script>` line after it) from every OpenClaw bootstrap candidate.
 * Another brain's injected lines name its own script and are left alone.
 */
export function stripBootstrapLines(scriptPath: string): number {
  let removed = 0;
  try {
    const { bootstrapCandidates } = detectOpenClaw();
    for (const candidate of bootstrapCandidates) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        if (!content.includes(`${BOOTSTRAP_MARKER}\nbash ${scriptPath}`)) continue;
        const lines = content.split('\n');
        const cleaned: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(BOOTSTRAP_MARKER) && lines[i + 1] === `bash ${scriptPath}`) {
            // Skip this marker line AND the next line (the bash start-script call).
            i++;
            continue;
          }
          cleaned.push(lines[i]);
        }
        // Backup before edit
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        writeFileSync(`${candidate}.bak.${stamp}`, content);
        writeFileSync(candidate, cleaned.join('\n'));
        console.log(`Removed bootstrap marker from: ${candidate}`);
        removed++;
      } catch (e) {
        console.error(`  [warn] bootstrap ${candidate}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch { /* OpenClaw detection best-effort */ }
  return removed;
}

/**
 * #5195: a non-default brain installed by an older gbrain ran under the shared
 * job name. Installing it again on the same target removes that shared job —
 * only when its wrapper names this brain — before the brain's own job is
 * written, and says so. Crontab lines are handled by installCrontab.
 */
export function replaceLegacySharedJob(job: AutopilotJob, target: InstallTarget): void {
  if (job.kind === 'default') return;
  const own = (wrapper: string | null) => autopilotWrapperOwner(wrapper, job.homeDir).owner === 'own';
  if (target === 'macos') {
    const legacyLabel = autopilotLaunchdLabel(null);
    const path = plistPath(legacyLabel);
    if (legacyLabel === job.launchdLabel || !own(plistWrapperPath(readIfExists(path) ?? ''))) return;
    execSync(`launchctl unload "${path}" 2>/dev/null || true`, { stdio: 'pipe' });
    unlinkSync(path);
    console.log(`Replaced the shared launchd job ${legacyLabel}, which ran this brain, with ${job.launchdLabel}.`);
  } else if (target === 'linux-systemd') {
    const path = systemdUnitPath(DEFAULT_AUTOPILOT_SYSTEMD_UNIT);
    if (!own(unitWrapperPath(readIfExists(path) ?? ''))) return;
    execSync(`systemctl --user disable --now ${DEFAULT_AUTOPILOT_SYSTEMD_UNIT} 2>/dev/null || true`, { stdio: 'pipe', timeout: 10_000 });
    unlinkSync(path);
    console.log(`Replaced the shared systemd unit ${DEFAULT_AUTOPILOT_SYSTEMD_UNIT}, which ran this brain, with ${job.systemdUnit}.`);
  } else if (target === 'ephemeral-container') {
    const path = legacyStartScriptPath();
    if (path === job.startScriptPath || !own(scriptWrapperPath(readIfExists(path) ?? ''))) return;
    unlinkSync(path);
    stripBootstrapLines(path);
    console.log(`Replaced the shared start script ${path}, which ran this brain, with ${job.startScriptPath}.`);
    console.log(`  Update any bootstrap line that runs \`bash ${path}\` to run \`bash ${job.startScriptPath}\`.`);
  }
}

export interface InstalledJob {
  target: InstallTarget;
  /** launchd label, systemd unit, start-script path, or the crontab marker. */
  name: string;
  wrapperPath: string | null;
  /** A pre-#5195 shared-name job that runs this non-default brain. */
  legacy: boolean;
}

/**
 * Which supervisor, if any, currently holds THIS brain's autopilot job (#5195).
 *
 * Checks every target `installDaemon` can produce. The prior version grepped
 * crontab ONLY on non-darwin, so systemd-user and ephemeral-container installs
 * read as "not installed" — cosmetic while status always exited 0, but a hard
 * false failure once the exit code became load-bearing. A shared job whose
 * wrapper runs another live brain is reported separately, never as this
 * brain's install.
 */
export function detectInstalledJob(job: AutopilotJob): { installed: InstalledJob | null; foreign: { name: string; home: string } | null } {
  let foreign: { name: string; home: string } | null = null;
  const assigned = job.kind !== 'unassigned';
  const consider = (target: InstallTarget, name: string, text: string | null, wrapperOf: (t: string) => string | null, legacy: boolean): InstalledJob | null => {
    if (text === null) return null;
    const wrapperPath = wrapperOf(text);
    const owner = autopilotWrapperOwner(wrapperPath, job.homeDir);
    if (legacy) return owner.owner === 'own' ? { target, name, wrapperPath, legacy } : null;
    if (owner.owner === 'other') {
      foreign ??= { name, home: owner.home };
      return null;
    }
    return { target, name, wrapperPath, legacy };
  };
  const candidates: Array<() => InstalledJob | null> = [];
  if (process.platform === 'darwin') {
    if (assigned) candidates.push(() => consider('macos', job.launchdLabel, readIfExists(plistPath(job.launchdLabel)), plistWrapperPath, false));
    if (job.kind !== 'default' && (!assigned || autopilotLaunchdLabel(null) !== job.launchdLabel)) {
      candidates.push(() => consider('macos', autopilotLaunchdLabel(null), readIfExists(plistPath(autopilotLaunchdLabel(null))), plistWrapperPath, true));
    }
  }
  if (assigned) candidates.push(() => consider('linux-systemd', job.systemdUnit, readIfExists(systemdUnitPath(job.systemdUnit)), unitWrapperPath, false));
  if (job.kind !== 'default') candidates.push(() => consider('linux-systemd', DEFAULT_AUTOPILOT_SYSTEMD_UNIT, readIfExists(systemdUnitPath(DEFAULT_AUTOPILOT_SYSTEMD_UNIT)), unitWrapperPath, true));
  if (assigned) candidates.push(() => consider('ephemeral-container', job.startScriptPath, readIfExists(job.startScriptPath), scriptWrapperPath, false));
  if (job.kind !== 'default') candidates.push(() => consider('ephemeral-container', legacyStartScriptPath(), readIfExists(legacyStartScriptPath()), scriptWrapperPath, true));
  candidates.push(() => {
    try {
      const crontab = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
      if (!crontabIndicatesAutopilotInstall(crontab)) return null;
      const line = crontab.split('\n').find(l => cronLineBelongsToBrain(l, job));
      if (!line) return null;
      const legacy = job.cronMarker !== null && !line.includes(job.cronMarker);
      return { target: 'linux-cron', name: job.cronMarker ?? 'crontab entry', wrapperPath: scriptWrapperPath(line), legacy };
    } catch { return null; /* no crontab */ }
  });
  for (const candidate of candidates) {
    const installed = candidate();
    if (installed) return { installed, foreign };
  }
  return { installed: null, foreign };
}

/**
 * Does this crontab contain an autopilot INSTALL line? The installed line
 * invokes the generated wrapper (autopilot-run.sh); older installs called
 * `gbrain autopilot` directly — match either. But the docs also recommend
 * cron-ing `gbrain autopilot --status` as a health monitor, and counting THAT
 * line as an install makes a monitor-only machine report installed/never_run
 * with exit 1 forever. Comments never count. Pure and exported for tests.
 */
export function crontabIndicatesAutopilotInstall(crontab: string): boolean {
  return crontab.split('\n').some((line) => {
    if (line.trimStart().startsWith('#')) return false;
    if (line.includes('autopilot-run.sh')) return true;
    return line.includes('gbrain autopilot') && !line.includes('--status');
  });
}


/**
 * DX-O12: this brain's job for `autopilot --status`: the names it resolves to,
 * the definition actually installed (which may be a pre-#5195 shared-name job,
 * or one whose wrapper is gone because the brain moved), and the human lines.
 */
export function autopilotJobStatus(job: AutopilotJob): { installTarget: InstallTarget | null; report: Record<string, unknown>; lines: string[] } {
  const { installed, foreign } = detectInstalledJob(job);
  const wrapperMissing = installed?.wrapperPath ? !existsSync(installed.wrapperPath) : false;
  const needsReinstall = installed?.legacy ? 'legacy_shared_job' : wrapperMissing ? 'wrapper_missing' : null;
  const assigned = job.kind !== 'unassigned';
  const report = {
    kind: job.kind,
    suffix: job.suffix,
    launchd_label: assigned ? job.launchdLabel : null,
    systemd_unit: assigned ? job.systemdUnit : null,
    start_script: assigned ? job.startScriptPath : null,
    cron_marker: job.cronMarker,
    install_id_path: job.installIdPath,
    wrapper_path: job.wrapperPath,
    log_path: job.logPath,
    installed_definition: installed
      ? { target: installed.target, name: installed.name, wrapper_path: installed.wrapperPath, wrapper_exists: !wrapperMissing, legacy_shared_name: installed.legacy }
      : null,
    needs_reinstall: needsReinstall,
    shared_job_of_other_brain: foreign,
  };
  const lines: string[] = [];
  const jobName = installed?.name ?? (assigned ? `${job.launchdLabel} (launchd) / ${job.systemdUnit} (systemd)` : null);
  if (jobName) lines.push(`Job: ${jobName}${job.suffix ? ` (suffix ${job.suffix})` : ''}`);
  if (job.installIdPath) lines.push(`Install id: ${job.installIdPath}`);
  lines.push(`Wrapper: ${installed?.wrapperPath ?? job.wrapperPath}`);
  lines.push(`Log: ${job.logPath}`);
  if (needsReinstall === 'legacy_shared_job') {
    lines.push(`  This brain runs under the shared job ${installed!.name} from an older gbrain. Give it its own job: ${brainCommand(job.homeDir, '--install')}`);
  } else if (needsReinstall === 'wrapper_missing') {
    lines.push(`  The job runs ${installed!.wrapperPath}, which no longer exists (the brain moved?). Reinstall: ${brainCommand(job.homeDir, '--install')}`);
  }
  if (foreign) lines.push(`  ${foreign.name} runs the brain at ${foreign.home}, not this one.`);
  return { installTarget: installed?.target ?? null, report, lines };
}

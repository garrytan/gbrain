/**
 * gbrain autopilot — Self-maintaining brain daemon.
 *
 * v0.11.1 shape:
 *   - Default path (minion_mode != off AND engine == postgres): spawn a
 *     `gbrain jobs work` child process, submit ONE `autopilot-cycle` job
 *     per interval with an idempotency_key so slow cycles don't stack up.
 *     The forked worker drains the queue durably; restart with 10s backoff
 *     on crash (5-crash cap → autopilot stops with a clear error).
 *   - Fallback (minion_mode=off, PGLite, or `--inline`): run sync →
 *     extract → embed inline, same as pre-v0.11.1 behavior.
 *
 * Usage:
 *   gbrain autopilot [--repo <path>] [--interval N] [--json] [--inline]
 *   gbrain autopilot --install [--repo <path>]
 *   gbrain autopilot --uninstall
 *   gbrain autopilot --status [--json]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, utimesSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync, spawn, type ChildProcess } from 'child_process';
import type { BrainEngine } from '../core/engine.ts';
import { loadPreferences } from '../core/preferences.ts';
import { loadConfig } from '../core/config.ts';

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function logError(phase: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const ts = new Date().toISOString().slice(0, 19);
  const line = `[${ts}] [${phase}] ERROR: ${msg}`;
  console.error(line);
  try {
    const logDir = join(process.env.HOME || '', '.gbrain');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'autopilot.log'), line + '\n');
  } catch { /* best-effort */ }
}

/**
 * Resolve the gbrain CLI entrypoint for spawning the worker child.
 *
 * A .ts source path is never a valid spawn target — spawning it fails with
 * EACCES because TypeScript source isn't executable. The canonical install
 * puts a shim at `/usr/local/bin/gbrain` (or wherever `which gbrain`
 * resolves to) that already wraps the right runtime+entrypoint; prefer it.
 *
 * Order of resolution:
 *   1. `which gbrain` — the shim on PATH, canonical for installed builds.
 *   2. process.execPath if it ends with /gbrain (compiled binary, no shim).
 *   3. argv[1] if it ends with /gbrain (e.g., direct invocation of compiled
 *      binary without PATH). Never .ts source paths.
 *   4. Throw with a clear install hint.
 */
export function resolveGbrainCliPath(): string {
  try {
    const which = execSync('which gbrain', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which) return which;
  } catch { /* not on $PATH — fall through */ }

  const exec = process.execPath ?? '';
  if (exec.endsWith('/gbrain') || exec.endsWith('\\gbrain.exe')) {
    return exec;
  }

  const arg1 = process.argv[1] ?? '';
  if (arg1.endsWith('/gbrain') || arg1.endsWith('\\gbrain.exe')) {
    return arg1;
  }

  throw new Error('Could not resolve the gbrain CLI path. Install gbrain so it is on $PATH (e.g. /usr/local/bin/gbrain), or run autopilot from the compiled binary directly.');
}

export async function runAutopilot(engine: BrainEngine, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: gbrain autopilot [--repo <path>] [--interval N] [--json]\n' +
      '       gbrain autopilot --install [--repo <path>]\n' +
      '       gbrain autopilot --uninstall\n' +
      '       gbrain autopilot --status [--json]\n\n' +
      'Self-maintaining brain daemon. Runs the full maintenance cycle\n' +
      '(lint + backlinks + sync + extract + embed + orphans) on an interval.\n\n' +
      'For a one-shot cron-triggered cycle, see `gbrain dream`.',
    );
    return;
  }

  if (args.includes('--install')) {
    await installDaemon(engine, args);
    return;
  }
  if (args.includes('--uninstall')) {
    uninstallDaemon();
    return;
  }
  if (args.includes('--status')) {
    showStatus(args.includes('--json'));
    return;
  }

  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  const baseInterval = parseInt(parseArg(args, '--interval') || '300', 10);
  const jsonMode = args.includes('--json');
  const forceInline = args.includes('--inline');

  if (!repoPath) {
    console.error('No repo path. Use --repo or run gbrain sync --repo first.');
    process.exit(1);
  }

  // Lock file to prevent concurrent instances (#14)
  const lockPath = join(process.env.HOME || '', '.gbrain', 'autopilot.lock');
  try {
    mkdirSync(join(process.env.HOME || '', '.gbrain'), { recursive: true });
    if (existsSync(lockPath)) {
      const stat = require('fs').statSync(lockPath);
      const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
      if (ageMinutes < 10) {
        console.error('Another autopilot instance is running (lock file is fresh). Exiting.');
        process.exit(0);
      }
      console.log('Stale lock file found (>10 min). Taking over.');
    }
    writeFileSync(lockPath, String(process.pid));
  } catch { /* best-effort */ }

  console.log(`Autopilot starting. Repo: ${repoPath}, interval: ${baseInterval}s`);

  // Mode resolution: Minions dispatch when the user has opted in AND the
  // worker daemon can actually run (Postgres only; PGLite's exclusive file
  // lock blocks a separate worker process).
  const mode = loadPreferences().minion_mode ?? 'pain_triggered';
  const cfg = loadConfig();
  const engineType = cfg?.engine ?? 'pglite';
  const useMinionsDispatch = mode !== 'off' && engineType === 'postgres' && !forceInline;

  let stopping = false;
  let workerProc: ChildProcess | null = null;
  let crashCount = 0;

  if (useMinionsDispatch) {
    const cliPath = resolveGbrainCliPath();
    const startWorker = () => {
      const child = spawn(cliPath, ['jobs', 'work'], { stdio: 'inherit', env: process.env });
      workerProc = child;
      console.log(`[autopilot] Minions worker spawned (pid: ${child.pid})`);
      child.on('exit', (code) => {
        workerProc = null;
        if (stopping) return;
        if (crashCount >= 5) {
          console.error('[autopilot] 5 consecutive worker crashes, giving up.');
          process.exit(1);
        }
        crashCount++;
        console.error(`[autopilot] worker exited code=${code}, restart #${crashCount} in 10s`);
        setTimeout(startWorker, 10_000);
      });
    };
    startWorker();
  } else {
    const why = mode === 'off' ? 'minion_mode=off'
      : (engineType !== 'postgres' ? 'engine=pglite' : 'flag=--inline');
    console.log(`[autopilot] running steps inline (${why})`);
  }

  // Async shutdown with 35s drain window for the worker child. The worker
  // has its own SIGTERM handler (minions/worker.ts:79-85) that drains
  // in-flight jobs for up to 30s before exit. We give it 35s here to
  // account for signal-delivery latency, then SIGKILL as a last resort.
  //
  // No `process.on('exit')` handler — its callback runs synchronously and
  // cannot await the worker's drain.
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Autopilot stopping (${sig}).`);
    if (workerProc) {
      try { workerProc.kill('SIGTERM'); } catch { /* already dead */ }
      await Promise.race([
        new Promise<void>(r => workerProc!.once('exit', () => r())),
        new Promise<void>(r => setTimeout(() => r(), 35_000)),
      ]);
      if (workerProc && !workerProc.killed) {
        try { workerProc.kill('SIGKILL'); } catch { /* already dead */ }
      }
    }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });

  let consecutiveErrors = 0;

  while (!stopping) {
    const cycleStart = Date.now();
    let cycleOk = true;

    // Refresh the lock mtime so another cron-fired autopilot doesn't
    // declare the instance stale after 10 minutes (Codex C).
    try { utimesSync(lockPath, new Date(), new Date()); } catch { /* best-effort */ }

    // DB health check (reconnect if needed)
    try {
      await engine.getConfig('version');
    } catch {
      try {
        await engine.disconnect();
        await (engine as any).connect?.();
      } catch (e) { logError('reconnect', e); }
    }

    if (useMinionsDispatch) {
      // Submit ONE autopilot-cycle job per cycle slot. The idempotency key
      // dedupes overrun submissions — if a cycle's job runs longer than
      // the interval, the next submission is a no-op at the DB layer
      // (ON CONFLICT DO NOTHING on the unique partial index).
      try {
        const { MinionQueue } = await import('../core/minions/queue.ts');
        const queue = new MinionQueue(engine);
        const slotMs = Math.floor(Date.now() / (baseInterval * 1000)) * baseInterval * 1000;
        const slot = new Date(slotMs).toISOString();
        const timeoutMs = Math.max(baseInterval * 2 * 1000, 300_000);
        const job = await queue.add('autopilot-cycle',
          { repoPath },
          {
            queue: 'default',
            idempotency_key: `autopilot-cycle:${slot}`,
            max_attempts: 2,
            timeout_ms: timeoutMs,
          },
        );
        if (jsonMode) {
          process.stderr.write(JSON.stringify({ event: 'dispatched', job_id: job.id, slot }) + '\n');
        } else {
          console.log(`[dispatch] job #${job.id} autopilot-cycle slot=${slot}`);
        }
      } catch (e) { logError('dispatch', e); cycleOk = false; }
    } else {
      // Inline fallback — delegate to runCycle so lint + backlinks +
      // orphan sweep run too (previously this path only did sync +
      // extract + embed, which didn't match the Minions-dispatch
      // path's phase set). Now both converge on the same primitive.
      try {
        const { runCycle } = await import('../core/cycle.ts');
        const report = await runCycle(engine, {
          brainDir: repoPath,
          // Autopilot daemon path: pulls by default (matches
          // pre-v0.17 autopilot behavior). CLI dream defaults false
          // for cron safety; that choice is scoped to dream only.
          pull: true,
          yieldBetweenPhases: async () => {
            await new Promise(r => setImmediate(r));
          },
        });
        if (report.status === 'failed' || report.status === 'partial') {
          cycleOk = false;
        }
        if (jsonMode) {
          process.stderr.write(JSON.stringify({ event: 'cycle-inline', status: report.status, duration_ms: report.duration_ms, totals: report.totals }) + '\n');
        } else {
          const t = report.totals;
          console.log(`[cycle-inline ${report.status}] lint=${t.lint_fixes} backlinks=${t.backlinks_added} synced=${t.pages_synced} extracted=${t.pages_extracted} embedded=${t.pages_embedded} orphans=${t.orphans_found}`);
        }
      } catch (e) { logError('cycle-inline', e); cycleOk = false; }
    }

    // 4. Health check + adaptive interval (same for both paths)
    let interval = baseInterval;
    try {
      const health = await engine.getHealth();
      const score = (health as any).brain_score ?? 50;
      interval = score >= 90 ? baseInterval * 2
               : score < 70 ? Math.max(Math.floor(baseInterval / 2), 60)
               : baseInterval;

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0);
      const line = `[cycle] score=${score} elapsed=${elapsed}s next=${interval}s`;
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'cycle', brain_score: score, elapsed_s: Number(elapsed), next_s: interval }) + '\n');
      } else {
        console.log(line);
      }
    } catch (e) { logError('health', e); }

    if (cycleOk) {
      consecutiveErrors = 0;
    } else {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        console.error('5 consecutive cycle failures. Stopping autopilot.');
        void shutdown('cycle-failure-cap');
        break;
      }
    }

    // Wait for next cycle
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

// --- Install/Uninstall ---

function plistPath(): string {
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.gbrain.autopilot.plist');
}

function systemdUnitPath(): string {
  return join(process.env.HOME || '', '.config', 'systemd', 'user', 'gbrain-autopilot.service');
}

function ephemeralStartScriptPath(): string {
  return join(process.env.HOME || '', '.gbrain', 'start-autopilot.sh');
}

export type InstallTarget = 'macos' | 'linux-systemd' | 'ephemeral-container' | 'linux-cron';

/**
 * Detect the right supervisor for this host.
 *
 *   - macos   → launchd (always, when platform === 'darwin').
 *   - ephemeral-container → Render / Railway / Fly / Docker. Crontab is
 *                           unreliable here (wiped on deploy); we hand
 *                           the user a start script instead.
 *   - linux-systemd → systemd user scope actually works (is-system-running
 *                     probe succeeds). Codex hardened from the naive
 *                     /run/systemd/system check.
 *   - linux-cron  → fallback.
 */
export function detectInstallTarget(): InstallTarget {
  if (process.platform === 'darwin') return 'macos';

  const ephemeral = !!(
    process.env.RENDER
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.FLY_APP_NAME
    || existsSync('/.dockerenv')
  );
  if (ephemeral) return 'ephemeral-container';

  if (existsSync('/run/systemd/system')) {
    try {
      execSync('systemctl --user is-system-running', { stdio: 'pipe', timeout: 3000 });
      return 'linux-systemd';
    } catch {
      // user bus not available → fall through to cron.
    }
  }

  return 'linux-cron';
}

function detectOpenClaw(): { detected: boolean; bootstrapCandidates: string[] } {
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

function writeWrapperScript(repoPath: string): string {
  const home = process.env.HOME || '';
  const gbrainDir = join(home, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });

  // Wrapper sources the user's shell profile for API keys so nothing is
  // baked into plist/crontab/systemd unit files (#2).
  const wrapperPath = join(gbrainDir, 'autopilot-run.sh');
  const gbrainPath = resolveGbrainCliPath();
  const safeRepoPath = repoPath.replace(/'/g, "'\\''");
  const safeGbrainPath = gbrainPath.replace(/'/g, "'\\''");
  const wrapper = `#!/bin/bash
# Auto-generated by gbrain autopilot --install
# Sources shell profile for API keys, then runs autopilot
source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
exec '${safeGbrainPath}' autopilot --repo '${safeRepoPath}'
`;
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  return wrapperPath;
}

async function installDaemon(engine: BrainEngine, args: string[]) {
  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  if (!repoPath) {
    console.error('No repo path. Use --repo or run gbrain sync --repo first.');
    process.exit(1);
  }

  const forcedTarget = parseArg(args, '--target') as InstallTarget | undefined;
  const target: InstallTarget = forcedTarget ?? detectInstallTarget();

  const injectBootstrap = args.includes('--inject-bootstrap');
  const noInject = args.includes('--no-inject');

  const wrapperPath = writeWrapperScript(repoPath);
  const home = process.env.HOME || '';

  switch (target) {
    case 'macos':
      installLaunchd(wrapperPath, home, repoPath);
      break;
    case 'linux-systemd':
      installSystemd(wrapperPath, repoPath);
      break;
    case 'ephemeral-container':
      installEphemeralContainer(wrapperPath, home, repoPath, { injectBootstrap, noInject });
      break;
    case 'linux-cron':
      installCrontab(wrapperPath, home);
      break;
    default: {
      console.error(`Unknown --target "${forcedTarget}". Allowed: macos, linux-systemd, ephemeral-container, linux-cron.`);
      process.exit(2);
    }
  }
}

function installLaunchd(wrapperPath: string, home: string, repoPath: string) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gbrain.autopilot</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(wrapperPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(home)}/.gbrain/autopilot.log</string>
  <key>StandardErrorPath</key><string>${escapeXml(home)}/.gbrain/autopilot.err</string>
</dict>
</plist>`;

  try {
    const agentsDir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(plistPath(), plist);
    execSync(`launchctl load "${plistPath()}"`, { stdio: 'pipe' });
    console.log('Installed launchd service: com.gbrain.autopilot');
    console.log(`  Repo: ${repoPath}`);
    console.log(`  Log: ~/.gbrain/autopilot.log`);
    console.log('  Uninstall: gbrain autopilot --uninstall');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('EACCES') || msg.includes('Permission')) {
      console.error('Permission denied writing plist. Try: mkdir -p ~/Library/LaunchAgents');
    } else {
      console.error(`Failed to install: ${msg}`);
    }
    process.exit(1);
  }
}

function installSystemd(wrapperPath: string, repoPath: string) {
  const unit = `[Unit]
Description=GBrain Autopilot
After=network-online.target

[Service]
Type=simple
ExecStart=${wrapperPath}
Restart=on-failure
RestartSec=30
StandardOutput=append:%h/.gbrain/autopilot.log
StandardError=append:%h/.gbrain/autopilot.err

[Install]
WantedBy=default.target
`;
  try {
    const unitPath = systemdUnitPath();
    mkdirSync(join(process.env.HOME || '', '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unitPath, unit);
    execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 10_000 });
    execSync('systemctl --user enable --now gbrain-autopilot.service', { stdio: 'pipe', timeout: 15_000 });
    console.log('Installed systemd user service: gbrain-autopilot.service');
    console.log(`  Repo: ${repoPath}`);
    console.log('  Log: ~/.gbrain/autopilot.log');
    console.log('  Uninstall: gbrain autopilot --uninstall');
  } catch (e: unknown) {
    console.error(`Failed to install systemd unit: ${e instanceof Error ? e.message : e}`);
    console.error('You may need: `loginctl enable-linger $USER` so the unit runs without a login session.');
    process.exit(1);
  }
}

function installEphemeralContainer(
  wrapperPath: string,
  home: string,
  repoPath: string,
  opts: { injectBootstrap: boolean; noInject: boolean },
) {
  // Write a start script the agent's bootstrap can source on every container start.
  const safeWrapperPath = wrapperPath.replace(/'/g, "'\\''");
  const script = `#!/bin/bash
# Auto-generated by gbrain autopilot --install (ephemeral-container target)
# Ephemeral filesystems lose crontab on every deploy; source this from
# your agent's bootstrap instead.
nohup '${safeWrapperPath}' > ~/.gbrain/autopilot.log 2>&1 &
echo \$! > ~/.gbrain/autopilot.pid
`;
  const scriptPath = ephemeralStartScriptPath();
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(scriptPath, script, { mode: 0o755 });

  console.log('Ephemeral container detected (Render / Railway / Fly / Docker).');
  console.log(`Repo: ${repoPath}`);
  console.log(`Start script: ${scriptPath}`);
  console.log('');
  console.log('Crontab is unreliable here (wiped on deploy). Add ONE LINE to your');
  console.log('agent bootstrap to launch autopilot on every start:');
  console.log('');
  console.log(`  bash ${scriptPath}`);
  console.log('');

  // OpenClaw detection + optional auto-injection into ensure-services.sh.
  const { detected, bootstrapCandidates } = detectOpenClaw();
  if (detected) {
    console.log(`OpenClaw detected. Bootstrap candidates found:`);
    for (const p of bootstrapCandidates) console.log(`  - ${p}`);
    console.log('');
  }

  const shouldInject = (injectOpts: { detected: boolean; injectBootstrap: boolean; noInject: boolean }) => {
    if (injectOpts.noInject) return false;
    // Auto-inject by default when OpenClaw is detected + at least one
    // candidate exists. Users can explicitly opt in with --inject-bootstrap
    // on other hosts (uncommon).
    if (injectOpts.detected && bootstrapCandidates.length > 0) return true;
    return injectOpts.injectBootstrap;
  };

  if (shouldInject({ detected, injectBootstrap: opts.injectBootstrap, noInject: opts.noInject })) {
    for (const candidate of bootstrapCandidates) {
      try {
        const existing = readFileSync(candidate, 'utf-8');
        const marker = '# gbrain:autopilot v0.11.0';
        if (existing.includes(marker)) {
          console.log(`  [skip] ${candidate} already has the gbrain marker`);
          continue;
        }
        // Backup before edit
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const bakPath = `${candidate}.bak.${stamp}`;
        writeFileSync(bakPath, existing);
        const snippet = `\n${marker}\nbash ${scriptPath}\n`;
        writeFileSync(candidate, existing.trimEnd() + snippet);
        console.log(`  [injected] ${candidate} (.bak at ${bakPath})`);
      } catch (e) {
        console.error(`  [warn] failed to inject ${candidate}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  console.log('  Uninstall: gbrain autopilot --uninstall');
}

function installCrontab(wrapperPath: string, home: string) {
  // Linux/WSL without systemd — crontab runs the wrapper every 5 minutes.
  const safeWrapperPath = wrapperPath.replace(/'/g, "'\\''");
  const cronLine = `*/5 * * * * '${safeWrapperPath}' >> '${home.replace(/'/g, "'\\''")}/.gbrain/autopilot.log' 2>&1`;
  try {
    const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
    if (existing.includes('gbrain autopilot') || existing.includes('autopilot-run.sh')) {
      console.log('Crontab entry already exists. Remove with: gbrain autopilot --uninstall');
      return;
    }
    // Use a temp file instead of echo pipe to avoid shell escaping issues (#1)
    const tmpFile = join(home, '.gbrain', 'crontab.tmp');
    writeFileSync(tmpFile, existing.trimEnd() + '\n' + cronLine + '\n');
    execSync(`crontab '${tmpFile.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
    try { unlinkSync(tmpFile); } catch { /* best-effort */ }
    console.log('Installed crontab entry for gbrain autopilot (every 5 minutes)');
    console.log('  Uninstall: gbrain autopilot --uninstall');
  } catch (e: unknown) {
    console.error(`Failed to install crontab: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

function uninstallDaemon() {
  const home = process.env.HOME || '';
  const wrapperPath = join(home, '.gbrain', 'autopilot-run.sh');

  // Always try all four targets — the user might have run `--install` under
  // one target earlier and moved hosts (e.g. macOS laptop → Linux server).
  // Each path is idempotent (missing files = skip silently).

  let removed = 0;

  // macOS launchd
  if (existsSync(plistPath())) {
    try {
      execSync(`launchctl unload "${plistPath()}" 2>/dev/null || true`, { stdio: 'pipe' });
      unlinkSync(plistPath());
      console.log('Removed launchd service: com.gbrain.autopilot');
      removed++;
    } catch (e) {
      console.error(`  [warn] launchd: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Linux systemd user unit
  if (existsSync(systemdUnitPath())) {
    try {
      execSync('systemctl --user disable --now gbrain-autopilot.service 2>/dev/null || true', { stdio: 'pipe', timeout: 10_000 });
      unlinkSync(systemdUnitPath());
      try { execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 5_000 }); } catch { /* best-effort */ }
      console.log('Removed systemd user service: gbrain-autopilot.service');
      removed++;
    } catch (e) {
      console.error(`  [warn] systemd: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Ephemeral container start script + bootstrap marker injection
  if (existsSync(ephemeralStartScriptPath())) {
    try {
      unlinkSync(ephemeralStartScriptPath());
      console.log('Removed ephemeral start script: ~/.gbrain/start-autopilot.sh');
      removed++;
    } catch (e) {
      console.error(`  [warn] start script: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Remove marker-line from any OpenClaw bootstrap we previously injected.
  try {
    const { bootstrapCandidates } = detectOpenClaw();
    for (const candidate of bootstrapCandidates) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        if (!content.includes('# gbrain:autopilot v0.11.0')) continue;
        const lines = content.split('\n');
        const cleaned: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('# gbrain:autopilot v0.11.0')) {
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

  // Linux crontab (don't gate on platform — the user may have run `--install
  // --target linux-cron` on a different machine that now has the crontab).
  try {
    const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
    if (existing.includes('gbrain autopilot') || existing.includes('autopilot-run.sh')) {
      const filtered = existing.split('\n').filter(l =>
        !l.includes('gbrain autopilot') && !l.includes('autopilot-run.sh'),
      ).join('\n');
      const tmpFile = join(home, '.gbrain', 'crontab.tmp');
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(tmpFile, filtered);
      execSync(`crontab '${tmpFile.replace(/'/g, "'\\''")}' 2>/dev/null || true`, { stdio: 'pipe' });
      try { unlinkSync(tmpFile); } catch { /* best-effort */ }
      console.log('Removed crontab entry for gbrain autopilot');
      removed++;
    }
  } catch (e) {
    console.error(`  [warn] crontab: ${e instanceof Error ? e.message : e}`);
  }

  // Wrapper script — shared by all targets
  if (existsSync(wrapperPath)) {
    try {
      unlinkSync(wrapperPath);
    } catch { /* best-effort */ }
  }

  if (removed === 0) {
    console.log('No autopilot install found on this host. Nothing to uninstall.');
  }
}

function showStatus(json: boolean) {
  const logFile = join(process.env.HOME || '', '.gbrain', 'autopilot.log');
  let lastLine = '';
  try {
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    lastLine = lines[lines.length - 1] || '';
  } catch { /* no log */ }

  let installed = false;
  if (process.platform === 'darwin') {
    installed = existsSync(plistPath());
  } else {
    try {
      const crontab = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
      installed = crontab.includes('gbrain autopilot');
    } catch { /* no crontab */ }
  }

  if (json) {
    console.log(JSON.stringify({ installed, last_log: lastLine }));
  } else {
    console.log(`Autopilot: ${installed ? 'installed' : 'not installed'}`);
    if (lastLine) console.log(`Last log: ${lastLine}`);
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * PR-A: the two surfaces that make a dead autopilot visible.
 *
 *   generateSelfDisableGuard — stops a daemon whose --repo vanished, for real,
 *     under a supervisor that restarts it on every exit.
 *   classifyAutopilotStatus — tri-state verdict + exit code, so `--status` can
 *     no longer answer "installed" for a daemon that died 71 days ago.
 *
 * Both are pure, so no daemon is installed here.
 */
import { describe, test, expect } from 'bun:test';
import {
  generateSelfDisableGuard,
  crontabIndicatesAutopilotInstall,
  classifyAutopilotStatus,
  autopilotStatusExitCode,
  autopilotLaunchdLabel,
  autopilotEngineIdentity,
  AUTOPILOT_SYSTEMD_UNIT,
} from '../src/commands/autopilot.ts';

describe('generateSelfDisableGuard', () => {
  test('tests the repo DIRECTORY, never $repo/.git', () => {
    const guard = generateSelfDisableGuard('/data/brain', 'macos');
    expect(guard).toContain("[ ! -d '/data/brain' ]");
    // .git is a FILE in worktrees and submodules, and --repo may be a
    // subdirectory of the checkout — either shape would false-positive and
    // disable a healthy install. Assert on the executable line only; the
    // surrounding comment mentions .git precisely to explain the trap.
    const testLine = guard.split('\n').find((l) => l.startsWith('if [ '))!;
    expect(testLine).toBe("if [ ! -d '/data/brain' ]; then");
    expect(testLine).not.toContain('.git');
  });

  test('macOS actually boots the job out — exit 0 alone is a respawn loop', () => {
    // KeepAlive=true means launchd restarts on ANY exit, so "detect and exit"
    // disables nothing; it just makes the failure quieter and more frequent.
    const guard = generateSelfDisableGuard('/data/brain', 'macos');
    expect(guard).toContain('launchctl bootout');
    expect(guard).toContain(autopilotLaunchdLabel());
  });

  test('systemd disables the unit — Restart=always has the same problem', () => {
    const guard = generateSelfDisableGuard('/data/brain', 'linux-systemd');
    expect(guard).toContain('systemctl --user disable --now');
    expect(guard).toContain(AUTOPILOT_SYSTEMD_UNIT);
  });

  test('cron and container just exit — they are periodic/one-shot, not KeepAlive', () => {
    for (const target of ['linux-cron', 'ephemeral-container'] as const) {
      const guard = generateSelfDisableGuard('/data/brain', target);
      expect(guard).toContain('exit 0');
      expect(guard).not.toContain('launchctl bootout');
      expect(guard).not.toContain('systemctl --user disable');
    }
  });

  test('writes a marker so --status can explain WHY it stopped', () => {
    expect(generateSelfDisableGuard('/data/brain', 'macos')).toContain('autopilot-disabled');
  });

  test('single-quotes in the repo path cannot break out of the shell literal', () => {
    const guard = generateSelfDisableGuard("/data/o'brien/brain", 'macos');
    expect(guard).toContain("'/data/o'\\''brien/brain'");
  });

  test('one missed probe is a strike, not a disable — three consecutive misses required', () => {
    // Repos on external volumes, NFS, or cloud-synced folders are routinely
    // absent for the first launch after login. A single-probe guard would
    // permanently bootout a healthy install on one transient miss (adversarial
    // review catch); the counter makes disable require persistence.
    const guard = generateSelfDisableGuard('/data/brain', 'macos');
    expect(guard).toContain('autopilot-disable-strikes');
    expect(guard).toContain('-lt 3');
    // Below the threshold the guard exits WITHOUT writing the disabled marker
    // or booting the job out: the early-exit line precedes both.
    const strikeExit = guard.indexOf('exit 0');
    expect(strikeExit).toBeGreaterThan(-1);
    expect(strikeExit).toBeLessThan(guard.indexOf('autopilot-disabled'));
    expect(strikeExit).toBeLessThan(guard.indexOf('launchctl bootout'));
    // A successful probe resets the counter, or three misses spread over
    // months would accumulate into a false disable.
    expect(guard.trimEnd().endsWith("2>/dev/null || true")).toBe(true);
    expect(guard.split('rm -f').length).toBeGreaterThanOrEqual(3);
  });
});

describe('crontabIndicatesAutopilotInstall', () => {
  test('wrapper line and direct daemon line count as installs', () => {
    expect(crontabIndicatesAutopilotInstall("*/5 * * * * '/h/.gbrain/autopilot-run.sh' >> log 2>&1")).toBe(true);
    expect(crontabIndicatesAutopilotInstall('*/5 * * * * gbrain autopilot --repo /data/brain')).toBe(true);
  });

  test('a status-monitor cron line is NOT an install', () => {
    // docs recommend cron-ing the status command as a health gate; counting
    // it as an install makes a monitor-only machine report installed and
    // never_run with exit 1 forever (adversarial review catch).
    expect(crontabIndicatesAutopilotInstall('*/10 * * * * gbrain autopilot --status --json >> health.log')).toBe(false);
  });

  test('comments and unrelated lines never count', () => {
    expect(crontabIndicatesAutopilotInstall('# gbrain autopilot --repo /data/brain (disabled)')).toBe(false);
    expect(crontabIndicatesAutopilotInstall('0 3 * * * /usr/local/bin/backup.sh')).toBe(false);
    expect(crontabIndicatesAutopilotInstall('')).toBe(false);
  });
});

describe('classifyAutopilotStatus', () => {
  const base = {
    installed: true,
    installTarget: 'macos' as const,
    disabledReason: null as string | null,
    pausedReason: null as string | null,
    heartbeatAgeSeconds: 10,
    intervalSeconds: 300,
    lastLog: '',
  };

  test('THE INCIDENT: installed with a 71-day-old heartbeat → stale, exit 1', () => {
    // This is the case that reported "Autopilot: installed" and exited 0 for
    // 71 days while the daemon was dead.
    const r = classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: 71 * 86400 });
    expect(r.state).toBe('stale');
    expect(autopilotStatusExitCode(r.state)).toBe(1);
  });

  test('fresh heartbeat → fresh, exit 0', () => {
    const r = classifyAutopilotStatus(base);
    expect(r.state).toBe('fresh');
    expect(autopilotStatusExitCode(r.state)).toBe(0);
  });

  test('nothing installed → exit 0 (nothing claimed, nothing broken)', () => {
    const r = classifyAutopilotStatus({ ...base, installed: false, installTarget: null, heartbeatAgeSeconds: null });
    expect(r.state).toBe('not_installed');
    expect(autopilotStatusExitCode(r.state)).toBe(0);
  });

  test('installed but never ticked → never_run, exit 1', () => {
    const r = classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: null });
    expect(r.state).toBe('never_run');
    expect(autopilotStatusExitCode(r.state)).toBe(1);
  });

  test('self-disabled wins over every other signal, exit 2', () => {
    const r = classifyAutopilotStatus({ ...base, disabledReason: 'repo path gone: /data/brain' });
    expect(r.state).toBe('disabled');
    expect(r.disabled_reason).toContain('/data/brain');
    expect(autopilotStatusExitCode(r.state)).toBe(2);
  });

  test('a healthy adaptive-schedule gap does not flip the verdict — a real outage does', () => {
    // The adaptive scheduler sleeps TWO intervals between ticks on the
    // healthiest brains and the heartbeat only refreshes at tick top, so a
    // normal healthy gap is cycle_duration + 2x interval. Tolerance is 6x —
    // review-army catch: at 3x, the best-behaved installs flapped stale
    // exit-1 alarms in the exact cron gates this exit code ships for.
    expect(classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: 301 }).state).toBe('fresh');
    expect(classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: 1799 }).state).toBe('fresh');
    expect(classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: 1801 }).state).toBe('stale');
  });

  test('tolerance scales with the interval, not a hardcoded constant', () => {
    const slow = classifyAutopilotStatus({ ...base, intervalSeconds: 3600, heartbeatAgeSeconds: 5000 });
    expect(slow.stale_after_seconds).toBe(21600);
    expect(slow.state).toBe('fresh');
  });

  test('a garbage interval cannot silence the alarm — NaN staleAfter would read dead as fresh', () => {
    // Pre-fix: `--interval garbage` parsed to NaN, staleAfter = NaN, and every
    // age comparison came back false — the 71-day-dead daemon reported 'fresh'
    // with exit 0. The pure layer now falls back to the default tolerance.
    const r = classifyAutopilotStatus({ ...base, intervalSeconds: NaN, heartbeatAgeSeconds: 71 * 86400 });
    expect(r.stale_after_seconds).toBe(1800);
    expect(r.state).toBe('stale');
    expect(autopilotStatusExitCode(r.state)).toBe(1);
    expect(classifyAutopilotStatus({ ...base, intervalSeconds: 0 }).stale_after_seconds).toBe(1800);
  });

  test('pause marker → paused, exit 1: a parked daemon must not report running', () => {
    // The tick loop refreshes its heartbeat BEFORE honoring the pause marker,
    // so a quiesced daemon looks 'fresh' by mtime while doing no work. Without
    // this state, a marker orphaned by a dead migrate is invisible — the
    // 71-day incident's shape again, reached through the pause path.
    const r = classifyAutopilotStatus({ ...base, pausedReason: 'paused by gbrain migrate at 2026-08-11T00:00:00Z' });
    expect(r.state).toBe('paused');
    expect(r.paused_reason).toContain('gbrain migrate');
    expect(autopilotStatusExitCode(r.state)).toBe(1);
  });

  test('disabled outranks paused; a leftover marker with nothing installed stays quiet', () => {
    // disabled is the stronger, permanent claim (exit 2). And with no install
    // at all, a stray marker pauses nothing — alarming on it would make a
    // clean machine fail its cron gate forever.
    const both = classifyAutopilotStatus({ ...base, disabledReason: 'repo path gone', pausedReason: 'paused' });
    expect(both.state).toBe('disabled');
    const stray = classifyAutopilotStatus({
      ...base, installed: false, installTarget: null, heartbeatAgeSeconds: null, pausedReason: 'paused',
    });
    expect(stray.state).toBe('not_installed');
    expect(autopilotStatusExitCode(stray.state)).toBe(0);
  });
});

describe('autopilotEngineIdentity (post-migration convergence)', () => {
  // Red-team catch: after a clean migration flipped config.json, the daemon
  // never converged — its health probe kept succeeding against the OLD engine
  // (the preserved backup stays alive) and reconnect() deliberately restores
  // the config captured at connect(). The tick loop now compares this
  // identity against its boot value and exits for supervisor relaunch.
  test('changes when the engine kind or connection target changes', () => {
    const pglite = autopilotEngineIdentity({ engine: 'pglite', database_path: '/a/brain.pglite' });
    expect(autopilotEngineIdentity({ engine: 'postgres', database_url: 'postgres://x/db' })).not.toBe(pglite);
    expect(autopilotEngineIdentity({ engine: 'pglite', database_path: '/b/brain.pglite' })).not.toBe(pglite);
  });

  test('ignores everything a migration does not flip — unrelated config edits must not restart the daemon', () => {
    const before = autopilotEngineIdentity({ engine: 'pglite', database_path: '/a/brain.pglite' });
    const after = autopilotEngineIdentity({
      engine: 'pglite', database_path: '/a/brain.pglite',
      embedding_model: 'voyage-3', search: { mode: 'tokenmax' },
    } as Parameters<typeof autopilotEngineIdentity>[0]);
    expect(after).toBe(before);
  });

  test('a missing config file reads as the pglite default, not a crash', () => {
    expect(autopilotEngineIdentity(null)).toBe(autopilotEngineIdentity({ engine: 'pglite' }));
  });
});

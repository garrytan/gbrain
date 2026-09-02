/**
 * Post-upgrade daemon restart — pins the fix for KeepAlive daemons that keep
 * old code in memory after `gbrain self-upgrade` / `gbrain upgrade`.
 *
 * launchctl / systemctl / ps are NEVER invoked for real: every I/O seam is
 * injected. This file must not restart Leon's (or CI's) live daemons.
 *
 * Discrimination: dynamic-import the new module so a reverted/missing source
 * fails an executed assertion (not a vacuous import crash). Wiring into
 * upgrade.ts is pinned by source analysis in the same file.
 *
 * test-reads-source-ok: the upgrade.ts wiring describe asserts
 * `runPostUpgrade` / `--swap-only` call `runPostUpgradeDaemonRestart` via
 * source text — behavioral spawn of the full post-upgrade path would connect
 * an engine and mutate the host; the source pin is the established pattern
 * in test/upgrade.serial.test.ts for the same module.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

async function loadMod() {
  try {
    return await import('../src/core/post-upgrade-daemon-restart.ts');
  } catch {
    return null;
  }
}

describe('post-upgrade-daemon-restart module present', () => {
  test('exports restartGbrainDaemonsAfterUpgrade (discrimination probe)', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    expect(typeof mod!.restartGbrainDaemonsAfterUpgrade).toBe('function');
  });
});

describe('looksLikeGbrainOwnedLaunchdLabel', () => {
  test('matches upstream installer labels and user-created gbrain labels', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { looksLikeGbrainOwnedLaunchdLabel } = mod!;
    expect(looksLikeGbrainOwnedLaunchdLabel('com.gbrain.autopilot')).toBe(true);
    expect(looksLikeGbrainOwnedLaunchdLabel('com.gbrain.brain-pull.default')).toBe(true);
    expect(looksLikeGbrainOwnedLaunchdLabel('com.example.gbrain-http')).toBe(true);
    expect(looksLikeGbrainOwnedLaunchdLabel('com.example.gbrain-supervisor')).toBe(true);
  });

  test('rejects unrelated labels and the postupgrade-restart watcher', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { looksLikeGbrainOwnedLaunchdLabel } = mod!;
    expect(looksLikeGbrainOwnedLaunchdLabel('com.apple.Spotlight')).toBe(false);
    expect(looksLikeGbrainOwnedLaunchdLabel('ai.hermes.gateway')).toBe(false);
    expect(looksLikeGbrainOwnedLaunchdLabel('com.example.gbrain-postupgrade-restart')).toBe(false);
    expect(looksLikeGbrainOwnedLaunchdLabel('')).toBe(false);
  });
});

describe('programArgsReferenceGbrain', () => {
  test('detects direct gbrain binary paths and bare tokens', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { programArgsReferenceGbrain } = mod!;
    expect(programArgsReferenceGbrain(['/Users/x/.bun/bin/gbrain', 'jobs', 'supervisor'])).toBe(true);
    expect(programArgsReferenceGbrain(['/usr/bin/env', '-u', 'FOO', '/opt/bin/gbrain', 'serve'])).toBe(true);
    expect(programArgsReferenceGbrain(['gbrain', 'serve', '--http'])).toBe(true);
    expect(programArgsReferenceGbrain(['/usr/bin/python3', 'server.py'])).toBe(false);
  });

  test('detects autopilot-run.sh basename and sniffs wrapper script bodies', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { programArgsReferenceGbrain } = mod!;
    expect(programArgsReferenceGbrain(['/home/u/.gbrain/autopilot-run.sh'])).toBe(true);

    const files: Record<string, string> = {
      '/tmp/serve-http.sh': '#!/bin/bash\nexec "$HOME/.bun/bin/gbrain" serve --http\n',
      '/tmp/unrelated.sh': '#!/bin/bash\necho hello\n',
    };
    const readFile = (p: string) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    };
    expect(programArgsReferenceGbrain(['/tmp/serve-http.sh'], { readFile })).toBe(true);
    expect(programArgsReferenceGbrain(['/tmp/unrelated.sh'], { readFile })).toBe(false);
  });
});

describe('shouldRestartLaunchdJob', () => {
  test('restarts KeepAlive gbrain jobs; skips interval-only and non-gbrain', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { shouldRestartLaunchdJob } = mod!;

    expect(
      shouldRestartLaunchdJob({
        label: 'com.gbrain.autopilot',
        pid: 5317,
        programArgs: ['/home/u/.gbrain/autopilot-run.sh'],
        keepAlive: true,
      }),
    ).toBe(true);

    expect(
      shouldRestartLaunchdJob({
        label: 'com.example.gbrain-http',
        pid: 2417,
        programArgs: ['/home/u/.gbrain/scripts/serve-http.sh'],
        keepAlive: true,
      }, {
        readFile: () => 'exec gbrain serve --http\n',
      }),
    ).toBe(true);

    // Calendar/interval job with no live PID and no KeepAlive — fresh spawn each fire.
    expect(
      shouldRestartLaunchdJob({
        label: 'com.gbrain.brain-pull.default',
        pid: null,
        programArgs: ['/home/u/.gbrain/brain-pull-default.sh'],
        keepAlive: false,
      }, {
        readFile: () => 'exec gbrain sources pull\n',
      }),
    ).toBe(false);

    expect(
      shouldRestartLaunchdJob({
        label: 'com.apple.Spotlight',
        pid: 1,
        programArgs: ['/usr/bin/gbrain'], // pathological — label gate wins
        keepAlive: true,
      }),
    ).toBe(false);
  });
});

describe('parseLaunchctlList + parseLaunchdPlistXml', () => {
  test('parses launchctl list rows including dash PID', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { parseLaunchctlList } = mod!;
    const rows = parseLaunchctlList(
      [
        'PID\tStatus\tLabel',
        '5317\t0\tcom.gbrain.autopilot',
        '-\t0\tcom.gbrain.brain-pull.default',
        '2417\t0\tcom.example.gbrain-http',
      ].join('\n'),
    );
    expect(rows).toEqual([
      { pid: 5317, lastExitStatus: 0, label: 'com.gbrain.autopilot' },
      { pid: null, lastExitStatus: 0, label: 'com.gbrain.brain-pull.default' },
      { pid: 2417, lastExitStatus: 0, label: 'com.example.gbrain-http' },
    ]);
  });

  test('parses ProgramArguments + KeepAlive from plist XML', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { parseLaunchdPlistXml } = mod!;
    const xml = `<?xml version="1.0"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gbrain.autopilot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/x/.gbrain/autopilot-run.sh</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict></plist>`;
    expect(parseLaunchdPlistXml(xml)).toEqual({
      programArgs: ['/Users/x/.gbrain/autopilot-run.sh'],
      keepAlive: true,
    });
  });
});

describe('classifyLiveGbrainProcess', () => {
  test('separates serve/daemon from transient upgrade CLI', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { classifyLiveGbrainProcess } = mod!;
    expect(classifyLiveGbrainProcess('gbrain serve --http')).toBe('serve');
    expect(classifyLiveGbrainProcess('/Users/x/.bun/bin/gbrain jobs supervisor start')).toBe('daemon');
    expect(classifyLiveGbrainProcess('gbrain autopilot --repo /data/brain')).toBe('daemon');
    expect(classifyLiveGbrainProcess('gbrain self-upgrade')).toBe('transient');
    expect(classifyLiveGbrainProcess('gbrain post-upgrade')).toBe('transient');
    expect(classifyLiveGbrainProcess('gbrain doctor --json')).toBe('transient');
    expect(classifyLiveGbrainProcess('vim notes.md')).toBeNull();
  });
});

describe('restartGbrainDaemonsAfterUpgrade (darwin, injected)', () => {
  test('kickstarts matching KeepAlive jobs and never touches interactive serve', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { restartGbrainDaemonsAfterUpgrade } = mod!;

    const kickstarted: string[] = [];
    const warnings: string[] = [];
    const logs: string[] = [];

    const report = restartGbrainDaemonsAfterUpgrade({
      platform: 'darwin',
      uid: 501,
      home: '/Users/test',
      launchctlList: () =>
        [
          'PID\tStatus\tLabel',
          '100\t0\tcom.gbrain.autopilot',
          '200\t0\tcom.example.gbrain-http',
          '-\t0\tcom.gbrain.brain-pull.default',
          '300\t0\tcom.apple.Spotlight',
        ].join('\n'),
      readLaunchdJob: (label) => {
        if (label === 'com.gbrain.autopilot') {
          return { programArgs: ['/Users/test/.gbrain/autopilot-run.sh'], keepAlive: true };
        }
        if (label === 'com.example.gbrain-http') {
          return { programArgs: ['/Users/test/.gbrain/scripts/serve-http.sh'], keepAlive: true };
        }
        if (label === 'com.gbrain.brain-pull.default') {
          return { programArgs: ['/Users/test/.gbrain/brain-pull.sh'], keepAlive: false };
        }
        if (label === 'com.apple.Spotlight') {
          return { programArgs: ['/System/Library/Spotlight'], keepAlive: true };
        }
        return null;
      },
      readFile: (p) => {
        if (p.endsWith('serve-http.sh')) return 'exec gbrain serve --http\n';
        if (p.endsWith('brain-pull.sh')) return 'exec gbrain sources pull\n';
        throw new Error('ENOENT ' + p);
      },
      kickstart: (label, uid) => {
        kickstarted.push(`gui/${uid}/${label}`);
      },
      listGbrainProcesses: () => [
        { pid: 100, cmdline: '/Users/test/.bun/bin/gbrain autopilot --repo /data' },
        { pid: 200, cmdline: '/Users/test/.bun/bin/gbrain serve --http' },
        // Interactive serve — NOT under a launchd job we restart
        { pid: 999, cmdline: 'gbrain serve' },
        { pid: process.pid, cmdline: 'gbrain post-upgrade' },
      ],
      log: (l) => logs.push(l),
      warn: (l) => warnings.push(l),
    });

    expect(kickstarted.sort()).toEqual([
      'gui/501/com.example.gbrain-http',
      'gui/501/com.gbrain.autopilot',
    ]);
    // Interval brain-pull and Spotlight must never be kickstarted.
    expect(kickstarted.join(' ')).not.toContain('brain-pull');
    expect(kickstarted.join(' ')).not.toContain('Spotlight');

    const okKick = report.actions.filter((a) => a.kind === 'launchd-kickstart' && a.ok);
    expect(okKick.map((a) => a.target).sort()).toEqual([
      'com.example.gbrain-http',
      'com.gbrain.autopilot',
    ]);

    // Interactive serve warned, never killed (no kickstart of pid 999).
    expect(report.unmanagedWarnings.some((p) => p.pid === 999)).toBe(true);
    expect(warnings.join('\n')).toMatch(/pid 999/);
    expect(warnings.join('\n')).toMatch(/NOT killed/i);
  });

  test('records kickstart failure without throwing (upgrade must stay successful)', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { restartGbrainDaemonsAfterUpgrade, formatDaemonRestartHint } = mod!;

    const report = restartGbrainDaemonsAfterUpgrade({
      platform: 'darwin',
      uid: 501,
      launchctlList: () => '100\t0\tcom.gbrain.autopilot\n',
      readLaunchdJob: () => ({
        programArgs: ['/Users/test/.gbrain/autopilot-run.sh'],
        keepAlive: true,
      }),
      kickstart: () => {
        throw new Error('launchctl boom');
      },
      listGbrainProcesses: () => [],
      log: () => {},
      warn: () => {},
    });

    expect(report.actions.some((a) => a.kind === 'launchd-kickstart' && !a.ok)).toBe(true);
    expect(formatDaemonRestartHint(report)).toContain('launchctl kickstart -k');
  });
});

describe('restartGbrainDaemonsAfterUpgrade (linux, injected)', () => {
  test('try-restarts autopilot unit and warns about other live daemons', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { restartGbrainDaemonsAfterUpgrade, AUTOPILOT_SYSTEMD_UNIT } = mod!;

    const restarted: string[] = [];
    const warnings: string[] = [];

    const report = restartGbrainDaemonsAfterUpgrade({
      platform: 'linux',
      systemdUnitPresent: (unit) => unit === AUTOPILOT_SYSTEMD_UNIT,
      systemctlTryRestart: (unit) => {
        restarted.push(unit);
      },
      listGbrainProcesses: () => [
        { pid: 42, cmdline: 'gbrain jobs supervisor start --queue default' },
        { pid: 43, cmdline: 'gbrain serve --http' },
      ],
      log: () => {},
      warn: (l) => warnings.push(l),
    });

    expect(restarted).toEqual([AUTOPILOT_SYSTEMD_UNIT]);
    expect(report.actions.some((a) => a.kind === 'systemd-try-restart' && a.ok)).toBe(true);
    expect(warnings.join('\n')).toMatch(/OLD code/);
    expect(warnings.join('\n')).toMatch(/pid 42/);
    expect(warnings.join('\n')).toMatch(/pid 43/);
  });

  test('when no systemd unit, still prints actionable warning with PIDs', async () => {
    const mod = await loadMod();
    expect(mod).not.toBeNull();
    const { restartGbrainDaemonsAfterUpgrade } = mod!;
    const warnings: string[] = [];

    restartGbrainDaemonsAfterUpgrade({
      platform: 'linux',
      systemdUnitPresent: () => false,
      systemctlTryRestart: () => {
        throw new Error('should not be called');
      },
      listGbrainProcesses: () => [{ pid: 7, cmdline: 'gbrain autopilot --repo /data' }],
      log: () => {},
      warn: (l) => warnings.push(l),
    });

    expect(warnings.join('\n')).toMatch(/pid 7/);
    expect(warnings.join('\n')).toMatch(/systemctl --user try-restart/);
  });
});

describe('upgrade.ts wiring (source analysis)', () => {
  test('runPostUpgrade and swap-only path call runPostUpgradeDaemonRestart', () => {
    // test-reads-source-ok: behavioral spawn of full post-upgrade connects an
    // engine and mutates the host; source pin matches upgrade.serial.test.ts.
    const source = readFileSync(join(ROOT, 'src/commands/upgrade.ts'), 'utf8');
    expect(source).toContain('runPostUpgradeDaemonRestart');
    expect(source).toContain("phase: 'daemon-restart'");
    expect(source).toContain('post-upgrade-daemon-restart');

    // runPostUpgrade body must invoke the helper (not merely define it).
    // Anchor on the exact signature — `runPostUpgradeDaemonRestart` also
    // starts with that prefix and would steal a naive indexOf.
    const postUpgradeStart = source.indexOf('export async function runPostUpgrade(args');
    expect(postUpgradeStart).toBeGreaterThan(0);
    const postUpgradeSlice = source.slice(postUpgradeStart, postUpgradeStart + 2500);
    expect(postUpgradeSlice).toContain('await runPostUpgradeDaemonRestart');

    // --swap-only early return must also restart daemons (post-upgrade is skipped).
    const swapOnlyIdx = source.indexOf('if (swapOnly)');
    expect(swapOnlyIdx).toBeGreaterThan(0);
    const swapSlice = source.slice(swapOnlyIdx, swapOnlyIdx + 500);
    expect(swapSlice).toContain('runPostUpgradeDaemonRestart');
  });
});

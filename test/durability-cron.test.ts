/**
 * Durability cron generators (v0.42.44, D2 + D12): pure-string renderers.
 * Asserts the cron is DB-free (gbrain sources pull --path, NOT `pull <id>`),
 * secret-free, self-disabling, and that the launchd plist is periodic.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withEnv } from './helpers/with-env.ts';
import {
  renderCronWrapper,
  generateBrainPullPlist,
  installDurabilityCron,
  durabilityJobStatus,
} from '../src/core/brain-repo-durability.ts';

const TOKEN = 'ghp_SHOULD_NEVER_APPEAR';

describe('renderCronWrapper (D2 DB-free)', () => {
  const w = renderCronWrapper('wiki', '/data/clones/wiki', 'main', '/usr/local/bin/gbrain', '/home/u/.gbrain/brain-push.log');

  test('calls the DB-free path command, not the engine-opening one', () => {
    expect(w).toContain("sources pull --path '/data/clones/wiki'");
    expect(w).toContain("--branch 'main'");
    expect(w).not.toMatch(/sources pull '?wiki'?(\s|$)/); // never `sources pull wiki`
  });

  test('self-disables via git rev-parse (recognizes worktrees where the git marker is a FILE), not a bare dir test', () => {
    expect(w).toContain("if ! git -C '/data/clones/wiki' rev-parse --is-inside-work-tree");
    expect(w).not.toContain("-d '/data/clones/wiki/.git'");
    expect(w).not.toContain("-d '/data/clones/wiki'");
    expect(w).toContain('not a git work tree, skipping');
  });

  test('sources the shell profile (secret-free) and never bakes a token', () => {
    expect(w).toContain('source ~/.zshenv');
    expect(w.includes(TOKEN)).toBe(false);
  });
});

describe('generateBrainPullPlist (D12 launchd)', () => {
  const plist = generateBrainPullPlist('com.gbrain.brain-pull.wiki', '/home/u/.gbrain/brain-pull-wiki.sh', '/home/u', 1800);

  test('is periodic (StartInterval), not a KeepAlive daemon', () => {
    expect(plist).toContain('<key>StartInterval</key><integer>1800</integer>');
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });

  test('carries the per-source label and the wrapper path only (no secret)', () => {
    expect(plist).toContain('<string>com.gbrain.brain-pull.wiki</string>');
    expect(plist).toContain('/home/u/.gbrain/brain-pull-wiki.sh');
    expect(plist.includes(TOKEN)).toBe(false);
  });
});


describe('installDurabilityCron — crontab probe [B2/D-cloud]', () => {
  test('crontab absent on a non-darwin host → skipped (expected in containers), never needs_attention', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin-'));
    const home = mkdtempSync(join(tmpdir(), 'gb-cron-'));
    await withEnv({ PATH: empty, GBRAIN_HOME: home }, async () => {
      const r = installDurabilityCron('wiki', '/data/clones/wiki', 'main', 1800, false, 'linux');
      expect(r.status).toBe('skipped');
      expect(r.detail).toContain('no crontab on this host');
      expect(r.detail).toContain('post-commit auto-push');
    });
  });

  test('crontab present but failing → needs_attention (a real breakage stays loud)', async () => {
    const shim = mkdtempSync(join(tmpdir(), 'shim-cron-'));
    // -l lists empty; writing the new tab (crontab -) fails.
    writeFileSync(join(shim, 'crontab'), '#!/bin/sh\ncase "$1" in -l) exit 0;; esac\nexit 1\n', { mode: 0o755 });
    const home = mkdtempSync(join(tmpdir(), 'gb-cron2-'));
    await withEnv({ PATH: `${shim}:${process.env.PATH ?? ''}`, GBRAIN_HOME: home }, async () => {
      const r = installDurabilityCron('wiki', '/data/clones/wiki', 'main', 1800, false, 'linux');
      expect(r.status).toBe('needs_attention');
      expect(r.detail).toContain('crontab install failed');
    });
  });

  test('dry-run on a crontab-less host still reports the honest skip', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin2-'));
    await withEnv({ PATH: empty }, async () => {
      const r = installDurabilityCron('wiki', '/data/clones/wiki', 'main', 1800, true, 'linux');
      expect(r.status).toBe('skipped');
    });
  });
});

describe('durabilityJobStatus — presence + liveness [D7]', () => {
  test('no scheduler binaries at all → kind none (never throws)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin3-'));
    const home = mkdtempSync(join(tmpdir(), 'jb-home-'));
    await withEnv({ PATH: empty, HOME: home }, async () => {
      const s = durabilityJobStatus('wiki', 1800, 'linux');
      expect(s.kind).toBe('none');
      expect(s.wrapperPresent).toBe(false);
    });
  });

  test('crontab line present (shim) → kind crontab, live', async () => {
    const shim = mkdtempSync(join(tmpdir(), 'shim-jb-'));
    writeFileSync(
      join(shim, 'crontab'),
      '#!/bin/sh\ncase "$1" in -l) echo "*/30 * * * * /x.sh # com.gbrain.brain-pull.wiki"; exit 0;; esac\nexit 1\n',
      { mode: 0o755 },
    );
    const home = mkdtempSync(join(tmpdir(), 'jb-home2-'));
    await withEnv({ PATH: shim, HOME: home }, async () => {
      const s = durabilityJobStatus('wiki', 1800, 'linux');
      expect(s.kind).toBe('crontab');
      expect(s.live).toBe(true);
    });
  });

  test('stale pull log is reported (logFresh false)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin4-'));
    const home = mkdtempSync(join(tmpdir(), 'jb-home3-'));
    const logDir = join(home, '.gbrain');
    // A log last touched 3 hours ago against a 30-min interval.
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, 'brain-pull.log');
    writeFileSync(log, 'old\n');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(log, old, old);
    await withEnv({ PATH: empty, HOME: home }, async () => {
      const s = durabilityJobStatus('wiki', 1800, 'linux');
      expect(s.logFresh).toBe(false);
    });
  });
});

describe('durabilityJobStatus — darwin launchd liveness [D7]', () => {
  async function darwinFixture(launchctlExit: number): Promise<ReturnType<typeof durabilityJobStatus>> {
    const home = mkdtempSync(join(tmpdir(), 'jb-mac-'));
    const plistDir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, 'com.gbrain.brain-pull.wiki.plist'), '<plist/>');
    const shim = mkdtempSync(join(tmpdir(), 'shim-lc-'));
    writeFileSync(join(shim, 'launchctl'), `#!/bin/sh\nexit ${launchctlExit}\n`, { mode: 0o755 });
    return withEnv({ PATH: shim, HOME: home }, async () => durabilityJobStatus('wiki', 1800, 'darwin'));
  }

  test('plist present + launchctl reports loaded → live', async () => {
    const s = await darwinFixture(0);
    expect(s.kind).toBe('launchd');
    expect(s.live).toBe(true);
  });

  test('plist present but NOT loaded (the dead-job shape [D7]) → live=false', async () => {
    const s = await darwinFixture(1);
    expect(s.kind).toBe('launchd');
    expect(s.live).toBe(false);
  });
});

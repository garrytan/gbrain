/**
 * #5195 (T4, ENG-O11): every brain gets its own autopilot job name.
 *
 * The default brain (`~/.gbrain`) keeps the shared pre-#5195 names; any other
 * brain derives `<name>-<suffix>` names from a random install id recorded in
 * `<brain>/autopilot-install-id` as `{ id, realpath, created_at }`. These pin
 * the id's copy/move semantics, the concurrent first install, the default-brain
 * rule, the test-seam override, and crontab-line ownership. The install-target
 * behavior (all four targets, two brains, legacy replacement) is pinned end to
 * end in test/e2e/autopilot-multi-brain.serial.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import {
  type AutopilotJob,
  autopilotInstallIdPath,
  autopilotLaunchdLabel,
  autopilotWrapperOwner,
  ensureAutopilotInstallId,
  isDefaultBrainHome,
  resolveAutopilotInstallId,
  resolveAutopilotJob,
} from '../src/core/autopilot-paths.ts';
import { cronLineBelongsToBrain, generateSelfDisableGuard } from '../src/commands/autopilot.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO = resolve(import.meta.dir, '..');

/**
 * Bun's os.homedir() is fixed at process start, so the default-brain rule
 * (which compares against homedir()/.gbrain, as configDir() does) is checked
 * in a child process started with the HOME under test.
 */
function jobIn(env: Record<string, string | undefined>, mint = false): AutopilotJob & { isDefault: boolean } {
  const script = `import { resolveAutopilotJob, isDefaultBrainHome } from ${JSON.stringify(join(REPO, 'src/core/autopilot-paths.ts'))};\n` +
    `process.stdout.write(JSON.stringify({ ...resolveAutopilotJob({ mint: ${mint} }), isDefault: isDefaultBrainHome() }));\n`;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) childEnv[k] = v;
  const r = spawnSync(process.execPath, ['-e', script], { env: childEnv, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function withHosts(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-5195-')));
  mkdirSync(join(root, 'home'), { recursive: true });
  try {
    await withEnv({ HOME: join(root, 'home'), GBRAIN_AUTOPILOT_LABEL: undefined }, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('#5195 default brain keeps the shared names', () => {
  test('GBRAIN_HOME unset, or pointing at $HOME, is the default brain', async () => {
    await withHosts(async (root) => {
      const home = join(root, 'home');
      for (const gbrainHome of [undefined, home]) {
        const job = jobIn({ HOME: home, GBRAIN_HOME: gbrainHome }, true);
        expect(job.isDefault).toBe(true);
        expect(job.kind).toBe('default');
        expect(job.launchdLabel).toBe('com.gbrain.autopilot');
        expect(job.systemdUnit).toBe('gbrain-autopilot.service');
        expect(job.startScriptPath).toBe(join(home, '.gbrain', 'start-autopilot.sh'));
        expect(job.cronMarker).toBeNull();
        expect(job.logPath).toBe(join(home, '.gbrain', 'autopilot.log'));
        expect(job.installIdPath).toBeNull();
        expect(existsSync(join(home, '.gbrain', 'autopilot-install-id'))).toBe(false);
      }
    });
  });

  test('a symlinked GBRAIN_HOME that resolves to ~/.gbrain is still the default brain', async () => {
    await withHosts(async (root) => {
      mkdirSync(join(root, 'home', '.gbrain'), { recursive: true });
      const { symlinkSync } = await import('fs');
      symlinkSync(join(root, 'home'), join(root, 'alias'));
      expect(jobIn({ HOME: join(root, 'home'), GBRAIN_HOME: join(root, 'alias') }).isDefault).toBe(true);
      expect(jobIn({ HOME: join(root, 'home'), GBRAIN_HOME: join(root, 'other') }).isDefault).toBe(false);
    });
  });
});

describe('#5195 non-default brains get their own names from the install id', () => {
  test('two brains on one host get distinct suffixed names, all four targets', async () => {
    await withHosts(async (root) => {
      const a = await withEnv({ GBRAIN_HOME: join(root, 'brain-a') }, () => resolveAutopilotJob({ mint: true }));
      const b = await withEnv({ GBRAIN_HOME: join(root, 'brain-b') }, () => resolveAutopilotJob({ mint: true }));
      for (const job of [a, b]) {
        expect(job.kind).toBe('suffixed');
        expect(job.suffix).toMatch(/^[0-9a-f]{8}$/);
        expect(job.launchdLabel).toBe(`com.gbrain.autopilot.${job.suffix}`);
        expect(job.systemdUnit).toBe(`gbrain-autopilot-${job.suffix}.service`);
        expect(job.startScriptPath).toBe(join(job.homeDir, `start-autopilot-${job.suffix}.sh`));
        expect(job.cronMarker).toBe(`# gbrain-autopilot:${job.suffix}`);
        expect(job.logPath).toBe(join(job.homeDir, 'autopilot.log'));
      }
      expect(a.suffix).not.toBe(b.suffix);
      expect(a.launchdLabel).not.toBe(b.launchdLabel);
      expect(a.systemdUnit).not.toBe(b.systemdUnit);
    });
  });

  test('the record holds { id, realpath, created_at } and a reinstall reuses it', async () => {
    await withHosts(async (root) => {
      await withEnv({ GBRAIN_HOME: join(root, 'brain-a') }, () => {
        const id = ensureAutopilotInstallId();
        const rec = JSON.parse(readFileSync(autopilotInstallIdPath(), 'utf-8'));
        expect(rec.id).toBe(id);
        expect(rec.realpath).toBe(join(root, 'brain-a', '.gbrain'));
        expect(Number.isNaN(Date.parse(rec.created_at))).toBe(false);
        expect(ensureAutopilotInstallId()).toBe(id);
      });
    });
  });

  test('read-only resolution never mints: an uninstalled brain owns no named job', async () => {
    await withHosts(async (root) => {
      await withEnv({ GBRAIN_HOME: join(root, 'never-installed') }, () => {
        const job = resolveAutopilotJob();
        expect(job.kind).toBe('unassigned');
        expect(job.suffix).toBeNull();
        // A configDir() that does not exist yet resolves with `resolve`.
        expect(resolveAutopilotInstallId().relation).toBe('none');
        expect(existsSync(join(root, 'never-installed'))).toBe(false);
      });
    });
  });

  test('cp -r of a brain mints a new id on install (the original still exists)', async () => {
    await withHosts(async (root) => {
      const original = await withEnv({ GBRAIN_HOME: join(root, 'brain-a') }, () => ensureAutopilotInstallId());
      cpSync(join(root, 'brain-a'), join(root, 'brain-copy'), { recursive: true });
      await withEnv({ GBRAIN_HOME: join(root, 'brain-copy') }, () => {
        expect(resolveAutopilotInstallId().relation).toBe('copied');
        expect(resolveAutopilotJob().kind).toBe('unassigned');
        const copy = ensureAutopilotInstallId();
        expect(copy).not.toBe(original);
        expect(JSON.parse(readFileSync(autopilotInstallIdPath(), 'utf-8')).realpath).toBe(join(root, 'brain-copy', '.gbrain'));
      });
      await withEnv({ GBRAIN_HOME: join(root, 'brain-a') }, () => {
        expect(ensureAutopilotInstallId()).toBe(original);
      });
    });
  });

  test('mv of a brain keeps its id and job, and records the new path', async () => {
    await withHosts(async (root) => {
      const before = await withEnv({ GBRAIN_HOME: join(root, 'brain-a') }, () => resolveAutopilotJob({ mint: true }));
      renameSync(join(root, 'brain-a'), join(root, 'brain-moved'));
      await withEnv({ GBRAIN_HOME: join(root, 'brain-moved') }, () => {
        expect(resolveAutopilotInstallId().relation).toBe('moved');
        expect(resolveAutopilotJob().suffix).toBe(before.suffix);
        const after = resolveAutopilotJob({ mint: true });
        expect(after.suffix).toBe(before.suffix);
        expect(after.launchdLabel).toBe(before.launchdLabel);
        expect(JSON.parse(readFileSync(autopilotInstallIdPath(), 'utf-8')).realpath).toBe(join(root, 'brain-moved', '.gbrain'));
        expect(resolveAutopilotInstallId().relation).toBe('same');
      });
    });
  });

  test('concurrent first installs agree on one id', async () => {
    await withHosts(async (root) => {
      const gbrainHome = join(root, 'brain-race');
      const script = `import { ensureAutopilotInstallId } from ${JSON.stringify(join(REPO, 'src/core/autopilot-paths.ts'))};\nprocess.stdout.write(ensureAutopilotInstallId());\n`;
      const scriptPath = join(root, 'race.ts');
      writeFileSync(scriptPath, script);
      const runs = Array.from({ length: 6 }, () => new Promise<string>((done, fail) => {
        const child = spawn(process.execPath, [scriptPath], { env: { ...process.env, GBRAIN_HOME: gbrainHome, HOME: join(root, 'home') } });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => (code === 0 ? done(out.trim()) : fail(new Error(`exit ${code}: ${err}`))));
      }));
      const ids = await Promise.all(runs);
      expect(new Set(ids).size).toBe(1);
      expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
      const leftovers = (await import('fs')).readdirSync(join(gbrainHome, '.gbrain')).filter(f => f.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });
  }, 60_000);

  test('concurrent installs of a freshly copied brain settle on one new id', async () => {
    await withHosts(async (root) => {
      const original = await withEnv({ GBRAIN_HOME: join(root, 'brain-a') }, () => ensureAutopilotInstallId());
      cpSync(join(root, 'brain-a'), join(root, 'brain-copy'), { recursive: true });
      const script = `import { ensureAutopilotInstallId } from ${JSON.stringify(join(REPO, 'src/core/autopilot-paths.ts'))};\nprocess.stdout.write(ensureAutopilotInstallId());\n`;
      const scriptPath = join(root, 'race-copy.ts');
      writeFileSync(scriptPath, script);
      const ids = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((done, fail) => {
        const child = spawn(process.execPath, [scriptPath], { env: { ...process.env, GBRAIN_HOME: join(root, 'brain-copy'), HOME: join(root, 'home') } });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => (code === 0 ? done(out.trim()) : fail(new Error(`exit ${code}: ${err}`))));
      })));
      expect(new Set(ids).size).toBe(1);
      expect(ids[0]).not.toBe(original);
      const recorded = JSON.parse(readFileSync(join(root, 'brain-copy', '.gbrain', 'autopilot-install-id'), 'utf-8'));
      expect(recorded.id).toBe(ids[0]);
      expect(existsSync(join(root, 'brain-copy', '.gbrain', 'autopilot-install-id.lock'))).toBe(false);
    });
  }, 60_000);

  test('the GBRAIN_AUTOPILOT_LABEL test seam still wins over the suffix', async () => {
    await withHosts(async (root) => {
      await withEnv({ GBRAIN_HOME: join(root, 'brain-a'), GBRAIN_AUTOPILOT_LABEL: 'com.gbrain.autopilot.test.seam' }, () => {
        const job = resolveAutopilotJob({ mint: true });
        expect(job.suffix).not.toBeNull();
        expect(job.launchdLabel).toBe('com.gbrain.autopilot.test.seam');
        expect(autopilotLaunchdLabel(job.suffix)).toBe('com.gbrain.autopilot.test.seam');
      });
    });
  });

  test("the wrapper's self-disable lines name this brain's own label and unit", async () => {
    await withHosts(async (root) => {
      await withEnv({ GBRAIN_HOME: join(root, 'brain-a') }, () => {
        const job = resolveAutopilotJob({ mint: true });
        expect(generateSelfDisableGuard('/data/brain', 'macos', job)).toContain(`gui/$(id -u)/com.gbrain.autopilot.${job.suffix}`);
        expect(generateSelfDisableGuard('/data/brain', 'linux-systemd', job)).toContain(`disable --now gbrain-autopilot-${job.suffix}.service`);
      });
    });
  });
});

describe('#5195 crontab line ownership', () => {
  test('marked lines belong to their suffix; unmarked lines to the brain whose wrapper they name, else the default brain', async () => {
    await withHosts(async (root) => {
      const home = join(root, 'home');
      const def = jobIn({ HOME: home, GBRAIN_HOME: undefined });
      expect(def.kind).toBe('default');
      const a = await withEnv({ GBRAIN_HOME: join(root, 'brain-a') }, () => resolveAutopilotJob({ mint: true }));
      const b = await withEnv({ GBRAIN_HOME: join(root, 'brain-b') }, () => resolveAutopilotJob({ mint: true }));
      const marked = `*/5 * * * * '${a.wrapperPath}' >> '${a.logPath}' 2>&1 ${a.cronMarker}`;
      const legacyA = `*/5 * * * * '${a.wrapperPath}' >> '${home}/.gbrain/autopilot.log' 2>&1`;
      const legacyDefault = `*/5 * * * * '${home}/.gbrain/autopilot-run.sh' >> '${home}/.gbrain/autopilot.log' 2>&1`;
      const direct = '*/5 * * * * gbrain autopilot --repo /data/brain';
      const monitor = '*/10 * * * * gbrain autopilot --status --json >> health.log';

      expect(cronLineBelongsToBrain(marked, a)).toBe(true);
      expect(cronLineBelongsToBrain(marked, b)).toBe(false);
      expect(cronLineBelongsToBrain(marked, def)).toBe(false);

      expect(cronLineBelongsToBrain(legacyA, a)).toBe(true);
      expect(cronLineBelongsToBrain(legacyA, b)).toBe(false);
      expect(cronLineBelongsToBrain(legacyA, def)).toBe(false);

      expect(cronLineBelongsToBrain(legacyDefault, def)).toBe(true);
      expect(cronLineBelongsToBrain(legacyDefault, a)).toBe(false);

      expect(cronLineBelongsToBrain(direct, def)).toBe(true);
      expect(cronLineBelongsToBrain(direct, a)).toBe(false);

      expect(cronLineBelongsToBrain(monitor, def)).toBe(false);
      expect(cronLineBelongsToBrain(`# ${legacyDefault}`, def)).toBe(false);
    });
  });

  test('wrapper ownership: own, dangling (moved brain), another live brain', async () => {
    await withHosts(async (root) => {
      mkdirSync(join(root, 'brain-b', '.gbrain'), { recursive: true });
      writeFileSync(join(root, 'brain-b', '.gbrain', 'autopilot-run.sh'), '#!/bin/sh\n');
      const home = join(root, 'brain-a', '.gbrain');
      expect(autopilotWrapperOwner(join(home, 'autopilot-run.sh'), home).owner).toBe('own');
      expect(autopilotWrapperOwner(join(root, 'gone', '.gbrain', 'autopilot-run.sh'), home).owner).toBe('dangling');
      expect(autopilotWrapperOwner(join(root, 'brain-b', '.gbrain', 'autopilot-run.sh'), home))
        .toEqual({ owner: 'other', home: join(root, 'brain-b', '.gbrain') });
      expect(autopilotWrapperOwner(null, home).owner).toBe('unknown');
    });
  });
});

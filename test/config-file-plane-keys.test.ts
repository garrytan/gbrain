/**
 * Bootstrap hook-lane config keys are FILE-plane canonical [D18]:
 * `config set` must route `push.allow_unverified_remote` and
 * `hooks.stop_push_debounce_min` to ~/.gbrain/config.json (NEVER the DB
 * plane) because their readers are engine-free hook/push children that only
 * see loadConfigFileOnly. These tests pin the write half (runConfig routing +
 * the loud warning) and the read half (configAllowsUnverifiedRemote).
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runConfig } from '../src/commands/config.ts';
import { configAllowsUnverifiedRemote } from '../src/core/workspace-push.ts';
import {
  BACKUP_INTERVAL_DAYS_DEFAULT,
  backupCheckDisabled,
  backupIntervalMs,
  __setBackupIntervalForTests,
} from '../src/core/backup/status-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

// The file-plane write never depends on the engine — a null stub proves it.
// (Its best-effort stale-DB-row cleanup warns on the null stub and continues.)
const noEngine = null as unknown as BrainEngine;

async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return out;
}

describe('config set — file-plane bootstrap hook-lane keys [D18]', () => {
  test('push.allow_unverified_remote: set true → file plane + loud warning; read half sees it; set false unsets', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-plane-'));
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const out = await captureLog(() => runConfig(noEngine, ['set', 'push.allow_unverified_remote', 'true']));
      expect(out).toContain('file plane');
      // Every enable warns loudly — the override trusts the remote on the user's word.
      expect(out).toContain('WARNING');
      expect(out).toContain('SKIP repo-visibility verification');
      const cfgPath = join(parent, '.gbrain', 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { push?: { allow_unverified_remote?: boolean } };
      expect(cfg.push?.allow_unverified_remote).toBe(true);
      // The engine-free read half (detached push children) sees the same file.
      expect(configAllowsUnverifiedRemote()).toBe(true);

      // set false → off, and no warning banner.
      const out2 = await captureLog(() => runConfig(noEngine, ['set', 'push.allow_unverified_remote', 'false']));
      expect(out2).not.toContain('WARNING');
      expect(configAllowsUnverifiedRemote()).toBe(false);
    });
  });

  test('hooks.stop_push_debounce_min: integer minutes land on the file plane (0 = every turn allowed)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-plane2-'));
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const out = await captureLog(() => runConfig(noEngine, ['set', 'hooks.stop_push_debounce_min', '7']));
      expect(out).toContain('Set hooks.stop_push_debounce_min = 7');
      expect(out).toContain('file plane');
      const cfgPath = join(parent, '.gbrain', 'config.json');
      let cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { hooks?: { stop_push_debounce_min?: number } };
      expect(cfg.hooks?.stop_push_debounce_min).toBe(7);
      // 0 is valid (cloud-sandbox cadence: push every turn).
      await captureLog(() => runConfig(noEngine, ['set', 'hooks.stop_push_debounce_min', '0']));
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { hooks?: { stop_push_debounce_min?: number } };
      expect(cfg.hooks?.stop_push_debounce_min).toBe(0);
    });
  });
});

/**
 * backup.* keys are FILE-plane canonical for the same reason as the hook-lane
 * keys: their readers (backupCheckDisabled / backupIntervalMs in
 * src/core/backup/status-file.ts) are engine-free — `gbrain hook`, the cli.ts
 * startup rail, and the MCP dispatch notice all resolve through
 * loadConfigFileOnly, which never sees the DB plane. These tests pin the write
 * half (runConfig routes the nested keys to ~/.gbrain/config.json) AND the
 * read half (the status-file resolvers flip on the same file).
 */
describe('config set — backup.* file-plane keys', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Validation-error idiom: console.error + process.exit(1) → capture the
   * error stream and turn exit into a recoverable sentinel throw. */
  async function captureErrExit(fn: () => Promise<void>): Promise<{ err: string; exitCode: number | undefined }> {
    const origErr = console.error;
    const origExit = process.exit;
    let err = '';
    let exitCode: number | undefined;
    console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
    (process as { exit: unknown }).exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error('__exit__');
    }) as unknown as typeof process.exit;
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== '__exit__') throw e;
    } finally {
      console.error = origErr;
      process.exit = origExit;
    }
    return { err, exitCode };
  }

  test('backup.check_enabled: false lands NESTED on the file plane and flips backupCheckDisabled(); true flips it back; unset restores the default', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-backup-'));
    // Clear the env kill switch — backupCheckDisabled consults it first.
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_BACKUP_CHECK: undefined }, async () => {
      const out = await captureLog(() => runConfig(noEngine, ['set', 'backup.check_enabled', 'false']));
      expect(out).toContain('Set backup.check_enabled = false');
      expect(out).toContain('file plane');
      const cfgPath = join(parent, '.gbrain', 'config.json');
      let cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { backup?: { check_enabled?: boolean } };
      expect(cfg.backup?.check_enabled).toBe(false); // nested, not a flat dotted key
      // The engine-free read half sees the same file.
      expect(backupCheckDisabled()).toBe(true);

      // set true → re-enabled.
      await captureLog(() => runConfig(noEngine, ['set', 'backup.check_enabled', 'true']));
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { backup?: { check_enabled?: boolean } };
      expect(cfg.backup?.check_enabled).toBe(true);
      expect(backupCheckDisabled()).toBe(false);

      // unset → key removed from the file, default (enabled) restored.
      const out2 = await captureLog(() => runConfig(noEngine, ['unset', 'backup.check_enabled']));
      expect(out2).toContain('Unset backup.check_enabled (file plane)');
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { backup?: { check_enabled?: boolean } };
      expect(cfg.backup?.check_enabled).toBeUndefined();
      expect(backupCheckDisabled()).toBe(false);
    });
  });

  test('backup.check_interval_days: 7 lands nested and backupIntervalMs() = 7d; unset restores the 30d default', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-backup2-'));
    // Env resolves ABOVE config in backupIntervalMs — clear it; also clear any
    // leftover test-seam override so the config value is what resolves.
    __setBackupIntervalForTests(null);
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_BACKUP_CHECK_DAYS: undefined }, async () => {
      const out = await captureLog(() => runConfig(noEngine, ['set', 'backup.check_interval_days', '7']));
      expect(out).toContain('Set backup.check_interval_days = 7');
      expect(out).toContain('file plane');
      const cfgPath = join(parent, '.gbrain', 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { backup?: { check_interval_days?: number } };
      expect(cfg.backup?.check_interval_days).toBe(7);
      expect(backupIntervalMs()).toBe(7 * DAY);

      // unset → default interval restored.
      await captureLog(() => runConfig(noEngine, ['unset', 'backup.check_interval_days']));
      expect(backupIntervalMs()).toBe(BACKUP_INTERVAL_DAYS_DEFAULT * DAY);
    });
  });

  test('backup.check_interval_days: "0" and "abc" are refused (exit 1, nothing written)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-backup3-'));
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_BACKUP_CHECK_DAYS: undefined }, async () => {
      const cfgPath = join(parent, '.gbrain', 'config.json');
      for (const bad of ['0', 'abc']) {
        const { err, exitCode } = await captureErrExit(() =>
          runConfig(noEngine, ['set', 'backup.check_interval_days', bad]));
        expect(exitCode).toBe(1);
        expect(err).toContain('backup.check_interval_days must be an integer >= 1');
        expect(existsSync(cfgPath)).toBe(false); // the refused set wrote NOTHING
      }
    });
  });
});

/**
 * Vendor API keys are FILE-plane canonical too.
 *
 * `buildGatewayConfig` folds credentials into the gateway env from the file
 * plane (config.json) + process env ONLY — it never reads the DB plane. So
 * `gbrain config set openai_api_key sk-...` writing the DB was a silent
 * no-op: it printed "Set openai_api_key = ***", exited 0, and `config get`
 * read it straight back, while every provider call still failed with
 * "requires OPENAI_API_KEY".
 *
 * This is the same bug class the v0.37.11.0 wave closed for embedding_model
 * ("writes the DB plane, which the embed pipeline never reads — silent lie
 * that took users hours to diagnose"). embedding_model can only be fixed by
 * refusing, since changing it needs a wipe-and-reinit. A credential has no
 * such constraint, so the better fix is to route the write to the plane the
 * consumer actually reads.
 *
 * A null engine is the discriminator: the file-plane branch must return
 * before any DB access, so these pass only if nothing reaches the engine.
 */
const GATEWAY_MAPPED_KEYS = [
  'openai_api_key',
  'anthropic_api_key',
  'openrouter_api_key',
  'voyage_api_key',
  'dashscope_api_key',
  'deepseek_api_key',
  'google_api_key',
] as const;

describe('config set — vendor API keys are FILE-plane canonical', () => {
  test('openai_api_key lands in config.json, is redacted in output, and never touches the engine', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-apikey-'));
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const out = await captureLog(() => runConfig(noEngine, ['set', 'openai_api_key', 'sk-TEST-VALUE-123']));
      expect(out).toContain('file plane');
      // #892: the raw secret must never reach stdout/scrollback.
      expect(out).not.toContain('sk-TEST-VALUE-123');
      expect(out).toContain('***');

      const cfgPath = join(parent, '.gbrain', 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { openai_api_key?: string };
      expect(cfg.openai_api_key).toBe('sk-TEST-VALUE-123');
    });
  });

  test('every gateway-mapped vendor key routes to the file plane', async () => {
    for (const key of GATEWAY_MAPPED_KEYS) {
      const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-apikey-all-'));
      await withEnv({ GBRAIN_HOME: parent }, async () => {
        await captureLog(() => runConfig(noEngine, ['set', key, `secret-for-${key}`]));
        const cfgPath = join(parent, '.gbrain', 'config.json');
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
        expect(cfg[key]).toBe(`secret-for-${key}`);
      });
    }
  });

  test('unset removes the key from the file plane, so set/unset round-trip on one plane', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-apikey-unset-'));
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      await captureLog(() => runConfig(noEngine, ['set', 'openai_api_key', 'sk-TO-BE-REMOVED']));
      const cfgPath = join(parent, '.gbrain', 'config.json');
      expect((JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>).openai_api_key)
        .toBe('sk-TO-BE-REMOVED');

      const out = await captureLog(() => runConfig(noEngine, ['unset', 'openai_api_key']));
      expect(out).toContain('file plane');
      expect((JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>).openai_api_key)
        .toBeUndefined();
    });
  });
});

/**
 * integrations.memorable.enabled is a CONSENT event, not a plain write.
 * Enabling requires the gbrain-authored disclosure stamp (a separate 0600
 * file the external memorable CLI has never written — it full-file-rewrites
 * config.json, so a config-key stamp could be forged by habit, lost to a
 * rewrite race, or resurrected after revocation). Under bun test stdin is not
 * a TTY, so the non-interactive posture is what these tests exercise:
 * refuse without --yes, consent with it.
 */
import {
  memorableConsentPath,
  memorableGateAllowed,
  readMemorableConsent,
} from '../src/core/context/hook-heartbeat.ts';

async function captureAll(fn: () => Promise<void>): Promise<{ out: string; err: string; exitCode: number | null }> {
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  let out = '';
  let err = '';
  let exitCode: number | null = null;
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__exit_${code}`); }) as never;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('__exit_'))) throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { out, err, exitCode };
}

describe('config set integrations.memorable.enabled — the disclosure consent gate', () => {
  const enabledOn = { integrations: { memorable: { enabled: true } } };

  test('non-TTY without --yes: disclosure shown, refusal, NOTHING written', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-mem-refuse-'));
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_MEMORABLE: undefined }, async () => {
      const r = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'true']));
      expect(r.out).toContain('closed source'); // the disclosure text rendered
      expect(r.err).toContain('refusing to enable');
      expect(r.err).toContain('[AGENT]');
      expect(r.exitCode).toBe(1);
      expect(await readMemorableConsent()).toBeNull();
      expect(existsSync(join(parent, '.gbrain', 'config.json'))).toBe(false);
      expect((await memorableGateAllowed(enabledOn)).allowed).toBe(false);
    });
  });

  test('--yes consents: stamp written, flag set, gate opens; disable revokes both', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-mem-yes-'));
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_MEMORABLE: undefined }, async () => {
      const r = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'true', '--yes']));
      expect(r.out).toContain('Consent recorded');
      expect(r.out).toContain('Set integrations.memorable.enabled = true');
      // The enable banner names the off switches — the env kill switch is
      // documented nowhere else in gbrain's own output. (#4743 pin)
      expect(r.out).toContain('Turn off:');
      expect(r.out).toContain('GBRAIN_MEMORABLE=0');
      const stamp = await readMemorableConsent();
      expect(stamp).not.toBeNull();
      expect(stamp!.harnesses).toContain('claude-code');
      const cfgPath = join(parent, '.gbrain', 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { integrations?: { memorable?: { enabled?: boolean } } };
      expect(cfg.integrations?.memorable?.enabled).toBe(true);
      expect((await memorableGateAllowed(cfg)).allowed).toBe(true);

      // Disable = revocation: flag off AND the stamp file deleted.
      const r2 = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'false']));
      expect(r2.out).toContain('consent was revoked');
      expect(await readMemorableConsent()).toBeNull();
      expect(existsSync(await memorableConsentPath())).toBe(false);
      // Re-enabling without --yes now refuses again (disclosure required anew).
      const r3 = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'true']));
      expect(r3.exitCode).toBe(1);
    });
  });

  test('unset routes to the file plane and revokes the stamp (the pre-fix DB fall-through lied)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-mem-unset-'));
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_MEMORABLE: undefined }, async () => {
      await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'true', '--yes']));
      expect(await readMemorableConsent()).not.toBeNull();
      const r = await captureAll(() => runConfig(noEngine, ['unset', 'integrations.memorable.enabled']));
      expect(r.out).toContain('Unset integrations.memorable.enabled (file plane)');
      expect(await readMemorableConsent()).toBeNull();
      const cfg = JSON.parse(readFileSync(join(parent, '.gbrain', 'config.json'), 'utf8')) as { integrations?: { memorable?: { enabled?: boolean } } };
      expect(cfg.integrations?.memorable?.enabled).toBeUndefined();
    });
  });

  test('every off-ish spelling writes literal false without prompting (#4743 pin)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-mem-offish-'));
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_MEMORABLE: undefined }, async () => {
      const cfgPath = join(parent, '.gbrain', 'config.json');
      for (const spelling of ['false', 'off', 'no', '0', 'nonsense']) {
        const r = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', spelling]));
        // The false path is not a consent event: no disclosure, no refusal,
        // and the stored value is a real boolean — a string here would still
        // read as OFF at the gate, but the file must say what it means.
        expect(r.out).toContain('= false');
        expect(r.exitCode).toBeNull();
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { integrations?: { memorable?: { enabled?: unknown } } };
        expect(cfg.integrations?.memorable?.enabled).toBe(false);
      }
    });
  });

  test('the key is registered in KNOWN_CONFIG_KEYS, so `config get` does not report it unknown (#4743 pin)', async () => {
    const { KNOWN_CONFIG_KEYS } = await import('../src/core/config.ts');
    expect(KNOWN_CONFIG_KEYS).toContain('integrations.memorable.enabled');
  });

  test('the out-of-band state: flag true (as `memorable enable` writes it) but no stamp — gate stays closed', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-mem-oob-'));
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_MEMORABLE: undefined }, async () => {
      // Simulate the external CLI's b2() write: enabled: true, no disclosure.
      const gb = join(parent, '.gbrain');
      mkdirSync(gb, { recursive: true });
      const cfg = { engine: 'pglite', integrations: { memorable: { enabled: true } } };
      writeFileSync(join(gb, 'config.json'), JSON.stringify(cfg, null, 2));
      const gate = await memorableGateAllowed(cfg);
      expect(gate).toEqual({ allowed: false, reason: 'disclosure_missing' });
    });
  });
});

/**
 * #5489: every `self_upgrade.*` reader is file-plane — the cli.ts startup
 * check (loadConfigFileOnly, before any DB connect), the autopilot silent
 * channel and doctor's self_upgrade_health (loadConfig). `config set
 * self_upgrade.mode auto` used to write the DB plane, print "Set ... = auto"
 * and change nothing. The null engine is the discriminator again: the write
 * must land in config.json without reaching the engine.
 */
import {
  parseSelfUpgradeConfigValue,
  resolveQuietHoursWindow,
  resolveSelfUpgradeMode,
} from '../src/core/self-upgrade.ts';
import { checkSelfUpgradeHealth } from '../src/commands/doctor.ts';
import { tryRunConfigThinClient } from '../src/commands/config.ts';
import { routeThinClientCommand } from '../src/commands/thin-client-routing.ts';
import type { GBrainConfig } from '../src/core/config.ts';

/** A DB plane holding rows an earlier, pre-routing `config set` wrote. */
function staleRowEngine(rows: Record<string, string>): { engine: BrainEngine; rows: Map<string, string> } {
  const map = new Map(Object.entries(rows));
  const engine = {
    getConfig: async (k: string) => map.get(k) ?? null,
    unsetConfig: async (k: string) => (map.delete(k) ? 1 : 0),
  } as unknown as BrainEngine;
  return { engine, rows: map };
}

describe('config set — self_upgrade.* keys are FILE-plane canonical (#5489)', () => {
  const VALID_CASES: ReadonlyArray<{ leaf: string; raw: string; stored: unknown }> = [
    { leaf: 'mode', raw: 'auto', stored: 'auto' },
    { leaf: 'mode', raw: 'off', stored: 'off' },
    { leaf: 'mode_prompted', raw: 'false', stored: false },
    { leaf: 'mode_prompted', raw: 'yes', stored: true },
    { leaf: 'quiet_hours', raw: '{"start":1,"end":5,"tz":"UTC"}', stored: { start: 1, end: 5, tz: 'UTC' } },
    { leaf: 'failed_versions', raw: '0.57.0.0, 0.57.1.0', stored: ['0.57.0.0', '0.57.1.0'] },
    { leaf: 'failed_versions', raw: '["0.57.0.0"]', stored: ['0.57.0.0'] },
    { leaf: 'failed_versions', raw: '[]', stored: [] },
    { leaf: 'attempting_version', raw: '0.57.2.0', stored: '0.57.2.0' },
    // stored in the 4-segment form the upgrade check compares by string
    { leaf: 'attempting_version', raw: 'v0.57.2', stored: '0.57.2.0' },
    { leaf: 'failed_versions', raw: '0.57.1, v0.57.1.0', stored: ['0.57.1.0'] },
    { leaf: 'last_check_ts', raw: '1790000000000', stored: 1790000000000 },
    { leaf: 'last_applied_version', raw: '0.57.1.0', stored: '0.57.1.0' },
  ];

  test('the cases cover every registered self_upgrade.* key', async () => {
    const { KNOWN_CONFIG_KEYS } = await import('../src/core/config.ts');
    const registered = KNOWN_CONFIG_KEYS.filter((k) => k.startsWith('self_upgrade.')).sort();
    const covered = [...new Set(VALID_CASES.map((c) => `self_upgrade.${c.leaf}`))].sort();
    expect(covered).toEqual(registered);
  });

  for (const c of VALID_CASES) {
    test(`self_upgrade.${c.leaf} ${c.raw} lands nested in config.json`, async () => {
      const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-selfup-'));
      await withEnv({ GBRAIN_HOME: parent }, async () => {
        const r = await captureAll(() => runConfig(noEngine, ['set', `self_upgrade.${c.leaf}`, c.raw]));
        expect(r.exitCode).toBeNull();
        expect(r.out).toContain('file plane');
        const cfg = JSON.parse(readFileSync(join(parent, '.gbrain', 'config.json'), 'utf8')) as {
          self_upgrade?: Record<string, unknown>;
        };
        expect(cfg.self_upgrade?.[c.leaf]).toEqual(c.stored);
      });
    });
  }

  test('the readers see the new mode: startup check, doctor, and unset restores the notify default', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-selfup-read-'));
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_SELF_UPGRADE_MODE: undefined }, async () => {
      const { loadConfigFileOnly } = await import('../src/core/config.ts');
      await captureAll(() => runConfig(noEngine, ['set', 'self_upgrade.mode', 'auto']));
      expect(resolveSelfUpgradeMode(loadConfigFileOnly())).toBe('auto');
      expect(checkSelfUpgradeHealth().message).toContain('mode=auto');

      const r = await captureAll(() => runConfig(noEngine, ['unset', 'self_upgrade.mode']));
      expect(r.out).toContain('Unset self_upgrade.mode (file plane)');
      expect(resolveSelfUpgradeMode(loadConfigFileOnly())).toBe('notify');
    });
  });

  test('an empty failed_versions list clears the known-bad set', () => {
    expect(parseSelfUpgradeConfigValue('failed_versions', '')).toEqual({ ok: true, value: [] });
  });

  test('resolveQuietHoursWindow fills 23:00-08:00 in the system timezone, keeping configured bounds', () => {
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    expect(resolveQuietHoursWindow(undefined)).toEqual({ start: 23, end: 8, tz: systemTz });
    expect(resolveQuietHoursWindow({ end: 5, tz: 'UTC' })).toEqual({ start: 23, end: 5, tz: 'UTC' });
  });

  test('a stale DB-plane row is never reported as the value, and set/unset remove it', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-selfup-stale-'));
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const { engine, rows } = staleRowEngine({ 'self_upgrade.mode': 'auto', 'self_upgrade.quiet_hours': '{"start":1,"end":5}' });

      // get: the file has no mode, so the answer is not-found plus a pointer at the stale row.
      const got = await captureAll(() => runConfig(engine, ['get', 'self_upgrade.mode']));
      expect(got.exitCode).toBe(1);
      expect(got.out).toBe('');
      expect(got.err).toContain('stale DB-plane row');

      // set writes the file and deletes the stale row.
      const set = await captureAll(() => runConfig(engine, ['set', 'self_upgrade.mode', 'off']));
      expect(set.out).toContain('Removed a stale DB-plane row for self_upgrade.mode');
      expect(rows.has('self_upgrade.mode')).toBe(false);

      // unset with no file value still removes the stale row instead of "not found".
      const unset = await captureAll(() => runConfig(engine, ['unset', 'self_upgrade.quiet_hours']));
      expect(unset.exitCode).toBeNull();
      expect(unset.out).toContain('Unset self_upgrade.quiet_hours (stale db-plane row)');
      expect(rows.size).toBe(0);
    });
  });

  test('set/unset self_upgrade.mode say when GBRAIN_SELF_UPGRADE_MODE overrides the file', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-selfup-env-'));
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_SELF_UPGRADE_MODE: 'off' }, async () => {
      const set = await captureAll(() => runConfig(noEngine, ['set', 'self_upgrade.mode', 'auto']));
      expect(set.err).toContain('GBRAIN_SELF_UPGRADE_MODE=off is set and overrides the file');
      const unset = await captureAll(() => runConfig(noEngine, ['unset', 'self_upgrade.mode']));
      expect(unset.err).toContain('GBRAIN_SELF_UPGRADE_MODE=off');
    });
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_SELF_UPGRADE_MODE: undefined }, async () => {
      const set = await captureAll(() => runConfig(noEngine, ['set', 'self_upgrade.mode', 'auto']));
      expect(set.err).not.toContain('GBRAIN_SELF_UPGRADE_MODE');
    });
  });

  test('a thin client sets, reads and unsets self_upgrade.* on its own file plane', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-selfup-thin-'));
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_SELF_UPGRADE_MODE: undefined }, async () => {
      const thinCfg = { engine: 'pglite', remote_mcp: { mcp_url: 'https://brain.example.test/mcp' } } as unknown as GBrainConfig;
      const set = await captureAll(async () => {
        expect(await routeThinClientCommand(thinCfg, 'config', ['set', 'self_upgrade.mode', 'off'])).toBe(true);
      });
      expect(set.out).toContain('Set self_upgrade.mode = "off" (file plane');
      const { loadConfigFileOnly } = await import('../src/core/config.ts');
      expect(resolveSelfUpgradeMode(loadConfigFileOnly())).toBe('off');

      const got = await captureAll(async () => { expect(await tryRunConfigThinClient(['get', 'self_upgrade.mode'])).toBe(true); });
      expect(got.out.trim()).toBe('off');

      const unset = await captureAll(async () => { expect(await tryRunConfigThinClient(['unset', 'self_upgrade.mode'])).toBe(true); });
      expect(unset.out).toContain('Unset self_upgrade.mode (file plane)');
      expect(resolveSelfUpgradeMode(loadConfigFileOnly())).toBe('notify');

      // Host-plane keys and flags keep the thin-client refusal.
      expect(await tryRunConfigThinClient(['set', 'search.mode', 'balanced'])).toBe(false);
      expect(await tryRunConfigThinClient(['set', 'self_upgrade.mode', 'off', '--force'])).toBe(false);
    });
  });

  test('set keeps the sibling self_upgrade state the upgrade machinery wrote', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-selfup-merge-'));
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const gb = join(parent, '.gbrain');
      mkdirSync(gb, { recursive: true });
      writeFileSync(join(gb, 'config.json'), JSON.stringify({
        engine: 'pglite',
        self_upgrade: { mode: 'notify', mode_prompted: true, failed_versions: ['0.50.0.0'] },
      }));
      await captureAll(() => runConfig(noEngine, ['set', 'self_upgrade.mode', 'auto']));
      const cfg = JSON.parse(readFileSync(join(gb, 'config.json'), 'utf8')) as { engine?: string; self_upgrade?: Record<string, unknown> };
      expect(cfg.engine).toBe('pglite');
      expect(cfg.self_upgrade).toEqual({ mode: 'auto', mode_prompted: true, failed_versions: ['0.50.0.0'] });
    });
  });

  const INVALID_CASES: ReadonlyArray<{ leaf: string; raw: string }> = [
    { leaf: 'mode', raw: 'yes' },
    { leaf: 'mode', raw: 'Auto' },
    { leaf: 'mode_prompted', raw: 'maybe' },
    { leaf: 'quiet_hours', raw: 'not-json' },
    { leaf: 'quiet_hours', raw: '[1,5]' },
    { leaf: 'quiet_hours', raw: '{"start":24,"end":5}' },
    { leaf: 'quiet_hours', raw: '{"start":2.5,"end":5}' },
    // end defaults to 8 at the reader, so start 8 alone is a zero-width window
    { leaf: 'quiet_hours', raw: '{"start":8}' },
    { leaf: 'quiet_hours', raw: '{"start":1,"end":5,"tz":"Mars/Olympus_Mons"}' },
    { leaf: 'quiet_hours', raw: '{"start":1,"end":5,"policy":"skip"}' },
    { leaf: 'failed_versions', raw: 'latest' },
    { leaf: 'failed_versions', raw: '[1]' },
    { leaf: 'failed_versions', raw: '[0.57' },
    { leaf: 'attempting_version', raw: 'v-next' },
    { leaf: 'last_check_ts', raw: '1.5' },
    { leaf: 'last_check_ts', raw: '12abc' },
    { leaf: 'last_applied_version', raw: '0.57.x' },
    { leaf: 'last_applied_version', raw: '0.57' },
    // unregistered leaves are refused, never written to a DB row nothing reads
    { leaf: 'modee', raw: 'auto' },
    { leaf: 'quiet_hours.start', raw: '1' },
  ];

  for (const c of INVALID_CASES) {
    test(`self_upgrade.${c.leaf} ${c.raw} is refused and nothing is written`, async () => {
      const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-selfup-bad-'));
      await withEnv({ GBRAIN_HOME: parent }, async () => {
        const r = await captureAll(() => runConfig(noEngine, ['set', `self_upgrade.${c.leaf}`, c.raw]));
        expect(r.exitCode).toBe(1);
        expect(r.err).toContain(`self_upgrade.${c.leaf}`);
        expect(existsSync(join(parent, '.gbrain', 'config.json'))).toBe(false);
      });
    });
  }
});

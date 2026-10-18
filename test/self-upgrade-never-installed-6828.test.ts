/**
 * #6828 recovery: installs that already recorded a never-installed version
 * known-bad. Before the fix, a swap that installed nothing reported
 * "swapped", the supervisor relaunched the same version, and the boot
 * reconcile put the attempted version in `self_upgrade.failed_versions`, so
 * the auto channel never installed that release once it was published.
 *
 * Protects: `neverInstalledFailedVersions` clears only entries the audit
 * proves were never installed (the swap row and the relaunch's
 * crash-on-launch row ran the same version; the version never ran; the last
 * recorded upgrade did not install it); `gbrain self-upgrade
 * --clear-never-installed` previews by default and `--apply` removes exactly
 * those entries; doctor's self_upgrade_health names the preview as its fix
 * with the apply as the next step. The audit rows below are the strings the
 * pre-fix channel wrote (the field sequence in #6828).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSelfUpgradeHealth } from '../src/commands/doctor.ts';
import { runSelfUpgrade } from '../src/commands/self-upgrade.ts';
import { logSelfUpgrade } from '../src/core/audit/self-upgrade-audit.ts';
import { neverInstalledFailedVersions } from '../src/core/self-upgrade-recovery.ts';
import { withEnv } from './helpers/with-env.ts';

const A = '0.60.257.0';
const B = '0.60.258.0';
const C = '0.60.259.0';

/** The pre-fix channel's rows for one no-op "swap" from `running` to `attempted`, minutes apart. */
function noOpSwapRows(running: string, attempted: string, hour: number) {
  const at = (m: number) => `2026-10-16T0${hour}:0${m}:00.000Z`;
  return [
    { ts: at(1), channel: 'autopilot', action: 'apply', current: running, latest: attempted, reason: `auto-upgrading ${running} -> ${attempted}` },
    { ts: at(2), channel: 'autopilot', action: 'apply', current: running, latest: attempted, outcome: 'applied', reason: 'swapped; exiting for supervisor relaunch' },
    { ts: at(3), channel: 'autopilot', action: 'apply', current: running, latest: attempted, outcome: 'failed', reason: 'crash-on-launch: running version is not at or past the attempted version (recorded known-bad)' },
    { ts: at(4), channel: 'autopilot', action: 'known_bad', current: running, latest: attempted, outcome: 'skipped', reason: `${attempted} previously failed; not retrying` },
  ];
}

/** The last_upgrade record a pre-fix no-op swap wrote between its apply row and its swapped row. */
const noOpRecord = (running: string, hour: number) => ({ from: running, to: running, ts: `2026-10-16T0${hour}:01:30.000Z` });

describe('neverInstalledFailedVersions (pure)', () => {
  test('the #6828 field sequences: the entry is proven by the no-op swap\'s own last_upgrade record', () => {
    const events = [
      ...noOpSwapRows(A, B, 5),
      // The operator cleared B; B really installed and ran, then the same defect hit C.
      { ts: '2026-10-16T05:28:16.000Z', channel: 'autopilot', action: 'apply', current: B, latest: B, outcome: 'applied', reason: 'running version is at or past the attempted version' },
      ...noOpSwapRows(B, C, 6),
    ];
    expect(neverInstalledFailedVersions([C], events, noOpRecord(B, 6))).toEqual([
      { version: C, running: B, swapped_at: '2026-10-16T06:02:00.000Z', recorded_at: '2026-10-16T06:03:00.000Z' },
    ]);
    // B ran (an audit row has current = B), so an entry for it is never cleared.
    expect(neverInstalledFailedVersions([B, C], events, noOpRecord(B, 6)).map((e) => e.version)).toEqual([C]);
    expect(neverInstalledFailedVersions([B], noOpSwapRows(A, B, 5), noOpRecord(A, 5)).map((e) => e.version)).toEqual([B]);
  });

  test('a release that installed and crashed before its boot reconcile stays known-bad, even after a later no-op', () => {
    // A -> B really installed (last_upgrade A -> B); B crashed before writing anything; the operator restored A,
    // whose boot recorded B. A later no-op swap to C then overwrote last_upgrade with A -> A.
    const events = [...noOpSwapRows(A, B, 5), ...noOpSwapRows(A, C, 6)];
    expect(neverInstalledFailedVersions([B, C], events, noOpRecord(A, 6)).map((e) => e.version)).toEqual([C]);
    expect(neverInstalledFailedVersions([B], noOpSwapRows(A, B, 5), { from: A, to: B, ts: '2026-10-16T05:01:30.000Z' })).toEqual([]);
  });

  test('anything unproven stays known-bad', () => {
    const rows = noOpSwapRows(A, B, 5);
    const rec = noOpRecord(A, 5);
    expect(neverInstalledFailedVersions([B], [], rec)).toEqual([]);
    expect(neverInstalledFailedVersions([B], rows, null)).toEqual([]);
    // The record is outside this entry's swap window (another swap wrote it).
    expect(neverInstalledFailedVersions([B], rows, { ...rec, ts: '2026-10-16T05:03:30.000Z' })).toEqual([]);
    // The relaunch ran a different version than the swap (a rollback): not a no-op.
    const rollback = rows.map((e, i) => (i === 2 ? { ...e, current: '0.60.256.0' } : e));
    expect(neverInstalledFailedVersions([B], rollback, rec)).toEqual([]);
    // A swap that failed outright (the install step exited non-zero) proves nothing about the disk.
    const swapFailed = [rows[0], { ...rows[1], outcome: 'failed', reason: undefined, error: 'Command failed: gbrain upgrade --swap-only' }];
    expect(neverInstalledFailedVersions([B], swapFailed, rec)).toEqual([]);
    // A second failure for the same version: keep it.
    expect(neverInstalledFailedVersions([B], [...rows, ...swapFailed.map((e) => ({ ...e, ts: e.ts.replace('T05', 'T07') }))], rec)).toEqual([]);
    // The crash-on-launch row with no swap row before it.
    expect(neverInstalledFailedVersions([B], [rows[2]], rec)).toEqual([]);
  });
});
const UNPROVEN = '0.59.1.0';

/** A home whose known-bad list holds B (the #6828 no-op) and an unproven entry, with the pre-fix audit rows. */
async function withRecoveryHome(fn: (ctx: { failedVersions: () => string[]; run: (args: string[]) => Promise<string> }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-6828-recover-'));
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_AUDIT_DIR: join(dir, 'audit'), HOME: dir, GBRAIN_SELF_UPGRADE_MODE: undefined }, async () => {
      mkdirSync(join(dir, '.gbrain'), { recursive: true });
      writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', self_upgrade: { mode: 'auto', failed_versions: [B, UNPROVEN] } }));
      // The no-op swap overwrote last_upgrade with A -> A.
      writeFileSync(join(dir, '.gbrain', 'upgrade-state.json'), JSON.stringify({ last_upgrade: { from: A, to: A, ts: '2026-10-16T05:01:30.000Z' } }));
      for (const row of noOpSwapRows(A, B, 5)) logSelfUpgrade(row as Parameters<typeof logSelfUpgrade>[0]);
      logSelfUpgrade({ ts: '2026-10-01T01:00:00.000Z', channel: 'autopilot', action: 'apply', current: '0.59.0.0', latest: UNPROVEN, outcome: 'failed', error: 'Command failed: gbrain upgrade --swap-only' });
      await fn({
        failedVersions: () => JSON.parse(readFileSync(join(dir, '.gbrain', 'config.json'), 'utf8')).self_upgrade.failed_versions,
        run: async (args) => {
          log.mockClear();
          await runSelfUpgrade(args);
          return log.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
        },
      });
    });
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('gbrain self-upgrade --clear-never-installed and doctor', () => {
  test('doctor names the preview as the fix and the apply as the next step', async () => {
    await withRecoveryHome(async () => {
      const c = checkSelfUpgradeHealth();
      expect(c.status).toBe('warn');
      expect(c.message).toContain(`skips ${B} as known-bad`);
      expect(c.message).toContain('never installed');
      const fix = c.fix as { argv: string[]; then?: { argv: string[] } };
      expect(fix.argv).toEqual(['gbrain', 'self-upgrade', '--clear-never-installed', '--json']);
      expect(fix.then?.argv).toEqual(['gbrain', 'self-upgrade', '--clear-never-installed', '--apply']);
    });
  });

  test('the preview writes nothing; --apply removes exactly the proven entry; doctor clears', async () => {
    await withRecoveryHome(async ({ failedVersions, run }) => {
      const preview = JSON.parse(await run(['--clear-never-installed', '--json']));
      expect(preview.never_installed.map((e: { version: string }) => e.version)).toEqual([B]);
      expect(preview.never_installed[0]).toMatchObject({ running: A });
      expect(preview.kept).toEqual([UNPROVEN]);
      expect(preview.applied).toBe(false);
      expect(preview.next.argv).toEqual(['gbrain', 'self-upgrade', '--clear-never-installed', '--apply']);
      expect(failedVersions()).toEqual([B, UNPROVEN]);

      const human = await run(['--clear-never-installed']);
      expect(human).toContain(`${B}: the swap at 2026-10-16T05:02:00.000Z left ${A} running`);
      expect(human).toContain('Clear them: gbrain self-upgrade --clear-never-installed --apply');
      expect(failedVersions()).toEqual([B, UNPROVEN]);

      expect(await run(['--clear-never-installed', '--apply'])).toContain('Cleared known-bad versions that were never installed:');
      expect(failedVersions()).toEqual([UNPROVEN]);
      expect(checkSelfUpgradeHealth().message).not.toContain('never installed');

      expect(JSON.parse(await run(['--clear-never-installed', '--apply', '--json']))).toMatchObject({ never_installed: [], kept: [UNPROVEN], applied: false });
    });
  });
});

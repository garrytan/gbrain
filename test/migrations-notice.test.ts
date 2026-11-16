/**
 * GST-2732: with no postinstall, a reinstall over an older brain leaves its upgrade migrations to the next command,
 * so connect names them. The notice must fire when an older brain has unrun migrations and stay quiet on a brain
 * with no ledger, a brain that ran them all, and the commands that run or report migrations themselves.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { pendingUpgradeMigrationsNotice } from '../src/cli/migrations-notice.ts';
import { MIGRATION_VERSIONS } from '../src/core/migration-ledger.ts';
import { appendCompletedMigration } from '../src/core/preferences.ts';
import { noteSchemaVersion } from '../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';

const engine = { getConfig: async () => null } as never;
const homes: string[] = [];
const latest = MIGRATION_VERSIONS[MIGRATION_VERSIONS.length - 1]!;

async function inHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-migrations-notice-'));
  homes.push(home);
  return withEnv({ GBRAIN_HOME: home }, fn);
}

afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

describe('pendingUpgradeMigrationsNotice', () => {
  test('an older brain with unrun upgrade migrations gets a migrations_pending notice whose fix applies them', async () => {
    const notice = await inHome(async () => {
      appendCompletedMigration({ version: MIGRATION_VERSIONS[0]!, status: 'complete' } as never);
      return pendingUpgradeMigrationsNotice(engine, 'query', latest);
    });
    expect(notice).toMatchObject({ code: 'migrations_pending', fix: { argv: ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'] } });
    expect(notice!.why).toContain(latest);
  });

  test('a migration whose last run was partial still gets the notice', async () => {
    const notice = await inHome(async () => {
      for (const version of MIGRATION_VERSIONS) appendCompletedMigration({ version, status: version === latest ? 'partial' : 'complete' } as never);
      return pendingUpgradeMigrationsNotice(engine, 'query', latest);
    });
    expect(notice?.why).toContain(latest);
  });

  test('a wedged migration gets a notice whose fix asks the user before clearing it', async () => {
    const notice = await inHome(async () => {
      for (const version of MIGRATION_VERSIONS) if (version !== latest) appendCompletedMigration({ version, status: 'complete' } as never);
      for (let i = 0; i < 3; i++) appendCompletedMigration({ version: latest, status: 'partial' } as never);
      return pendingUpgradeMigrationsNotice(engine, 'query', latest);
    });
    expect(notice).toMatchObject({ code: 'migrations_pending', fix: { ask_user: true, argv: ['gbrain', 'apply-migrations', '--force-retry', latest] } });
    expect(notice!.why).toContain(latest);
  });

  test('a wedged migration a newer migration ran past is history, as apply-migrations says, so it gets no notice', async () => {
    const older = MIGRATION_VERSIONS[MIGRATION_VERSIONS.length - 3]!;
    const notice = await inHome(async () => {
      for (const version of MIGRATION_VERSIONS) if (version !== older) appendCompletedMigration({ version, status: 'complete' } as never);
      for (let i = 0; i < 3; i++) appendCompletedMigration({ version: older, status: 'partial' } as never);
      return pendingUpgradeMigrationsNotice(engine, 'query', latest);
    });
    expect(notice).toBeNull();
  });

  test('no ledger yet (a fresh brain) means no notice', async () => {
    expect(await inHome(() => pendingUpgradeMigrationsNotice(engine, 'query', latest))).toBeNull();
  });

  test('a brain that ran every migration gets no notice', async () => {
    const notice = await inHome(async () => {
      for (const version of MIGRATION_VERSIONS) appendCompletedMigration({ version, status: 'complete' } as never);
      return pendingUpgradeMigrationsNotice(engine, 'query', latest);
    });
    expect(notice).toBeNull();
  });

  test('commands that run or report the migrations themselves get no notice', async () => {
    for (const command of ['apply-migrations', 'post-upgrade', 'upgrade', 'doctor', 'init', 'setup']) {
      const notice = await inHome(async () => {
        appendCompletedMigration({ version: MIGRATION_VERSIONS[0]!, status: 'complete' } as never);
        return pendingUpgradeMigrationsNotice(engine, command, latest);
      });
      expect(notice).toBeNull();
    }
  });

  test('gbrain serve gets the notice, since a brain used only over MCP runs no other command', async () => {
    const notice = await inHome(async () => {
      appendCompletedMigration({ version: MIGRATION_VERSIONS[0]!, status: 'complete' } as never);
      return pendingUpgradeMigrationsNotice(engine, 'serve', latest);
    });
    expect(notice).toMatchObject({ code: 'migrations_pending' });
  });

  test('an empty ledger on a brain an older release last opened still gets the notice', async () => {
    const existing = { getConfig: async () => null } as never;
    noteSchemaVersion(existing, LATEST_SCHEMA_VERSION - 1);
    const notice = await inHome(() => pendingUpgradeMigrationsNotice(existing, 'query', latest));
    expect(notice).toMatchObject({ code: 'migrations_pending' });
    expect(notice!.why).toContain(latest);
  });

  test('an empty ledger on a brain whose schema is already current (a new or rebuilt GBRAIN_HOME) gets no notice', async () => {
    const current = { getConfig: async () => null } as never;
    noteSchemaVersion(current, LATEST_SCHEMA_VERSION);
    expect(await inHome(() => pendingUpgradeMigrationsNotice(current, 'query', latest))).toBeNull();
  });

  test('an empty ledger on a brain created in this run (schema version 1 at connect) gets no notice', async () => {
    const created = { getConfig: async () => null } as never;
    noteSchemaVersion(created, 1);
    // pregate-literal: LATEST_SCHEMA_VERSION=316 any version above 1 stands for the brain after this run migrated it
    noteSchemaVersion(created, 316);
    expect(await inHome(() => pendingUpgradeMigrationsNotice(created, 'query', latest))).toBeNull();
  });
});

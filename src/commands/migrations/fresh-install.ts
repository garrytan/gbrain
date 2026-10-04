/**
 * Fresh-install migration stamping (agent-first operator wave, E8).
 *
 * A brain `gbrain init` just created is already at the current schema, so a
 * migration that declares `fresh_install_noop: true` has nothing to do there:
 * init records it complete with `fresh_install: true` and the creating
 * version. Every other registered migration stays unrun and lists as
 * `pending_fresh_install` (src/core/migration-ledger.ts), which
 * `gbrain apply-migrations --yes` completes. Called once by init, only when
 * the database was created by this init (never on re-init of an existing one).
 */

import { VERSION } from '../../version.ts';
import { appendCompletedMigration } from '../../core/preferences.ts';
import { compareVersions } from '../../core/migration-ledger.ts';
import { migrations } from './index.ts';

export interface FreshInstallStamp {
  installed_version: string;
  stamped: string[];
  pending_fresh_install: string[];
}

export function stampFreshInstallMigrations(installed: string = VERSION.replace(/^v/, '').trim()): FreshInstallStamp {
  const receipt: FreshInstallStamp = { installed_version: installed, stamped: [], pending_fresh_install: [] };
  for (const migration of migrations) {
    if (compareVersions(migration.version, installed) > 0) continue;
    if (!migration.fresh_install_noop) {
      receipt.pending_fresh_install.push(migration.version);
      continue;
    }
    appendCompletedMigration({
      version: migration.version,
      status: 'complete',
      fresh_install: true,
      installed_version: installed,
      phases: [{ name: 'fresh_install', status: 'skipped', detail: `No-op on a brain gbrain init created at v${installed}: schema current, nothing to backfill or install.` }],
    });
    receipt.stamped.push(migration.version);
  }
  return receipt;
}

/** The init seam: stamp, then print one line. Fail-open: an unwritable ledger leaves every migration pending, which apply-migrations still completes. */
export function recordFreshInstallMigrations(): void {
  try {
    const receipt = stampFreshInstallMigrations();
    const pending = receipt.pending_fresh_install;
    console.error(`[init] Migrations: ${receipt.stamped.length} recorded as not needed on a new brain; `
      + (pending.length ? `${pending.length} setup migration(s) pending (${pending.join(', ')}). Finish setup: gbrain apply-migrations --yes --no-autopilot-install` : 'none pending.'));
  } catch (error) {
    console.error(`[init] Migrations: could not record fresh-install migrations (${error instanceof Error ? error.message : String(error)}); all list as pending. Finish setup: gbrain apply-migrations --yes --no-autopilot-install`);
  }
}

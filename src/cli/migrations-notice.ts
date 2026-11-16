import type { BrainEngine } from '../core/engine.ts';
import type { Notice } from '../core/agent-output.ts';

/** Commands that run or report the upgrade migrations themselves, so connect adds no pending-migrations notice to them. */
const ORCHESTRATOR_MIGRATION_OWNERS: ReadonlySet<string> = new Set(['apply-migrations', 'post-upgrade', 'upgrade', 'doctor', 'init', 'setup']);

/** A6/D1: the pending-migrations warning as a notice whose fix applies them (stderr; stdout stays the command's). */
export function migrationsNotice(why: string): Notice {
  return { code: 'migrations_pending', kind: 'safety', why, fix: { argv: ['gbrain', 'apply-migrations', '--yes'], consent: [], actor: 'agent',
    requires_exclusive: true, why: 'Applies the pending schema migrations (the same ones every command applies on connect).', verify: { argv: ['gbrain', 'doctor', '--json'] } } };
}

/**
 * Upgrade migrations (the orchestrators in src/commands/migrations/) run only from apply-migrations, post-upgrade and
 * setup, never on connect. A reinstall over an older brain (`bun install -g` again) runs neither, so connect says so;
 * `gbrain serve` gets it once, at startup on stderr, since a brain used only over MCP runs no other command.
 * Returns null when nothing is pending, the command owns the migrations, the brain is fresh, or the ledger can't be read.
 */
export async function pendingUpgradeMigrationsNotice(engine: BrainEngine, command: string, version: string): Promise<Notice | null> {
  if (ORCHESTRATOR_MIGRATION_OWNERS.has(command)) return null;
  try {
    const { declinedMigrations, migrationLedgerSummary, upgradeLedgerApplies } = await import('../core/migration-ledger.ts');
    if (!upgradeLedgerApplies(engine)) return null;
    const summary = migrationLedgerSummary(version, await declinedMigrations(engine));
    if (summary.wedged.length > 0) {
      const { wedgedMigrationFix } = await import('../commands/apply-migrations.ts');
      return { ...migrationsNotice(`Upgrade migration(s) ${summary.wedged.join(', ')} failed several runs in a row and are wedged; the command ran, and apply-migrations --yes will not clear them until the cause is fixed.`), fix: wedgedMigrationFix(summary.wedged) };
    }
    const pending = [...summary.pending, ...summary.partial];
    if (pending.length === 0) return null;
    const notice = migrationsNotice(`${pending.length} upgrade migration(s) have not finished on this brain yet (${pending.join(', ')}); the command ran, and gbrain apply-migrations --yes --no-autopilot-install finishes the upgrade.`);
    return { ...notice, fix: { ...notice.fix!, argv: ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'] } };
  } catch { return null; }
}

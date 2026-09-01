/**
 * gbrain sources set-path <id> <path> — non-destructive local_path repair.
 *
 * Reported incident (#4739): a brain's `default` source sat with
 * `local_path: null` while the sync.repo_path fallback was broken, and there
 * was no way to fix the pointer short of a raw SQL UPDATE. Mirrors
 * runSetCrMode's shape (sources.ts): loud rejection on a missing source
 * (never a silent 0-row UPDATE), prints the prior value before changing it
 * so the change is visible/reversible, and never touches files on disk —
 * purely a DB pointer repair.
 *
 * Lives in its own module (like sources-demo.ts / sources-harden.ts) so
 * sources.ts stays under its module-size ratchet ceiling.
 */
import { existsSync, statSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';

export async function runSetPath(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  const path = args[1];

  if (!id || !path) {
    console.error('Usage: gbrain sources set-path <id> <path>');
    console.error("  Sets the source's local_path — the on-disk directory gbrain treats as");
    console.error('  its write-through target and walks for sync/audit. Non-destructive: only');
    console.error('  updates the pointer, never touches files on disk.');
    process.exit(2);
  }

  const existing = await engine.executeRaw<{ id: string; local_path: string | null }>(
    `SELECT id, local_path FROM sources WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (existing.length === 0) {
    console.error(`Error: source "${id}" not found.`);
    console.error(`  Run 'gbrain sources list' to see registered sources.`);
    process.exit(4);
  }

  const priorPath = existing[0]!.local_path;

  if (!existsSync(path) || !statSync(path).isDirectory()) {
    console.error(`Error: path does not exist on disk (or is not a directory): ${path}`);
    console.error('  This command only repairs the DB pointer — it never creates directories.');
    console.error('  Create the directory first, then re-run.');
    process.exit(5);
  }

  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [path, id]);

  if (priorPath) {
    console.log(`Updated source "${id}" local_path: ${priorPath} -> ${path}`);
  } else {
    console.log(`Set source "${id}" local_path (was NULL) -> ${path}`);
  }
  console.log('Run `gbrain doctor` to confirm the change resolves any related warning.');
}

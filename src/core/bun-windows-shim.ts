/**
 * #10538: on Windows, Bun links a global package's bin as a small launcher, `<bin>\gbrain.exe`, next to its
 * `gbrain.bunx` metadata. `gbrain upgrade` runs through that launcher and Windows keeps a running executable open, so
 * `bun remove -g gbrain` deletes the package and `gbrain.bunx` but leaves `gbrain.exe`, and the next `bun add -g`
 * (the restore too) fails with `failed to link gbrain: EEXIST`, leaving a launcher that only prints
 * `could not find bin metadata file`. Windows does let a running executable be renamed, so the upgrade moves the orphaned
 * launcher aside before each add, and a later run deletes the launchers moved aside once nothing holds them.
 *
 * Safety: only `gbrain.exe` and `gbrain.exe.stale[.<n>...]` directly inside Bun's own bin directory are ever touched,
 * only a regular file small enough to be Bun's launcher is moved (a compiled gbrain release binary is tens of MB), and
 * nothing happens off Windows.
 */
import { existsSync, lstatSync, readdirSync, renameSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SHIM = 'gbrain.exe';
const STALE_SHIM = /^gbrain\.exe\.stale(\.\d+)*$/;
/** Bun's Windows launcher is a few KB. */
const MAX_SHIM_BYTES = 1024 * 1024;

/**
 * The directory Bun links global bins into: what `askBun` (`bun pm bin -g`, which also honors bunfig's globalBinDir)
 * reports, else BUN_INSTALL_BIN, else <BUN_INSTALL>/bin, else ~/.bun/bin.
 */
export function bunShimDir(env: NodeJS.ProcessEnv = process.env, askBun?: () => string): string {
  if (askBun) {
    try {
      const reported = askBun().trim();
      if (reported) return reported;
    } catch {
      // Bun could not answer: the environment's answer below is the one Bun uses without a bunfig override.
    }
  }
  if (env.BUN_INSTALL_BIN) return env.BUN_INSTALL_BIN;
  if (env.BUN_INSTALL) return join(env.BUN_INSTALL, 'bin');
  return join(env.USERPROFILE || env.HOME || homedir(), '.bun', 'bin');
}

/** Deletes launchers an earlier upgrade moved aside. One a process still holds stays for a later run. */
export function removeStaleShims(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!STALE_SHIM.test(name)) continue;
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isFile()) continue;
      rmSync(path);
      removed.push(path);
    } catch {
      // Still running (EBUSY/EPERM): the next upgrade deletes it.
    }
  }
  return removed;
}

/**
 * Moves the launcher out of the way of the next `bun add -g`. Call it only where no installed package owns the launcher:
 * right after `bun remove -g gbrain`, or after a failed add. Returns the move, or null when nothing was moved.
 */
export function moveAsideOrphanedShim(dir: string, platform: NodeJS.Platform = process.platform, pid: number = process.pid): { from: string; to: string } | null {
  if (platform !== 'win32') return null;
  removeStaleShims(dir);
  const from = join(dir, SHIM);
  if (!existsSync(from)) return null;
  let to = join(dir, `${SHIM}.stale.${pid}`);
  for (let n = 1; existsSync(to); n++) to = join(dir, `${SHIM}.stale.${pid}.${n}`);
  try {
    const stat = lstatSync(from);
    if (!stat.isFile() || stat.size > MAX_SHIM_BYTES) return null;
    renameSync(from, to);
  } catch (err) {
    console.error(`Could not move ${from} aside (${(err as NodeJS.ErrnoException).code ?? String(err)}); bun add may fail with EEXIST.`);
    return null;
  }
  console.error(`Moved the old Bun launcher ${from} aside to ${to}.`);
  return { from, to };
}

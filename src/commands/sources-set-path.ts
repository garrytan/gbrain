/**
 * gbrain sources set-path <id> <path> — non-destructive local_path repair.
 *
 * Reported incident (#4739): a brain's `default` source sat with
 * `local_path: null` while the sync.repo_path fallback was broken, and there
 * was no way to fix the pointer short of a raw SQL UPDATE. Mirrors
 * runSetCrMode's shape (sources.ts): loud rejection on a missing source
 * (never a silent 0-row UPDATE), prints the prior value before changing it
 * so the change is visible/reversible, and never touches files on disk —
 * purely a DB pointer repair. Enforces the same overlapping-path guard
 * `sources add` does (a repointed source nesting inside / swallowing another
 * source's tree misattributes files on sync); `--force` bypasses it.
 *
 * Lives in its own module (like sources-demo.ts / sources-harden.ts) so
 * sources.ts stays under its module-size ratchet ceiling.
 */
import { existsSync, statSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { msysToNativePath } from '../core/path-confine.ts';
import type { BrainEngine } from '../core/engine.ts';
import { assertNoOverlappingPath, SourceOpError } from '../core/sources-ops.ts';
import { classifyEphemeralCiPath, allowEphemeralPersist } from '../core/ci-path-guard.ts';

export async function runSetPath(engine: BrainEngine, rawArgs: string[]): Promise<void> {
  const force = rawArgs.includes('--force');
  const args = rawArgs.filter((a) => a !== '--force');
  const id = args[0];
  const rawPath = args[1];

  if (!id || !rawPath) {
    console.error('Usage: gbrain sources set-path <id> <path> [--force]');
    console.error("  Sets the source's local_path — the on-disk directory gbrain treats as");
    console.error('  its write-through target and walks for sync/audit. Non-destructive: only');
    console.error('  updates the pointer, never touches files on disk.');
    console.error("  Refuses a path that overlaps another source's tree, or one that looks like");
    console.error('  an ephemeral CI checkout (/home/runner/work/*, $GITHUB_WORKSPACE, ...);');
    console.error('  --force bypasses both guards.');
    process.exit(2);
  }

  // Same treatment addSource applies (#3696 / gbrain#2955): absolutize a
  // relative path and normalize MSYS/Git-Bash drive spellings BEFORE the
  // existence check and the UPDATE. Storing '.' or '/c/Users/x' verbatim
  // would plant the exact phantom-path class this repair command exists to
  // fix (a daemon at cwd=/ join-resolves a path that does not exist).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- set-path is a trusted local CLI repair command (CLI_ONLY); absolutizing the operator's own directory is the #3696 fix
  const path = resolvePath(msysToNativePath(rawPath));

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

  if (!force) {
    try {
      await assertNoOverlappingPath(engine, id, path);
    } catch (e) {
      if (e instanceof SourceOpError && e.code === 'overlapping_path') {
        console.error(`Error (${e.code}): ${e.message}`);
        console.error('  Pass --force to set it anyway (only if the trees are meant to overlap).');
        process.exit(6);
      }
      throw e;
    }
  }

  // Ephemeral-CI-path guard (2026-09-08 shared-brain incident): this repair
  // command is the one writer that can repoint a NON-NULL local_path in one
  // line — which is exactly what a CI job (or an agent following a sync
  // refusal hint inside CI) reaches for. A runner checkout passes the
  // existsSync check above ON the runner, then poisons the shared row for
  // every other machine. Refuse unless --force / the env hatch.
  if (!force && !allowEphemeralPersist()) {
    const verdict = classifyEphemeralCiPath(path);
    if (verdict.ephemeral) {
      console.error(
        `Error (ephemeral_ci_path): "${path}" looks like an ephemeral CI checkout ` +
        `(${verdict.detail}). Pointing source "${id}" at it would break capture and ` +
        `sync on every other machine sharing this brain once the runner is gone.`,
      );
      console.error(
        '  To sync CI content without repointing, use `gbrain sync --repo <path> ' +
        '--source <id>` (session-scoped). If this path really is durable, pass ' +
        '--force or set GBRAIN_ALLOW_EPHEMERAL_REPO_PATH=1.',
      );
      process.exit(7);
    }
  }

  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [path, id]);

  if (priorPath) {
    console.log(`Updated source "${id}" local_path: ${priorPath} -> ${path}`);
  } else {
    console.log(`Set source "${id}" local_path (was NULL) -> ${path}`);
  }
  console.log('Run `gbrain doctor` to confirm the change resolves any related warning.');
}

/**
 * `gbrain skillpack conventions <dir> [--json]` (GST-4066): write the shared conventions gbrain's bundled skills link
 * to as ../conventions/<file> into <dir>/conventions, from the copy embedded in gbrain, so the links resolve on a
 * single-file binary install that has no skills folder on disk. Additive like scaffold: a file that already holds
 * other text is kept and named, never overwritten.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { exitCliError, usageError } from '../../cli/cli-error.ts';
import { isThinClient, loadConfig } from '../../core/config.ts';
import { bundledConventionFiles } from '../../core/skills/bundled.ts';
import { VERSION } from '../../version.ts';
import { resolveAbs } from './shared.ts';

const USAGE = 'Usage: gbrain skillpack conventions <dir> [--json]';

export async function cmdConventions(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${USAGE}\n\nWrite the shared conventions the bundled skills link to as ../conventions/<file> into\n<dir>/conventions, from the copy built into this gbrain. A file you changed is kept.`);
    return;
  }
  const json = args.includes('--json');
  const dirs = args.filter(a => a !== '--json');
  const unknown = dirs.find(a => a.startsWith('-'));
  if (unknown) exitCliError(usageError(`unknown flag ${unknown} for gbrain skillpack conventions.`, USAGE, { code: 'unknown_flag' }), 'skillpack');
  if (dirs.length !== 1) exitCliError(usageError(`gbrain skillpack conventions <dir> takes one folder, got ${dirs.length}.`, `${USAGE} (the folder your skills sit in; conventions/ is written inside it)`), 'skillpack');
  const root = resolveAbs(dirs[0]!);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- root is the operator's own folder argument on the local CLI
  const conventionsDir = join(root, 'conventions');
  const written: string[] = [], unchanged: string[] = [], kept: string[] = [];
  mkdirSync(conventionsDir, { recursive: true });
  for (const file of bundledConventionFiles(isThinClient(loadConfig()) ? 'downstream' : 'owner')) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- file.path is a key of gbrain's embedded skills map, never input
    const target = join(root, file.path);
    if (!existsSync(target)) {
      writeFileSync(target, file.content);
      written.push(file.path);
    } else {
      (readFileSync(target, 'utf8') === file.content ? unchanged : kept).push(file.path);
    }
  }
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, gbrain_version: VERSION, conventions_dir: conventionsDir, written, unchanged, kept }, null, 2));
    return;
  }
  console.log(conventionsDir);
  console.log(`  ${written.length} written, ${unchanged.length} already current`);
  for (const f of kept) console.log(`  kept ${f} (it differs from gbrain ${VERSION}'s copy; delete it and re-run to take gbrain's)`);
}

/**
 * GBRA-150: `foresights sources resolve-path <id> <path...> [--stdin] [--json]`, the CLI face of the read-only
 * `sources_resolve_path` operation (src/core/persistence/resolve-paths.ts): what foresights did with each file path of a source.
 */
import type { BrainEngine } from '../core/engine.ts';
import { OperationError } from '../core/ops/contract.ts';
import { resolveSourcePaths } from '../core/persistence/resolve-paths.ts';

export const RESOLVE_PATH_USAGE = 'Usage: foresights sources resolve-path <id> <path...> [--stdin] [--json]';

export async function runResolvePath(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${RESOLVE_PATH_USAGE}\n\n`
      + 'Read-only. For each file path of a source (relative to the source root, or to the Git top level), print the slug\n'
      + 'foresights gives it, whether sync skips it (and why), its hold, its page and embedding state, whether search can find it\n'
      + 'now, and the command that moves it on. A deleted path is checked by the page that records it as its origin, never by\n'
      + 'slug, so a case-folded twin that owns the slug is not mistaken for a failed delete.\n'
      + '  --stdin  read further paths from standard input, one per line (for example from git diff --name-only)\n'
      + '  --json   print the result as JSON');
    return;
  }
  const unknown = args.find(arg => arg.startsWith('--') && arg !== '--json' && arg !== '--stdin');
  if (unknown) throw new OperationError('invalid_params', `Unknown option: ${unknown}.`, RESOLVE_PATH_USAGE);
  const [sourceId, ...paths] = args.filter(arg => !arg.startsWith('--'));
  if (args.includes('--stdin')) paths.push(...(await Bun.stdin.text()).split('\n').map(line => line.trim()).filter(Boolean));
  if (!sourceId || !paths.length) throw new OperationError('invalid_params', 'Name one source and at least one path.', RESOLVE_PATH_USAGE);
  const result = await resolveSourcePaths(engine, sourceId, paths);
  if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`Source ${result.source_id} (${result.mode}), last synced commit ${result.last_commit?.slice(0, 12) ?? '(none)'}${result.head && result.head !== result.last_commit ? `, checkout HEAD ${result.head.slice(0, 12)}` : ''}`);
  for (const p of result.paths) {
    console.log(`  ${p.path} -> ${p.slug}: ${p.state}${p.searchable === true ? ' (searchable)' : p.searchable === 'keyword' ? ' (keyword search only)' : ''}`);
    console.log(`    ${p.why}`);
    if (p.fix?.argv) console.log(`    next: ${p.fix.argv.join(' ')}`);
  }
}

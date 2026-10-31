/**
 * `gbrain pages ghosts [--source <id>] [--json]` (#6696 B5): read-only list of
 * a source's ghost pages, live pages whose canonical file is missing on the
 * owner host. Same classifier as doctor `ghost_pages` and `gbrain repair
 * ghost-pages` (`src/core/ghost-pages.ts`); refuses off the owner host
 * (`not_owner_host`) and on an unreadable checkout (`ghost_storage_unknown`).
 */
import type { BrainEngine } from '../core/engine.ts';
import { opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { scanGhostSource } from '../core/ghost-pages.ts';
import { GHOST_CONSEQUENCES, GHOST_REPAIR_LIMIT, SKILL_PATH_NOTE, UNRESOLVABLE_NOTE, ghostPreviewCommand, ghostScanRefusal, skillPathRestore, unresolvableDetail } from '../core/repair/ghost-pages.ts';

export const PAGES_GHOSTS_USAGE = 'Usage: gbrain pages ghosts [--source <id>] [--json]';

export async function runPagesGhosts(engine: BrainEngine, args: string[]): Promise<void> {
  let explicit: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--json') json = true;
    else if (token === '--source' && args[i + 1] && !args[i + 1]!.startsWith('-')) explicit = args[++i];
    else if (token.startsWith('--source=') && token.length > '--source='.length) explicit = token.slice('--source='.length);
    else {
      throw opError('invalid_params', `Unexpected argument ${token} for gbrain pages ghosts.`, `${PAGES_GHOSTS_USAGE} (read-only).`,
        { fix: readFix('Lists the ghost pages of the default source; writes nothing.', { argv: ['gbrain', 'pages', 'ghosts', '--json'] }) });
    }
  }
  const sourceId = await resolveSourceId(engine, explicit ?? null);
  const scan = await scanGhostSource(engine, sourceId, { candidateLimit: GHOST_REPAIR_LIMIT });
  const refusal = ghostScanRefusal(scan);
  if (refusal) throw refusal;
  const next = scan.ghosts.length
    ? [`Preview the removal: ${ghostPreviewCommand(sourceId)} (writes nothing; apply only after the user agrees).`, GHOST_CONSEQUENCES.keep]
    : [];
  if (scan.skill_paths.length) next.push(SKILL_PATH_NOTE);
  if (scan.unresolvable_count) next.push(UNRESOLVABLE_NOTE);
  if (json) {
    console.log(JSON.stringify({ source_id: sourceId, status: scan.status, ...(scan.reason ? { reason: scan.reason } : {}), count: scan.ghosts.length,
      ghosts: scan.ghosts, ...(scan.skill_paths.length ? { skill_paths: scan.skill_paths } : {}),
      ...(scan.unresolvable_count ? { unresolvable: unresolvableDetail(scan.unresolvable_count, scan.unresolvable) } : {}), inspected: scan.inspected, file_backed: scan.file_backed, truncated: scan.truncated, exact: !scan.truncated, next }, null, 2));
    return;
  }
  console.log(`${scan.ghosts.length}${scan.truncated ? '+' : ''} ghost page(s) in source ${sourceId} (${scan.inspected} live page(s) inspected, ${scan.file_backed} file-backed).`);
  for (const ghost of scan.ghosts) console.log(`  ${ghost.slug}  missing ${ghost.path}  revision ${ghost.revision}`);
  if (scan.skill_paths.length) console.log(`${scan.skill_paths.length} more are files of the shared skillpack (listed apart; the repair leaves them alone):`);
  for (const ghost of scan.skill_paths) console.log(`  ${ghost.slug}  missing ${ghost.path}  restore: ${skillPathRestore(scan.root, ghost)}`);
  if (scan.unresolvable_count) console.log(`${scan.unresolvable_count} page(s) record a path that names no file inside the source (not ghosts; never removed):`);
  for (const page of scan.unresolvable) console.log(`  ${page.slug}  recorded path ${page.source_path}`);
  for (const line of next) console.log(line);
}

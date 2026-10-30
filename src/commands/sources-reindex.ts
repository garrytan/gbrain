/**
 * `gbrain sources reindex <source-id> --from-git` (git-canonical memory, G3, docs/designs/GIT_CANONICAL_MEMORY.md): the
 * re-derive verb of a strict source (`config.canonical = "git"`). The default `--dry-run` reads the level a full sync pass
 * would classify (sync-pass.ts `readShadowLevel`, read-only) and lists every page where Git's verdict replaces what the
 * database holds: an import over a database version sync never saw, a drifted page, a keep_db page or an edited tombstone,
 * and the deletion of a page whose file a commit removed. It prints a preview hash bound to HEAD and that list.
 * `--apply --expect <hash>` reads the level again, refuses `preview_changed` when it differs, and then runs the full sync
 * pass that applies Git's verdict (`gbrain sync --source <id> --no-pull --full`, with `--no-embed` and `--no-extract` passed on). A source that is not strict is refused,
 * because Git wins only where the source says so. Trusted local CLI only: it prints slugs and paths.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { previewChangedError, previewHash } from '../core/persistence/preview-approval.ts';
import { readShadowLevel } from '../core/persistence/sync-pass.ts';
import type { SyncClass } from '../core/persistence/sync-classify.ts';

const USAGE = 'Usage: gbrain sources reindex <source-id> --from-git [--dry-run | --apply --expect <hash> [--no-embed] [--no-extract]] [--json]';
const DOCS = 'docs/designs/GIT_CANONICAL_MEMORY.md#the-model';

export interface ReindexOverwrite { path: string; slug: string | null; action: 'import' | 'delete'; replaces: SyncClass }

export interface ReindexPreview {
  status: 'preview';
  source_id: string;
  /** The commit the level was read at. */
  head: string;
  /** Every page whose database version Git's verdict replaces, by path. */
  overwrites: ReindexOverwrite[];
  /** The other paths the pass imports or deletes, where the database holds nothing Git lacks. */
  imports: number;
  deletes: number;
  preview_hash: string;
  apply: string[];
}

export function parseReindexArgs(args: string[]): { sourceId: string; apply: boolean; expect: string | null; json: boolean; processing: string[] } {
  const positional: string[] = [];
  let expect: string | null = null, apply = false, fromGit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--expect') { expect = args[++i] ?? null; if (!expect) throw new OperationError('invalid_params', '--expect needs the preview hash.', USAGE); continue; }
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--from-git') { fromGit = true; continue; }
    if (arg === '--dry-run' || arg === '--json' || arg === '--no-embed' || arg === '--no-extract') continue;
    if (arg.startsWith('-')) throw new OperationError('invalid_params', `Unknown sources reindex flag: ${arg}.`, USAGE);
    positional.push(arg);
  }
  if (positional.length !== 1) throw new OperationError('invalid_params', 'sources reindex needs exactly one source id.', USAGE);
  if (!fromGit) throw new OperationError('invalid_params', 'sources reindex re-derives from Git only: pass --from-git.', USAGE);
  if (apply && args.includes('--dry-run')) throw new OperationError('invalid_params', '--apply and --dry-run exclude each other.', USAGE);
  if (apply && !expect) throw new OperationError('invalid_params', '--apply needs --expect <hash> from the --dry-run preview.', USAGE);
  return { sourceId: positional[0]!, apply, expect, json: args.includes('--json'), processing: args.filter(arg => arg === '--no-embed' || arg === '--no-extract') };
}

/** The read-only preview: what the next full pass of a strict source replaces in the database. */
export async function previewReindex(engine: BrainEngine, sourceId: string): Promise<ReindexPreview> {
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  const [source] = await engine.executeRaw<{ strict: boolean }>(`SELECT COALESCE(config->>'canonical','')='git' AS strict FROM sources WHERE id=$1`, [sourceId]);
  if (!source?.strict) throw new OperationError('invalid_params', `Source ${sourceId} is not strict (git-canonical), so Git does not win there and nothing was read.`,
    `Only a source with config.canonical = "git" re-derives from Git. gbrain sources git-gap ${sourceId} shows how far its database is from HEAD.`, DOCS);
  const level = await readShadowLevel(engine, { sourceId, full: true });
  if (!level) throw new OperationError('invalid_params', `Source ${sourceId} keeps an approved company-brain manifest, so it has no level to re-derive.`, USAGE, DOCS);
  const unsettled = level.paths.filter(entry => !entry.result.settled && !entry.result.inFlight && (entry.result.action === 'import' || entry.result.action === 'delete'));
  const overwrites = unsettled.filter(entry => entry.result.gitWins)
    .map(entry => ({ path: entry.path, slug: entry.slug, action: entry.result.action as 'import' | 'delete', replaces: entry.result.gitWins!, revision: entry.revision, level: entry.state.level }));
  const preview_hash = previewHash({ source: sourceId, head: level.head, overwrites: overwrites.map(o => [o.path, o.action, o.revision, o.level]) });
  return { status: 'preview', source_id: sourceId, head: level.head, overwrites: overwrites.map(({ path, slug, action, replaces }) => ({ path, slug, action, replaces })),
    imports: unsettled.filter(entry => !entry.result.gitWins && entry.result.action === 'import').length,
    deletes: unsettled.filter(entry => !entry.result.gitWins && entry.result.action === 'delete').length,
    preview_hash, apply: ['gbrain', 'sources', 'reindex', sourceId, '--from-git', '--apply', '--expect', preview_hash] };
}

function describe(preview: ReindexPreview): string {
  const lines = [`Source ${preview.source_id} at ${preview.head.slice(0, 12)}: Git's verdict replaces ${preview.overwrites.length} database version(s); the pass also imports ${preview.imports} and deletes ${preview.deletes} page(s) Git moved.`];
  for (const o of preview.overwrites) lines.push(`  ${o.action} ${o.path}${o.slug ? ` (page ${o.slug})` : ''}: replaces ${o.replaces}`);
  lines.push(`Nothing changed. To apply: ${preview.apply.join(' ')}`);
  return lines.join('\n');
}

export async function runSourcesReindex(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) { console.log(`${USAGE}\nPreview first: lists every database version Git's verdict replaces on a strict source (${DOCS}).`); return; }
  try {
    const parsed = parseReindexArgs(args);
    const preview = await previewReindex(engine, parsed.sourceId);
    if (!parsed.apply) { console.log(json ? JSON.stringify(preview) : describe(preview)); return; }
    if (preview.preview_hash !== parsed.expect) throw previewChangedError(parsed.expect!, `gbrain sources reindex ${parsed.sourceId} --from-git --dry-run`);
    const { runSync } = await import('./sync.ts');
    await runSync(engine, ['--source', parsed.sourceId, '--no-pull', '--full', ...parsed.processing, ...(json ? ['--json'] : [])]);
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources reindex', render: cliRenderContext() });
    console.log(json ? JSON.stringify({ status: 'refused', ...env }) : `Reindex refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(1);
  }
}

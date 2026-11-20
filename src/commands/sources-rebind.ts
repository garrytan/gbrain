/**
 * `gbrain sources rebind <id> [--yes] [--json]` (GST-3022): the non-destructive door after the checkout's push
 * destination changed. An owned-folder source records the branch's push URLs at its first write and keeps its pages
 * database-only while they differ (owned-folder/destination.ts, `remote_changed`). The preview prints the recorded and
 * the current destinations and the apply command; `--yes` records the current ones, so the next sync writes the folder
 * again. It changes no file and no page, and refuses `preview_changed` when the destination moved since the preview.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import type { ConnectorKind } from '../core/persistence/connector-kinds.ts';
import { isOwnedFolderKind, ownedFolderRel } from '../core/owned-folder/paths.ts';
import { resolveOwnedDestination, samePushUrls } from '../core/owned-folder/destination.ts';
import { readOwnedState, writeOwnedState } from '../core/owned-folder/writer.ts';

const USAGE = 'gbrain sources rebind <id> [--expect <current-push-urls>] [--yes] [--json]';

export interface RebindResult { source_id: string; applied: boolean; recorded: string[]; current: string[]; changed: boolean; apply?: string[] }

export function parseRebindArgs(args: string[]): { sourceId: string; yes: boolean; expect?: string } {
  const positional: string[] = [];
  let yes = false, expect: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--yes') { yes = true; continue; }
    if (arg === '--expect') { expect = args[++i]; continue; }
    if (arg.startsWith('-')) throw opError('invalid_params', `Unknown flag ${arg}.`, `Usage: ${USAGE}`);
    positional.push(arg);
  }
  if (positional.length !== 1) throw opError('invalid_params', 'Name one source.', `Usage: ${USAGE}`);
  return { sourceId: positional[0]!, yes, ...(expect !== undefined ? { expect } : {}) };
}

export async function rebindOwnedSource(engine: BrainEngine, opts: ReturnType<typeof parseRebindArgs>): Promise<RebindResult> {
  const [src] = await engine.executeRaw<{ incarnation: string; local_path: string | null; config: Record<string, unknown> | null; archived: boolean | null }>(
    'SELECT incarnation::text AS incarnation, local_path, config, archived FROM sources WHERE id=$1', [opts.sourceId]);
  if (!src || src.archived || !isOwnedFolderKind(src.config)) {
    throw opError('invalid_params', `${opts.sourceId} is not an active source that keeps its pages in ${ownedFolderRel(opts.sourceId)}/.`,
      'Name an iMessage source; gbrain sources list prints them.');
  }
  const kind = src.config!.kind as ConnectorKind;
  const owned = await readOwnedState(engine, opts.sourceId, src.incarnation, kind);
  if (!owned) {
    throw opError('invalid_params', `${opts.sourceId} has not written ${ownedFolderRel(opts.sourceId)}/ yet, so there is no destination to re-bind.`,
      `Run gbrain sync --source ${opts.sourceId}; its first write records the destination.`);
  }
  const destination = await resolveOwnedDestination(engine, opts.sourceId, null);
  if (destination.record !== 'folder') {
    throw opError('invalid_params', `${opts.sourceId} cannot write its folder now: ${destination.detail}.`, 'Fix that first; rebind only records a changed push destination.');
  }
  const current = destination.pushUrls;
  const shown = current.join(',');
  if (opts.expect !== undefined && opts.expect !== shown) {
    const preview = ['gbrain', 'sources', 'rebind', opts.sourceId];
    throw opError('preview_changed', `The checkout now pushes to ${shown || 'no remote'}, not ${opts.expect || 'no remote'} as the preview showed; nothing changed.`,
      `Preview again with ${preview.join(' ')} and apply the command it prints.`,
      { fix: { argv: preview, consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the recorded and current destinations; changes nothing.' } });
  }
  const changed = !samePushUrls(owned.push_urls, current);
  if (!opts.yes) {
    return { source_id: opts.sourceId, applied: false, recorded: owned.push_urls, current, changed,
      apply: ['gbrain', 'sources', 'rebind', opts.sourceId, '--expect', shown, '--yes'] };
  }
  if (changed) await writeOwnedState(engine, opts.sourceId, kind, { ...owned, push_urls: current });
  return { source_id: opts.sourceId, applied: true, recorded: owned.push_urls, current, changed };
}

function describe(r: RebindResult): string {
  const was = r.recorded.join(', ') || 'no remote', now = r.current.join(', ') || 'no remote';
  if (!r.changed) return `Source "${r.source_id}": its pages already go to ${now}; nothing to re-bind.`;
  if (!r.applied) {
    return [`Source "${r.source_id}" recorded ${was} at its first write; the checkout now pushes to ${now}.`,
      `Re-binding lets the next sync commit its pages under ${ownedFolderRel(r.source_id)}/ again, so they travel to ${now}. No file changes now.`,
      `Apply: ${r.apply!.join(' ')}`].join('\n');
  }
  return `Source "${r.source_id}" now writes its pages for ${now} (was ${was}); the next sync commits them.`;
}

export async function runRebind(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const result = await rebindOwnedSource(engine, parseRebindArgs(args));
    console.log(json ? JSON.stringify(result) : describe(result));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources rebind', render: cliRenderContext() });
    console.log(json ? JSON.stringify(env) : `Refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(error.code === 'invalid_params' ? 2 : 1);
  }
}

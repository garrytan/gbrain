/**
 * GBRA-218 local `--as <member>`: an operation's reads previewed as one member.
 * The handler runs under that member's identity with the remote read policy
 * (readers and privacy), while ctx.remote stays false, so upload confinement
 * and write trust are unchanged. An unknown or ill-formed member is refused
 * before any work.
 */
import type { BrainEngine } from '../core/engine.ts';
import { isThinClient, loadConfig } from '../core/config.ts';
import { finishCliTeardown } from '../core/cli-force-exit.ts';
import { exitCliError, usageError } from './cli-error.ts';

const NON_OPERATION_SEARCH = new Set(['modes', 'stats', 'tune', 'diagnose']);

/** --as only previews operation reads on a local brain; any other command would ignore it, and a thin client reads as its own credential. */
export function refuseAsOutsideOperations(command: string, subArgs: string[], isOperation: boolean): void {
  if (!isOperation || (command === 'search' && NON_OPERATION_SEARCH.has(subArgs[0] ?? ''))) {
    exitCliError(usageError(`--as previews member reads for operation commands only; 'gbrain ${command}' does not take it.`,
      'Use --as with an operation such as search, query, get or list, or check a credential with gbrain access check --token <name>.'), command);
  }
  if (isThinClient(loadConfig())) {
    exitCliError(usageError('--as previews member reads on a local brain; a thin client reads as its own credential.', 'Run the command on the brain host, or check the credential with gbrain access check there.'), command);
  }
}

export interface AsPreview {
  run<T>(fn: () => Promise<T>): Promise<T>;
  context<C extends object>(ctx: C): C;
}

const PASSTHROUGH: AsPreview = { run: fn => fn(), context: ctx => ctx };

export async function openAsPreview(engine: BrainEngine, member: string | undefined, command: string): Promise<AsPreview> {
  if (member === undefined) return PASSTHROUGH;
  let identity: string[];
  try {
    identity = (await (await import('../core/access/members.ts')).memberIdentity(engine, member)).identity;
  } catch (e: unknown) {
    await finishCliTeardown({ engine });
    exitCliError(e, command);
  }
  const { withCallerAccess } = await import('../core/search/private-visibility.ts');
  const access = { identity, applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] };
  return {
    run: fn => withCallerAccess(access, fn),
    context: ctx => ({ ...ctx, accessIdentity: identity, applyRemoteReadPolicy: true }),
  };
}

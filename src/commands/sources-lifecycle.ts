/** Source mutations use authenticated resident ingress before any PGLite open. */
import type { BrainEngine } from '../core/engine.ts';
import { OperationError } from '../core/ops/contract.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { isThinClient, loadConfig } from '../core/config.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { writeStdoutFinal, setCliExitVerdict } from '../core/cli-force-exit.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { runPersistenceAdministration } from '../core/persistence/administration.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { assertTopologyCommitted } from '../core/persistence/managed-sources.ts';
import { parseSourceLifecycleArgs, type ParsedSourceLifecycle } from './sources-lifecycle-args.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';

export const SOURCE_LIFECYCLE_HELP = `Managed source administration:
  gbrain sources add <id> [--path <directory> | --url <https-url> | --kind github|google]
  gbrain sources archive <id>
  gbrain sources restore <id> [--no-federate]
  gbrain sources remove <id> --confirm-destructive
  gbrain sources purge <archived-id> --confirm-destructive
  gbrain sources set-path <id> <verified-directory>
  gbrain sources reclone <id>

All commands accept --request-id <uuid>, --expected-incarnation <uuid>, --dry-run,
--brain <id>, and --json. Retain the returned request ID across retries. Rebind
requires an exact canonical manifest, including deletions; --force cannot bypass
ownership. Remove and purge retain local storage for explicit operator cleanup.
Unmanaged installations retain their existing source command behavior.`;

function checkManagedOptions(parsed: ParsedSourceLifecycle): void {
  if (parsed.legacyOnly) throw new OperationError('writer_coordinator_required',
    'Source creation cannot also install legacy Git hardening on a managed worktree.',
    'Create the source without --pat-file. Configure supported postpublication Git effects separately.');
}

export async function executeSourceLifecycle(engine: BrainEngine, parsed: ParsedSourceLifecycle): Promise<Record<string, unknown>> {
  checkManagedOptions(parsed);
  return runPersistenceAdministration(engine, parsed.operation, parsed.params);
}

async function render(result: Record<string, unknown>): Promise<void> {
  await writeStdoutFinal(JSON.stringify(result, null, 2) + '\n');
  if (result.dry_run !== true) {
    try { assertTopologyCommitted(result); }
    catch { setCliExitVerdict(1); }
  }
}

/** Also called by connected command users so no legacy raw DELETE/UPDATE slips through. */
export async function runConnectedSourceLifecycle(engine: BrainEngine, args: string[]): Promise<boolean> {
  if (!await managedPersistenceEnabled(engine)) return false;
  await render(await executeSourceLifecycle(engine, parseSourceLifecycleArgs(args)));
  return true;
}

export async function runSourceLifecycleCli(args: string[], getEngine: () => Promise<BrainEngine>): Promise<void> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(SOURCE_LIFECYCLE_HELP); return; }
  try {
    let parsed: ParsedSourceLifecycle | undefined;
    let parseError: unknown;
    try { parsed = parseSourceLifecycleArgs(args); } catch (error) { parseError = error; }
    // Global CLI routing has already consumed --brain; parsing retains it for direct callers too.
    const brainId = resolveBrainId(parsed?.brain ?? getCliOptions().brain);
    const config = persistenceConfigForBrain(loadConfig(), brainId, brainId === 'host' ? [] : loadMounts());
    if (!config) throw new OperationError('invalid_params', 'No brain is configured. Run gbrain init first.');
    if (isThinClient(config)) throw new OperationError('permission_denied', 'Source administration runs locally on the selected brain host; an ordinary remote token is not administration authority.');
    if (parsed) {
      // --pat-file must refuse before the resident owner can create anything.
      const delegated = await maybeDelegateLocalAdministration(parsed.operation,
        { ...parsed.params, ...(parsed.legacyOnly ? { legacy_hardening: true } : {}) }, config,
        { timeoutMs: getCliOptions().timeoutMs ?? undefined });
      if (delegated.handled) { await render(delegated.result as Record<string, unknown>); return; }
    } else {
      // An invalid mutation must not attempt another datastore open while its owner is live.
      const { inspectLockHolder } = await import('../core/pglite-lock.ts');
      if (config.engine === 'pglite' && config.database_path && inspectLockHolder(config.database_path).held) throw parseError;
    }
    const engine = await getEngine();
    if (await managedPersistenceEnabled(engine)) {
      if (!parsed) throw parseError;
      await render(await executeSourceLifecycle(engine, parsed));
    } else {
      const { runSources } = await import('./sources.ts');
      await runSources(engine, args);
    }
  } catch (error) {
    if (!await reportPersistenceCliError(error, args.includes('--json'))) throw error;
  }
}

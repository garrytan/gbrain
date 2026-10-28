/** Google / GitHub connector sources: sync by materializing the connector. */
import { assertSyncDispatchActive } from '../../core/persistence/sync-authority.ts';
import { currentSourceFilesystemSignal } from '../../core/minions/source-filesystem.ts';
import { currentJobSignal } from '../../core/minions/submission-authority.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { serr } from '../../core/console-prefix.ts';
import { assertResetCheckpointSource } from '../../core/persistence/connector-reset.ts';
import { isConnectorSourceKind, type ConnectorKind } from '../../core/persistence/connector-kinds.ts';
import { assertNever } from '../../core/types.ts';
import type { SyncOpts, SyncResult } from '../sync.ts';

export async function runConnectorSync(engine: BrainEngine, opts: SyncOpts, managed: boolean): Promise<SyncResult | null> {
  if (opts.resetCheckpoint) await assertResetCheckpointSource(engine, opts.sourceId);
  if (!opts.sourceId && !opts.githubItem) return null;
  const sourceId = opts.sourceId ?? 'default';
  const [source] = await engine.executeRaw<{ local_path: string | null; config: unknown }>(
    'SELECT local_path,config FROM sources WHERE id=$1', [sourceId]);
  assertSyncDispatchActive();
  if (!source) {
    if (opts.githubItem) throw new Error(`github_item refresh requires a github-kind source; source "${sourceId}" not found.`);
    return null;
  }
  const config = typeof source.config === 'string' ? JSON.parse(source.config) : source.config ?? {};
  if (!isConnectorSourceKind(config.kind)) {
    if (opts.githubItem) throw new Error(`github_item refresh requires a github-kind source, but "${sourceId}" is not github-kind.`);
    return null;
  }
  if (opts.githubItem && config.kind !== 'github') throw new Error(`github_item refresh requires a github-kind source, but "${sourceId}" is not github-kind.`);
  const signals = [opts.signal, currentJobSignal(), currentSourceFilesystemSignal()].filter((signal): signal is AbortSignal => !!signal);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  if (signal?.aborted) throw signal.reason ?? new Error('Sync job cancelled');
  const options = signal ? { ...opts, signal } : opts;
  const fallbackDir = source.local_path ?? (managed ? '' : (await import('../../core/sources-ops.ts')).defaultCloneDir(`${sourceId}-${config.kind}`));
  serr(`[gbrain phase] sync.${config.kind}_materialize`);
  return withConnectorPartialReason(await runConnectorKind(engine, sourceId, config, fallbackDir, options), signal);
}

async function runConnectorKind(engine: BrainEngine, sourceId: string, config: Record<string, unknown> & { kind: ConnectorKind }, fallbackDir: string, options: SyncOpts): Promise<SyncResult> {
  switch (config.kind) {
    case 'github': {
      const { parseGitHubSourceConfig, runGitHubSync } = await import('../../core/github-source.ts');
      return runGitHubSync(engine, sourceId, parseGitHubSourceConfig(config, fallbackDir), options);
    }
    case 'google': {
      const { parseGoogleSourceConfig, runGoogleSync } = await import('../../core/google/google-source.ts');
      return runGoogleSync(engine, sourceId, parseGoogleSourceConfig(config, fallbackDir), options);
    }
    case 'meetings': {
      const { parseMeetingsSourceConfig } = await import('../../core/meetings/source-config.ts');
      const { runMeetingsSync } = await import('../../core/meetings/meetings-source.ts');
      return runMeetingsSync(engine, sourceId, parseMeetingsSourceConfig(config, fallbackDir), options);
    }
    default: return assertNever(config.kind);
  }
}

/**
 * #5012: a connector partial never reports the git path's `timeout` default.
 * Failed items name `connector_item_failures`; an early stop with no cause is
 * `connector_partial` unless the run's signal aborted it (`timeout`).
 */
export function withConnectorPartialReason(result: SyncResult, signal?: AbortSignal): SyncResult {
  if (result.status !== 'partial' || result.reason) return result;
  return {
    ...result,
    filesImported: result.filesImported ?? result.added + result.modified,
    reason: (result.failedFiles ?? 0) > 0 ? 'connector_item_failures' : signal?.aborted ? 'timeout' : 'connector_partial',
  };
}

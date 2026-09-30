/** Google / GitHub connector sources: sync by materializing the connector. */
import { assertSyncDispatchActive } from '../../core/persistence/sync-authority.ts';
import { currentSourceFilesystemSignal } from '../../core/minions/source-filesystem.ts';
import { currentJobSignal } from '../../core/minions/submission-authority.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { serr } from '../../core/console-prefix.ts';
import { assertResetCheckpointSource } from '../../core/persistence/connector-reset.ts';
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
  if (config.kind !== 'google' && config.kind !== 'github') {
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
  if (config.kind === 'github') {
    const { parseGitHubSourceConfig, runGitHubSync } = await import('../../core/github-source.ts');
    return runGitHubSync(engine, sourceId, parseGitHubSourceConfig(config, fallbackDir), options);
  }
  const { parseGoogleSourceConfig, runGoogleSync } = await import('../../core/google/google-source.ts');
  return runGoogleSync(engine, sourceId, parseGoogleSourceConfig(config, fallbackDir), options);
}

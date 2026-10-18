/**
 * The repo `gbrain autopilot --install` bakes into the daemon when no --repo
 * is given (#6755): sync.repo_path, else the default source's local_path. A
 * brain whose repo is a managed source keeps it only in sources.local_path,
 * so the config key alone refused an install the brain could name.
 */
import type { BrainEngine } from '../../core/engine.ts';

/** The default source's local_path, or null when it has none. */
export async function defaultSourceLocalPath(engine: BrainEngine): Promise<string | null> {
  const [row] = await engine.executeRaw<{ local_path: string | null }>(`SELECT local_path FROM sources WHERE id = 'default'`);
  return row?.local_path || null;
}

/** sync.repo_path, else the default source's local_path; null when neither is set. */
export async function installRepoFallback(engine: BrainEngine): Promise<string | null> {
  return (await engine.getConfig('sync.repo_path')) || defaultSourceLocalPath(engine);
}

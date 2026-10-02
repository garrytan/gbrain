import type { BrainEngine } from '../engine.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { isConnectorSourceKind } from './connector-identity.ts';
import type { WriteAuthority } from './model.ts';

/**
 * Where a fact fenced onto an existing entity page publishes: the canonical
 * file through the source's worktree binding, or the database page body only.
 * `unbound` is a write-through source with a root but no owner yet; remember
 * claims one automatically on PGLite, while maintenance writers (relink)
 * refuse rather than claim.
 */
export type FactWriteTarget =
  | { kind: 'publish'; binding: WorktreeBinding | null; databaseOnlyReason?: WriteAuthority['databaseOnlyReason'] }
  | { kind: 'unbound'; root: string };

export async function resolveFactWriteTarget(engine: BrainEngine, sourceId: string,
  source: { local_path: string | null; kind: string | null }, opts: { sandbox?: boolean } = {}): Promise<FactWriteTarget> {
  const configured = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  const writeThrough = configured && !opts.sandbox;
  const reason = opts.sandbox ? 'subagent_sandbox' as const : !configured ? 'disabled_by_config' as const : undefined;
  if (!writeThrough) return { kind: 'publish', binding: null, databaseOnlyReason: reason };
  const binding = await getWorktreeBinding(engine, sourceId);
  const root = source.local_path || (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  // An unbound connector source is database-only by design; never claim it for a fence write.
  if (root && !binding && isConnectorSourceKind(source.kind)) return { kind: 'publish', binding: null, databaseOnlyReason: 'connector_database' };
  if (root && !binding) return { kind: 'unbound', root };
  return { kind: 'publish', binding };
}

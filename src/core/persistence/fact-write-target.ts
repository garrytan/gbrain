import type { BrainEngine } from '../engine.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { decideUnboundWrite } from './unbound-source.ts';
import type { WriteAuthority } from './model.ts';

/**
 * Where a fact fenced onto an existing entity page publishes: the canonical
 * file through the source's worktree binding, or the database page body only.
 * A write-through source with a root but no owner follows `decideUnboundWrite`
 * (#6608): `unbound` is its claim outcome (PGLite), which remember takes
 * automatically while maintenance writers (relink) refuse rather than claim;
 * an unbound Postgres source writes a page without a canonical file
 * database-only under `persistence.unbound_write=database_only` and refuses
 * otherwise. `fileBacked` is whether the target page records a canonical file;
 * the refusal names the checkout only to trusted local (`remote: false`) callers.
 */
export type FactWriteTarget =
  | { kind: 'publish'; binding: WorktreeBinding | null; databaseOnlyReason?: WriteAuthority['databaseOnlyReason'] }
  | { kind: 'unbound'; root: string };

export async function resolveFactWriteTarget(engine: BrainEngine, sourceId: string,
  source: { local_path: string | null; kind: string | null },
  opts: { sandbox?: boolean; fileBacked: boolean; remote: boolean }): Promise<FactWriteTarget> {
  const configured = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  const writeThrough = configured && !opts.sandbox;
  const reason = opts.sandbox ? 'subagent_sandbox' as const : !configured ? 'disabled_by_config' as const : undefined;
  if (!writeThrough) return { kind: 'publish', binding: null, databaseOnlyReason: reason };
  const binding = await getWorktreeBinding(engine, sourceId);
  const root = source.local_path || (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  if (!root || binding) return { kind: 'publish', binding };
  const decision = await decideUnboundWrite(engine, { sourceId, sourceKind: source.kind, fileBacked: opts.fileBacked, path: opts.remote ? null : root });
  return decision.kind === 'claim' ? { kind: 'unbound', root } : { kind: 'publish', binding: null, databaseOnlyReason: decision.reason };
}

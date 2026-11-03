/**
 * GBRA-156: the next command `gbrain sources add` prints when a new
 * non-federated source leaves the no-grant floor holding no page.
 *
 * A remote token or agent connection with no source grant reads the default
 * source plus the federated ones. When none of those holds a page, such a
 * connection is refused (`sources_not_readable`) until a source is federated
 * or the connection is granted sources, so the add says which command makes
 * the new source readable. The stored federation default is unchanged.
 */
import type { BrainEngine } from '../core/engine.ts';
import { localFederatedSourceIds } from '../core/source-resolver.ts';
import { privatePagesFilterFragment, resolveExcludePrivatePages } from '../core/search/private-visibility.ts';

export interface SourcesAddNext {
  command: string;
  argv: string[];
  why: string;
}

/** The federate step for `id` when the no-grant floor holds no live page a remote read may show, else null. */
export async function noGrantFloorNext(engine: BrainEngine, id: string): Promise<SourcesAddNext | null> {
  const floor = (await localFederatedSourceIds(engine, 'default', 'seed_default')) ?? ['default'];
  const visible = await resolveExcludePrivatePages(engine, true) ? ` AND ${privatePagesFilterFragment('p')}` : '';
  const [row] = await engine.executeRaw<{ holds: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = ANY($1::text[]) AND p.deleted_at IS NULL${visible}) AS holds`, [floor]);
  if (row?.holds) return null;
  const argv = ['gbrain', 'sources', 'federate', id];
  return {
    command: argv.join(' '),
    argv,
    why: `Connections with no source grant read only the default source and federated sources, and none of them holds a page, so their reads are refused until "${id}" is federated or they are granted sources.`,
  };
}

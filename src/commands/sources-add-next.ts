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
import type { Notice } from '../core/agent-output.ts';
import { newSourceJoinsDefaultSearch } from '../core/source-default-search.ts';
import { localFederatedSourceIds } from '../core/source-resolver.ts';
import { privatePagesFilterFragment, resolveExcludePrivatePages } from '../core/search/private-visibility.ts';
import { quarantineFilterFragment } from '../core/quarantine.ts';

export interface SourcesAddNext {
  command: string;
  argv: string[];
  why: string;
}

/** The federate step for `id` when the no-grant floor holds no live, unquarantined page a remote read may show, else null. */
export async function noGrantFloorNext(engine: BrainEngine, id: string): Promise<SourcesAddNext | null> {
  const floor = (await localFederatedSourceIds(engine, 'default', 'seed_default')) ?? ['default'];
  const visible = ` AND ${quarantineFilterFragment('p')}`
    + (await resolveExcludePrivatePages(engine, true) ? ` AND ${privatePagesFilterFragment('p')}` : '');
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

/** The notice for a source left out of default search; shared says the brain's shape kept it out, so federating is the user's call. */
export function notInDefaultSearchNotice(id: string, shared: boolean): Notice {
  return {
    code: 'source_not_in_default_search',
    kind: 'info',
    why: `The source "${id}" is not federated, so it is not in default search: a search, query or recall that names no source leaves its pages out, and a remote token or agent connection with no source grant cannot read them.`
      + (shared ? ' This brain serves several people or is not marked personal, so a new source stays out until someone chooses to add it.' : '')
      + ` Run \`gbrain sources federate ${id}\` to add it, or grant one token with \`gbrain auth rescope --token <name> --sources ${id}\`.`,
    fix: {
      argv: ['gbrain', 'sources', 'federate', id],
      consent: [],
      actor: 'agent',
      ...(shared ? { ask_user: true as const } : {}),
      requires_exclusive: false,
      why: 'Adds the source to default search and to what connections with no source grant can read.',
      verify: { argv: ['gbrain', 'sources', 'list', '--json'] },
    },
  };
}

/** After `gbrain sync --source <id>`: the same notice when that source holds pages and its federated setting is unset. */
export async function syncOutOfSearchNotice(engine: BrainEngine, args: string[]): Promise<Notice | null> {
  if (args[0] === 'status' || args[0] === 'unblock' || args.includes('--dry-run')) return null;
  const id = args.find((_, i) => args[i - 1] === '--source');
  if (!id || id === 'default') return null;
  try {
    const [row] = await engine.executeRaw<{ f: unknown; pages: number }>(
      `SELECT config->'federated' AS f, (SELECT count(*)::int FROM pages WHERE source_id = $1 AND deleted_at IS NULL) AS pages FROM sources WHERE id = $1`, [id]);
    if (!row || row.f != null || !Number(row.pages)) return null;
    return notInDefaultSearchNotice(id, !(await newSourceJoinsDefaultSearch(engine)));
  } catch {
    return null;
  }
}

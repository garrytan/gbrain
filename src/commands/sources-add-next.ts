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
import { rethrowCapabilityRefusal } from '../core/engine-capability-refusal.ts';
import type { Notice, RenderedNotice } from '../core/agent-output.ts';
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
    why: `Connections with no source grant read only the default source and federated sources, and none of them holds a page every reader of its source can read, so their empty reads are refused until "${id}" is federated or they are granted sources.`,
  };
}

/** The notice for a source left out of default search; shared says the brain's shape kept it out. Federating is the user's call when shared or when `ask` (a source that predates this add). */
export function notInDefaultSearchNotice(id: string, shared: boolean, ask = shared): Notice {
  return {
    code: 'source_not_in_default_search',
    kind: 'info',
    why: `The source "${id}" is not federated, so it is not in default search: a search, query or recall that names no source leaves its pages out, and a remote token or agent connection with no source grant cannot read them.`
      + (shared ? ' This brain serves several people or is not marked personal, so a new source stays out until someone chooses to add it.' : '')
      + ` To share it with every connection that reads default search, run \`gbrain sources federate ${id}\`; to share it with one token, \`gbrain auth rescope --token <name> --sources ${id}\`. A source meant to stay private needs nothing.`,
    fix: {
      argv: ['gbrain', 'sources', 'federate', id],
      consent: [],
      actor: 'agent',
      ...(ask ? { ask_user: true as const } : {}),
      requires_exclusive: false,
      why: 'Adds the source to default search and to what connections with no source grant can read.',
      verify: { argv: ['gbrain', 'sources', 'list', '--json'] },
    },
    ...(ask ? { user_message: `Should the source "${id}" be shared with every connection that reads this brain's default search? If yes, the command shown adds it. If it is meant for one person or a few connections, leave it as it is.` } : {}),
  };
}

/** After `gbrain sync --source <id>`: the same notice when that source holds pages and its federated setting is unset. */
export async function syncOutOfSearchNotice(engine: BrainEngine, args: string[]): Promise<Notice | null> {
  if (args[0] === 'status' || args[0] === 'unblock' || args.includes('--dry-run')) return null;
  const id = args.find((_, i) => args[i - 1] === '--source');
  if (!id || id === 'default') return null;
  try {
    // Typed reads: a Rust brain keeps no SQL table to select from, so the source row and its live page count come
    // from getSource and countSourcePages on every engine.
    const source = await engine.getSource(id);
    if (!source) return null;
    const config = source.config ?? {};
    if (config.federated != null || config.added_by_remote_caller === true || !Number(await engine.countSourcePages(id))) return null;
    return notInDefaultSearchNotice(id, !(await newSourceJoinsDefaultSearch(engine)), true);
  } catch (e) {
    // A Rust brain's typed refusal is not "no notice due": let it surface.
    rethrowCapabilityRefusal(e);
    return null;
  }
}

/** Writes the sync notice on stderr when it applies. */
export async function noteSyncOutOfSearch(engine: BrainEngine, args: string[]): Promise<void> {
  const notice = await syncOutOfSearchNotice(engine, args);
  if (notice) (await import('../cli/cli-error.ts')).writeCliNotice(notice);
}

/**
 * GST-2732: what a finished add means, for both CLI add paths. `chosen` is the --federated / --no-federated choice
 * (null when none was made); `path` is the local folder of a plain --path add, else null. Prints on `say`, writes the
 * notice on stderr unless json, and returns the rendered notices for the JSON document.
 */
export async function reportAddOutcome(input: { id: string; chosen: boolean | null | undefined; federated: boolean; path: string | null; json: boolean; say: (line: string) => void }): Promise<RenderedNotice[] | undefined> {
  const { existsSync } = await import('node:fs');
  if (input.path && existsSync(input.path) && !(await import('../core/git-remote.ts')).inGitCheckout(input.path)) {
    input.say('  plain folder (not a git repository): sync imports its files without Git, so git history is off and a file removed from it keeps its page');
  }
  if (input.chosen != null) return undefined;
  if (input.federated) {
    input.say(`  this brain serves one person, so a new source joins default search; \`gbrain sources unfederate ${input.id}\` takes it out`);
    return undefined;
  }
  const notice = notInDefaultSearchNotice(input.id, true);
  if (!input.json) (await import('../cli/cli-error.ts')).writeCliNotice(notice);
  const { cliRenderContext, renderNotice } = await import('../core/agent-output.ts');
  return [renderNotice(notice, cliRenderContext())];
}

/**
 * GBRA-218 local `--as <member>`: an operation's reads previewed as one member.
 * The handler runs under that member's identity with the remote read policy
 * (readers and privacy; GST-2059: the brain owner reads with privacy relaxed, and GST-2490: with access.owner_reads_restricted
 * on, past readers lists and rules too; GBRA-108: a read previews the lineage the member's own credential gets, owner
 * or access.members_read_lineage, and the owner's audience members; GBRA-108 design 1: a labelled-only member's grant), while ctx.remote stays false, so upload confinement
 * and write trust are unchanged. GST-3747: a member other than the owner reads no personal source bound to someone else
 * (access/member-sources.ts, the rule its keys get): unqualified reads span the floor memberFloorScope leaves, __all__
 * spans every other source, and naming such a source is refused. An unknown or ill-formed member is refused
 * before any work.
 */
import type { BrainEngine } from '../core/engine.ts';
import { isThinClient, loadConfig } from '../core/config.ts';
import { finishCliTeardown } from '../core/cli-force-exit.ts';
import { exitCliError, usageError } from './cli-error.ts';
import { ALL_SOURCES, NO_SOURCES } from '../core/source-id.ts';
import { decodeDeepResearchId } from '../core/deep-research-id.ts';

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
  /** The operation context under the preview; may narrow `params` in place (an __all__ read). */
  context<C extends { sourceId?: string; localFederatedSourceIds?: string[] }>(ctx: C, params?: Record<string, unknown>): C;
}

/** The source a fetch result id names; fetch decodes it inside its handler, past the preview's source check. */
function fetchedSource(params: Record<string, unknown>): string | undefined {
  if (typeof params.id !== 'string') return undefined;
  try { return decodeDeepResearchId(params.id)?.sourceId; } catch { return undefined; }
}

const PASSTHROUGH: AsPreview = { run: fn => fn(), context: ctx => ctx };

function namedSourceIds(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of [params.source_id, params.source_ids]) {
    for (const s of Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []) if (typeof s === 'string' && s.trim()) out.push(s.trim());
  }
  return out;
}

export async function openAsPreview(engine: BrainEngine, member: string | undefined, command: string, readOnly = false): Promise<AsPreview> {
  if (member === undefined) return PASSTHROUGH;
  let identity: string[];
  let owner: boolean;
  let ownerReadsRestricted: boolean;
  let lineage: boolean;
  let audienceKindMembers: string[];
  let labelledOnly: boolean;
  let memberId: string;
  try {
    const membersModule = await import('../core/access/members.ts');
    const resolved = await membersModule.memberIdentity(engine, member);
    identity = resolved.identity;
    const ownerModule = await import('../core/access/owner.ts');
    owner = resolved.member === await ownerModule.ownerMemberId(engine);
    ownerReadsRestricted = owner && await ownerModule.ownerReadsRestrictedOn(engine);
    lineage = readOnly && (owner || await (await import('../core/access/lineage.ts')).membersReadLineageOn(engine));
    audienceKindMembers = owner && lineage ? await membersModule.audienceMemberIds(engine) : [];
    labelledOnly = !owner && await (await import('../core/access/labelled-only.ts')).labelledOnlyFor(engine, [identity]);
    memberId = resolved.member;
  } catch (e: unknown) {
    await finishCliTeardown({ engine });
    exitCliError(e, command);
  }
  const { withCallerAccess } = await import('../core/search/private-visibility.ts');
  const folder = await (await import('../core/access/caller.ts')).folderAccessFor(engine, identity);
  const access = { identity, ...folder, applyRemoteReadPolicy: true, hidePrivate: !owner, owner, lineage, ownerReadsRestricted: ownerReadsRestricted && lineage, audienceKindMembers, labelledOnly, privateReadableSources: [] };
  const { floorWithout, hiddenPersonalSources } = await import('../core/access/member-sources.ts');
  const live = owner ? [] : (await engine.listAllSources()).map(s => s.id).sort();
  const hidden = owner ? new Set<string>() : await hiddenPersonalSources(engine, live, memberId, false);
  const visible = live.filter(s => !hidden.has(s));
  const { opError } = await import('../core/ops/contract.ts');
  const refuse = (source: string) => opError('permission_denied', `--as ${memberId}: source "${source}" is another member's personal source, so ${memberId} reads it only through a key whose grant names it.`,
    `Preview a source ${memberId} reads; gbrain access check shows what one of its keys reads.`);
  return {
    run: fn => withCallerAccess(access, fn),
    context: (ctx, params = {}) => {
      let scoped = ctx;
      if (hidden.size && readOnly) {
        const named = namedSourceIds(params);
        const anchor = ctx.localFederatedSourceIds?.length && params.source === undefined ? [] : [ctx.sourceId ?? ''];
        const denied = [...anchor, ...named].find(s => hidden.has(s));
        if (denied) throw refuse(denied);
        if (hidden.has(fetchedSource(params) ?? '')) throw opError('page_not_found', 'Page not found', 'Pass an id returned by a current `search` call.');
        if (ctx.sourceId === ALL_SOURCES || named.includes(ALL_SOURCES) || params.all_sources === true) {
          delete params.source_id;
          delete params.all_sources;
          const anchor = visible.includes('default') ? 'default' : visible[0] ?? NO_SOURCES;
          scoped = { ...ctx, sourceId: anchor, localFederatedSourceIds: [anchor, ...visible.filter(s => s !== anchor)] };
        } else {
          scoped = floorWithout(ctx, hidden);
        }
      }
      return { ...scoped, accessIdentity: identity, applyRemoteReadPolicy: true };
    },
  };
}

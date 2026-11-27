/**
 * The retrieval reflex's page reads and the proactive brief's entity-page read (engine-sql/reflex-reads.ts), answered
 * from the store (rust/crates/gbrain-store/src/cli_reads/reflex_reads.rs).
 *
 * The privacy maps to a store page policy the way the entity resolver's does (cli-entities.ts retirementHopPolicy):
 * `caller` and `floor` go through storePageTextPolicy, which refuses a caller whose members, grants or lineage widen
 * the policy. The eligibility maps to the store's trust floor and activation flag.
 */
import type { BriefEntityPageOpts, BriefEntityPageRow, ReflexPageMatch, ReflexPageRow, ReflexScope } from '../../engine-sql/reflex-reads.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { reflexPolicy } from './private-provenance.ts';

function storeMatch(member: string, match: ReflexPageMatch): Record<string, unknown> {
  switch (match?.kind) {
    case 'names': return { kind: 'names', titlesLc: [...match.titlesLc], exactSlugs: [...match.exactSlugs], slugSuffixes: [...match.slugSuffixes], surnamePatterns: [...(match.surnamePatterns ?? [])] };
    case 'slugs': return { kind: 'slugs', slugs: [...match.slugs] };
    case 'cjkExact': return { kind: 'cjkExact', norms: [...match.norms] };
    case 'titles': return { kind: 'titles', titlesLc: [...match.titlesLc] };
    default: refuseMember(member, `match kind ${String((match as { kind?: unknown } | undefined)?.kind)}`);
  }
}

export const readReflexLiveKeys: StoreMember<[scope: ReflexScope, slugs: readonly string[]], Array<{ slug: string; source_id: string }>> =
  async (brain, scope, slugs) => {
    const policy = reflexPolicy('readReflexLiveKeys', scope.privacy);
    return storeCall({ member: 'readReflexLiveKeys' }, () => brain.readReflexLiveKeys([...scope.sourceIds], [...slugs], policy)) as Promise<Array<{ slug: string; source_id: string }>>;
  };

export const readReflexPages: StoreMember<[scope: ReflexScope, match: ReflexPageMatch], ReflexPageRow[]> = async (brain, scope, match) => {
  const policy = reflexPolicy('readReflexPages', scope.privacy);
  const wanted = storeMatch('readReflexPages', match);
  return storeCall({ member: 'readReflexPages' }, () => brain.readReflexPages([...scope.sourceIds], wanted, policy)) as Promise<ReflexPageRow[]>;
};

export const readBriefEntityPages: StoreMember<[sourceId: string, slugs: readonly string[], opts: BriefEntityPageOpts], BriefEntityPageRow[]> =
  async (brain, sourceId, slugs, opts) => {
    const policy = reflexPolicy('readBriefEntityPages', opts.privacy);
    const eligibility = { minTrust: opts.eligibility?.floor ?? null, suppressFlagged: opts.eligibility?.suppressFlagged === true };
    return storeCall({ member: 'readBriefEntityPages', sourceId }, () => brain.readBriefEntityPages(sourceId, [...slugs], policy, eligibility)) as Promise<BriefEntityPageRow[]>;
  };

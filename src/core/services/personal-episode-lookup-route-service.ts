import type { BrainEngine } from '../engine.ts';
import type {
  PersonalEpisodeEntry,
  PersonalEpisodeLookupRoute,
  PersonalEpisodeLookupRouteInput,
  PersonalEpisodeLookupRouteResult,
} from '../types.ts';

export const DEFAULT_PERSONAL_EPISODE_SCOPE_ID = 'personal:default';

export async function getPersonalEpisodeLookupRoute(
  engine: BrainEngine,
  input: PersonalEpisodeLookupRouteInput,
): Promise<PersonalEpisodeLookupRouteResult> {
  const scopeId = input.scope_id ?? DEFAULT_PERSONAL_EPISODE_SCOPE_ID;
  const matches = await engine.listPersonalEpisodeEntries({
    scope_id: scopeId,
    title: input.title,
    source_kind: input.source_kind,
    limit: 10,
    offset: 0,
  });

  if (matches.length === 0) {
    return {
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }

  if (matches.length > 1) {
    return {
      selection_reason: 'ambiguous_title_match',
      candidate_count: matches.length,
      route: null,
    };
  }

  const [entry] = matches;
  if (!entry) {
    throw new Error('Expected one personal episode entry');
  }

  return {
    selection_reason: 'direct_title_match',
    candidate_count: 1,
    route: buildPersonalEpisodeLookupRoute(entry),
  };
}

function buildPersonalEpisodeLookupRoute(entry: PersonalEpisodeEntry): PersonalEpisodeLookupRoute {
  return {
    route_kind: 'personal_episode_lookup',
    personal_episode_id: entry.id,
    scope_id: entry.scope_id,
    title: entry.title,
    source_kind: entry.source_kind,
    start_time: entry.start_time,
    end_time: entry.end_time,
    summary: entry.summary,
    candidate_ids: entry.candidate_ids,
    retrieval_route: [
      'personal_episode_record',
      'minimal_personal_supporting_reads',
    ],
    summary_lines: [
      `Personal episode lookup is anchored to exact episode title ${entry.title}.`,
      `Episode source kind: ${entry.source_kind}.`,
      `Supporting personal reads kept narrow: ${entry.source_refs.length}.`,
    ],
    source_refs: entry.source_refs,
  };
}

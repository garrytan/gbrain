import type { BrainEngine } from '../engine.ts';
import type {
  PersonalProfileLookupRoute,
  PersonalProfileLookupRouteInput,
  PersonalProfileLookupRouteResult,
  ProfileMemoryEntry,
} from '../types.ts';

export const DEFAULT_PROFILE_MEMORY_SCOPE_ID = 'personal:default';

export async function getPersonalProfileLookupRoute(
  engine: BrainEngine,
  input: PersonalProfileLookupRouteInput,
): Promise<PersonalProfileLookupRouteResult> {
  const scopeId = input.scope_id ?? DEFAULT_PROFILE_MEMORY_SCOPE_ID;
  const matches = await engine.listProfileMemoryEntries({
    scope_id: scopeId,
    subject: input.subject,
    profile_type: input.profile_type,
    limit: 10,
    offset: 0,
  });

  const activeMatches = matches.filter((entry) => entry.superseded_by == null);
  if (activeMatches.length === 0) {
    return {
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }
  if (activeMatches.length > 1) {
    return {
      selection_reason: 'ambiguous_subject_match',
      candidate_count: activeMatches.length,
      route: null,
    };
  }

  const [entry] = activeMatches;
  if (!entry) {
    throw new Error('Expected one active profile memory entry');
  }

  return {
    selection_reason: 'direct_subject_match',
    candidate_count: 1,
    route: buildPersonalProfileLookupRoute(entry),
  };
}

function buildPersonalProfileLookupRoute(entry: ProfileMemoryEntry): PersonalProfileLookupRoute {
  return {
    route_kind: 'personal_profile_lookup',
    profile_memory_id: entry.id,
    scope_id: entry.scope_id,
    profile_type: entry.profile_type,
    subject: entry.subject,
    content: entry.content,
    sensitivity: entry.sensitivity,
    export_status: entry.export_status,
    retrieval_route: [
      'profile_memory_record',
      'minimal_personal_supporting_reads',
    ],
    summary_lines: [
      `Personal profile lookup is anchored to exact profile subject ${entry.subject}.`,
      `Profile type: ${entry.profile_type}.`,
      `Supporting personal reads kept narrow: ${entry.source_refs.length}.`,
    ],
    source_refs: entry.source_refs,
  };
}

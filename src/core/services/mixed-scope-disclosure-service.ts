import type { BrainEngine } from '../engine.ts';
import type {
  BroadSynthesisRouteRead,
  MixedScopeDisclosure,
  MixedScopeDisclosureInput,
  MixedScopeDisclosureResult,
  PersonalEpisodeLookupRoute,
  PersonalProfileLookupRoute,
} from '../types.ts';
import { getMixedScopeBridge } from './mixed-scope-bridge-service.ts';

export async function getMixedScopeDisclosure(
  engine: BrainEngine,
  input: MixedScopeDisclosureInput,
): Promise<MixedScopeDisclosureResult> {
  const result = await getMixedScopeBridge(engine, input);
  if (!result.route) {
    return {
      selection_reason: result.selection_reason,
      candidate_count: result.candidate_count,
      scope_gate: result.scope_gate,
      disclosure: null,
    };
  }

  return {
    selection_reason: result.selection_reason,
    candidate_count: result.candidate_count,
    scope_gate: result.scope_gate,
    disclosure: buildDisclosure(
      result.route.work_route.summary_lines,
      result.route.work_route.recommended_reads,
      result.route.personal_route_kind,
      result.route.personal_route,
    ),
  };
}

function buildDisclosure(
  workSummaryLines: string[],
  recommendedReads: BroadSynthesisRouteRead[],
  personalRouteKind: 'profile' | 'episode',
  personalRoute: PersonalProfileLookupRoute | PersonalEpisodeLookupRoute,
): MixedScopeDisclosure {
  if (personalRouteKind === 'profile' && personalRoute.route_kind === 'personal_profile_lookup') {
    if (personalRoute.sensitivity === 'secret') {
      return {
        disclosure_kind: 'mixed_scope_bridge',
        personal_route_kind: 'profile',
        personal_visibility: 'profile_withheld',
        work_summary_lines: workSummaryLines,
        personal_summary_lines: [
          `Personal profile matched: ${personalRoute.subject} (${personalRoute.profile_type}).`,
          'Personal profile content withheld by visibility policy.',
        ],
        recommended_reads: recommendedReads,
      };
    }

    if (personalRoute.export_status === 'exportable') {
      return {
        disclosure_kind: 'mixed_scope_bridge',
        personal_route_kind: 'profile',
        personal_visibility: 'profile_content_disclosed',
        work_summary_lines: workSummaryLines,
        personal_summary_lines: [
          `Personal profile matched: ${personalRoute.subject} (${personalRoute.profile_type}).`,
          `Personal profile content: ${personalRoute.content}`,
        ],
        recommended_reads: recommendedReads,
      };
    }

    return {
      disclosure_kind: 'mixed_scope_bridge',
      personal_route_kind: 'profile',
      personal_visibility: 'profile_metadata_only',
      work_summary_lines: workSummaryLines,
      personal_summary_lines: [
        `Personal profile matched: ${personalRoute.subject} (${personalRoute.profile_type}).`,
        'Personal profile content withheld because the record is private-only.',
      ],
      recommended_reads: recommendedReads,
    };
  }

  const episodeRoute = personalRoute as PersonalEpisodeLookupRoute;
  return {
    disclosure_kind: 'mixed_scope_bridge',
    personal_route_kind: 'episode',
    personal_visibility: 'episode_metadata_only',
    work_summary_lines: workSummaryLines,
    personal_summary_lines: [
      `Personal episode matched: ${episodeRoute.title} (${episodeRoute.source_kind}).`,
      'Personal episode summary withheld in mixed-scope disclosure.',
    ],
    recommended_reads: recommendedReads,
  };
}

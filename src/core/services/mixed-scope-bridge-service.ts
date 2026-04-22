import type { BrainEngine } from '../engine.ts';
import type {
  MixedScopeBridgeInput,
  MixedScopeBridgeResult,
  PersonalEpisodeLookupRoute,
  PersonalProfileLookupRoute,
  ScopeGateDecisionResult,
} from '../types.ts';
import { getBroadSynthesisRoute } from './broad-synthesis-route-service.ts';
import { getPersonalEpisodeLookupRoute } from './personal-episode-lookup-route-service.ts';
import { getPersonalProfileLookupRoute } from './personal-profile-lookup-route-service.ts';
import { evaluateScopeGate } from './scope-gate-service.ts';

export async function getMixedScopeBridge(
  engine: BrainEngine,
  input: MixedScopeBridgeInput,
): Promise<MixedScopeBridgeResult> {
  const scopeGate = await evaluateScopeGate(engine, {
    intent: 'mixed_scope_bridge',
    requested_scope: input.requested_scope,
    query: input.query,
    subject: input.subject,
  } as any);

  if (scopeGate.policy !== 'allow') {
    return buildResult(scopeGate.decision_reason, 0, scopeGate, null);
  }

  const workResult = await getBroadSynthesisRoute(engine, {
    map_id: input.map_id,
    scope_id: input.scope_id,
    kind: input.kind,
    query: input.query,
    limit: input.limit,
  });
  const personalResult = await resolvePersonalRoute(engine, input);

  const candidateCount = Number(workResult.route !== null) + Number(personalResult.route !== null);

  if (!workResult.route) {
    return buildResult('work_route_no_match', candidateCount, scopeGate, null);
  }
  if (!personalResult.route) {
    return buildResult(
      personalResult.selection_reason === 'ambiguous_subject_match'
      || personalResult.selection_reason === 'ambiguous_title_match'
        ? 'personal_route_ambiguous'
        : 'personal_route_no_match',
      candidateCount,
      scopeGate,
      null,
    );
  }

  return buildResult('direct_mixed_scope_bridge', 2, scopeGate, {
    route_kind: 'mixed_scope_bridge',
    bridge_reason: 'explicit_mixed_scope',
    personal_route_kind: input.personal_route_kind,
    work_route: workResult.route,
    personal_route: personalResult.route,
    retrieval_route: [
      'mixed_scope_gate',
      'work_broad_synthesis',
      input.personal_route_kind === 'profile'
        ? 'personal_profile_lookup'
        : 'personal_episode_lookup',
      'bounded_cross_scope_bridge',
    ],
    summary_lines: [
      'Mixed bridge pairs one work route with one personal route.',
      `Work route status: ${workResult.route.status}.`,
      input.personal_route_kind === 'profile'
        ? `Personal route subject: ${(personalResult.route as PersonalProfileLookupRoute).subject}.`
        : `Personal route episode: ${(personalResult.route as PersonalEpisodeLookupRoute).title}.`,
    ],
  });
}

async function resolvePersonalRoute(
  engine: BrainEngine,
  input: MixedScopeBridgeInput,
): Promise<{
  selection_reason: string;
  route: PersonalProfileLookupRoute | PersonalEpisodeLookupRoute | null;
}> {
  if (input.personal_route_kind === 'profile') {
    const result = await getPersonalProfileLookupRoute(engine, {
      subject: input.subject ?? '',
      profile_type: input.profile_type,
    });

    return {
      selection_reason: result.selection_reason,
      route: result.route,
    };
  }

  const result = await getPersonalEpisodeLookupRoute(engine, {
    title: input.episode_title ?? '',
    source_kind: input.episode_source_kind,
  });

  return {
    selection_reason: result.selection_reason,
    route: result.route,
  };
}

function buildResult(
  selectionReason: string,
  candidateCount: number,
  scopeGate: ScopeGateDecisionResult,
  route: MixedScopeBridgeResult['route'],
): MixedScopeBridgeResult {
  return {
    selection_reason: selectionReason,
    candidate_count: candidateCount,
    route,
    scope_gate: scopeGate,
  };
}

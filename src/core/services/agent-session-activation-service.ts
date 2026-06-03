import type {
  AgentSessionMemoryRouteResult,
  MemoryActivationArtifact,
} from '../types.ts';

export function buildAgentSessionActivationArtifacts(
  routeResults: AgentSessionMemoryRouteResult[],
): MemoryActivationArtifact[] {
  return routeResults.flatMap((result) => {
    if (result.direct_write?.kind === 'profile_memory') {
      const id = normalizeDirectWriteId('profile-memory', result.direct_write.id);
      return [{
        id,
        artifact_kind: 'profile_memory',
        source_ref: id,
        scope_policy: 'allow',
      }];
    }

    if (result.direct_write?.kind === 'personal_episode') {
      const id = normalizeDirectWriteId('personal-episode', result.direct_write.id);
      return [{
        id,
        artifact_kind: 'personal_episode',
        source_ref: id,
        scope_policy: 'allow',
      }];
    }

    const candidateInput = result.route?.candidate_input;
    if (!candidateInput) return [];

    const sourceRef = candidateInput.source_refs[0] ?? result.signal.source_refs[0];
    const artifact: MemoryActivationArtifact = {
      id: candidateInput.id
        ? `memory-candidate:${candidateInput.id}`
        : `memory-candidate-preview:${result.signal.id}`,
      artifact_kind: 'memory_candidate',
      ...(sourceRef ? { source_ref: sourceRef } : {}),
      ...(result.signal.scope_id.startsWith('personal:') ? { scope_policy: 'allow' } : {}),
    };

    return [artifact];
  });
}

function normalizeDirectWriteId(prefix: 'profile-memory' | 'personal-episode', id: string): string {
  const prefixWithSeparator = `${prefix}:`;
  return id.startsWith(prefixWithSeparator) ? id : `${prefixWithSeparator}${id}`;
}

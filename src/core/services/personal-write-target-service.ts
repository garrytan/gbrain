import type { BrainEngine } from '../engine.ts';
import type {
  PersonalWriteTargetInput,
  PersonalWriteTargetKind,
  PersonalWriteTargetResult,
  RetrievalRouteIntent,
} from '../types.ts';
import { evaluateScopeGate } from './scope-gate-service.ts';

export const DEFAULT_PERSONAL_WRITE_SCOPE_ID = 'personal:default';

export async function selectPersonalWriteTarget(
  engine: BrainEngine,
  input: PersonalWriteTargetInput,
): Promise<PersonalWriteTargetResult> {
  const scopeGate = await evaluateScopeGate(engine, {
    intent: mapTargetKindToScopeIntent(input.target_kind),
    requested_scope: input.requested_scope,
    query: input.query,
    subject: input.subject,
    title: input.title,
  });

  if (scopeGate.policy !== 'allow') {
    return {
      selection_reason: scopeGate.decision_reason,
      candidate_count: 0,
      route: null,
      scope_gate: scopeGate,
    };
  }

  return {
    selection_reason: 'direct_personal_write_target',
    candidate_count: 1,
    route: {
      route_kind: 'personal_write_target',
      target_kind: input.target_kind,
      scope_id: DEFAULT_PERSONAL_WRITE_SCOPE_ID,
      write_path: buildWritePath(input.target_kind),
      summary_lines: buildSummaryLines(input.target_kind),
    },
    scope_gate: scopeGate,
  };
}

function mapTargetKindToScopeIntent(targetKind: PersonalWriteTargetKind): RetrievalRouteIntent {
  return targetKind === 'profile_memory'
    ? 'personal_profile_lookup'
    : 'personal_episode_lookup';
}

function buildWritePath(targetKind: PersonalWriteTargetKind): string[] {
  return targetKind === 'profile_memory'
    ? ['scope_gate', 'profile_memory_record']
    : ['scope_gate', 'personal_episode_record'];
}

function buildSummaryLines(targetKind: PersonalWriteTargetKind): string[] {
  return targetKind === 'profile_memory'
    ? [
      'Personal write target resolved to canonical Profile Memory.',
      'Write path remains gated by explicit personal-scope approval.',
    ]
    : [
      'Personal write target resolved to canonical Personal Episode history.',
      'Write path remains gated by explicit personal-scope approval.',
    ];
}

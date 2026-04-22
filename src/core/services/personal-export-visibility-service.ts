import type { BrainEngine } from '../engine.ts';
import type {
  PersonalEpisodeEntry,
  ProfileMemoryEntry,
  ScopeGateDecisionResult,
  ScopeGateScope,
} from '../types.ts';
import { evaluateScopeGate } from './scope-gate-service.ts';

export interface PersonalExportPreviewInput {
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
  query?: string;
}

export interface PersonalExportPreviewResult {
  selection_reason: string;
  scope_gate: ScopeGateDecisionResult;
  profile_memory_entries: ProfileMemoryEntry[];
  personal_episode_entries: PersonalEpisodeEntry[];
}

export async function previewPersonalExport(
  engine: BrainEngine,
  input: PersonalExportPreviewInput,
): Promise<PersonalExportPreviewResult> {
  const scopeGate = await evaluateScopeGate(engine, {
    intent: 'personal_profile_lookup',
    requested_scope: input.requested_scope,
    query: input.query,
  });

  if (scopeGate.policy !== 'allow') {
    return {
      selection_reason: scopeGate.decision_reason,
      scope_gate: scopeGate,
      profile_memory_entries: [],
      personal_episode_entries: [],
    };
  }

  const entries = await engine.listProfileMemoryEntries({
    scope_id: 'personal:default',
    limit: 1000,
    offset: 0,
  });

  return {
    selection_reason: 'direct_personal_export_preview',
    scope_gate: scopeGate,
    profile_memory_entries: entries.filter((entry) => entry.export_status === 'exportable' && entry.superseded_by == null),
    personal_episode_entries: [],
  };
}

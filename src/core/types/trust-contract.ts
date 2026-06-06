import type {
  MemoryActivationArtifact,
  MemoryActivationDecision,
  MemoryActivationLabel,
  MemoryArtifactAuthority,
  MemoryArtifactKind,
} from './retrieval-routing.ts';

export type TrustContractActivation = MemoryActivationDecision;

export type TrustContractArtifactKind =
  | MemoryArtifactKind
  | 'assertion_surface'
  | 'graph_path';

export type TrustFreshnessLabel =
  | 'current'
  | 'stale'
  | 'unknown'
  | 'not_applicable';

export type TrustRevalidationInstruction =
  | 'none'
  | 'read_canonical'
  | 'reverify_code'
  | 'evaluate_scope_gate'
  | 'promote_candidate'
  | 'review_candidate';

export type TrustAssertionLifecycle =
  | 'active'
  | 'stale'
  | 'expired'
  | 'archived'
  | 'rejected'
  | 'conflicted'
  | 'purged';

export type TrustAssertionAuthority =
  | 'canonical'
  | 'derived'
  | 'candidate'
  | 'scope_denied';

export interface TrustAssertionSurfaceInput {
  scope_matches?: boolean;
  lifecycle?: TrustAssertionLifecycle;
  authority?: TrustAssertionAuthority;
  code_claim?: boolean;
}

export interface TrustContractInput
  extends Omit<MemoryActivationArtifact, 'artifact_kind'> {
  artifact_kind: TrustContractArtifactKind;
  assertion?: TrustAssertionSurfaceInput;
}

export interface TrustContractDecision {
  artifact_id: string;
  activation: TrustContractActivation;
  activation_label: MemoryActivationLabel;
  authority: MemoryArtifactAuthority;
  freshness: TrustFreshnessLabel;
  revalidation: TrustRevalidationInstruction;
  reason_codes: string[];
  policy_version: string;
  policy_version_hash: string;
  source_ref: string | null;
}

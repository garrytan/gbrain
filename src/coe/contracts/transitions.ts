import { CoeContractError } from "./errors.ts";

export const CLAIM_STATUSES = [
  "draft",
  "quarantined",
  "verified",
  "partially_supported",
  "contradicted",
  "rejected",
  "superseded",
  "retracted",
  "needs_review",
] as const;

export const ARTIFACT_STATUSES = ["active", "quarantined", "superseded", "retracted"] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];
export type TransitionDomain = "claim" | "snapshot" | "evidence";

const claimTransitions = {
  draft: ["quarantined", "needs_review", "rejected"],
  quarantined: ["draft", "needs_review", "rejected"],
  needs_review: ["verified", "partially_supported", "contradicted", "rejected", "quarantined"],
  verified: ["partially_supported", "contradicted", "needs_review", "superseded", "retracted"],
  partially_supported: ["verified", "contradicted", "needs_review", "rejected", "superseded", "retracted"],
  contradicted: ["verified", "partially_supported", "needs_review", "rejected", "superseded", "retracted"],
  rejected: [],
  superseded: ["retracted"],
  retracted: [],
} satisfies Record<ClaimStatus, readonly ClaimStatus[]>;

const artifactTransitions = {
  active: ["quarantined", "superseded", "retracted"],
  quarantined: ["active", "retracted"],
  superseded: ["retracted"],
  retracted: [],
} satisfies Record<ArtifactStatus, readonly ArtifactStatus[]>;

export const COE_TRANSITIONS = {
  claim: claimTransitions,
  snapshot: artifactTransitions,
  evidence: artifactTransitions,
} as const;

export function canTransition(domain: TransitionDomain, from: string, to: string): boolean {
  const transitions = COE_TRANSITIONS[domain] as Record<string, readonly string[]>;
  return transitions[from]?.includes(to) ?? false;
}

export function assertTransition(domain: TransitionDomain, from: string, to: string): void {
  if (!canTransition(domain, from, to)) {
    throw new CoeContractError(
      "invalid_transition",
      `Transition ${domain}:${from}->${to} is not allowed`,
    );
  }
}

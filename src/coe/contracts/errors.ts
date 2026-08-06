export const COE_ERROR_CODES = [
  "invalid_json",
  "unsupported_schema_version",
  "unknown_field",
  "invalid_contract",
  "invalid_transition",
  "scope_widening",
  "hash_mismatch",
  "id_mismatch",
  "policy_violation",
  "release_blocked",
] as const;

export type CoeErrorCode = (typeof COE_ERROR_CODES)[number];

export interface CoeContractIssue {
  path: string;
  message: string;
}

export class CoeContractError extends Error {
  constructor(
    readonly code: CoeErrorCode,
    message: string,
    readonly issues: readonly CoeContractIssue[] = [],
  ) {
    super(message);
    this.name = "CoeContractError";
  }
}

export interface AutoPromoteVerdictKey {
  candidate_id: string;
  content_hash: string;
  runner_kind: string;
  prompt_version: string;
}

export interface AutoPromoteVerdictRow extends AutoPromoteVerdictKey {
  decision: string;
  confidence: number;
  reasoning: string;
  judged_at: string;
}

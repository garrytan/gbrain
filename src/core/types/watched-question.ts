import type { ScopeGateScope } from './retrieval-routing.ts';

export interface WatchedQuestionReadSnapshot {
  selector_id?: string;
  slug: string;
  content_hash: string;
  line_start?: number;
  line_end?: number;
}

export interface WatchedQuestion {
  id: string;
  scope_id: string;
  question: string;
  requested_scope: ScopeGateScope | null;
  enabled: boolean;
  latest_fingerprint: string | null;
  latest_required_reads: WatchedQuestionReadSnapshot[];
  latest_probe_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WatchedQuestionInput {
  id?: string;
  scope_id: string;
  question: string;
  requested_scope?: ScopeGateScope | null;
  enabled?: boolean;
  now?: Date | string | null;
}

export interface WatchedQuestionFilters {
  scope_id?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export interface WatchedQuestionSnapshotPatch {
  latest_fingerprint: string;
  latest_required_reads: WatchedQuestionReadSnapshot[];
  latest_probe_at: Date | string;
  updated_at?: Date | string | null;
}

export interface WatchedQuestionRun {
  id: string;
  question_id: string;
  scope_id: string;
  question: string;
  changed: boolean;
  previous_fingerprint: string | null;
  current_fingerprint: string;
  previous_required_reads: WatchedQuestionReadSnapshot[];
  current_required_reads: WatchedQuestionReadSnapshot[];
  created_at: Date;
}

export interface WatchedQuestionRunInput {
  id?: string;
  question_id: string;
  scope_id: string;
  question: string;
  changed: boolean;
  previous_fingerprint?: string | null;
  current_fingerprint: string;
  previous_required_reads?: WatchedQuestionReadSnapshot[];
  current_required_reads?: WatchedQuestionReadSnapshot[];
  created_at?: Date | string | null;
}

export interface WatchedQuestionRunFilters {
  scope_id?: string;
  question_id?: string;
  changed?: boolean;
  since?: Date | string;
  until?: Date | string;
  limit?: number;
  offset?: number;
}

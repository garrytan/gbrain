/**
 * The shapes `restoreCensus` and `restoreQuarantine` pass across the addon (rust/crates/gbrain-store/src/restore.rs).
 * `engine_format_version` is the store's record format (`FORMAT`); the archive container's own `format_version` is a
 * different number and never appears here.
 */

/** A reason a restore cannot publish; `restore_step_unsupported` carries it as `reason`. */
export type RestoreBlockerReason = 'pending_requests' | 'recovery_required' | 'purge_replay' | 'unclassified_state';

export interface RestoreStoreIdentity {
  engine_format_version: number;
  schema_version: number;
  brain_id: string;
  /** The commit sequence the census read. */
  generation: number;
}

export interface RestoreAuthority {
  local_writers: string[];
  oauth_clients: string[];
}

export interface RestoreCensus {
  store: RestoreStoreIdentity;
  /** Unfinished write requests by state. */
  requests: Record<string, number>;
  claims: number;
  effects_live: number;
  recovery_records: number;
  jobs_live: number;
  /** Authority the archive holds that a restore revokes. */
  authority: RestoreAuthority;
  /** Every source, archived ones included. */
  sources: Array<{ id: string; archived: boolean; local_path: string | null; kind: string | null; remote_url: string | null }>;
  /** The config rows a restore may change, with their archived values. */
  settings: Array<{ key: string; value: string }>;
  purges_present: string[];
  purges_missing: string[];
  /** Records of a kind this build's restore has not classified (for example `jobs 0x2b`). */
  unclassified: string[];
  blockers: Array<{ reason: RestoreBlockerReason; count: number; /** What `unclassified_state` found, by name when known (for example `access tokens (jobs 0x2b)`). */ detail?: string }>;
}

export interface RestoreQuarantinePlan {
  restore_id: string;
  /** Every source of the store: `local_path` as archived, `rebased_path` for a managed source. */
  sources: Array<{ id: string; local_path: string | null; rebased_path: string | null }>;
  /** `value: null` deletes the row. */
  settings: Array<{ key: string; value: string | null }>;
}

export interface RestoreQuarantineReport {
  detached_sources: string[];
  rebased_sources: string[];
  rebased_origins: number;
  changed_settings: string[];
  jobs_cancelled: number;
  /** Exactly what was revoked. */
  revoked: RestoreAuthority;
  reconnect: string[];
  /** The config row that keeps what was replaced. */
  inventory_key: string;
}

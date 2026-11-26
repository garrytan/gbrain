
import type { AudiencePrincipalRows, FolderAccessRows, LiveMemberRow, MayActForVia, MemberBindingVia } from '../engine-sql/access-control.ts';
import type { ScopeSourceLock } from '../engine-sql/access-credentials.ts';
import type * as BeliefStateSql from '../engine-sql/belief-state.ts';

export interface LedgerMembers {
  /** The post-commit mark of each publication with a committed event: one observation time, never below its newest event, never replaced. */
  markBeliefCommits(publicationIds: readonly string[]): Promise<void>;
  /** The raw state of belief streams in one read (belief/state.ts shapes it): pages, write counters, facts, takes, owned links and transitions, their endpoints and the writer tier. Restores `plan_cache_mode` to `input.planModePrev` (null: no net change). */
  readBeliefStateRows(input: BeliefStateSql.BeliefStateRowsInput): Promise<BeliefStateSql.BeliefStateRows>;

  /**
   * The live (enabled, not tombstoned) access member `key` names through `via` (the member id, the config key's value,
   * a live legacy token or a live OAuth client), with its groups; null when there is none. A failed read throws
   * unchanged (access/caller.ts tells a schema older than the member tables from a transient failure).
   */
  readLiveMember(via: MemberBindingVia, key: string): Promise<LiveMemberRow | null>;

  /**
   * The applied folder rules any of `readers` meets (none read when `readers` is empty) and every folder prefix that
   * reads as nobody, `!unreadable` included when this database role cannot read the folder access tables. Runs through
   * this engine's executeRaw; a failure throws (access/caller.ts folderAccessForAll counts it as fail closed).
   */
  readFolderAccess(readers: readonly string[]): Promise<FolderAccessRows>;

  /**
   * The stored may_act_for of one caller (`via` names where it is stored; `key` is the token id, the client id or the
   * config key): a live token's or client's list, null when the row is revoked, deleted or absent; the stdio config text as stored.
   */
  readMayActFor(via: MayActForVia, key: string): Promise<string[] | string | null>;

  /** Which of `memberIds` are enabled members (with their groups) and which of `groupIds` exist; an empty list reads nothing. */
  readAudiencePrincipals(memberIds: readonly string[], groupIds: readonly string[]): Promise<AudiencePrincipalRows>;
  /** The id and config of each source among `ids`; `lock` takes the rows in id order FOR SHARE or FOR UPDATE (a single-writer store takes none). */
  readScopeSourceConfigs(ids: readonly string[], lock?: ScopeSourceLock): Promise<{ id: string; config: unknown }[]>;
}

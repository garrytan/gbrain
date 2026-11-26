
import type { AccessMemberLookup, AccessMemberRow, AudiencePrincipalRows, FolderAccessRows, LiveMemberRow, MayActForVia, MemberBindingVia } from '../engine-sql/access-control.ts';
import type { ScopeSourceLock } from '../engine-sql/access-credentials.ts';
import type * as BeliefLedgerSql from '../engine-sql/belief-ledger.ts';
import type * as BeliefStateSql from '../engine-sql/belief-state.ts';

export interface LedgerMembers {
  /** Inserts the event rows in `ord` order, skipping an event key already recorded; returns how many were inserted. */
  insertBeliefEvents(rows: readonly BeliefLedgerSql.BeliefEventInsertRow[]): Promise<number>;
  /** The post-commit mark of each publication with a committed event: one observation time, never below its newest event, never replaced. */
  markBeliefCommits(publicationIds: readonly string[]): Promise<void>;
  /** The open page lifetime at each (incarnation, slug) pair that has one. No set order. */
  readOpenBeliefLifetimes(pairs: readonly { incarnation: string; slug: string }[]): Promise<BeliefLedgerSql.BeliefLifetimeRow[]>;
  /** Ends the page lifetime if it is still open. */
  endBeliefLifetime(lifetime: string): Promise<void>;
  /** The raw state of belief streams in one read (belief/state.ts shapes it): pages, write counters, facts, takes, owned links and transitions, their endpoints and the writer tier. Restores `plan_cache_mode` to `input.planModePrev` (null: no net change). */
  readBeliefStateRows(input: BeliefStateSql.BeliefStateRowsInput): Promise<BeliefStateSql.BeliefStateRows>;
  /** Fact rows by id in the state read's columns, for a guard event whose row is outside the batch's streams. No set order. */
  readBeliefFactsById(ids: readonly number[]): Promise<Array<Record<string, unknown>>>;
  // The belief side of a purge (engine-sql/belief-purge.ts). Each runs the statement belief/purge.ts or purge-mirror.ts ran through executeRaw.
  /** Raises the source's purge epoch by one; the new epoch, or null for an unknown source. Write; run it in the purge transaction. */
  bumpSourcePurgeEpoch(sourceId: string): Promise<number | null>;
  /** Whether the source has any belief event, of any incarnation. */
  hasBeliefEvents(sourceId: string): Promise<boolean>;

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

  /** Access member rows with their groups: one by exact id or by declared email (any status), or all by id, removed ones only when asked. */
  readAccessMembers(by: AccessMemberLookup): Promise<AccessMemberRow[]>;
  /** The id and config of each source among `ids`; `lock` takes the rows in id order FOR SHARE or FOR UPDATE (a single-writer store takes none). */
  readScopeSourceConfigs(ids: readonly string[], lock?: ScopeSourceLock): Promise<{ id: string; config: unknown }[]>;
}


import type { DurablePersistenceSettings } from '../engine-sql/persistence-declaration.ts';
import type * as FactsPurgePlanSql from '../engine-sql/facts-purge-plan.ts';
import type * as FactsPurgeSql from '../engine-sql/facts-purge.ts';
import type * as FactsRecallSql from '../engine-sql/facts-recall.ts';
import type * as FactsTrustSql from '../engine-sql/facts-trust.ts';

export interface FactsStatementMembers {
  loadPurgeTarget(id: number, sourceId: string): Promise<FactsPurgeSql.PurgeTargetRow | null>;
  /** Stores a fact purge tombstone; false when the same (source, visibility, subject, fingerprint) one exists. */
  insertFactPurge(row: FactsPurgeSql.FactPurgeInsert): Promise<boolean>;
  /** The one writer of take purge tombstones: stores one for `claimHash`, or one per distinct take claim of the page for `pageId`, under the subject; false when none was new (each exists, or the page has no takes). Write; run it in the purge transaction. */
  /** Stores a take purge tombstone; false when the same (source, subject, fingerprint) one exists. */
  insertTakePurge(row: FactsPurgeSql.TakePurgeInsert): Promise<boolean>;
  /** Records a page purge's content-hash tombstones under the slug; a hash already tombstoned takes the new slug, request and time. Write; run it in the purge transaction. */
  upsertPagePurges(row: FactsPurgeSql.PagePurgeUpsert): Promise<void>;
  /** Bounds the statements of the transaction it runs in to `ms` milliseconds (set_config, local). */
  setPurgeProbeTimeout(ms: number): Promise<void>;
  /** One batch of stored derivation results after the cursor (page, pipeline, occurrence): the rows scanned, the claim candidates, those a sweep covers and holds the claim, and those it does not, and the last key. Reads page_segment_derivations and pages. */
  probePurgeDerivations(sourceId: string, needles: string[], pageIds: number[], patterns: string[], cursor: FactsPurgeSql.DerivationKey | null, rows: number): Promise<FactsPurgeSql.PurgeDerivationProbeRow>;
  /** How many tombstones the page purge left for the slug. Reads page_purges. */
  countPagePurgeTombstones(sourceId: string, slug: string): Promise<number>;
  /** The request's effects in kind order, each with whether any target is parked. Reads persistence_effects. */
  listPurgeEffects(requestId: string): Promise<Array<{ kind: string; state: string; error_code: string | null; parked: boolean }>>;
  /** Deletes the source's review queue rows naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_queue; run it in the purge transaction. */
  deletePurgeReviewQueue(sourceId: string, refs: string[]): Promise<number>;
  /** Deletes the source's review proposals naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_proposals; run it in the purge transaction. */
  deletePurgeReviewProposals(sourceId: string, refs: string[]): Promise<number>;
  /** Deletes the source's decide proposals that supersede or are superseded by one of the facts; how many. Writes decide_proposals; run it in the purge transaction. */
  deletePurgeDecideProposals(sourceId: string, factIds: number[]): Promise<number>;
  /** The rows a purge verification probe finds, at most `rows + 1`. */
  countPurgeProbe(probe: FactsPurgePlanSql.PurgeProbe, rows: number): Promise<number>;
  /** The first 20 rows a named purge probe lists (link, timeline and raw data rows still carrying the claim). */
  listPurgeProbeItems(probe: FactsPurgePlanSql.PurgeProbe & { kind: 'named' }): Promise<string[]>;
  /** The stored provenance (`facts.source`) of these facts of the source. */
  listFactProvenance(sourceId: string, ids: number[]): Promise<Array<{ id: number | string; source: string | null }>>;
  /** Every active conversation slot row of the given slots under the pool read policy, by valid_from, id. */
  listSlotRows(scope: FactsTrustSql.FactPoolScope, slots: ReadonlyArray<{ source_id: string; entity_slug: string; dimension: string }>): Promise<FactsRecallSql.SlotFactRow[]>;

  /**
   * Declares persistence protocol 2 for the current transaction (`gbrain.persistence_protocol`), with the durable-write
   * settings when given, and returns the brain's persistence id read under the brain row's share lock (null when the
   * row is missing). Outside a transaction the declaration ends with its statement. engine-sql/persistence-declaration.ts.
   */
  declarePersistence(opts?: { durable?: DurablePersistenceSettings }): Promise<string | null>;
  /** Synchronous commit for the rest of the current transaction (engine-sql/persistence-declaration.ts); nothing outside one. */
  requireSynchronousCommit(): Promise<void>;
}

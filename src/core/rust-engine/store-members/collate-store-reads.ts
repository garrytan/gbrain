/**
 * The decision, OAuth, feedback, question and credential reads of engine-sql/collate-store-reads.ts, served by the store
 * (rust/docs/store). Every listing answers in byte order, as the SQL's `COLLATE "C"` does.
 *
 * The members are added by the slices that move those callers; this file is the place they live.
 */
/** The row types the members answer with live beside their SQL, so a store member and its SQL engine twin share one shape. */
export type * from '../../engine-sql/collate-store-reads.ts';

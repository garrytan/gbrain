/**
 * The store work of writer activation and deactivation (`gbrain sources writer activate|deactivate`) and of the
 * pre-activation claim release (persistence/activation.ts, deactivation.ts, pre-activation-release.ts), plus the
 * counter charges of a topology receipt (persistence/topology-receipts.ts).
 *
 * - `writerReleaseStore` (BrainEngine) returns narrow reads and writes with the row shapes those files decide on, so
 *   the blocker texts, the checks and the error texts stay in the persistence files and a Rust brain hands them the
 *   same store over its own records (src/core/rust-engine/store-members/writer-release.ts). Called on a transaction
 *   engine, every call runs in that transaction; called on the engine, each call is its own statement.
 * - `auditPages` is the page read of the activation preview's drift audit (persistence/reconcile-audit.ts).
 * - `addPersistenceCounters` adds non-negative or negative amounts to one counter row's columns; the CHECK (>= 0)
 *   constraints refuse a charge that would go below zero.
 *
 * Source ids sort by the server's collation here, as the SQL they replace did.
 */
import type { BrainEngine } from '../engine.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

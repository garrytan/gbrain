/**
 * Wave B PR 4 lane 4a (spec 11): a fact purge leaves no page_segment_derivations row holding the claim; this file runs
 * sweep batches, cursors, writes behind and beside the sweep, deadlines and batch halving on PGLite. The PostgreSQL
 * arm is test/e2e/derivation-purge-batching-postgres.test.ts; cases in test/helpers/derivation-purge-cases.ts.
 */
import { registerDerivationPurgeBatchingCases } from '../helpers/derivation-purge-cases.ts';

registerDerivationPurgeBatchingCases('pglite');

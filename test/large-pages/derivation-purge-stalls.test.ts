/**
 * Wave B PR 4 lane 4a (spec 11): a fact purge leaves no page_segment_derivations row holding the claim; this file runs
 * stalls, paid work, the early pending return, receipt probes and the doctor check on PGLite. The PostgreSQL arm is
 * test/e2e/derivation-purge-stalls-postgres.test.ts; cases in test/helpers/derivation-purge-cases.ts.
 */
import { registerDerivationPurgeStallsCases } from '../helpers/derivation-purge-cases.ts';

registerDerivationPurgeStallsCases('pglite');

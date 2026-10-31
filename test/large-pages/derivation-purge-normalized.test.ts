/**
 * Wave B PR 4 lane 4a (spec 11): a fact purge leaves no page_segment_derivations row holding the claim; this file runs
 * a retired row stating the claim in a normalized form (Greek final sigma, Turkish dotted I, case and spacing) on
 * PGLite. The PostgreSQL arm is test/e2e/derivation-purge-normalized-postgres.test.ts; cases in
 * test/helpers/derivation-purge-cases.ts.
 */
import { registerDerivationPurgeNormalizedCases } from '../helpers/derivation-purge-cases.ts';

registerDerivationPurgeNormalizedCases('pglite');

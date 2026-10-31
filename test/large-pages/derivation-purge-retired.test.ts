/**
 * Wave B PR 4 lane 4a (spec 11): a fact purge leaves no page_segment_derivations row holding the claim; this file runs
 * retired rows, racing derivations, demotion, scope matching and the typed timeout of the sweep's recording on PGLite.
 * The PostgreSQL arm is test/e2e/derivation-purge-retired-postgres.test.ts; cases in
 * test/helpers/derivation-purge-cases.ts.
 */
import { registerDerivationPurgeRetiredCases } from '../helpers/derivation-purge-cases.ts';

registerDerivationPurgeRetiredCases('pglite');

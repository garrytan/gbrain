/**
 * Wave B PR 4 lane 4a (spec 11): a fact purge leaves no page_segment_derivations row holding the claim; this file runs
 * rows entering the sweep's scope while it walks, open writers, and the scope lock (scope_lock_busy) on PGLite. The
 * PostgreSQL arm is test/e2e/derivation-purge-scope-postgres.test.ts; cases in test/helpers/derivation-purge-cases.ts.
 */
import { registerDerivationPurgeScopeCases } from '../helpers/derivation-purge-cases.ts';

registerDerivationPurgeScopeCases('pglite');

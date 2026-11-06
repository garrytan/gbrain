/**
 * GBRA-248 W1, gate condition 1: a PGLite brain and keyless config from the
 * previous release upgrade under this build with no behavior change, for the
 * repo, content-directory and no-root shapes
 * (test/helpers/upgrade-from-previous-release.ts; the Postgres half is
 * test/e2e/upgrade-from-previous-release.test.ts).
 */
import { upgradeFromPreviousReleaseSuite } from './helpers/upgrade-from-previous-release.ts';

upgradeFromPreviousReleaseSuite('pglite');

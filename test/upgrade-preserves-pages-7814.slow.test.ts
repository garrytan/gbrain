/**
 * #7814 on PGLite (the Postgres run is test/e2e/upgrade-preserves-pages-7814-postgres.test.ts).
 *
 * Protects: upgrading a brain created by v0.59.2.0 (pages, no fresh-install
 * ledger stamps) through the real `gbrain apply-migrations` runner changes no
 * page, repo-less and repo. Fails when any historical orchestrator rewrites
 * page content or frontmatter on upgrade, as v0.13.1's `validate: false`
 * grandfather did. Contract: test/helpers/upgrade-preserves-pages-contract.ts.
 */
import { expect, test } from 'bun:test';
import { runUpgradePreservesPages } from './helpers/upgrade-preserves-pages-contract.ts';

for (const shape of ['repo-less', 'repo'] as const) {
  test(`pglite ${shape}: upgrading a v0.59.2.0-shaped brain changes no page content_hash`, async () => {
    await runUpgradePreservesPages(undefined, shape, expect);
  }, 900_000);
}

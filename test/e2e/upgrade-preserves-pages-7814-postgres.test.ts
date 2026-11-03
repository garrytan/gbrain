/**
 * #7814 on Postgres; the PGLite run is test/upgrade-preserves-pages-7814.slow.test.ts.
 * See test/helpers/upgrade-preserves-pages-contract.ts for what it protects.
 */
import { expect, test } from 'bun:test';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { runUpgradePreservesPages } from '../helpers/upgrade-preserves-pages-contract.ts';

for (const shape of ['repo-less', 'repo'] as const) {
  test(`postgres ${shape}: upgrading a v0.59.2.0-shaped brain changes no page content_hash`, async () => {
    await runUpgradePreservesPages(requirePostgresTestDatabase(), shape, expect);
  }, 900_000);
}

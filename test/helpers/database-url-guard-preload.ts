/**
 * Invocation-level guard: refuse to start a test run while a database URL is
 * ambient in the environment, unless the invoker explicitly opted in.
 *
 * Why this exists (#3485): `gbrain init` writes DATABASE_URL into
 * ~/.gbrain/.env pointing at the developer's real brain. Several test files
 * connect to whatever DATABASE_URL names and run TRUNCATE/DELETE/DROP — a
 * bare `bun test` with that env sourced has destroyed a real brain before.
 * The per-file name floor (test/helpers/db-guard.ts) is the second layer;
 * this preload is the first: no test file loads at all while an unexpected
 * database URL is present.
 *
 * Both DATABASE_URL and GBRAIN_DATABASE_URL are checked — the runtime honors
 * both (src/core/config.ts), so guarding only one leaves a live path.
 *
 * HARD-FAIL, never silently unset: silently clearing the var would turn
 * DATABASE_URL-gated e2e tests into green skips, hiding the exact class of
 * bug (#2339) those tests exist to catch. The e2e wrappers (scripts/
 * run-e2e.sh, the e2e/heavy workflows) set GBRAIN_TEST_ALLOW_DATABASE_URL=1
 * at their own subprocess boundary; nothing sets it globally.
 *
 * Registered FIRST in bunfig.toml's [test].preload so it runs before any
 * other preload does work.
 */

const ALLOW = process.env.GBRAIN_TEST_ALLOW_DATABASE_URL === '1';

if (!ALLOW) {
  const offending = (['DATABASE_URL', 'GBRAIN_DATABASE_URL'] as const).filter(
    (name) => {
      const v = process.env[name];
      return v !== undefined && v !== '';
    },
  );
  if (offending.length > 0) {
    console.error(
      [
        `TEST-RUN GUARD: refusing to start — ${offending.join(' and ')} ${offending.length === 1 ? 'is' : 'are'} set.`,
        ``,
        `Some tests run destructive SQL (TRUNCATE/DELETE/DROP) against whatever`,
        `these URLs point at. A bare \`bun test\` with a real brain's URL in the`,
        `environment has wiped that brain before (#3485).`,
        ``,
        `Pick one:`,
        `  - unset the variable${offending.length > 1 ? 's' : ''} and re-run (unit tests need no database).`,
        `    If it keeps coming back, check for a .env file in this directory or a`,
        `    sourced ~/.gbrain/.env — bun auto-loads cwd .env into the test run.`,
        `  - run the e2e suite through its wrapper: \`bun run test:e2e\``,
        `    (the wrapper opts in at its own boundary), or`,
        `  - if you really mean to run tests against this database, opt in`,
        `    ONE-SHOT: \`GBRAIN_TEST_ALLOW_DATABASE_URL=1 bun test ...\` — avoid a`,
        `    shell-profile export, which would permanently disarm this guard. The`,
        `    per-file guard (test/helpers/db-guard.ts) still requires a test-shaped`,
        `    database name after that.`,
      ].join('\n'),
    );
    process.exit(1);
  }
}

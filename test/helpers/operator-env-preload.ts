/**
 * Pre-test setup: drop the operator's ambient agent/workspace context so the
 * unit suite's result depends on the code under test, not on whoever's shell
 * started it.
 *
 * scripts/run-e2e.sh already performs this scrub for the E2E lane (its
 * "Hermetic env scrub" block); the unit lane never got the same treatment.
 * Measured on one operator machine (#4023), ambient operator context alone
 * produced failures with no defect in the product: a stray GBRAIN_SOURCE
 * short-circuits source resolution at tier `env` before the tier under test
 * (8 failures across source-resolver-with-tier / source-resolver-silent-
 * fallback, 1 in extract-fs-source-id), and GBRAIN_CYCLE_FRESHNESS_WARN_HOURS
 * moves the very threshold doctor-cycle-freshness asserts. Provider
 * *_API_KEYs — the other ambient-failure class #4023 measured — are handled
 * by provider-keys-preload.ts; this preload deliberately leaves them alone.
 *
 * A preload rather than a runner-script scrub so a direct
 * `bun test test/foo.test.ts` — how anyone iterates on a single file — is
 * covered too. For the wrapper lanes the scrub is idempotent: run-e2e.sh
 * already unsets these prefixes and re-exports its own keeps at its own
 * subprocess boundary. This runs once, before any test file loads, so it only
 * removes ambient shell state — vars a test sets itself are never touched.
 *
 * CONDUCTOR_* / MCP_* / OPENCLAW_* are operator/agent workspace context with
 * no test-infrastructure tenants: stripped wholesale. GBRAIN_* is shared
 * between operator config overrides (must be stripped) and this repo's own
 * test machinery exported into `bun test` processes by the runners and CI
 * workflows (must survive), so it is stripped through the keep-lists below.
 * A blanket GBRAIN_* delete would break that machinery — e.g. the e2e lane's
 * GBRAIN_DATABASE_URL target or the snapshot fast path.
 *
 * Escape hatch: GBRAIN_TEST_KEEP_AMBIENT_ENV=1 disables the scrub entirely
 * (it lives under GBRAIN_TEST_, so it survives its own scrub). Debugging:
 * GBRAIN_DEBUG_PRELOAD=1 logs the removed NAMES — never values, which may be
 * secrets.
 */

/** Operator/agent workspace prefixes with no test-machinery tenants. */
const STRIP_PREFIX = /^(CONDUCTOR_|MCP_|OPENCLAW_)/;

const KEEP_EXACT = new Set([
  'GBRAIN_HOME', // per-run HOME isolation — gbrain-home-preload and run-e2e.sh both respect a pre-set value
  'GBRAIN_DATABASE_URL', // e2e DB target; database-url-guard-preload (registered first) already vetoed un-opted runs
  'GBRAIN_MODEL_DISCOVERY', // operator override provider-keys-preload deliberately respects
  'GBRAIN_PGLITE_SNAPSHOT', // schema-snapshot fast path exported by every unit runner (scripts/lib/test-env.sh)
  'GBRAIN_COMPILED_BIN', // heavy-lane compile-once binary (agent-harness.ts ensureCompiledGbrain)
  'GBRAIN_AUDIT_DIR', // audit-dir-preload honors a wrapper pre-set (inspect audit output after a run)
  'GBRAIN_SYNC_FAILURES_DIR', // same wrapper pre-set contract in sync-failures-preload
  'GBRAIN_DEBUG_PRELOAD', // the preload stack's own logging hatch
  // Test-control opt-in documented in cycle-synthesize-triage-calibration's
  // header — the scrub was silently no-op'ing the paid live layer (any
  // GBRAIN_* opt-in read by a test file needs a row here or a KEEP_PREFIX).
  'GBRAIN_TRIAGE_CALIBRATION_LIVE',
]);

// GBRAIN_TEST_*: test-control opt-ins (ALLOW_DATABASE_URL, KEEP_PROVIDER_KEYS,
// shard/memory knobs) must survive their own scrub or every escape hatch is a
// dead end. GBRAIN_CI_*: ci-local.sh port plumbing. GBRAIN_E2E_*: db-guard's
// name-floor opt-in (its error message tells operators to set it) + e2e
// runner knobs. GBRAIN_REAL_*: heavy-lane real-agent door-suite opt-ins read
// in-process by test/e2e/install-real-*.serial.test.ts.
const KEEP_PREFIX = /^GBRAIN_(TEST_|CI_|E2E_|REAL_)/;

if (process.env.GBRAIN_TEST_KEEP_AMBIENT_ENV !== '1') {
  const removed: string[] = [];
  for (const name of Object.keys(process.env)) {
    const strip =
      STRIP_PREFIX.test(name) ||
      (name.startsWith('GBRAIN_') && !KEEP_EXACT.has(name) && !KEEP_PREFIX.test(name));
    if (!strip) continue;
    delete process.env[name];
    removed.push(name);
  }
  if (process.env.GBRAIN_DEBUG_PRELOAD === '1' && removed.length > 0) {
    console.error(
      `[operator-env-preload] cleared ${removed.length}: ${removed.sort().join(', ')}`,
    );
  }
}

/**
 * Pre-test setup: neutralize the operator's ambient environment so the unit
 * suite's result depends on the code under test, not on whoever's shell started
 * it.
 *
 * ## Why
 *
 * `scripts/run-e2e.sh` already does exactly this for the E2E lane (see its
 * "Hermetic env scrub" block): it drops `CONDUCTOR_* / MCP_* / OPENCLAW_* /
 * GBRAIN_*` before bun starts, because "a dev shell or a Conductor workspace
 * exports ... GBRAIN_* config overrides (e.g. a stray GBRAIN_BRAIN_ID,
 * GBRAIN_SOURCE, GBRAIN_*_THRESHOLD ...) that would silently change test
 * behavior — making 'hermetic' E2E non-hermetic and its failures unreproducible
 * across machines."
 *
 * The unit lane never got that treatment. Measured on one operator machine
 * (2026-08-11), the ambient environment alone produced **12 failures** with no
 * defect in the product:
 *
 * | Ambient value | Failures it caused |
 * | --- | --- |
 * | `GBRAIN_SOURCE=default` | 8 in `source-resolver-with-tier` + `source-resolver-silent-fallback`, 1 in `extract-fs-source-id` — resolution short-circuits at tier `env` before reaching the tier under test |
 * | `GBRAIN_CYCLE_FRESHNESS_WARN_HOURS=10` | 1 in `doctor-cycle-freshness` — moves the very threshold the test asserts (11 pass / 0 fail once unset) |
 * | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | 2 in `memory-verbs-conformance`, 2 in `mcp-eval-capture`, 2 in `facts-classify` — tests pinning provider-unavailable branches take the live-provider path instead |
 *
 * A red suite that is red for environmental reasons is worse than a slow one:
 * it trains you to ignore failures.
 *
 * ## Why a preload rather than a scrub in the runner script
 *
 * `run-e2e.sh` scrubs in the shell, which only protects `bun run test`. A
 * preload also protects a direct `bun test test/foo.test.ts` — how anyone
 * actually iterates on a single file. The cost is that this file must handle the
 * E2E gate itself (below), since `run-e2e.sh` also invokes `bun test` and
 * therefore inherits `bunfig.toml`'s preload list.
 *
 * ## Load order matters
 *
 * This MUST precede `legacy-embedding-preload.ts` in `bunfig.toml`. That preload
 * snapshots `env: { ...process.env }` into the gateway config, and
 * `gateway.isAvailable()` reads `_config.env[k]` — NOT `process.env[k]`. So a key
 * present when the snapshot is taken makes the gateway "available" for the rest
 * of the process, and a test that later does `delete process.env.OPENAI_API_KEY`
 * does **not** undo it. That is exactly why `mcp-eval-capture` failed despite
 * deleting the key in its own setup. Strip before the snapshot or don't bother.
 *
 * ## The E2E gate
 *
 * E2E tests legitimately need live providers. They are detected by argv: this
 * repo's E2E runner invokes `bun test <file>` one file at a time with paths
 * under `test/e2e/`. When any argv entry names an E2E path, provider keys are
 * left ALONE. The gate is deliberately fail-safe in that direction — a
 * misdetection leaves keys in place (E2E keeps working, at worst a unit file
 * stays non-hermetic) rather than stripping them out from under a live-provider
 * suite.
 *
 * The operator-context scrub is NOT gated: `run-e2e.sh` already performs it for
 * E2E, so applying it here is idempotent for that lane and additionally protects
 * direct invocations.
 *
 * ## Escape hatches
 *
 * - `GBRAIN_TEST_KEEP_AMBIENT_ENV=1` — disable this preload entirely.
 * - `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1` — keep provider keys, still scrub operator
 *   context. Use to reproduce a live-provider bug from a unit file.
 * - `GBRAIN_DEBUG_PRELOAD=1` — log what was removed.
 *
 * ## Deliberately NOT stripped
 *
 * Provider `*_BASE_URL` vars and `AZURE_OPENAI_USE_ENTRA` redirect endpoints and
 * auth mode, so they are a plausible leak of the same shape — but no test has
 * been observed failing because of them, and someone may point tests at a local
 * Ollama on purpose. Left alone pending evidence rather than widened on
 * speculation. A `_API_KEY$` pattern is used instead of a hardcoded list of the
 * 21 provider vars so new recipes are covered without touching this file.
 */

const KEEP_EXACT = new Set([
  'GBRAIN_HOME',           // config/HOME isolation — run-e2e.sh keeps this too
  'GBRAIN_DEBUG_PRELOAD',  // needed for the logging below to be reachable
]);

/** Operator-context prefixes, mirroring run-e2e.sh's denylist. */
const OPERATOR_PREFIX = /^(CONDUCTOR_|MCP_|OPENCLAW_|GBRAIN_)/;

/** Test-control vars must survive their own scrub, or the hatches can't work. */
const KEEP_PREFIX = /^GBRAIN_TEST_/;

/** Any provider credential. Pattern, not a list, so new recipes are covered. */
const PROVIDER_KEY = /_API_KEY$/;

function isE2eRun(): boolean {
  return process.argv.some(
    (a) => a.includes('test/e2e/') || a.includes('test\\e2e\\'),
  );
}

// Read the hatches BEFORE scrubbing, since they live under GBRAIN_*.
const keepAll = process.env.GBRAIN_TEST_KEEP_AMBIENT_ENV === '1';
const keepProviderKeys = process.env.GBRAIN_TEST_KEEP_PROVIDER_KEYS === '1';
const debug = process.env.GBRAIN_DEBUG_PRELOAD === '1';

if (!keepAll) {
  const removed: string[] = [];

  for (const name of Object.keys(process.env)) {
    if (KEEP_EXACT.has(name) || KEEP_PREFIX.test(name)) continue;

    const isOperatorVar = OPERATOR_PREFIX.test(name);
    const isProviderKey = PROVIDER_KEY.test(name);
    if (!isOperatorVar && !isProviderKey) continue;

    // The only gated category: live-provider credentials during an E2E run.
    if (isProviderKey && !isOperatorVar && (keepProviderKeys || isE2eRun())) continue;

    delete process.env[name];
    removed.push(name);
  }

  if (debug && removed.length > 0) {
    // Names only — never values.
    console.error(`[hermetic-env-preload] cleared ${removed.length}: ${removed.sort().join(', ')}`);
  }
}

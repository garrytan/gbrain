/**
 * The nightly probes the `gbrain autopilot` daemon runs after every tick
 * (4.5 quality probe, 4.6 conversation-parser probe). Both own their gates and
 * never throw into the loop. Called by runAutopilotDaemon.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { gbrainPath as gbrainHomePath } from '../core/config.ts';
import type { AutopilotDaemonState } from './autopilot-daemon.ts';
import { logError } from './autopilot.ts';

export async function runNightlyQualityProbeStep(engine: BrainEngine, cfg: GBrainConfig | null, repoPath: string): Promise<void> {
  // 4.5 — Nightly quality probe (v0.41).
  // Per D10: trust the phase's internal 24h rate-limit (via shouldRunNightly
  // reading the audit JSONL). No scheduler-side precheck — one source of
  // truth for the rate-limit. Feature flag gates the probe entirely.
  // Wrapped in try/catch — a probe failure NEVER crashes the autopilot
  // loop. Probe runs even when cycleOk=false (probe may surface signal
  // explaining why the cycle is failing).
  try {
    const { resolveProbeEnabled, resolveProbeMaxUsd, runNightlyQualityProbe } =
      await import('../core/cycle/nightly-quality-probe.ts');
    const { resolveNightlyProbeSearchConfigSnapshot } =
      await import('../core/cycle/nightly-probe-search-config.ts');
    // Dual-plane read: `gbrain config set` (what the doctor enable hint
    // prints) writes the DB plane; ~/.gbrain/config.json is the fallback.
    let dbEnabled: string | null = null;
    let dbMaxUsd: string | null = null;
    try {
      dbEnabled = await engine.getConfig('autopilot.nightly_quality_probe.enabled');
      dbMaxUsd = await engine.getConfig('autopilot.nightly_quality_probe.max_usd');
    } catch { /* DB unavailable → file plane only */ }
    const probeEnabled = resolveProbeEnabled(dbEnabled, cfg?.autopilot?.nightly_quality_probe?.enabled);
    if (probeEnabled) {
      const { runLongMemEvalForProbe, runCrossModalBatchForProbe } = await import('../core/cycle/nightly-probe-adapters.ts');
      const { isAvailable } = await import('../core/ai/gateway.ts');
      const { existsSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { join } = await import('node:path');
      const maxUsd = resolveProbeMaxUsd(dbMaxUsd, cfg?.autopilot?.nightly_quality_probe?.max_usd);
      // The fixture lives in the package, not usually in the user's brain repo.
      const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
      const fixtureAtPkgRoot = existsSync(join(pkgRoot, 'test', 'fixtures', 'longmemeval-nightly.jsonl'));
      await runNightlyQualityProbe({
        isEnabled: () => true, // already gated above; phase re-checks for defense-in-depth
        hasEmbeddingProvider: () => isAvailable('embedding'),
        resolveMaxUsd: () => maxUsd,
        resolveRepoRoot: () => (fixtureAtPkgRoot ? pkgRoot : repoPath ?? gbrainHomePath('.')),
        resolveSearchConfigSnapshot: () => resolveNightlyProbeSearchConfigSnapshot(engine),
        runLongMemEval: runLongMemEvalForProbe,
        runCrossModalBatch: runCrossModalBatchForProbe,
        now: () => new Date(),
      });
    }
  } catch (e) {
    logError('autopilot.nightly_probe', e);
    // Intentional: do NOT bump consecutiveErrors. Probe failure is
    // informational; autopilot loop continues.
  }
}

export async function runParserProbeStep(engine: BrainEngine, cfg: GBrainConfig | null, state: AutopilotDaemonState): Promise<void> {
  // 4.6 — Nightly conversation-parser probe (v0.41.16.0 phase module;
  // the scheduler wire-up was deferred at ship and is added here). Same
  // posture as 4.5: the phase owns its gates (enabled/mode-gate, LLM
  // key), the wiring owns invocation + the audit row, and a probe
  // failure NEVER crashes the autopilot loop. Per D10 the probe is
  // default-ON for search.mode=tokenmax, opt-in otherwise.
  try {
    const { runConversationParserNightlyProbe } = await import('../core/conversation-parser/nightly-probe.ts');
    const { logParserProbeEvent, parserProbeRanWithin } = await import('../core/audit-parser-probe.ts');
    const { isAvailable } = await import('../core/ai/gateway.ts');
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    // Flag reads dual-plane: the DB row (`gbrain config set …`) wins,
    // ~/.gbrain/config.json is the fallback. search.mode lives on the
    // DB plane only (mode.ts owns it).
    let parserDbEnabled: string | null = null;
    let dbSearchMode: string | null = null;
    try {
      parserDbEnabled = await engine.getConfig('autopilot.conversation_parser_probe.enabled');
      dbSearchMode = await engine.getConfig('search.mode');
    } catch { /* DB unavailable → file plane only */ }
    const parserEnabled = parserDbEnabled != null
      ? parserDbEnabled === 'true'
      : cfg?.autopilot?.conversation_parser_probe?.enabled === true;
    const searchMode = dbSearchMode ?? '';
    // Fixtures are committed in the gbrain package (test/fixtures/…),
    // NOT the brain repo — resolve from the module location. Compiled
    // binaries carry no source tree: skip quietly instead of writing
    // failure rows that would flip doctor to WARN on every binary install.
    const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
    const fixturePath = join(pkgRoot, 'test', 'fixtures', 'conversation-formats', 'all.jsonl');
    const adversarialPath = join(pkgRoot, 'test', 'fixtures', 'conversation-formats', 'adversarial.jsonl');
    const shouldInvoke = parserEnabled || searchMode === 'tokenmax';
    if (shouldInvoke && existsSync(fixturePath) && existsSync(adversarialPath)) {
      const result = await runConversationParserNightlyProbe({
        isEnabled: () => parserEnabled,
        searchMode: () => searchMode,
        hasLlmKey: () => isAvailable('chat'),
        resolveFixturePath: () => fixturePath,
        resolveAdversarialPath: () => adversarialPath,
        now: () => new Date(),
        shouldSkipForRateLimit: () => parserProbeRanWithin(24 * 60 * 60 * 1000),
      });
      // rate_limited is a non-run: the loop ticks every few minutes, so
      // logging every skip would flood the audit file with no-signal rows.
      if (result.outcome !== 'rate_limited') logParserProbeEvent(result);
    } else if (shouldInvoke && !state.parserProbeFixtureWarned) {
      state.parserProbeFixtureWarned = true;
      console.error(`[parser-probe] fixtures not found under ${pkgRoot}; skipping (probe needs a source-checkout install)`);
    }
  } catch (e) {
    logError('autopilot.parser_probe', e);
    // Informational, like 4.5: do NOT bump consecutiveErrors.
  }
}

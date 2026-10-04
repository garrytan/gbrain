/**
 * v0.60.31 migration — security fix wave. Two phases:
 *   1. credential-safe re-chunk of existing pages (ENG-2), below;
 *   2. the one-time notice for Google sources outside `~/.gbrain`, whose files
 *      written before this version keep their old permissions until
 *      `gbrain repair google-file-modes` (opt-in) or a rewrite tightens them
 *      (v0_60_31-google-file-modes.ts; detection only).
 *
 * Schema migration v189 already withheld the old chunks of every page whose
 * canonical body carries a private-key marker. This orchestrator re-chunks
 * those pages through the credential-safe projection, provider-free (see
 * src/core/page-state/credential-reseal.ts). It never embeds: re-chunked key
 * chunks wait for the consent-gated `gbrain embed --stale`.
 *
 * Idempotent: each page re-seals in its own transaction and a re-sealed page
 * is no longer pending, so a rerun after an interruption resumes with the
 * pages still withheld. A failed page records the run as partial so the next
 * `gbrain apply-migrations --yes` retries it.
 */
import type { Migration, OrchestratorOpts, OrchestratorPhaseResult, OrchestratorResult } from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { buildGatewayConfig } from '../../core/ai/build-gateway-config.ts';
import { credentialProjectionPending, resealCredentialProjections } from '../../core/page-state/credential-reseal.ts';
import { runMigrateOnlyCore } from './in-process.ts';
import { googleFileModesNoticePhase } from './v0_60_31-google-file-modes.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

async function credentialProjectionPhase(engine: BrainEngine, opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  const name = 'credential_projection';
  if (opts.dryRun) {
    const pending = await credentialProjectionPending(engine);
    return { name, status: 'skipped', detail: `dry-run: ${pending.rebuildable} page(s) would be re-chunked without provider calls` };
  }
  const result = await resealCredentialProjections(engine);
  const kept = result.kept ? `; ${result.kept} code page(s) without a recorded source path stay withheld until re-imported` : '';
  const detail = `${result.resealed} page(s) re-chunked without provider calls, ${result.superseded} superseded by newer writes${kept}. `
    + 'Embed the re-chunked text when ready: gbrain embed --stale';
  if (result.failed) return { name, status: 'failed', detail: `${result.failed} page(s) failed to re-chunk and stay withheld; ${detail}` };
  return { name, status: 'complete', detail };
}

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  let engine = testEngineOverride;
  if (!engine) {
    const config = loadConfig();
    if (!config) return { version: '0.60.31', status: 'complete', phases: [{ name: 'credential_projection', status: 'skipped', detail: 'no_brain_configured' }] };
    // Schema migration v189 marks the pages this phase re-chunks; PGLite skips the runner's schema pre-flight.
    if (!opts.dryRun) await runMigrateOnlyCore();
    const { configureGateway } = await import('../../core/ai/gateway.ts');
    configureGateway(buildGatewayConfig(config));
    engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
  }
  try {
    const phases = [
      await credentialProjectionPhase(engine, opts),
      await googleFileModesNoticePhase(engine, { dryRun: opts.dryRun }),
    ];
    return { version: '0.60.31', status: phases.some(p => p.status === 'failed') ? 'partial' : 'complete', phases };
  } finally {
    if (!testEngineOverride) await engine.disconnect().catch(() => {});
  }
}

export const v0_60_31: Migration = {
  version: '0.60.31',
  fresh_install_noop: true,
  featurePitch: {
    headline: 'Stored private keys no longer reach search chunks or delivered evidence, and Google connector files are written private.',
    description: 'Pages whose body holds a private key are withheld from search until they are re-chunked with the key replaced by a <REDACTED:private_key_pem> token. This migration re-chunks them with no provider calls; run `gbrain embed --stale` afterwards to embed the new chunks. Stored page bodies are unchanged. '
      + 'Google connector files are now written 0600 (directories 0700); files written before this version under a Google source directory outside ~/.gbrain keep their old permissions. '
      + 'gbrain doctor lists them; preview the opt-in fix with gbrain repair google-file-modes and apply it with --apply.',
  },
  orchestrator,
};

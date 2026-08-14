/**
 * Hermes runner — invokes the real `hermes` binary (NousResearch
 * hermes-agent, the public platform) in a tempdir with a BRIEF.md prompt.
 * Live mode only.
 *
 * Invocation pattern (verified against a pinned local install, v0.20.0 —
 * see docs/mcp/HERMES-CLI-PIN.md):
 *   hermes -z "<brief>"
 *
 * The z flag is Hermes's headless one-shot: single prompt in, final response
 * text on stdout, nothing else. We deliberately do NOT pass Hermes's
 * working-directory flag (spelled "in") — `spawnWithCapture` already sets
 * `cwd`. `opts.agentName` is unused: the one-shot mode has no sub-agent
 * selector.
 *
 * Hermeticity posture (deliberate): live mode runs the OPERATOR's configured
 * Hermes — the real ~/.hermes (model settings, skills, sessions) is inherited
 * unless HERMES_HOME points elsewhere — against a hermetic BRAIN. The fully
 * hermetic lane is the door e2e (install-real-hermes.serial.test.ts).
 *
 * Binary resolution: $HERMES_BIN > `which hermes` > unavailable.
 * Path validation: must be absolute, must be executable, no '..' segments.
 */

import { execSync } from 'child_process';
import { statSync } from 'fs';
import {
  BASE_ENV_ALLOWLIST,
  validateBinPathEnv,
  type AgentRunner,
  type DetectResult,
  type InvokeOpts,
  type InvokeResult,
} from '../agent-runner.ts';
import { spawnWithCapture } from '../transcript-capture.ts';

/**
 * Allow-list for env propagation when spawning hermes. Delta from the shared
 * base: HERMES_HOME, so callers (door e2e, CI) can point Hermes at an
 * isolated home instead of the operator's real ~/.hermes; and
 * OPENROUTER_API_KEY, because OpenRouter is a Hermes-documented auth path
 * (docs/mcp/HERMES.md) — an operator whose hermes auths only via that env var
 * would otherwise see "no inference provider" and the harness would blame the
 * agent. Caveat (observed, docs/mcp/HERMES-CLI-PIN.md): live mode forwards
 * whatever provider keys the operator's shell exports, mirroring a direct
 * hermes run — with MULTIPLE keys visible and no model pinned in config,
 * Hermes's provider auto-routing can mis-route and fail with an HTTP 401 in
 * the final text. The operator's own config.yaml model pin is what prevents
 * that, same as it does outside the harness.
 */
const ENV_ALLOWLIST = [...BASE_ENV_ALLOWLIST, 'HERMES_HOME', 'OPENROUTER_API_KEY'];

export class HermesRunner implements AgentRunner {
  readonly name = 'hermes';

  async detect(): Promise<DetectResult> {
    const fromEnv = process.env.HERMES_BIN?.trim();
    let binPath: string | undefined;

    if (fromEnv) {
      const validation = validateBinPathEnv('HERMES_BIN', fromEnv);
      if (validation) return { available: false, reason: validation };
      binPath = fromEnv;
    } else {
      try {
        const out = execSync('which hermes', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const found = out.trim();
        if (!found || !found.startsWith('/')) {
          return { available: false, reason: 'hermes not on PATH' };
        }
        binPath = found;
      } catch {
        return { available: false, reason: 'hermes not on PATH' };
      }
    }

    if (!binPath) return { available: false, reason: 'no binary resolved' };

    try {
      const s = statSync(binPath);
      if (!s.isFile()) return { available: false, reason: `not a regular file: ${binPath}` };
      // eslint-disable-next-line no-bitwise
      if (!(s.mode & 0o111)) return { available: false, reason: `not executable: ${binPath}` };
    } catch (e) {
      return { available: false, reason: `stat failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    return { available: true, binPath };
  }

  async invoke(opts: InvokeOpts): Promise<InvokeResult> {
    const detected = await this.detect();
    if (!detected.available || !detected.binPath) {
      throw new Error(`hermes runner unavailable: ${detected.reason ?? 'unknown'}`);
    }
    const args = ['-z', opts.brief];

    // Filter env to allow-list, then merge caller overrides.
    const baseEnv: Record<string, string> = {};
    for (const key of ENV_ALLOWLIST) {
      const v = process.env[key];
      if (typeof v === 'string') baseEnv[key] = v;
    }
    const env: Record<string, string> = { ...baseEnv, ...opts.env };

    const result = await spawnWithCapture(detected.binPath, args, {
      cwd: opts.cwd,
      env,
      timeoutMs: opts.timeoutMs,
      transcriptSink: opts.transcriptSink,
    });

    return { exitCode: result.exitCode, durationMs: result.durationMs };
  }
}

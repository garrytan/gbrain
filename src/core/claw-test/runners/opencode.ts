/**
 * opencode runner — invokes the real `opencode` binary (SST terminal agent,
 * opencode.ai) in a tempdir with a BRIEF.md prompt. Live mode only.
 *
 * Invocation pattern (verified against a pinned hermetic install, v1.18.18 —
 * see docs/mcp/OPENCODE-CLI-PIN.md):
 *   opencode run "<brief>" --format default
 *
 * `run` is opencode's headless one-shot: prompt in, final answer text ALONE
 * on stdout (banner/UI on stderr), exit 0. `--format default` is passed
 * explicitly so an upstream default flip cannot silently change the
 * transcript shape. NO `--auto`: MCP tool calls fire in run mode without any
 * permission flag (verified — the keyless SMOKE recalled a nonce through
 * gbrain_recall with the flag absent). NO `-m`: live mode runs the
 * OPERATOR's configured opencode, whose model pin (or the anonymous free
 * tier) is the point of the measurement.
 *
 * Naming: opencode (SST, opencode.ai, npm `opencode-ai`) is not OpenClaw
 * (the platform with its own runner) and not the original `opencode` CLI
 * that became Crush — the version preamble below makes a mis-bound claimant
 * diagnosable (the SST CLI answers `--version` with a BARE semver).
 *
 * Hermeticity posture (deliberate): live mode runs the OPERATOR's configured
 * opencode — the real XDG config/data dirs are inherited unless
 * XDG_CONFIG_HOME/XDG_DATA_HOME point elsewhere — against a hermetic BRAIN.
 * opencode-specific contamination channel (observed): the user-global
 * opencode config is read for EVERY run, and a project opencode.json in the
 * cwd spawns its local MCP servers with NO trust gate. Live-mode workspaces
 * are harness-created tempdirs (no project config in reach), but a global
 * mcp.gbrain entry would bind the operator's REAL brain while the oracle
 * probes the hermetic one — `invoke()` logs a loud warning for that case.
 * The fully hermetic lane is the door e2e
 * (install-real-opencode.serial.test.ts): fresh HOME + XDG dirs.
 * OPENCODE_CONFIG_CONTENT (inline whole-config env) is deliberately NOT
 * forwarded — it is a config-shadowing channel, and it was observed inert in
 * 1.18.18 anyway (OPENCODE-CLI-PIN.md §Path seams).
 *
 * Binary resolution: $OPENCODE_BIN > `which opencode` > unavailable.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  BASE_ENV_ALLOWLIST,
  detectBinary,
  filterAllowlistEnv,
  type AgentRunner,
  type DetectResult,
  type InvokeOpts,
  type InvokeResult,
} from '../agent-runner.ts';
import { spawnWithCapture } from '../transcript-capture.ts';

/**
 * Allow-list for env propagation when spawning opencode. The base list
 * carries ONLY Anthropic + OpenAI provider keys — opencode's headline
 * feature is multi-provider, so the delta NAMES the additional provider
 * keys a live-lane operator may be running on (xAI, Google, OpenRouter);
 * anything not named here silently strips and reads as a misleading
 * agent-auth failure. Plus the opencode seams: XDG dirs (config/auth
 * relocation for hermetic callers), OPENCODE_CONFIG(_DIR) (observed inert
 * in 1.18.18 but forwarded so a future release that activates them behaves
 * the way the caller intended), and OPENCODE_DISABLE_AUTOUPDATE (the env
 * half of the double autoupdate kill).
 */
const ENV_ALLOWLIST = [
  ...BASE_ENV_ALLOWLIST,
  'XAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_DISABLE_AUTOUPDATE',
];

export class OpencodeRunner implements AgentRunner {
  readonly name = 'opencode';

  async detect(): Promise<DetectResult> {
    return detectBinary('OPENCODE_BIN', 'opencode');
  }

  async invoke(opts: InvokeOpts): Promise<InvokeResult> {
    const detected = await this.detect();
    if (!detected.available || !detected.binPath) {
      throw new Error(`opencode runner unavailable: ${detected.reason ?? 'unknown'}`);
    }
    const args = ['run', opts.brief, '--format', 'default'];
    const env = filterAllowlistEnv(ENV_ALLOWLIST, opts.env);

    this.warnOnGlobalGbrainEntry(env);

    // Version preamble: recorded as a plain stdout transcript event. The SST
    // CLI answers with a BARE semver (`1.18.18` — no name, no build hash);
    // any other shape means a colliding `opencode` claimant is bound.
    // execFileSync (no shell) with the SAME filtered env as the turn itself.
    try {
      const version = execFileSync(detected.binPath, ['--version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15_000,
        env: env as NodeJS.ProcessEnv,
        cwd: opts.cwd,
      }).trim();
      opts.transcriptSink.write({
        ts: Date.now(),
        channel: 'stdout',
        bytes: Buffer.from(`[opencode-runner preamble] version: ${version}\n`, 'utf-8'),
      });
    } catch {
      // Preamble is diagnostic only — never fail the run for it.
    }

    const result = await spawnWithCapture(detected.binPath, args, {
      cwd: opts.cwd,
      env,
      timeoutMs: opts.timeoutMs,
      transcriptSink: opts.transcriptSink,
    });

    return { exitCode: result.exitCode, durationMs: result.durationMs };
  }

  /**
   * Loud tripwire for the global-config contamination channel: when the
   * config dir opencode will resolve carries an mcp.gbrain entry, a live
   * turn routes gbrain tool calls at the operator's REAL brain while the
   * oracle probes the hermetic one. Warning only (live mode deliberately
   * runs the operator's agent); the hermetic lane is the door e2e. Checks
   * BOTH filenames — opencode merges opencode.json AND opencode.jsonc.
   */
  private warnOnGlobalGbrainEntry(env: Record<string, string>): void {
    try {
      const xdg = env.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME;
      const home = env.HOME ?? process.env.HOME;
      const cfgDir = xdg ? join(xdg, 'opencode') : home ? join(home, '.config', 'opencode') : null;
      if (!cfgDir) return;
      for (const file of ['opencode.jsonc', 'opencode.json']) {
        const p = join(cfgDir, file);
        if (!existsSync(p)) continue;
        // Loose containment probe, not a parse: the global config is JSONC
        // (comments legal), and a substring hit is enough for a warning.
        const text = readFileSync(p, 'utf-8');
        if (/"gbrain"\s*:/.test(text) && /"mcp"\s*:/.test(text)) {
          console.warn(
            `[opencode-runner] WARNING: ${p} carries an mcp.gbrain entry. opencode reads the ` +
              "user-global config on every run, so this live turn may bind the OPERATOR'S REAL " +
              'brain instead of the hermetic one. Use a scratch HOME/XDG_CONFIG_HOME for clean ' +
              'measurements (docs/mcp/OPENCODE-CLI-PIN.md).',
          );
          return;
        }
      }
    } catch {
      // Best-effort tripwire — unreadable/invalid config is not an error here.
    }
  }
}

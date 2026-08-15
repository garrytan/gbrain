/**
 * Grok runner — invokes the real `grok` binary (xAI Grok Build CLI) in a
 * tempdir with a BRIEF.md prompt. Live mode only.
 *
 * Invocation pattern (verified against a pinned local install, v1.0.4 —
 * see docs/mcp/GROK-CLI-PIN.md):
 *   grok -p "<brief>" --output-format plain
 *
 * The p flag ("single") is Grok Build's headless one-shot: prompt in, final
 * response text on stdout, exit. We deliberately do NOT pass grok's cwd flag
 * — `spawnWithCapture` already sets `cwd`. `opts.agentName` is unused: the
 * one-shot mode targets the default agent. The permission posture
 * ("always-approve" / "permission-mode", both spelled dash-free here on
 * purpose) is deliberately NOT passed until the authed observation proves it
 * required for headless MCP tool calls — GROK-CLI-PIN.md marks that item
 * pending auth; revisit after the first authed live run.
 *
 * Naming: grok (xAI, XAI_API_KEY) is not groq (Groq Inc. inference recipe,
 * GROQ_API_KEY) and not ngrok (tunnels).
 *
 * Hermeticity posture (deliberate): live mode runs the OPERATOR's configured
 * Grok — the real ~/.grok (auth, model settings, trusted folders) is
 * inherited unless GROK_HOME points elsewhere — against a hermetic BRAIN.
 * Grok-specific contamination channel (observed): grok reads VENDOR MCP
 * configs — ~/.claude.json and project .mcp.json — for folders the operator
 * has trusted. If the operator's ~/.claude.json registers gbrain, a live-lane
 * grok turn in a trusted folder can bind the operator's REAL brain while the
 * oracle probes the hermetic one. `invoke()` logs a loud warning when it
 * detects that case; the fully hermetic lane is the door e2e
 * (install-real-grok.serial.test.ts), where fresh HOME + cwd make vendor
 * fallback structurally impossible (entries show "folder untrusted").
 * Also observed: grok loads .envrc from the cwd by default — live-mode
 * workspaces are harness-created tempdirs, so no operator .envrc is in reach.
 *
 * Binary resolution: $GROK_BIN > `which grok` > unavailable.
 * Path validation: must be absolute, must be executable, no '..' segments.
 * Collision note: the community superagent-ai grok-cli ships a colliding
 * `grok` binary; the official one is identified by its version output shape
 * `grok X.Y.Z (buildhash)` — the live lane writes a version preamble into
 * the transcript so a mis-bound binary is diagnosable from the transcript.
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
 * Allow-list for env propagation when spawning grok. Delta from the shared
 * base: GROK_HOME, so callers (door e2e, dx scenarios) can point Grok at an
 * isolated home instead of the operator's real ~/.grok; and XAI_API_KEY,
 * grok's documented headless auth path (keyless one-shot exits 1 with
 * "Not signed in" — see docs/mcp/GROK-CLI-PIN.md) — an operator who auths
 * via that env var would otherwise be blamed as an agent failure.
 * FOREIGN provider keys are removed from the base: grok is single-provider
 * (xAI) — forwarding the operator's Anthropic/OpenAI credentials to a
 * third-party binary buys nothing and is the exact cross-provider exposure
 * the door lane's grokChildEnv scrub exists to prevent.
 */
const FOREIGN_PROVIDER_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
const ENV_ALLOWLIST = [
  ...BASE_ENV_ALLOWLIST.filter((k) => !FOREIGN_PROVIDER_KEYS.has(k)),
  'GROK_HOME',
  'XAI_API_KEY',
];

export class GrokRunner implements AgentRunner {
  readonly name = 'grok';

  async detect(): Promise<DetectResult> {
    return detectBinary('GROK_BIN', 'grok');
  }

  async invoke(opts: InvokeOpts): Promise<InvokeResult> {
    const detected = await this.detect();
    if (!detected.available || !detected.binPath) {
      throw new Error(`grok runner unavailable: ${detected.reason ?? 'unknown'}`);
    }
    const args = ['-p', opts.brief, '--output-format', 'plain'];
    const env = filterAllowlistEnv(ENV_ALLOWLIST, opts.env);

    this.warnOnVendorGbrainEntry(env);

    // Version preamble: recorded as a plain stdout transcript event (the
    // transcript schema is stdio-bytes-only, so this is a captured preamble,
    // not a new event type). Makes a mis-bound community binary or an
    // auto-updated version diagnosable from the transcript alone.
    // execFileSync (no shell — the which-resolved path is not metachar-
    // validated) with the SAME filtered env as the turn itself: the resolved
    // binary must never see ambient secrets the allowlist excludes.
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
        bytes: Buffer.from(`[grok-runner preamble] version: ${version}\n`, 'utf-8'),
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
   * Loud tripwire for the vendor-config contamination channel: when the HOME
   * grok will see carries a ~/.claude.json with an mcpServers.gbrain entry,
   * a trusted-folder grok turn may route gbrain tool calls at the operator's
   * REAL brain. Warning only (live mode deliberately runs the operator's
   * agent); the hermetic lane is the door e2e.
   */
  private warnOnVendorGbrainEntry(env: Record<string, string>): void {
    try {
      const home = env.HOME ?? process.env.HOME;
      if (!home) return;
      const claudeJson = join(home, '.claude.json');
      if (!existsSync(claudeJson)) return;
      const parsed = JSON.parse(readFileSync(claudeJson, 'utf-8')) as {
        mcpServers?: Record<string, unknown>;
      };
      if (parsed?.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'gbrain')) {
        console.warn(
          '[grok-runner] WARNING: ~/.claude.json registers an mcpServers.gbrain entry. ' +
            'Grok Build reads vendor MCP configs for trusted folders, so this live run ' +
            'may bind the OPERATOR\'S REAL brain instead of the hermetic one. ' +
            'Use a scratch HOME/GROK_HOME for clean measurements (docs/mcp/GROK-CLI-PIN.md).',
        );
      }
    } catch {
      // Best-effort tripwire — unreadable/invalid vendor config is not an error here.
    }
  }
}

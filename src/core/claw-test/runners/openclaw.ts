/**
 * OpenClaw runner — invokes the real `openclaw` binary in a tempdir with a
 * BRIEF.md prompt. Live mode only.
 *
 * Invocation pattern (verified against test/e2e/skills.test.ts and
 * test/e2e/bench-vs-openclaw/harness.ts):
 *   openclaw agent --local --agent <agent-name> --message "<brief>"
 *
 * NOT `openclaw run` with a prompt-file flag (spelled "prompt-file" — that
 * flag does not exist; Codex pass 2 of the eng review caught the speculative
 * shape).
 *
 * Binary resolution: $OPENCLAW_BIN > `which openclaw` > unavailable.
 * Path validation: must be absolute, must be executable, no '..' segments.
 */

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

const DEFAULT_AGENT_NAME = 'default';
/** Allow-list for env propagation when spawning openclaw (no delta from base). */
const ENV_ALLOWLIST = [...BASE_ENV_ALLOWLIST];

export class OpenClawRunner implements AgentRunner {
  readonly name = 'openclaw';

  async detect(): Promise<DetectResult> {
    return detectBinary('OPENCLAW_BIN', 'openclaw');
  }

  async invoke(opts: InvokeOpts): Promise<InvokeResult> {
    const detected = await this.detect();
    if (!detected.available || !detected.binPath) {
      throw new Error(`openclaw runner unavailable: ${detected.reason ?? 'unknown'}`);
    }
    const agentName = opts.agentName ?? DEFAULT_AGENT_NAME;
    const args = ['agent', '--local', '--agent', agentName, '--message', opts.brief];
    const env = filterAllowlistEnv(ENV_ALLOWLIST, opts.env);

    const result = await spawnWithCapture(detected.binPath, args, {
      cwd: opts.cwd,
      env,
      timeoutMs: opts.timeoutMs,
      transcriptSink: opts.transcriptSink,
    });

    return { exitCode: result.exitCode, durationMs: result.durationMs };
  }
}

/**
 * OpenClaw runner — invokes the real `openclaw` binary in a tempdir with a
 * BRIEF.md prompt. Live mode only.
 *
 * Invocation pattern (verified against test/e2e/skills.test.ts and
 * test/e2e/bench-vs-openclaw/harness.ts):
 *   openclaw agent --local --agent <agent-name> --message "<brief>"
 *
 * NOT `openclaw run --prompt-file BRIEF.md` (that flag does not exist —
 * Codex pass 2 of the eng review caught the speculative shape).
 *
 * Binary resolution: $OPENCLAW_BIN > `which openclaw` > unavailable.
 * Path validation: must be absolute, must be executable, no '..' segments.
 */

import { execSync } from 'child_process';
import { statSync } from 'fs';
import type { AgentRunner, DetectResult, InvokeOpts, InvokeResult } from '../agent-runner.ts';
import { spawnWithCapture } from '../transcript-capture.ts';

const DEFAULT_AGENT_NAME = 'default';
/** Allow-list for env propagation when spawning openclaw. */
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LANG', 'TZ', 'NODE_ENV',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'GBRAIN_HOME', 'GBRAIN_FRICTION_RUN_ID', 'GBRAIN_DATABASE_URL',
];

export class OpenClawRunner implements AgentRunner {
  readonly name = 'openclaw';

  async detect(): Promise<DetectResult> {
    const fromEnv = process.env.OPENCLAW_BIN?.trim();
    let binPath: string | undefined;

    if (fromEnv) {
      const validation = validateAbsolutePath(fromEnv);
      if (validation) return { available: false, reason: validation };
      binPath = fromEnv;
    } else {
      try {
        const out = execSync('which openclaw', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const found = out.trim();
        if (!found || !found.startsWith('/')) {
          return { available: false, reason: 'openclaw not on PATH' };
        }
        binPath = found;
      } catch {
        return { available: false, reason: 'openclaw not on PATH' };
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
      throw new Error(`openclaw runner unavailable: ${detected.reason ?? 'unknown'}`);
    }
    const agentName = opts.agentName ?? DEFAULT_AGENT_NAME;
    const args = ['agent', '--local', '--agent', agentName, '--message', opts.brief];

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

function validateAbsolutePath(p: string): string | null {
  if (!p.startsWith('/')) return `OPENCLAW_BIN must be absolute; got ${p}`;
  if (p.split('/').includes('..')) return `OPENCLAW_BIN must not contain '..' segments; got ${p}`;
  return null;
}

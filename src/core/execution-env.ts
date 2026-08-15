/**
 * Execution-environment detection — the third bootstrap axis.
 *
 * `detectHarness` (bootstrap.ts) answers WHICH AGENT HOST (claude-code vs
 * codex). This module answers WHERE THAT HOST IS RUNNING:
 *
 *   - `cloud-sandbox`        → a hosted, reclaimed-after-inactivity VM behind a
 *                              credential-injecting egress proxy (Claude Code on
 *                              the web and lookalikes). No crontab, no surviving
 *                              background processes; GitHub REST is scoped to
 *                              session-attached repos and GraphQL is pinned to a
 *                              fixed operation set.
 *   - `ephemeral-container`  → Docker/Render/Railway/Fly-class containers.
 *                              Long-lived enough for normal hook cadence, but
 *                              schedulers (crontab/launchd) are unreliable or
 *                              absent (wiped on deploy).
 *   - `local`                → a normal machine. Everything works.
 *
 * Consumers branch persistence strategy (cron install vs event-driven pushes),
 * push-cadence defaults, and error messaging on this value. Detection is pure
 * and signal-injected so tests never depend on the machine running them.
 */
import { existsSync } from 'node:fs';

export type ExecutionEnvironment = 'local' | 'cloud-sandbox' | 'ephemeral-container';

/** Injectable probe signals (production defaults: process.env + existsSync). */
export interface EnvProbeSignals {
  env?: Record<string, string | undefined>;
  fileExists?: (p: string) => boolean;
}

/**
 * True when outbound credentials are substituted by a proxy rather than held
 * locally — the Claude Code cloud signature. Signals (any one suffices):
 *
 *   - GH_TOKEN / GITHUB_TOKEN carry the documented literal `proxy-injected`
 *     placeholder (the proxy attaches real credentials on the wire).
 *   - The https proxy URL carries an anthropic-egress-control JWT.
 *
 * Load-bearing caveat for verification code: inside such an environment an
 * "anonymous" HTTP probe may be silently authenticated by the proxy, so
 * anonymous-probe results must be treated as ambiguous (see repo-visibility).
 */
export function isCredentialInjectingProxy(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.GH_TOKEN === 'proxy-injected' || env.GITHUB_TOKEN === 'proxy-injected') return true;
  const proxy = env.https_proxy ?? env.HTTPS_PROXY ?? '';
  return /anthropic-egress/i.test(proxy);
}

/**
 * Detect where this process is running. Order matters: the cloud sandbox is
 * ALSO a container, so its signals are checked first.
 *
 *   1. `CLAUDE_CODE_REMOTE === 'true'` — official, never true locally.
 *   2. `CLAUDE_CODE_REMOTE_SESSION_ID` with the documented `cse_` prefix.
 *   3. A credential-injecting proxy signature (see above).
 *   4. Container platforms: RENDER / RAILWAY_ENVIRONMENT / FLY_APP_NAME env,
 *      or the /.dockerenv marker file (same signal set autopilot's
 *      detectInstallTarget has used for its ephemeral branch).
 *   5. Otherwise: local.
 */
export function detectExecutionEnvironment(signals: EnvProbeSignals = {}): ExecutionEnvironment {
  const env = signals.env ?? process.env;
  const fileExists = signals.fileExists ?? existsSync;
  if (env.CLAUDE_CODE_REMOTE === 'true') return 'cloud-sandbox';
  if ((env.CLAUDE_CODE_REMOTE_SESSION_ID ?? '').startsWith('cse_')) return 'cloud-sandbox';
  if (isCredentialInjectingProxy(env)) return 'cloud-sandbox';
  if (
    env.RENDER ||
    env.RAILWAY_ENVIRONMENT ||
    env.FLY_APP_NAME ||
    fileExists('/.dockerenv')
  ) {
    return 'ephemeral-container';
  }
  return 'local';
}

/** Whether `name` resolves on PATH. Moved here from bootstrap/status.ts so
 * environment-aware code (cron install, preflight) shares one probe. The
 * LIVE process.env.PATH is passed explicitly: Bun otherwise resolves against
 * the startup env snapshot, making runtime PATH changes (and PATH-shimmed
 * test fakes) invisible — the workspace-push.ts / status.ts precedent. */
export function binaryOnPath(name: string): boolean {
  try {
    return Bun.which(name, { PATH: process.env.PATH ?? '' }) !== null;
  } catch {
    return false;
  }
}

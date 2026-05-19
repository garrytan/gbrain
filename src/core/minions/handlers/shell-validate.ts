/**
 * Pre-enqueue validator for `shell` job params (v0.35.8.0).
 *
 * Called from BOTH submit surfaces BEFORE `MinionQueue.add()`:
 *   - `src/commands/jobs.ts` — `gbrain jobs submit shell` CLI handler
 *   - `src/core/operations.ts` — `submit_job` op handler for name='shell'
 *
 * Critical correctness property: a rejected payload NEVER lands in
 * `minion_jobs.data`. Validation in the worker handler (where it lived
 * pre-v0.35.8.0) ran AFTER `queue.add()` had already persisted the row, so
 * a bad payload (env: shadowing a secret, unknown inherit name) lived in
 * the DB row from submit-time until handler-pickup. This module exists
 * specifically to close that window. The handler still re-validates as
 * defense-in-depth.
 *
 * Throws `UnrecoverableError` on every failure path — validation errors are
 * never retry-worthy. Errors carry paste-ready hints pointing at the right
 * pattern (e.g. `inherit:["database_url"]` instead of `env:{GBRAIN_DATABASE_URL}`).
 */

import * as path from 'node:path';
import { UnrecoverableError } from '../types.ts';
import {
  INHERITABLE,
  INHERITABLE_NAMES,
  ALL_SHADOW_KEYS,
  inheritedByShadowKey,
  isInheritableSecret,
  type InheritableSecret,
} from './shell-inherit.ts';
import { loadConfig, type GBrainConfig } from '../../config.ts';

/** Validated, narrowed shell-job params. */
export interface ValidatedShellJobParams {
  cmd?: string;
  argv?: string[];
  cwd: string;
  env?: Record<string, string>;
  inherit?: InheritableSecret[];
}

export interface ValidateShellJobOpts {
  /**
   * Loaded gbrain config used to verify every name in `inherit:` actually has
   * a value the worker can resolve. Pass `null` when no config is loaded
   * (validator will fail-fast on any inherit request). Defaults to calling
   * `loadConfig()` when undefined — the typical CLI / op-handler path.
   *
   * Test seam: pass `{ config }` explicitly to drive the validator with a
   * stubbed config in hermetic unit tests instead of mocking the module.
   */
  config?: GBrainConfig | null;
}

/**
 * Validate raw shell-job submission `data`. Returns the narrowed shape on
 * success; throws `UnrecoverableError` with an operator-facing message on
 * every failure path.
 */
export function validateShellJobParams(
  data: Record<string, unknown>,
  opts: ValidateShellJobOpts = {},
): ValidatedShellJobParams {
  const hasCmd = typeof data.cmd === 'string' && (data.cmd as string).length > 0;
  const hasArgv = Array.isArray(data.argv) && (data.argv as unknown[]).length > 0;

  if (hasCmd && hasArgv) {
    throw new UnrecoverableError(
      'shell: specify exactly one of cmd or argv (see: docs/guides/minions-shell-jobs.md#errors)',
    );
  }
  if (!hasCmd && !hasArgv) {
    throw new UnrecoverableError(
      'shell: specify exactly one of cmd or argv (see: docs/guides/minions-shell-jobs.md#errors)',
    );
  }
  if (hasArgv) {
    const argvOk = (data.argv as unknown[]).every((a) => typeof a === 'string');
    if (!argvOk) {
      throw new UnrecoverableError(
        'shell: argv must be an array of strings (see: docs/guides/minions-shell-jobs.md#errors)',
      );
    }
  }
  if (typeof data.cwd !== 'string' || (data.cwd as string).length === 0) {
    throw new UnrecoverableError(
      'shell: cwd is required and must be an absolute path (see: docs/guides/minions-shell-jobs.md#errors)',
    );
  }
  if (!path.isAbsolute(data.cwd as string)) {
    throw new UnrecoverableError(
      'shell: cwd is required and must be an absolute path (see: docs/guides/minions-shell-jobs.md#errors)',
    );
  }
  if (data.env !== undefined) {
    if (typeof data.env !== 'object' || data.env === null || Array.isArray(data.env)) {
      throw new UnrecoverableError(
        'shell: env must be an object of string values (see: docs/guides/minions-shell-jobs.md#errors)',
      );
    }
    for (const v of Object.values(data.env as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new UnrecoverableError(
          'shell: env values must all be strings (see: docs/guides/minions-shell-jobs.md#errors)',
        );
      }
    }
  }

  const env = data.env as Record<string, string> | undefined;

  // ---- `inherit` validation (new in v0.35.8.0) ----
  let inherit: InheritableSecret[] | undefined;
  if (data.inherit !== undefined) {
    if (!Array.isArray(data.inherit)) {
      throw new UnrecoverableError(
        'shell: inherit must be an array of strings ' +
        `(allowed: ${INHERITABLE_NAMES.join(', ')}; see: docs/guides/minions-shell-jobs.md#secrets)`,
      );
    }
    const items = data.inherit as unknown[];
    for (const item of items) {
      if (!isInheritableSecret(item)) {
        const got = typeof item === 'string' ? `"${item}"` : typeof item;
        throw new UnrecoverableError(
          `shell: inherit contains unknown name ${got}; allowed: ${INHERITABLE_NAMES.join(', ')} ` +
          '(see: docs/guides/minions-shell-jobs.md#secrets)',
        );
      }
    }
    inherit = items as InheritableSecret[];
  }

  // ---- H1 (codex v0.36.5.0): cmd / argv inline-secret scan ----
  // Without this, a caller can bypass the env-key validator entirely by writing
  // `cmd: "GBRAIN_DATABASE_URL=postgresql://... gbrain sync"` — the URL lands
  // plaintext in `minion_jobs.data.cmd` and the shell-audit cmd_display. The
  // env-key validator below doesn't see this because the secret is embedded in
  // the command string, not the structured `env:` map. Match
  // `WORD=value` shell-inline-assignment patterns at the start of cmd or
  // anywhere in argv, anchored to known shadow-key names. The check is a
  // signal-strength heuristic — a determined caller can still base64-encode or
  // obfuscate, but the common typo / wintermute-pattern shapes are caught.
  const SHADOW_INLINE_RE = new RegExp(
    `(?:^|[\\s;&|])(${Array.from(ALL_SHADOW_KEYS).join('|')})=`,
    'i',
  );
  if (typeof data.cmd === 'string' && SHADOW_INLINE_RE.test(data.cmd)) {
    const m = data.cmd.match(SHADOW_INLINE_RE);
    const key = m?.[1] || 'secret';
    const which = inheritedByShadowKey(key);
    const hint = which
      ? `use \`inherit: ["${which}"]\` instead`
      : 'use the `inherit:` allowlist instead';
    throw new UnrecoverableError(
      `shell: cmd contains inline secret assignment "${key}=..." — ${hint}. ` +
      'Inline secrets in cmd land plaintext in `minion_jobs.data` and the ' +
      'shell-audit JSONL. See: docs/guides/minions-shell-jobs.md#secrets',
    );
  }
  if (Array.isArray(data.argv)) {
    for (const tok of data.argv as unknown[]) {
      if (typeof tok === 'string' && SHADOW_INLINE_RE.test(tok)) {
        const m = tok.match(SHADOW_INLINE_RE);
        const key = m?.[1] || 'secret';
        const which = inheritedByShadowKey(key);
        const hint = which
          ? `use \`inherit: ["${which}"]\` instead`
          : 'use the `inherit:` allowlist instead';
        throw new UnrecoverableError(
          `shell: argv contains inline secret assignment "${key}=..." — ${hint}. ` +
          'See: docs/guides/minions-shell-jobs.md#secrets',
        );
      }
    }
  }

  // ---- T3: env-shadow rejection (applies regardless of inherit) ----
  // A caller cannot route a secret via plain `env:` regardless of whether they
  // also requested it via `inherit:`. This closes the leak path PR #1137's
  // plain-env-secret workaround opened. Without this rule, any caller could
  // bypass inherit by just writing the env var directly — the secret still
  // lands plaintext in `minion_jobs.data`.
  if (env !== undefined) {
    for (const envKey of Object.keys(env)) {
      if (ALL_SHADOW_KEYS.has(envKey)) {
        const which = inheritedByShadowKey(envKey);
        const hint = which
          ? `use \`inherit: ["${which}"]\` instead`
          : 'use the `inherit:` allowlist instead';
        // F3: when caller passed BOTH inherit:[X] AND env:{shadowKey}, give
        // the explicit shadow message; otherwise give the general one.
        const isShadowOfRequested = which !== undefined && inherit?.includes(which);
        const prefix = isShadowOfRequested
          ? `shell: env ${envKey} shadows inherit["${which}"]`
          : `shell: env ${envKey} is a secret`;
        throw new UnrecoverableError(
          `${prefix} — ${hint}. ` +
          'See: docs/guides/minions-shell-jobs.md#secrets',
        );
      }
    }
  }

  // ---- F1: fail-fast on missing config value for any requested inherit ----
  // If the worker can't actually resolve the requested secret, reject at
  // submit-time with a paste-ready fix pointing at the exact config key to
  // set. Without this, a child process would receive an empty/undefined env
  // var and fail later with a vague "No database URL" downstream.
  if (inherit !== undefined && inherit.length > 0) {
    const cfg = opts.config !== undefined ? opts.config : loadConfig();
    for (const name of inherit) {
      const value = INHERITABLE[name].read(cfg);
      if (typeof value !== 'string' || value.length === 0) {
        throw new UnrecoverableError(
          `shell: inherit requested "${name}" but worker has no ${name} configured. ` +
          `Fix: \`gbrain config set ${name} <value>\` or set ${INHERITABLE[name].envKey} ` +
          'in the worker env. (see: docs/guides/minions-shell-jobs.md#secrets)',
        );
      }
    }
  }

  return {
    cmd: hasCmd ? (data.cmd as string) : undefined,
    argv: hasArgv ? (data.argv as string[]) : undefined,
    cwd: data.cwd as string,
    env,
    inherit,
  };
}


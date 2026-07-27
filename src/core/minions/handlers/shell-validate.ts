/**
 * Pre-enqueue validator for `shell` job params (v0.36.5.0).
 *
 * Called from BOTH submit surfaces BEFORE `MinionQueue.add()`:
 *   - `src/commands/jobs.ts` — `gbrain jobs submit shell` CLI handler
 *   - `src/core/operations.ts` — `submit_job` op handler for name='shell'
 *
 * Correctness property: a rejected payload NEVER lands in `minion_jobs.data`.
 * Pre-v0.36.5.0 validation ran in the worker handler AFTER `queue.add()` had
 * already persisted the row; this module exists to close that window.
 *
 * Trust model (read this once): the agent that submits the job is in the same
 * uid as the worker that runs it. We do NOT police WHICH secrets the agent
 * chooses to pass — that's the agent's call. We only validate:
 *
 *   1. Shape — `cmd` XOR `argv`, `cwd` absolute, `env` is string→string
 *   2. `inherit` is an array of snake_case names (prevents prototype-pollution
 *      lookups like `__proto__` and keeps audit logs readable)
 *   3. Every `inherit` name resolves to a non-empty string on the worker's
 *      `loadConfig()` (UX guardrail — fail at submit time, not minutes later
 *      in opaque child-process stderr)
 *
 * What we deliberately do NOT do:
 *   - No closed-enum allowlist of "approved" secrets. Agent decides.
 *   - No shadow-rejection (caller can also set the same key in `env:` if they
 *     want — that puts the value in the row plaintext, which is their call).
 *   - No inline-`cmd: "X=value ..."` scan. Same reasoning.
 */

import * as path from 'node:path';
import { UnrecoverableError } from '../types.ts';
import {
  INHERIT_NAME_RE,
  resolveInheritValue,
} from './shell-inherit.ts';
import { loadConfig, type GBrainConfig } from '../../config.ts';

/** Validated, narrowed shell-job params. */
export interface ValidatedShellJobParams {
  cmd?: string;
  argv?: string[];
  cwd: string;
  env?: Record<string, string>;
  inherit?: string[];
  redact_secrets?: boolean;
}

export interface ValidateShellJobOpts {
  /**
   * Loaded gbrain config used to verify every `inherit` name resolves to a
   * value. Pass `null` to fail-fast on any inherit request. Defaults to
   * calling `loadConfig()` when undefined — the typical CLI / op-handler path.
   *
   * Test seam: pass `{ config }` explicitly to drive the validator with a
   * stubbed config in hermetic unit tests instead of mocking the module.
   */
  config?: GBrainConfig | null;
}

/**
 * Validate raw shell-job submission `data`. Returns the narrowed shape on
 * success; throws `UnrecoverableError` with an operator-facing message on
 * every failure path. Validation errors are never retry-worthy.
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

  // ---- `inherit` shape validation ----
  // Free-form list of config-key names. The closed enum of v0.35-RC was
  // overcautious for the single-uid trust model — the agent knows what it
  // needs to pass to the child. We only enforce shape (snake_case) so audit
  // logs stay readable and prototype-pollution shapes (`__proto__`) can't
  // sneak through.
  let inherit: string[] | undefined;
  if (data.inherit !== undefined) {
    if (!Array.isArray(data.inherit)) {
      throw new UnrecoverableError(
        'shell: inherit must be an array of config-key names ' +
        '(see: docs/guides/minions-shell-jobs.md#secrets)',
      );
    }
    const items = data.inherit as unknown[];
    for (const item of items) {
      if (typeof item !== 'string' || item.length === 0) {
        throw new UnrecoverableError(
          'shell: inherit entries must be non-empty strings ' +
          '(see: docs/guides/minions-shell-jobs.md#secrets)',
        );
      }
      if (!INHERIT_NAME_RE.test(item)) {
        throw new UnrecoverableError(
          `shell: inherit name "${item}" must match [a-z][a-z0-9_]* ` +
          '(snake_case config-key shape; see: docs/guides/minions-shell-jobs.md#secrets)',
        );
      }
    }
    inherit = items as string[];
  }

  // ---- Fail-fast on missing config value ----
  // UX guardrail: if the worker can't resolve a requested name, fail at
  // submit-time with a paste-ready fix. Without this, the child gets an
  // unset env var and fails minutes later with a less precise error.
  if (inherit !== undefined && inherit.length > 0) {
    const cfg = opts.config !== undefined ? opts.config : loadConfig();
    for (const name of inherit) {
      const value = resolveInheritValue(cfg, name);
      if (value === undefined) {
        throw new UnrecoverableError(
          `shell: inherit requested "${name}" but worker has no ${name} configured. ` +
          `Fix: \`gbrain config set ${name} <value>\` or set the value in the worker's config file. ` +
          '(see: docs/guides/minions-shell-jobs.md#secrets)',
        );
      }
    }
  }

  // ---- `redact_secrets` shape check ----
  if (data.redact_secrets !== undefined && typeof data.redact_secrets !== 'boolean') {
    throw new UnrecoverableError(
      'shell: redact_secrets must be a boolean if set ' +
      '(see: docs/guides/minions-shell-jobs.md#secrets)',
    );
  }

  return {
    cmd: hasCmd ? (data.cmd as string) : undefined,
    argv: hasArgv ? (data.argv as string[]) : undefined,
    cwd: data.cwd as string,
    env: data.env as Record<string, string> | undefined,
    inherit,
    redact_secrets: data.redact_secrets as boolean | undefined,
  };
}

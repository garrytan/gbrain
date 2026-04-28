/**
 * Structured error envelope for agent-consumable failures.
 *
 * Shape matches `CycleReport.PhaseResult.error` from v0.17.0 so the agent
 * surface is consistent across `gbrain dream`, `sync --all`, `code-def`,
 * `code-refs`, `repos`, and `importCodeFile`.
 *
 * Agents consuming gbrain via CLI+JSON (OpenClaw and similar) need to
 * distinguish retryable from fatal, user-config from programmer errors,
 * and get a hint to recover. Raw Error().message strings lose that signal.
 */

export interface StructuredError {
  /** Short error class name, e.g. "ConfirmationRequired", "FileTooLarge". */
  class: string;
  /** Stable machine-readable code, snake_case. e.g. "cost_preview_requires_yes". */
  code: string;
  /** Human-readable message. One sentence. */
  message: string;
  /** Optional actionable hint. e.g. "Pass --yes to proceed". */
  hint?: string;
  /** Optional link to docs/runbook. */
  docs_url?: string;
}

export interface BuildErrorInput {
  class: string;
  code: string;
  message: string;
  hint?: string;
  docs_url?: string;
}

/**
 * Build a structured error envelope. Prefer this over throw new Error()
 * at any new v0.18.0 surface (repos, code-def, code-refs, sync --all,
 * importCodeFile, doctor --chunker-debug).
 */
export function buildError(input: BuildErrorInput): StructuredError {
  const e: StructuredError = {
    class: input.class,
    code: input.code,
    message: input.message,
  };
  if (input.hint) e.hint = input.hint;
  if (input.docs_url) e.docs_url = input.docs_url;
  return e;
}

/**
 * An Error subclass that carries a StructuredError envelope.
 * Agents catch this, extract `.envelope`, and print `{error: envelope}` as JSON.
 * Humans see the plain message via Error.message.
 */
export class StructuredAgentError extends Error {
  readonly envelope: StructuredError;

  constructor(envelope: StructuredError) {
    const hintSuffix = envelope.hint ? ` (${envelope.hint})` : '';
    super(`${envelope.class}: ${envelope.message}${hintSuffix}`);
    this.name = envelope.class;
    this.envelope = envelope;
  }
}

/**
 * Helper to construct-and-throw in one call.
 * Usage: throw errorFor({ class: 'FileTooLarge', code: 'file_too_large', message: '...' });
 */
export function errorFor(input: BuildErrorInput): StructuredAgentError {
  return new StructuredAgentError(buildError(input));
}

/**
 * Serialize an error envelope or unknown throwable for JSON output.
 * If the value is a StructuredAgentError, uses its structured envelope.
 * Otherwise falls back to a generic {class: 'Error', code: 'unknown', message}.
 */
export function serializeError(value: unknown): StructuredError {
  if (value instanceof StructuredAgentError) return value.envelope;
  if (value instanceof Error) {
    return buildError({
      class: value.name || 'Error',
      code: 'unknown',
      message: value.message,
    });
  }
  return buildError({
    class: 'Error',
    code: 'unknown',
    message: String(value),
  });
}

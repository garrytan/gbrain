/**
 * Embedding credential preflight.
 *
 * v0.41.6.0 D1 — fail fast at sync/embed/import entry when the configured
 * embedding provider can't be reached. Without this, gbrain proceeds into
 * the import phase, hits 565 per-file embed errors, writes 565 identical
 * "OpenAI embedding requires OPENAI_API_KEY." rows to `~/.gbrain/sync-failures.jsonl`,
 * and blocks the sync bookmark from advancing.
 *
 * Routes through `gateway.diagnoseEmbedding()` so the structured reason
 * (missing_env / no_touchpoint / unknown_provider / etc.) drives a precise
 * user-facing error message.
 *
 * Skip protocol: callers SHOULD NOT call validateEmbeddingCreds when the
 * user explicitly passed `--no-embed` (the canonical opt-out). The
 * deferred-setup sentinel is owned by `assertEmbeddingEnabled` in
 * `embedding-dim-check.ts`; this preflight runs AFTER that check fires.
 */

import { diagnoseEmbedding, type EmbeddingDiagnosis } from './ai/gateway.ts';

/**
 * Tagged error thrown by validateEmbeddingCreds. CLI catch sites format
 * `.userMessage` to stderr and exit non-zero. The structured fields
 * (`provider`, `model`, `missingEnvVars`, `reason`) enable programmatic
 * consumers (`gbrain doctor --json`, future autopilot health checks) to
 * read state without parsing the human message.
 */
export class EmbeddingCredentialError extends Error {
  readonly diagnosis: EmbeddingDiagnosis;
  readonly userMessage: string;

  constructor(diagnosis: EmbeddingDiagnosis, userMessage: string) {
    super(userMessage);
    this.name = 'EmbeddingCredentialError';
    this.diagnosis = diagnosis;
    this.userMessage = userMessage;
  }
}

/**
 * Run the preflight. Throws EmbeddingCredentialError when the gateway
 * can't serve embeddings. Returns silently when ok.
 *
 * Pure function: reads nothing except what `gateway.diagnoseEmbedding()`
 * already had at gateway configure-time.
 */
export function validateEmbeddingCreds(): void {
  const d = diagnoseEmbedding();
  if (d.ok) return;
  throw new EmbeddingCredentialError(d, formatEmbeddingCredsError(d));
}

/**
 * Format a paste-ready, multi-line error message from a non-ok diagnosis.
 * Exported for tests and for the doctor JSON output.
 */
export function formatEmbeddingCredsError(d: EmbeddingDiagnosis): string {
  if (d.ok) return '';

  switch (d.reason) {
    case 'no_gateway_config':
      return [
        'Embedding gateway is not configured.',
        'This is usually a startup-order bug. Re-run with --no-embed to import',
        'without embedding, then file an issue at https://github.com/garrytan/gbrain/issues',
      ].join('\n');

    case 'no_model_configured':
      return [
        'No embedding model is configured for this brain.',
        '',
        '  Set one: gbrain config set embedding_model openai:text-embedding-3-small',
        '  Or skip embedding now: re-run with --no-embed',
      ].join('\n');

    case 'unknown_provider':
      return [
        `Embedding model "${d.model}" uses an unknown provider "${d.provider}".`,
        '',
        `  ${d.message}`,
        '',
        '  Pick a known provider: gbrain config set embedding_model openai:text-embedding-3-small',
      ].join('\n');

    case 'no_touchpoint':
      return [
        `Provider "${d.provider}" does not offer an embedding touchpoint.`,
        '',
        '  Switch providers: gbrain config set embedding_model openai:text-embedding-3-small',
        '  Or run with --no-embed to import-only and embed later.',
      ].join('\n');

    case 'user_provided_model_unset':
      return [
        `Provider "${d.provider}" requires a specific model name to be configured.`,
        '',
        `  Set one: gbrain config set embedding_model ${d.provider}:<model-name>`,
        '  Or run with --no-embed to import-only and embed later.',
      ].join('\n');

    case 'missing_env': {
      const envs = d.missingEnvVars.join(', ');
      const primaryEnv = d.missingEnvVars[0];
      const lines = [
        `Embedding model "${d.model}" requires ${envs}.`,
        '',
        `Set it in your shell, or:`,
        `  • Re-run with --no-embed to import-only and embed later once the key is set.`,
      ];
      // Only offer a provider-switch hint when the current provider isn't openai
      // (otherwise we'd be suggesting they switch to the thing they already have).
      if (d.provider !== 'openai') {
        lines.push(`  • Switch providers: gbrain config set embedding_model openai:text-embedding-3-small`);
      } else {
        lines.push(`  • Switch providers: gbrain config set embedding_model voyage:voyage-3-large`);
      }
      lines.push('');
      lines.push(`Example shell setup:`);
      lines.push(`  export ${primaryEnv}=...`);
      return lines.join('\n');
    }
  }
}

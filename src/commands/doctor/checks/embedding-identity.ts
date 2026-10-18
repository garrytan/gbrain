/**
 * Doctor `embedding_identity_unqualified` (#6113): the brain's DB `config`
 * row `embedding_model` holds a model name with no provider prefix (a row
 * from an older install). The managed facts resolver reads only that row, so
 * facts-absorb stops with `embedding_configuration` while `gbrain config get
 * embedding_model` shows a valid `provider:model` from the file plane, and
 * `config set` cannot change the row. The supported rewrite is
 * `gbrain migrate embeddings --to <provider:model>`; the fix is its read-only
 * `--dry-run` preview, filled from the configured model (an `inputs` entry
 * only when none is configured). Applying it re-embeds active facts, so it is
 * the user's paid decision.
 */
import type { Check } from '../../doctor.ts';
import type { Action } from '../../../core/agent-output.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const NAME = 'embedding_identity_unqualified';
const QUALIFIED = /^[^\s:]+:[^\s]+$/;

/** The rewrite preview for a bare row; `configured` is the non-DB plane's `provider:model`, when it has one. */
export function embeddingIdentityFix(row: string, configured: string | null): Action {
  const target = configured && QUALIFIED.test(configured) ? configured : null;
  return {
    argv: ['gbrain', 'migrate', 'embeddings', '--to', target ?? '<PROVIDER_MODEL>', '--dry-run'],
    ...(target ? {} : { inputs: [{ name: 'PROVIDER_MODEL', how: `The provider-qualified id of the model that embedded this brain, for example openai:${row}; ask the user when unsure.` }] }),
    consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Previews rewriting the brain\'s embedding identity to a provider-qualified model, read-only. Applying it (the same command without --dry-run, with --yes and --max-cost-usd) re-embeds active facts, so show the user the preview\'s cost and ask first.',
    verify: doctorVerify(NAME),
    docs: 'docs/guides/troubleshooting.md#embedding-identity-unqualified',
  };
}

async function runEmbeddingIdentity(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat(NAME);
  try {
    const [row] = await engine.executeRaw<{ value: string }>(`SELECT value FROM config WHERE key = 'embedding_model'`);
    const stored = row?.value?.trim() ?? '';
    if (!stored || /[:/]/.test(stored)) {
      checks.push({ name: 'embedding_identity_unqualified', status: 'ok', message: stored ? `The brain records its embedding model with its provider (${stored}).` : 'The brain records no embedding_model row.' });
      return checks;
    }
    const { loadConfig } = await import('../../../core/config.ts');
    const configured = loadConfig()?.embedding_model?.trim() || null;
    const fix = embeddingIdentityFix(stored, configured);
    const argv = fix.argv ?? [];
    const target = argv[4]!;
    const differs = !fix.inputs && !target.endsWith(`:${stored}`);
    checks.push({
      name: 'embedding_identity_unqualified', status: 'warn',
      message: `The brain's embedding_model row is ${JSON.stringify(stored)} with no provider prefix (a row from an older install), so managed fact extraction stops with embedding_configuration; gbrain config set cannot change it. `
        + `Preview the rewrite: ${argv.join(' ')}${differs ? ` (the configured model ${target} is not ${stored}, so applying it switches models)` : ''}. Applying it re-embeds active facts and needs the user's paid authorization.`,
      details: { code: NAME, stored_model: stored, configured_model: configured, target_model: fix.inputs ? null : target, target_differs: differs },
      fix,
    });
  } catch (err) {
    checks.push(checkError(NAME, 'read the embedding_model config row', err));
  }
  return checks;
}

export const embeddingIdentityEntry: DoctorEntry = { name: 'embedding_identity_unqualified', emits: ['embedding_identity_unqualified'], run: runEmbeddingIdentity };

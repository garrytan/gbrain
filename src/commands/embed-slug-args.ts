import { opError } from '../core/ops/contract.ts';

/** The flags a single-page run (`gbrain embed <slug>`) reads; the value flags take the next argument. */
const SLUG_VALUE_FLAGS = new Set(['--source', '--batch-size', '--priority', '--max-usd', '--max-cost', '--pace-max-concurrency']);
const SLUG_BOOLEAN_FLAGS = new Set(['--dry-run', '--catch-up', '--yes', '--json', '--background', '--follow', '--pace', '--include-null-signature']);

/**
 * GST-2767: the page a single-page run embeds. The slug is the first argument that is neither a flag nor a flag's value,
 * so `--source <id>` is never read as a slug, and a flag no embed mode accepts (`--status`) is refused as unknown_flag
 * before anything is spent, instead of the next argument being looked up as a page.
 */
export function embedSlugTarget(args: readonly string[]): string | undefined {
  let slug: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (SLUG_VALUE_FLAGS.has(a)) { i++; continue; }
    const name = a.split('=')[0]!;
    if (SLUG_BOOLEAN_FLAGS.has(a) || (a.includes('=') && (name === '--pace' || SLUG_VALUE_FLAGS.has(name)))) continue;
    if (a.startsWith('-')) {
      const source = args[args.indexOf('--source') + 1];
      const dryRun = ['gbrain', 'embed', '--stale', '--dry-run', '--json', ...(args.includes('--source') && source ? ['--source', source] : [])];
      throw opError('unknown_flag', `gbrain embed does not accept ${name}.`,
        `Nothing was embedded. ${name === '--status' ? 'Embedding coverage is read with gbrain embed --stale --dry-run --json (add --source <id> for one source; it calls no provider and spends nothing) or gbrain doctor --only embedding_state --json. ' : ''}`
          + 'Run gbrain embed --help for the flags each mode takes.', {
          detail: name,
          why: `A single-page run (gbrain embed <slug>) takes only its own flags, and ${name} is not one of them, so the run stopped before it read a page or asked for spend approval.`,
          fix: { argv: dryRun, consent: [], actor: 'agent', requires_exclusive: false,
            why: 'Lists the pages whose embeddings are missing or stale without calling a provider or spending anything.',
            verify: { argv: ['gbrain', 'doctor', '--only', 'embedding_state', '--json'] } },
        });
    }
    slug ??= a;
  }
  return slug;
}

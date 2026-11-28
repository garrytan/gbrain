import { opError } from './ops/contract.ts';

/** Validate the explicit owner override before consent, backgrounding or provider work. */
export function validateProjectionEmbedArgs(args: readonly string[]): void {
  const currentOnly = args.includes('--current-projections-only');
  const override = args.includes('--no-current-projections-only');
  if (!currentOnly && !override) return;
  if (!args.includes('--stale') || args.some(arg => ['--all', '--slugs', '--held', '--facts', '--images', '--background'].includes(arg)) || (currentOnly && override)) {
    throw opError('invalid_params', 'Projection policy flags apply only to a foreground text --stale run and cannot be combined.',
      'Run gbrain embed --stale --dry-run to preview.');
  }
  if (override && !args.includes('--dry-run')) {
    const at = args.indexOf('--max-usd');
    const cap = at >= 0 ? Number(args[at + 1]) : NaN;
    if (!args.includes('--yes') || !Number.isFinite(cap) || cap <= 0) {
      throw opError('invalid_params', 'Rebuilding and embedding held projections requires --yes and a finite positive --max-usd.',
        'After owner approval, run gbrain embed --stale --yes --max-usd <usd> --no-current-projections-only.');
    }
  }
}

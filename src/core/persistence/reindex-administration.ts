import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { currentVerifiedLocalWriter } from './identity.ts';
import { runReindexCode, type ReindexCodeOpts } from '../../commands/reindex-code.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';

export async function runAuthenticatedCodeReindex(engine: BrainEngine, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const verified = currentVerifiedLocalWriter();
  if (!verified || verified.remote || verified.principal.kind !== 'local_cli') throw trustedCliRequired('Code reindex requires a trusted CLI registration.');
  if (Object.keys(params).some(k => k !== 'options') || !params.options || typeof params.options !== 'object' || Array.isArray(params.options)) throw opError('invalid_params', 'Code reindex requires typed options.', 'Run gbrain reindex-code from the CLI (gbrain reindex-code --help lists its flags); it builds the typed options this owner lane accepts.');
  const options = params.options as Record<string, unknown>;
  const allowed = ['sourceId', 'dryRun', 'yes', 'json', 'force', 'noEmbed', 'workers', 'maxCostUsd'];
  if (Object.keys(options).some(k => !allowed.includes(k)) ||
    ['dryRun', 'yes', 'json', 'force', 'noEmbed'].some(k => options[k] !== undefined && typeof options[k] !== 'boolean') ||
    options.sourceId !== undefined && (typeof options.sourceId !== 'string' || !options.sourceId) ||
    options.workers !== undefined && (!Number.isInteger(options.workers) || Number(options.workers) < 1 || Number(options.workers) > 64) ||
    options.maxCostUsd !== undefined && (typeof options.maxCostUsd !== 'number' || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)) throw opError('invalid_params', 'Invalid code reindex options.', 'Use gbrain reindex-code flags only: --source with a source id, --workers from 1 to 64, and --max-cost-usd above 0; gbrain reindex-code --help lists the rest.');
  if (!options.noEmbed && !options.dryRun && !options.yes) {
    throw new OperationError('confirmation_required', 'Explicit embedding consent is required; use --no-embed for keyless recovery.',
      'The CLI asks the user before delegating; run gbrain reindex-code without --yes to get the consent request and relay it to the user.');
  }
  if (!verified.grant.scopes.includes('write') || verified.grant.operations !== null && !verified.grant.operations.includes('submit_job') ||
    verified.grant.slugPrefixes !== null || !verified.grant.sourceIds.includes('*') &&
      (typeof options.sourceId !== 'string' || !verified.grant.sourceIds.includes(options.sourceId))) {
    throw opError('permission_denied', 'Code reindex exceeds the CLI source-wide write grant.',
      'This CLI\'s writer grant lacks write and submit_job on every selected source without slug limits. Review the grant; widening it with gbrain auth local-writer register --replace is a credentials change the user approves.',
      { fix: { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'], consent: [], actor: 'agent', why: 'Shows this brain\'s local writer registrations with their grants, read-only.', requires_exclusive: false } });
  }
  const work = runReindexCode(engine, options as ReindexCodeOpts);
  const unregister = engine.registerBeforeDisconnect(async () => { await work.catch(() => {}); });
  try { return { ...await work }; } finally { unregister(); }
}

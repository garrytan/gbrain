import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { currentVerifiedLocalWriter } from './identity.ts';
import { runReindexCode, type ReindexCodeOpts } from '../../commands/reindex-code.ts';

export async function runAuthenticatedCodeReindex(engine: BrainEngine, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const verified = currentVerifiedLocalWriter();
  if (!verified || verified.remote || verified.principal.kind !== 'local_cli') throw new OperationError('permission_denied', 'Code reindex requires a trusted CLI registration.');
  if (Object.keys(params).some(k => k !== 'options') || !params.options || typeof params.options !== 'object' || Array.isArray(params.options)) throw new OperationError('invalid_params', 'Code reindex requires typed options.');
  const options = params.options as Record<string, unknown>;
  const allowed = ['sourceId', 'dryRun', 'yes', 'json', 'force', 'noEmbed', 'workers', 'maxCostUsd'];
  if (Object.keys(options).some(k => !allowed.includes(k)) ||
    ['dryRun', 'yes', 'json', 'force', 'noEmbed'].some(k => options[k] !== undefined && typeof options[k] !== 'boolean') ||
    options.sourceId !== undefined && (typeof options.sourceId !== 'string' || !options.sourceId) ||
    options.workers !== undefined && (!Number.isInteger(options.workers) || Number(options.workers) < 1 || Number(options.workers) > 64) ||
    options.maxCostUsd !== undefined && (typeof options.maxCostUsd !== 'number' || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)) throw new OperationError('invalid_params', 'Invalid code reindex options.');
  if (!options.noEmbed && !options.dryRun && !options.yes) throw new OperationError('confirmation_required', 'Explicit embedding consent is required; use --no-embed for keyless recovery.');
  if (!verified.grant.scopes.includes('write') || verified.grant.operations !== null && !verified.grant.operations.includes('submit_job') ||
    verified.grant.slugPrefixes !== null || !verified.grant.sourceIds.includes('*') &&
      (typeof options.sourceId !== 'string' || !verified.grant.sourceIds.includes(options.sourceId))) {
    throw new OperationError('permission_denied', 'Code reindex exceeds the CLI source-wide write grant.');
  }
  const work = runReindexCode(engine, options as ReindexCodeOpts);
  const unregister = engine.registerBeforeDisconnect(async () => { await work.catch(() => {}); });
  try { return { ...await work }; } finally { unregister(); }
}

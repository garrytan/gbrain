/** One parser and one operation path for local, resident, and remote takes mutations. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { isThinClient, loadConfig, type GBrainConfig } from '../core/config.ts';
import { OperationError } from '../core/ops/contract.ts';
import { parseMutationPrecondition } from '../core/persistence/preconditions.ts';
import { isWriteReceipt } from '../core/persistence/types.ts';
import { maybeDelegateLocalOperation } from '../core/persistence/local-client.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';

const names = ['add', 'update', 'supersede', 'resolve'] as const;
export type TakesMutation = typeof names[number];
export function isTakesMutation(value: string): value is TakesMutation { return (names as readonly string[]).includes(value); }
const invalid = (message: string) => new OperationError('invalid_params', message);

export function parseTakesMutation(args: string[]): { operation: `takes_${TakesMutation}`; params: Record<string, unknown>; sourceId?: string; json: boolean } {
  const [sub, slug, ...rest] = args;
  if (!isTakesMutation(sub) || !slug || slug.startsWith('-')) throw invalid('Usage: gbrain takes add|update|supersede|resolve <slug> [options].');
  const params: Record<string, unknown> = { slug };
  let sourceId: string | undefined, json = false;
  const fields: Record<string, string> = { '--claim': 'claim', '--kind': 'kind', '--who': 'holder', '--weight': 'weight',
    '--source': 'source', '--since': 'since', '--row': 'row_num', '--quality': 'quality', '--outcome': 'outcome',
    '--evidence': 'evidence', '--value': 'value', '--unit': 'unit', '--by': 'resolved_by', '--dir': 'local_dir',
    '--request-id': 'request_id', '--expected-revision': 'expected_revision', '--source-id': 'source_id' };
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i], equal = raw.indexOf('=');
    const flag = equal < 0 ? raw : raw.slice(0, equal);
    if (seen.has(flag)) throw invalid(`Duplicate option ${flag}.`);
    seen.add(flag);
    if (flag === '--json' || flag === '--force') {
      if (equal >= 0) throw invalid(`${flag} does not accept a value.`);
      if (flag === '--json') json = true; else params.force = true;
      continue;
    }
    const key = fields[flag];
    if (!key) throw invalid(`Unsupported takes mutation option: ${flag}.`);
    const value = equal >= 0 ? raw.slice(equal + 1) : rest[++i];
    if (value === undefined || value.startsWith('--')) throw invalid(`${flag} requires a value.`);
    if (key === 'source_id') { sourceId = value; continue; }
    if (['weight', 'value', 'row_num'].includes(key)) {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number) || key === 'row_num' && (!Number.isSafeInteger(number) || number < 1)) throw invalid(`${flag} requires ${key === 'row_num' ? 'a positive integer' : 'a finite number'}.`);
      params[key] = number;
    } else params[key] = key === 'local_dir' ? resolve(value) : value;
  }
  const common = ['slug', 'request_id', 'expected_revision', 'force', 'local_dir'];
  const allowed = sub === 'add' ? ['claim', 'kind', 'holder', 'weight', 'source', 'since']
    : sub === 'update' ? ['row_num', 'weight', 'source', 'since']
    : sub === 'supersede' ? ['row_num', 'claim', 'kind', 'holder', 'weight', 'source', 'since']
    : ['row_num', 'quality', 'outcome', 'evidence', 'source', 'value', 'unit', 'resolved_by'];
  for (const key of Object.keys(params)) if (![...common, ...allowed].includes(key)) throw invalid(`${key} is not supported by takes ${sub}.`);
  for (const key of sub === 'add' ? ['claim', 'kind', 'holder'] : sub === 'supersede' ? ['row_num', 'claim'] : ['row_num']) {
    if (params[key] === undefined || params[key] === '') throw invalid(`Missing ${key === 'holder' ? '--who' : key === 'row_num' ? '--row' : `--${key}`}.`);
  }
  if (params.kind !== undefined && !['fact', 'take', 'bet', 'hunch'].includes(String(params.kind))) throw invalid('Invalid --kind. Expected fact, take, bet, or hunch.');
  if (sub === 'resolve') {
    if (params.quality !== undefined && params.outcome !== undefined) throw invalid('--quality and --outcome are mutually exclusive.');
    if (params.outcome !== undefined) {
      if (params.outcome !== 'true' && params.outcome !== 'false') throw invalid('--outcome must be true or false.');
      params.quality = params.outcome === 'true' ? 'correct' : 'incorrect';
      delete params.outcome;
    }
    if (!['correct', 'incorrect', 'partial', 'unresolvable'].includes(String(params.quality))) throw invalid('--quality requires correct, incorrect, partial, or unresolvable.');
    if (params.evidence !== undefined && params.source !== undefined && params.evidence !== params.source) throw invalid('--evidence and --source specify different evidence; use one.');
    if (params.evidence === undefined && params.source !== undefined) params.evidence = params.source;
    delete params.source;
  }
  Object.assign(params, parseMutationPrecondition(params));
  params.request_id ??= randomUUID();
  return { operation: `takes_${sub}`, params, sourceId, json };
}

export async function runTakesMutation(engine: BrainEngine | (() => Promise<BrainEngine>), args: string[], configOverride?: GBrainConfig): Promise<void> {
  let requestId: string | undefined;
  try {
    const parsed = parseTakesMutation(args);
    const { operation, params } = parsed;
    requestId = params.request_id as string;
    const config = configOverride ?? loadConfig(), cli = getCliOptions();
    let result: Record<string, unknown>;
    if (isThinClient(config)) {
      if (args.some(arg => arg === '--outcome' || arg.startsWith('--outcome='))) console.error('[deprecated] --outcome is the v0.28 alias for --quality. Prefer --quality correct|incorrect|partial in new scripts.');
      if (cli.brain || parsed.sourceId || params.local_dir !== undefined) throw invalid('--brain, --source-id, and --dir require a local brain host; the remote credential selects its source.');
      result = unpackToolResult(await callRemoteTool(config!, operation, params, { timeoutMs: cli.timeoutMs ?? 30_000 }));
    } else {
      const delegated = await maybeDelegateLocalOperation(operation, params, config, {
        brain: cli.brain, source: parsed.sourceId ?? null, timeoutMs: cli.timeoutMs ?? undefined,
      });
      if (delegated.handled) result = delegated.result as Record<string, unknown>;
      else {
        const connected = typeof engine === 'function' ? await engine() : engine;
        const { operations } = await import('../core/operations.ts');
        const op = operations.find(candidate => candidate.name === operation)!;
        result = await op.handler({ engine: connected, config: config ?? { engine: 'pglite' }, remote: false,
          sourceId: await resolveSourceId(connected, parsed.sourceId ?? null), dryRun: false,
          logger: { info: message => console.error(message), warn: message => console.error(message), error: message => console.error(message) },
        }, params) as Record<string, unknown>;
      }
    }
    if (isWriteReceipt(result.write_request) && result.write_request.state !== 'committed') {
      const pending = new OperationError('write_pending', 'The take mutation has not committed.', `Retry the same arguments with --request-id ${requestId}.`);
      pending.writeRequest = result.write_request;
      throw pending;
    }
    if (parsed.json) await writeStdoutFinal(JSON.stringify(result, null, 2) + '\n');
    else {
      const row = result.row_num ?? params.row_num;
      if (operation === 'takes_add') console.log(`Added take #${row} to ${params.slug}.`);
      else if (operation === 'takes_update') console.log(`Updated take #${row} on ${params.slug}.`);
      else if (operation === 'takes_supersede') console.log(`Superseded #${result.old_row} → new #${result.new_row} on ${params.slug}.`);
      else console.log(`Resolved take #${row} on ${params.slug}: quality=${params.quality}.`);
    }
  } catch (error) {
    if (!await reportPersistenceCliError(error, args.includes('--json'))) {
      console.error(error instanceof Error ? error.message : String(error)); setCliExitVerdict(1);
    }
    if (requestId) console.error(`Retry the same takes ${args[0]} arguments with --request-id ${requestId}.`);
  }
}

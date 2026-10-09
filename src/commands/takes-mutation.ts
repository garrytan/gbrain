/** One parser and one operation path for local, resident, and remote takes mutations (and `takes rebuild`). */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { isThinClient, loadConfig, type GBrainConfig } from '../core/config.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import type { Action } from '../core/agent-output.ts';
import { parseMutationPrecondition } from '../core/persistence/preconditions.ts';
import { isWriteReceipt } from '../core/persistence/types.ts';
import { currentCliWriteWait } from '../core/persistence/write-wait.ts';
import { maybeDelegateLocalOperation } from '../core/persistence/local-client.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';

const names = ['add', 'update', 'supersede', 'resolve', 'remove'] as const;
export type TakesMutation = typeof names[number];
export function isTakesMutation(value: string): value is TakesMutation { return (names as readonly string[]).includes(value); }
const USAGE_FIX = readFix('Prints every gbrain takes form with its flags.', { argv: ['gbrain', 'takes', '--help'] });
const invalid = (message: string, suggestion: string, fix: Action = USAGE_FIX) => opError('invalid_params', message, suggestion, { fix });
const REQUIRED_USAGE: Record<TakesMutation, string> = {
  add: '--claim "..." --kind fact|take|bet|hunch --who HOLDER', update: '--row N', supersede: '--row N --claim "..."', resolve: '--row N --quality correct|incorrect|partial',
  remove: '--row N',
};

export function parseTakesMutation(args: string[]): { operation: `takes_${TakesMutation}`; params: Record<string, unknown>; sourceId?: string; json: boolean } {
  const [sub, slug, ...rest] = args;
  if (!isTakesMutation(sub) || !slug || slug.startsWith('-')) throw invalid('Usage: gbrain takes add|update|supersede|resolve|remove <slug> [options].',
    isTakesMutation(sub) ? `Name the page slug right after takes ${sub}: gbrain takes ${sub} people/alice-example ${REQUIRED_USAGE[sub]}.`
      : 'Start with the mutation and the page slug, e.g. gbrain takes add people/alice-example --claim "..." --kind take --who alice-example.');
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
    if (seen.has(flag)) throw invalid(`Duplicate option ${flag}.`, `Pass ${flag} once, with the one value you mean.`);
    seen.add(flag);
    if (flag === '--json' || flag === '--force') {
      if (equal >= 0) throw invalid(`${flag} does not accept a value.`, `Write ${flag} on its own, without =value.`);
      if (flag === '--json') json = true; else params.force = true;
      continue;
    }
    const key = fields[flag];
    if (!key) throw invalid(`Unsupported takes mutation option: ${flag}.`,
      `Remove ${flag}; takes ${sub} accepts ${Object.keys(fields).join(', ')}, --json and --force.`);
    const value = equal >= 0 ? raw.slice(equal + 1) : rest[++i];
    if (value === undefined || value.startsWith('--')) throw invalid(`${flag} requires a value.`, `Give ${flag} its value right after it, as ${flag} VALUE or ${flag}=VALUE.`);
    if (key === 'source_id') { sourceId = value; continue; }
    if (['weight', 'value', 'row_num'].includes(key)) {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number) || key === 'row_num' && (!Number.isSafeInteger(number) || number < 1)) throw invalid(`${flag} requires ${key === 'row_num' ? 'a positive integer' : 'a finite number'}.`,
        key === 'row_num' ? `Pass --row as the take's row number from gbrain takes ${slug} --json, e.g. --row 2.` : `Pass ${flag} as a plain number, e.g. ${flag} ${key === 'weight' ? '0.7' : '1000'}.`,
        key === 'row_num' ? readFix(`Lists ${slug}'s takes with their row numbers, read-only.`, { argv: ['gbrain', 'takes', slug, '--json'] }) : USAGE_FIX);
      params[key] = number;
    } else params[key] = key === 'local_dir' ? resolve(value) : value;
  }
  const common = ['slug', 'request_id', 'expected_revision', 'force', 'local_dir'];
  const allowed = sub === 'add' ? ['claim', 'kind', 'holder', 'weight', 'source', 'since']
    : sub === 'update' ? ['row_num', 'weight', 'source', 'since']
    : sub === 'supersede' ? ['row_num', 'claim', 'kind', 'holder', 'weight', 'source', 'since']
    : sub === 'remove' ? ['row_num']
    : ['row_num', 'quality', 'outcome', 'evidence', 'source', 'value', 'unit', 'resolved_by'];
  const flagOf = (key: string) => Object.keys(fields).find(flag => fields[flag] === key) ?? `--${key}`;
  for (const key of Object.keys(params)) if (![...common, ...allowed].includes(key)) throw invalid(`${key} is not supported by takes ${sub}.`,
    `Remove ${flagOf(key)}; takes ${sub} takes ${allowed.map(flagOf).join(', ')} (plus --request-id, --expected-revision, --force and --dir).`);
  for (const key of sub === 'add' ? ['claim', 'kind', 'holder'] : sub === 'supersede' ? ['row_num', 'claim'] : ['row_num']) {
    if (params[key] === undefined || params[key] === '') throw invalid(`Missing ${key === 'holder' ? '--who' : key === 'row_num' ? '--row' : `--${key}`}.`,
      `takes ${sub} needs ${REQUIRED_USAGE[sub]}: gbrain takes ${sub} ${slug} ${REQUIRED_USAGE[sub]}.`,
      key === 'row_num' ? readFix(`Lists ${slug}'s takes with their row numbers, read-only.`, { argv: ['gbrain', 'takes', slug, '--json'] }) : USAGE_FIX);
  }
  if (params.kind !== undefined && !['fact', 'take', 'bet', 'hunch'].includes(String(params.kind))) throw invalid('Invalid --kind. Expected fact, take, bet, or hunch.',
    'Pass --kind as fact, take, bet or hunch, e.g. --kind take.');
  if (sub === 'resolve') {
    if (params.quality !== undefined && params.outcome !== undefined) throw invalid('--quality and --outcome are mutually exclusive.',
      'Pass only --quality correct|incorrect|partial|unresolvable; --outcome is its older true/false alias.');
    if (params.outcome !== undefined) {
      if (params.outcome !== 'true' && params.outcome !== 'false') throw invalid('--outcome must be true or false.',
        'Pass --quality correct|incorrect|partial|unresolvable instead (or --outcome true|false).');
      params.quality = params.outcome === 'true' ? 'correct' : 'incorrect';
      delete params.outcome;
    }
    if (!['correct', 'incorrect', 'partial', 'unresolvable'].includes(String(params.quality))) throw invalid('--quality requires correct, incorrect, partial, or unresolvable.',
      `Pass --quality as correct, incorrect, partial or unresolvable, e.g. gbrain takes resolve ${slug} --row ${String(params.row_num ?? 1)} --quality correct.`);
    if (params.evidence !== undefined && params.source !== undefined && params.evidence !== params.source) throw invalid('--evidence and --source specify different evidence; use one.',
      'Keep --evidence and drop --source (on resolve both name the evidence), or give them the same value.');
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
      if (operation === 'takes_remove') throw invalid('takes remove runs only on the brain host.',
        'Run gbrain takes remove on the brain host; a remote connection cannot remove takes.');
      if (args.some(arg => arg === '--outcome' || arg.startsWith('--outcome='))) console.error('[deprecated] --outcome is the v0.28 alias for --quality. Prefer --quality correct|incorrect|partial in new scripts.');
      if (cli.brain || parsed.sourceId || params.local_dir !== undefined) throw invalid('--brain, --source-id, and --dir require a local brain host; the remote credential selects its source.',
        'Drop --brain, --source-id and --dir on this thin client: the remote connection\'s credential selects the brain and source.',
        { argv: ['gbrain', 'takes', ...args.filter((arg, index) => !['--brain', '--source-id', '--dir'].some(flag => arg === flag || arg.startsWith(`${flag}=`)
          || (args[index - 1] === flag))) ], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'The same takes mutation without the local-host flags; the remote credential picks its source.' });
      result = unpackToolResult(await callRemoteTool(config!, operation, params, { timeoutMs: cli.timeoutMs ?? 30_000, writeWaitMs: currentCliWriteWait().waitMs }));
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
          sourceId: await resolveSourceId(connected, parsed.sourceId ?? null), dryRun: false, writeWaitMs: currentCliWriteWait().waitMs,
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
      else if (operation === 'takes_remove') console.log(`Removed take #${row} from ${params.slug}.`);
      else console.log(`Resolved take #${row} on ${params.slug}: quality=${params.quality}.`);
    }
  } catch (error) {
    if (!await reportPersistenceCliError(error, args.includes('--json'))) {
      console.error(error instanceof Error ? error.message : String(error)); setCliExitVerdict(1);
    }
    if (requestId) console.error(`Retry the same takes ${args[0]} arguments with --request-id ${requestId}.`);
  }
}

/**
 * W9F item 8: `gbrain takes rebuild <slug> [--source-id <id>] [--json]`. A
 * resident owner (`gbrain serve` holding PGLite) runs the `takes_rebuild`
 * operation; otherwise it runs here on the local engine. Both render the same
 * operation result, so JSON, warnings and exit codes match: exit 1 when the
 * page is missing or the rebuild warned.
 */
export async function runTakesRebuild(engine: BrainEngine | (() => Promise<BrainEngine>), args: string[], configOverride?: GBrainConfig): Promise<void> {
  const [slug, ...rest] = args;
  const json = rest.includes('--json');
  if (!slug || slug.startsWith('-')) {
    console.error('Usage: gbrain takes rebuild <slug> [--source-id <id>] [--json]');
    setCliExitVerdict(1);
    return;
  }
  const sourceFlag = rest.indexOf('--source-id');
  const sourceId = sourceFlag >= 0 ? rest[sourceFlag + 1] : undefined;
  try {
    const config = configOverride ?? loadConfig(), cli = getCliOptions();
    if (isThinClient(config)) throw invalid('takes rebuild runs only on the brain host.',
      'Run gbrain takes rebuild on the brain host; a remote connection cannot rebuild the takes index.');
    const params: Record<string, unknown> = { slug, request_id: randomUUID() };
    const delegated = await maybeDelegateLocalOperation('takes_rebuild', params, config, {
      brain: cli.brain, source: sourceId ?? null, timeoutMs: cli.timeoutMs ?? undefined,
    });
    let result: { source_id: string; pagesScanned: number; takesUpserted: number; warnings: string[] };
    if (delegated.handled) result = delegated.result as typeof result;
    else {
      const connected = typeof engine === 'function' ? await engine() : engine;
      const { operations } = await import('../core/operations.ts');
      const op = operations.find(candidate => candidate.name === 'takes_rebuild')!;
      result = await op.handler({ engine: connected, config: config ?? { engine: 'pglite' }, remote: false,
        sourceId: await resolveSourceId(connected, sourceId ?? null), dryRun: false,
        logger: { info: message => console.error(message), warn: message => console.error(message), error: message => console.error(message) },
      }, params) as typeof result;
    }
    if (json) await writeStdoutFinal(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.pagesScanned === 0) console.error(`No page ${slug} in source ${result.source_id}.`);
    else {
      for (const warning of result.warnings) console.error(`[takes rebuild] ${warning}`);
      console.log(`Rebuilt ${result.takesUpserted} take row(s) on ${slug} from its takes fence.`);
    }
    if (result.pagesScanned === 0 || result.warnings.length) setCliExitVerdict(1);
  } catch (error) {
    if (!await reportPersistenceCliError(error, json)) {
      console.error(error instanceof Error ? error.message : String(error)); setCliExitVerdict(1);
    }
  }
}

/** Engine-free parsing and delegation for explicitly local writer administration. */
import { resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { isThinClient, loadConfig, toEngineConfig } from '../core/config.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { OperationError } from '../core/ops/contract.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { runPersistenceAdministration } from '../core/persistence/administration.ts';
import type { PersistenceAdminOperation } from '../core/persistence/admin-contract.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { bigintToStringReplacer } from '../core/utils.ts';

export const WRITER_HELP = `Usage:
  gbrain sources writer status [<source>] [--probe] [--json]
  gbrain sources writer retry-effects <source> --request-id <uuid> [--dry-run] [--json]
  gbrain sources writer claim <source> --path <directory> [administration options] [--dry-run] [--json]
  gbrain sources writer activate --confirm-quiesced [--cleanup-dead-local-locks] [--shared-skills] [administration options] [--dry-run] [--json]
  gbrain sources writer transfer prepare <source> [--self-transfer] [administration options] [--dry-run] [--json]
  gbrain sources writer transfer accept <source> --path <worktree-root> --expected-epoch <n> --manifest <sha256> [--self-transfer] [administration options] [--dry-run] [--json]

Inspect status first. Routine diagnosis, doctor --fix, startup, and maintenance
must not change ownership or activate managed persistence. Read the operator
procedure in docs/architecture/topologies.md before deliberate administration.
Non-dry-run changes require --admin-intent <writer_claim|writer_activate|writer_transfer_prepare|writer_transfer_accept>
matching the action and --expected-state <admin_state from reviewed status>.
These checks also apply to interactive terminals; --yes is not a substitute.
Explicit noninteractive administration is supported. Stale state is rejected.
Use --brain <id> to select a database. Prepare drains the current owner and records
an exact manifest; accept requires that epoch and matching bytes on the successor.
Before activation, upgrade and stop older writers on every host, claim every
filesystem source, and inspect/release remaining legacy locks. --confirm-quiesced
attests quiescence but does not grant administration intent. --dry-run never enables.
Self-transfer is opt-in on both phases and only repairs this host's recorded
canonical root; it never relocates a checkout. Inspect status again after prepare.
Activation may explicitly remove exact dead local legacy holders with
--cleanup-dead-local-locks; expiry alone is never evidence of death.
--shared-skills activates recoverable skill bundles and blocks older writers.
No command takes over an owner based on a stale heartbeat.
retry-effects handles embedding effects only: it reconciles existing complete
vectors or explicitly authorizes one additional bounded retry cycle per request.
Repeating the command never renews that allowance. --dry-run never queues work.
It never changes ownership or activation and needs no topology admin-intent.`;

export const LOCAL_WRITER_HELP = `Usage:
  gbrain auth local-writer list [--limit <1-1000>] [--before <uuid>] [--json]
  gbrain auth local-writer register <cli|stdio> [--source-ids <csv>] [--scopes read,write]
    [--allowed-operations <csv>] [--slug-prefixes <csv>] [--replace] [--dry-run] [--json]
  gbrain auth local-writer revoke <uuid> [--dry-run] [--json]

Use --brain <id> to select a database. Registrations default to all sources and
read/write operations. Existing grants never widen silently: --replace requires
the complete intended grant and revokes the prior registration. Credentials stay
in private local files. CLI is the trusted administration lane; stdio stays remote.
A revoked CLI cannot replace itself through a running owner. Stop that owner and
explicitly register --replace locally to authorize a new principal.`;

type Group = 'writer' | 'local-writer';
export function parsePersistenceAdminArgs(group: Group, args: string[]): {
  operation: PersistenceAdminOperation; params: Record<string, unknown>; brain?: string; json: boolean;
} {
  const positional: string[] = [];
  const params: Record<string, unknown> = {};
  let brain: string | undefined, json = false;
  const values: Record<string, string> = {
    '--path': 'path', '--source': 'source_id', '--expected-epoch': 'expected_epoch', '--manifest': 'manifest',
    '--source-ids': 'source_ids', '--scopes': 'scopes', '--allowed-operations': 'allowed_operations',
    '--slug-prefixes': 'slug_prefixes', '--limit': 'limit', '--before': 'before',
    '--admin-intent': 'admin_intent', '--expected-state': 'expected_state', '--request-id': 'request_id',
  };
  const arrays = new Set(['source_ids', 'scopes', 'allowed_operations', 'slug_prefixes']);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const equal = token.indexOf('=');
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (seen.has(flag)) throw new OperationError('invalid_params', `Duplicate option ${flag}.`);
    seen.add(flag);
    if (['--json', '--dry-run', '--replace', '--probe', '--confirm-quiesced', '--self-transfer', '--cleanup-dead-local-locks', '--shared-skills'].includes(flag)) {
      if (equal >= 0) throw new OperationError('invalid_params', `${flag} does not accept a value.`);
      if (flag === '--json') json = true;
      else params[flag.slice(2).replaceAll('-', '_')] = true;
      continue;
    }
    if (flag !== '--brain' && !values[flag]) throw new OperationError('invalid_params', `Unknown administration option: ${flag}.`);
    const value = equal >= 0 ? token.slice(equal + 1) : args[++i];
    if (value === undefined || value.startsWith('--')) throw new OperationError('invalid_params', `${flag} requires a value.`);
    if (flag === '--brain') { brain = value; continue; }
    const key = values[flag];
    params[key] = arrays.has(key) ? value.split(',').map(part => part.trim()).filter(Boolean)
      : key === 'limit' ? Number(value) : key === 'path' ? resolve(value) : value;
  }
  let operation: PersistenceAdminOperation;
  if (group === 'writer') {
    const verb = positional.shift();
    if (verb === 'status') operation = 'writer_status';
    else if (verb === 'retry-effects') operation = 'writer_retry_effects';
    else if (verb === 'claim') operation = 'writer_claim';
    else if (verb === 'activate') operation = 'writer_activate';
    else if (verb === 'transfer') {
      const phase = positional.shift();
      if (phase !== 'prepare' && phase !== 'accept') throw new OperationError('invalid_params', 'Transfer requires prepare or accept.');
      operation = phase === 'prepare' ? 'writer_transfer_prepare' : 'writer_transfer_accept';
    } else throw new OperationError('invalid_params', 'Writer administration requires status, retry-effects, claim, activate, or transfer.');
    const source = positional.shift();
    if (source !== undefined) {
      if (params.source_id !== undefined) throw new OperationError('invalid_params', 'Specify the source once.');
      params.source_id = source;
    }
  } else {
    const verb = positional.shift();
    if (verb === 'list') operation = 'local_writer_list';
    else if (verb === 'register') { operation = 'local_writer_register'; params.lane = positional.shift(); }
    else if (verb === 'revoke') { operation = 'local_writer_revoke'; params.id = positional.shift(); }
    else throw new OperationError('invalid_params', 'Local writer administration requires list, register, or revoke.');
  }
  if (positional.length) throw new OperationError('invalid_params', `Unexpected argument: ${positional[0]}.`);
  return { operation, params, brain, json };
}

export async function runPersistenceAdminCli(group: Group, args: string[], connected?: BrainEngine): Promise<void> {
  if (!args.length || args.some(arg => arg === '--help' || arg === '-h')) {
    console.log(group === 'writer' ? WRITER_HELP : LOCAL_WRITER_HELP);
    return;
  }
  let owned: BrainEngine | undefined;
  try {
    const parsed = parsePersistenceAdminArgs(group, args);
    const brainId = resolveBrainId(parsed.brain ?? getCliOptions().brain);
    const config = persistenceConfigForBrain(loadConfig(), brainId, brainId === 'host' ? [] : loadMounts());
    if (!config) throw new OperationError('invalid_params', 'No brain is configured. Run gbrain init first.');
    if (isThinClient(config)) throw new OperationError('permission_denied', 'Writer administration runs locally on the selected brain host; an ordinary remote token is not administration authority.');
    const delegated = connected ? { handled: false as const } : await maybeDelegateLocalAdministration(parsed.operation, parsed.params, config,
      { timeoutMs: getCliOptions().timeoutMs ?? undefined });
    let result: unknown;
    if (delegated.handled) result = delegated.result;
    else {
      if (!connected) {
        const { createEngine } = await import('../core/engine-factory.ts');
        owned = await createEngine(toEngineConfig(config));
        await owned.connect(toEngineConfig(config));
      }
      result = await runPersistenceAdministration(connected ?? owned!, parsed.operation, parsed.params, config,
        brainId === 'host' ? 'owner' : 'mounted_database');
    }
    await writeStdoutFinal(JSON.stringify(result, bigintToStringReplacer, 2) + '\n');
  } catch (error) {
    if (!await reportPersistenceCliError(error, args.includes('--json'))) {
      console.error(error instanceof Error ? error.message : String(error));
      setCliExitVerdict(1);
    }
  } finally { if (owned) await finishCliTeardown({ engine: owned, drainTimeoutMs: 1000 }); }
}

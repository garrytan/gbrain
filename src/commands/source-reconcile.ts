import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { isThinClient, loadConfig, toEngineConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { OperationError } from '../core/ops/contract.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { validateSlug } from '../core/utils.ts';
import { runPersistenceAdministration } from '../core/persistence/administration.ts';
import type { PersistenceAdminOperation } from '../core/persistence/admin-contract.ts';
import { assertManagedFilesystemWrite } from '../core/persistence/filesystem-guard.ts';
import { PERSISTENCE_IPC_MAX_BYTES } from '../core/persistence/ipc.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { isWriteRequestId } from '../core/persistence/types.ts';
import { readLocalWriter, withVerifiedLocalRegistration } from '../core/persistence/identity.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';

export const RECONCILE_HELP = `Usage:
  gbrain sources reconcile <source> <slug> --brain <id> [--preview] [--out <new-file>] [--json]
  gbrain sources reconcile <source> <slug> --brain <id> --preview --from <preview-file>
    --decisions <decisions-file> --out <new-file> [--json]
  gbrain sources reconcile <source> <slug> --brain <id> --apply <resolved-preview-file>
    --request-id <uuid> [--json]
  gbrain sources reconcile <source> --brain <id> --audit [--limit <1-100>] [--after <slug>] [--json]
  gbrain sources reconcile <source> <slug> --brain <id> --backups [--limit <1-100>] [--after <request-uuid>] [--json]
  gbrain sources reconcile <source> <slug> --brain <id> --remove-backup <exact-reference> [--json]

Preview is the default and never changes canonical content. --out creates a new
private file outside canonical worktrees; it never replaces an existing file.
Resolve conflicts with JSON-Pointer decisions and inspect the resolved preview
before applying. Apply preserves both originals and uses the current canonical
owner without changing ownership, activation, roots, or sync checkpoints.
The caller must already have a trusted CLI registration whose original and
current grants permit put_page for this source and exact slug.
get_write_request needs its own operation grant; identical apply replay is
available without that receipt helper. Inspect the private artifact's .conflicts
and .result locally before applying; stdout contains only a summary.
Use the same request ID and arguments after a lost response or pending receipt.
After a terminal conflict, make a new preview and use a new request ID.
Retry any originally blocked memory write separately, with its own new ID.
Audit is bounded and read-only; its cursor is not a sync checkpoint.
Backups persist until explicitly removed. Removal deletes that private history,
not the page or immutable receipt, and refuses nonterminal/recovering requests.`;

export interface ReconcileCliArgs {
  operation: PersistenceAdminOperation;
  params: Record<string, unknown>;
  brain?: string;
  json: boolean;
  output?: string;
  input?: string;
  decisions?: string;
}

export function parseReconcileArgs(args: string[]): ReconcileCliArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const boolean = new Set(['--preview', '--audit', '--backups', '--json']);
  const values = new Set(['--brain', '--out', '--from', '--decisions', '--apply', '--request-id', '--limit', '--after', '--remove-backup']);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const equal = token.indexOf('=');
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (flags.has(flag)) throw new OperationError('invalid_params', `Duplicate option ${flag}.`);
    if (boolean.has(flag)) {
      if (equal >= 0) throw new OperationError('invalid_params', `${flag} does not accept a value.`);
      flags.set(flag, true);
      continue;
    }
    if (!values.has(flag)) throw new OperationError('invalid_params', `Unknown reconciliation option: ${flag}.`);
    const value = equal >= 0 ? token.slice(equal + 1) : args[++i];
    if (!value || value.startsWith('-') || value.includes('\0')) throw new OperationError('invalid_params', `${flag} requires a value.`);
    flags.set(flag, value);
  }
  const [source, slug] = positional;
  if (!isValidSourceId(source)) throw new OperationError('invalid_params', 'Reconciliation requires one explicit source ID.');
  const audit = flags.has('--audit');
  const backups = flags.has('--backups') || flags.has('--remove-backup');
  if (positional.length !== (audit ? 1 : 2)) throw new OperationError('invalid_params', audit
    ? 'Audit requires one source and no page slug.' : 'Reconciliation requires one source and one exact page slug.');
  if (slug !== undefined) {
    try { validateSlug(slug); } catch { throw new OperationError('invalid_params', 'Invalid page slug.'); }
    if (/[?*]/.test(slug)) throw new OperationError('invalid_params', 'Reconciliation does not accept page patterns.');
  }
  const applying = flags.has('--apply');
  if (applying && ['--preview', '--from', '--decisions', '--out', '--audit', '--backups', '--remove-backup'].some(flag => flags.has(flag))) {
    throw new OperationError('invalid_params', 'Apply cannot be combined with preview, decisions, output, or audit options.');
  }
  if (!applying && flags.has('--request-id')) throw new OperationError('invalid_params', '--request-id is only valid with --apply.');
  if (applying && !isWriteRequestId(flags.get('--request-id'))) throw new OperationError('invalid_params', 'Apply requires an explicit UUID --request-id.');
  if (flags.has('--decisions') && !flags.has('--from')) throw new OperationError('invalid_params', '--decisions requires --from.');
  if (!audit && !flags.has('--backups') && (flags.has('--limit') || flags.has('--after'))) throw new OperationError('invalid_params', '--limit and --after are only valid with --audit or --backups.');
  if (audit && ['--preview', '--out', '--from', '--decisions'].some(flag => flags.has(flag))) throw new OperationError('invalid_params', 'Audit cannot create or resolve a page preview.');
  if (backups && ['--preview', '--out', '--from', '--decisions', '--apply', '--audit'].some(flag => flags.has(flag)) || flags.has('--backups') && flags.has('--remove-backup')) {
    throw new OperationError('invalid_params', 'Backup administration cannot be combined with preview, apply, audit, or another backup action.');
  }
  const brain = flags.get('--brain') as string | undefined;
  if (brain !== undefined && !isValidSourceId(brain)) throw new OperationError('invalid_params', 'Invalid brain ID.');
  const params: Record<string, unknown> = { source_id: source, ...(slug ? { slug } : {}) };
  if (backups) {
    params.action = flags.has('--backups') ? 'list' : 'remove';
    if (flags.has('--remove-backup')) params.backup_reference = flags.get('--remove-backup');
    if (flags.has('--after') && !isWriteRequestId(flags.get('--after'))) throw new OperationError('invalid_params', 'Backup pagination requires a request UUID cursor.');
  }
  if (applying) params.request_id = flags.get('--request-id');
  if (flags.has('--limit')) {
    const limit = Number(flags.get('--limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new OperationError('invalid_params', 'Audit limit must be an integer from 1 to 100.');
    params.limit = limit;
  }
  if (flags.has('--after')) params.after = flags.get('--after');
  return { operation: audit ? 'writer_reconcile_audit' : backups ? 'writer_reconcile_backups' : applying ? 'writer_reconcile_apply' : 'writer_reconcile_preview',
    params, brain, json: flags.has('--json'), output: flags.get('--out') as string | undefined,
    input: (flags.get('--apply') ?? flags.get('--from')) as string | undefined,
    decisions: flags.get('--decisions') as string | undefined };
}

export function readReconcileJson(path: string): unknown {
  let fd: number | undefined;
  try {
    const target = resolve(path);
    if (!lstatSync(target).isFile()) throw new OperationError('invalid_params', 'Reconciliation input must be a regular JSON file, not a symbolic link.');
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PERSISTENCE_IPC_MAX_BYTES - 65536) throw new OperationError('invalid_params', 'Reconciliation input must be a bounded regular JSON file.');
    const content = readFileSync(fd);
    if (content.byteLength > PERSISTENCE_IPC_MAX_BYTES - 65536) throw new OperationError('invalid_params', 'Reconciliation input exceeds the transport limit.');
    try { return JSON.parse(content.toString('utf8')); }
    catch { throw new OperationError('invalid_params', 'Reconciliation input is not valid JSON.'); }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('invalid_params', 'Cannot read the reconciliation input as a regular JSON file.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function writeReconcilePreview(path: string, preview: unknown): void {
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    const requested = resolve(path);
    const directory = realpathSync(dirname(requested));
    const target = join(directory, basename(requested));
    assertManagedFilesystemWrite(target);
    const content = JSON.stringify(preview, null, 2) + '\n';
    if (Buffer.byteLength(content) > PERSISTENCE_IPC_MAX_BYTES - 65536) throw new OperationError('invalid_params', 'The preview exceeds the artifact size limit.');
    temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertManagedFilesystemWrite(target);
    linkSync(temporary, target);
    if (process.platform !== 'win32') {
      const directoryFd = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('storage_error', 'Cannot create the private preview file. Use an existing directory outside the canonical worktree and a new filename.');
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary) {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

export async function runReconcileCli(args: string[], connected?: BrainEngine): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(RECONCILE_HELP); return; }
  let owned: BrainEngine | undefined;
  try {
    const parsed = parseReconcileArgs(args);
    const brain = parsed.brain ?? getCliOptions().brain;
    if (!brain) throw new OperationError('invalid_params', 'Select the brain explicitly with --brain <id> (use --brain host for the local brain).');
    const config = persistenceConfigForBrain(loadConfig(), brain, brain === 'host' ? [] : loadMounts());
    if (!config) throw new OperationError('invalid_params', 'The selected brain has no configuration.');
    if (isThinClient(config)) throw new OperationError('permission_denied', 'Reconciliation runs on the canonical host using its existing trusted CLI registration. A remote token cannot repair files.');
    if (parsed.input) parsed.params[parsed.operation === 'writer_reconcile_apply' ? 'preview' : 'from'] = readReconcileJson(parsed.input);
    if (parsed.decisions) parsed.params.decisions = readReconcileJson(parsed.decisions);
    if (parsed.output) parsed.params.output_path = resolve(parsed.output);
    const delegated = connected ? { handled: false as const } : await maybeDelegateLocalAdministration(parsed.operation, parsed.params, config,
      { timeoutMs: getCliOptions().timeoutMs ?? undefined });
    let result: Record<string, unknown>;
    if (delegated.handled) result = delegated.result as Record<string, unknown>;
    else {
      if (!connected) {
        const { createEngine } = await import('../core/engine-factory.ts');
        owned = await createEngine(toEngineConfig(config));
        await owned.connect(toEngineConfig(config));
      }
      const engine = connected ?? owned!;
      const registration = await readLocalWriter(engine, 'cli');
      result = await withVerifiedLocalRegistration(engine, registration,
        () => runPersistenceAdministration(engine, parsed.operation, parsed.params));
    }
    const { preview, ...summary } = result;
    if (parsed.output) {
      if (!preview) throw new OperationError('storage_error', 'The owner did not return the requested preview.');
      writeReconcilePreview(parsed.output, preview);
      summary.preview_file = resolve(parsed.output);
    }
    await writeStdoutFinal(JSON.stringify(summary, null, 2) + '\n');
  } catch (error) {
    if (!await reportPersistenceCliError(error, args.includes('--json'))) {
      console.error('Reconciliation could not complete. Inspect the canonical owner before retrying.');
      setCliExitVerdict(1);
    }
  } finally { if (owned) await finishCliTeardown({ engine: owned, drainTimeoutMs: 1000 }); }
}

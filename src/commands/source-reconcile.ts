import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { flushDirectory } from '../core/fs-durable.ts';
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { isThinClient, loadConfig, toEngineConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { readFix, trustedCliRequired } from '../core/ops/op-fix.ts';
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
  gbrain sources reconcile <source> <slug> --brain <id> --preview --auto-additive [--accept-suggested]
    --out <new-file> [--json]
  gbrain sources reconcile <source> <slug> --brain <id> --apply <resolved-preview-file>
    --request-id <uuid> [--json]
  gbrain sources reconcile <source> --brain <id> --audit [--classify] [--limit <1-100>] [--after <slug>] [--json]
  gbrain sources reconcile <source> <slug> --brain <id> --backups [--limit <1-100>] [--after <request-uuid>] [--json]
  gbrain sources reconcile <source> <slug> --brain <id> --remove-backup <exact-reference> [--json]

Preview is the default and never changes canonical content. A database-only
page (no recorded origin, for example one written while the source was unbound)
is previewed against the canonical file at its slug path; apply records that
file as the page's origin. --out creates a new
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
--auto-additive decides only structurally additive drift: an appended contacts
list (every stored entry kept in order), an advanced activity date (updated,
last_*, *_last_used) and fields present on one side only. Inserted body or
timeline lines are suggested, not decided, because an added line can still
contradict an old one; read them in the private preview, then rerun with
--accept-suggested. Anything else (changed or removed text, policy, privacy,
title, type, tags, fences) keeps the preview unready for a person to decide.
Audit is bounded and read-only; its cursor is not a sync checkpoint. --classify
adds each drifted page's structural classification and counts, never values.
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
  const boolean = new Set(['--preview', '--audit', '--backups', '--json', '--auto-additive', '--accept-suggested', '--classify']);
  const values = new Set(['--brain', '--out', '--from', '--decisions', '--apply', '--request-id', '--limit', '--after', '--remove-backup']);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const equal = token.indexOf('=');
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (flags.has(flag)) throw opError('invalid_params', `Duplicate option ${flag}.`, `Pass ${flag} once, then rerun the command.`);
    if (boolean.has(flag)) {
      if (equal >= 0) throw opError('invalid_params', `${flag} does not accept a value.`, `Use ${flag} on its own, without =value, then rerun the command.`);
      flags.set(flag, true);
      continue;
    }
    if (!values.has(flag)) throw opError('invalid_params', `Unknown reconciliation option: ${flag}.`,
      'Reconciliation accepts --brain, --preview, --out, --from, --decisions, --apply, --request-id, --audit, --backups, --remove-backup, --limit, --after and --json; the help in fix shows which forms combine.',
      { fix: readFix('Lists every reconciliation form and its options.', { argv: ['gbrain', 'sources', 'reconcile', '--help'] }) });
    const value = equal >= 0 ? token.slice(equal + 1) : args[++i];
    if (!value || value.startsWith('-') || value.includes('\0')) throw opError('invalid_params', `${flag} requires a value.`,
      `Give ${flag} its value as the next argument or as ${flag}=value; a value cannot start with '-'.`);
    flags.set(flag, value);
  }
  const [source, slug] = positional;
  if (!isValidSourceId(source)) throw opError('invalid_params', 'Reconciliation requires one explicit source ID.',
    'Pass the source ID as the first argument, before the page slug; the command in fix lists registered source IDs.',
    { fix: readFix('Lists the registered sources and their IDs.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  const audit = flags.has('--audit');
  const backups = flags.has('--backups') || flags.has('--remove-backup');
  if (positional.length !== (audit ? 1 : 2)) throw opError('invalid_params', audit
    ? 'Audit requires one source and no page slug.' : 'Reconciliation requires one source and one exact page slug.',
    `An audit takes only the source (${source}); preview, apply and backups take the source and exactly one page slug. Rerun with the matching arguments.`);
  if (slug !== undefined) {
    try { validateSlug(slug); } catch {
      throw opError('invalid_params', 'Invalid page slug.',
        "Pass the page's exact stored slug: no leading '/', '..' segments, backslashes, URL-encoded separators or control characters.");
    }
    if (/[?*]/.test(slug)) throw opError('invalid_params', 'Reconciliation does not accept page patterns.',
      `Reconcile one page at a time by its exact slug; an --audit run for source ${source} lists the pages that need it.`);
  }
  const applying = flags.has('--apply');
  if (applying && ['--preview', '--from', '--decisions', '--out', '--audit', '--backups', '--remove-backup'].some(flag => flags.has(flag))) {
    throw opError('invalid_params', 'Apply cannot be combined with preview, decisions, output, or audit options.',
      'Run apply on its own: the resolved preview file after --apply, --request-id and --brain only. Make or resolve previews in a separate command first.');
  }
  if (!applying && flags.has('--request-id')) throw opError('invalid_params', '--request-id is only valid with --apply.',
    'Drop --request-id: previews, audits and backup listings change nothing and take no request ID.');
  if (applying && !isWriteRequestId(flags.get('--request-id'))) throw opError('invalid_params', 'Apply requires an explicit UUID --request-id.',
    'Add --request-id with a new UUID for a first apply. After a lost response or a pending receipt, reuse the same request_id with the same arguments instead of a new one.');
  if (flags.has('--decisions') && !flags.has('--from')) throw opError('invalid_params', '--decisions requires --from.',
    'Add --from with the preview file the decisions resolve, and --out with a new file for the resolved preview.');
  if (!audit && !flags.has('--backups') && (flags.has('--limit') || flags.has('--after'))) throw opError('invalid_params', '--limit and --after are only valid with --audit or --backups.',
    'Drop --limit and --after, or use them with --audit (source only) or --backups (one page).');
  if (audit && ['--preview', '--out', '--from', '--decisions', '--auto-additive', '--accept-suggested'].some(flag => flags.has(flag))) throw opError('invalid_params', 'Audit cannot create or resolve a page preview.',
    'Run the audit without --preview, --out, --from, --decisions, --auto-additive or --accept-suggested, then preview a page it lists in a separate command.');
  if (flags.has('--classify') && !audit) throw opError('invalid_params', '--classify is only valid with --audit.',
    'Add --audit (with --source), or drop --classify.');
  if ((applying || backups) && (flags.has('--auto-additive') || flags.has('--accept-suggested'))) throw opError('invalid_params', '--auto-additive and --accept-suggested only shape a preview.',
    'Use --auto-additive (and --accept-suggested) with --preview, then apply the written preview with --from.');
  if (flags.has('--accept-suggested') && !flags.has('--auto-additive')) throw opError('invalid_params', '--accept-suggested requires --auto-additive.',
    'Add --auto-additive, or drop --accept-suggested.');
  if (flags.has('--auto-additive') && flags.has('--decisions')) throw opError('invalid_params', '--auto-additive computes its own decisions; omit --decisions.',
    'Drop --decisions, or drop --auto-additive and resolve the preview with --decisions.');
  if (backups && ['--preview', '--out', '--from', '--decisions', '--apply', '--audit'].some(flag => flags.has(flag)) || flags.has('--backups') && flags.has('--remove-backup')) {
    throw opError('invalid_params', 'Backup administration cannot be combined with preview, apply, audit, or another backup action.',
      'Run --backups (list) or --remove-backup (delete one reference) on its own, with only --brain, --limit, --after and --json.');
  }
  const brain = flags.get('--brain') as string | undefined;
  if (brain !== undefined && !isValidSourceId(brain)) throw opError('invalid_params', 'Invalid brain ID.',
    'Pass --brain host for the local brain, or the ID of a mounted brain; the command in fix lists mounted brain IDs.',
    { fix: readFix('Lists the mounted brains and their IDs.', { argv: ['gbrain', 'mounts', 'list', '--json'] }) });
  const params: Record<string, unknown> = { source_id: source, ...(slug ? { slug } : {}) };
  if (backups) {
    params.action = flags.has('--backups') ? 'list' : 'remove';
    if (flags.has('--remove-backup')) params.backup_reference = flags.get('--remove-backup');
    if (flags.has('--after') && !isWriteRequestId(flags.get('--after'))) throw opError('invalid_params', 'Backup pagination requires a request UUID cursor.',
      'Pass --after exactly as the previous backup listing returned its cursor (a request UUID), or omit it to start from the newest backup.');
  }
  if (applying) params.request_id = flags.get('--request-id');
  if (flags.has('--auto-additive')) params.auto_additive = true;
  if (flags.has('--accept-suggested')) params.accept_suggested = true;
  if (flags.has('--classify')) params.classify = true;
  if (flags.has('--limit')) {
    const limit = Number(flags.get('--limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw opError('invalid_params', 'Audit limit must be an integer from 1 to 100.',
      'Pass --limit as a whole number from 1 to 100, or omit it for the default page size.');
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
    if (!lstatSync(target).isFile()) throw opError('invalid_params', 'Reconciliation input must be a regular JSON file, not a symbolic link.',
      'Pass the path of the preview or decisions file itself, not a symbolic link to it.');
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PERSISTENCE_IPC_MAX_BYTES - 65536) throw opError('invalid_params', 'Reconciliation input must be a bounded regular JSON file.',
      `Pass the regular preview file written by --out, or a decisions file under ${PERSISTENCE_IPC_MAX_BYTES - 65536} bytes.`);
    const content = readFileSync(fd);
    if (content.byteLength > PERSISTENCE_IPC_MAX_BYTES - 65536) throw opError('invalid_params', 'Reconciliation input exceeds the transport limit.',
      `Keep the input under ${PERSISTENCE_IPC_MAX_BYTES - 65536} bytes: pass the preview file written by --out unchanged, and only the decisions it needs.`);
    try { return JSON.parse(content.toString('utf8')); }
    catch {
      throw opError('invalid_params', 'Reconciliation input is not valid JSON.',
        'Pass the preview file written by --out unchanged, or a decisions file holding one JSON document; validate it with a JSON parser before rerunning.');
    }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw opError('invalid_params', 'Cannot read the reconciliation input as a regular JSON file.',
      'Check that the file exists, is a regular file and is readable by this user, then rerun with its path.');
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
    if (Buffer.byteLength(content) > PERSISTENCE_IPC_MAX_BYTES - 65536) throw opError('invalid_params', 'The preview exceeds the artifact size limit.',
      `Nothing changed. This page's preview is over the ${PERSISTENCE_IPC_MAX_BYTES - 65536}-byte artifact limit, so it cannot be resolved through reconcile; tell the user the page needs a manual edit of its canonical file.`);
    temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertManagedFilesystemWrite(target);
    linkSync(temporary, target);
    flushDirectory(directory);
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw opError('storage_error', 'Cannot create the private preview file. Use an existing directory outside the canonical worktree and a new filename.',
      'Nothing changed in the brain. Pass --out a new filename in an existing writable directory outside the source checkout; it never replaces an existing file.');
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
    if (!brain) throw opError('invalid_params', 'Select the brain explicitly with --brain <id> (use --brain host for the local brain).',
      'Add --brain host to reconcile the local brain, or --brain with a mounted brain ID from the command in fix.',
      { fix: readFix('Lists the mounted brains and their IDs.', { argv: ['gbrain', 'mounts', 'list', '--json'] }) });
    const config = persistenceConfigForBrain(loadConfig(), brain, brain === 'host' ? [] : loadMounts());
    if (!config) throw opError('invalid_params', 'The selected brain has no configuration.',
      `Brain '${brain}' is not configured on this machine. Use --brain host for the local brain, or a mounted brain ID from the command in fix.`,
      { fix: readFix('Lists the mounted brains and their IDs.', { argv: ['gbrain', 'mounts', 'list', '--json'] }) });
    if (isThinClient(config)) throw trustedCliRequired('Reconciliation runs on the canonical host using its existing trusted CLI registration. A remote token cannot repair files.');
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
      if (!preview) {
        const sourceId = String(parsed.params.source_id);
        throw opError('storage_error', 'The owner did not return the requested preview.',
          `Nothing was written; a preview never changes canonical content. Check the owner of source ${sourceId} with the command in fix, then rerun the preview.`,
          { fix: readFix('Shows the canonical owner and any pending recovery for this source.',
            { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--brain', brain, '--json'] }) });
      }
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

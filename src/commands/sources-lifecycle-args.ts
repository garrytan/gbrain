/** Parse trusted source administration before connecting to the selected datastore. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { OperationError } from '../core/ops/contract.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { msysToNativePath } from '../core/path-confine.ts';
import { isWriteRequestId } from '../core/persistence/types.ts';
import { defaultCloneDir, type AddSourceOpts } from '../core/sources-ops.ts';
import { isValidRepoName } from '../core/github-source.ts';
import { ALL_GOOGLE_SERVICES, DEFAULT_CALENDAR_ID } from '../core/google/types.ts';

export const SOURCE_LIFECYCLE_COMMANDS = ['add', 'remove', 'archive', 'restore', 'purge', 'set-path', 'reclone'] as const;
export function isSourceLifecycleCommand(value: string): boolean {
  return (SOURCE_LIFECYCLE_COMMANDS as readonly string[]).includes(value);
}
const invalid = (message: string) => new OperationError('invalid_params', message);
const absolute = (value: string) => resolve(msysToNativePath(value));

export interface ParsedSourceLifecycle {
  operation: 'source_add' | 'source_lifecycle';
  params: Record<string, unknown>;
  brain?: string;
  legacyOnly: boolean;
  json: boolean;
}

export function parseSourceLifecycleArgs(args: string[], generatedId = randomUUID()): ParsedSourceLifecycle {
  const [verb, ...rest] = args;
  if (!isSourceLifecycleCommand(verb)) throw invalid('Unknown source lifecycle command.');
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const booleans = new Set(['json', 'dry-run', 'yes', 'confirm-destructive', 'keep-storage', 'force',
    'federated', 'no-federated', 'no-federate', 'refederate', 'no-harden']);
  const valued = new Set(['request-id', 'expected-incarnation', 'brain', 'path', 'url', 'name', 'clone-dir',
    'pat-file', 'kind', 'account', 'access', 'token-command', 'token-env', 'services', 'history-days',
    'calendar-id', 'scope', 'repos', 'dir', 'app-id', 'app-pem', 'app-install']);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('-')) { positionals.push(token); continue; }
    if (!token.startsWith('--')) throw invalid(`Unknown option: ${token}.`);
    const equal = token.indexOf('=');
    const key = token.slice(2, equal < 0 ? undefined : equal);
    if (flags.has(key) || values.has(key)) throw invalid(`Duplicate option --${key}.`);
    if (booleans.has(key)) {
      if (equal >= 0) throw invalid(`--${key} does not accept a value.`);
      flags.add(key); continue;
    }
    if (!valued.has(key)) throw invalid(`Unknown option --${key}.`);
    const value = equal < 0 ? rest[++i] : token.slice(equal + 1);
    if (value === undefined || value === '' || value.startsWith('--')) throw invalid(`--${key} requires a value.`);
    values.set(key, value);
  }
  const id = positionals.shift();
  if (!id && verb === 'purge') throw invalid('Managed purge requires an explicit archived source ID. Run sources archived, then sources purge <id> --confirm-destructive.');
  if (!id || !isValidSourceId(id)) throw invalid('An explicit valid source ID is required.');
  const requestId = values.get('request-id') ?? generatedId;
  const incarnation = values.get('expected-incarnation');
  if (!isWriteRequestId(requestId) || incarnation !== undefined && !isWriteRequestId(incarnation)) {
    throw invalid('--request-id and --expected-incarnation must be UUIDs.');
  }
  const dryRun = flags.has('dry-run');
  const params: Record<string, unknown> = { action: verb === 'set-path' ? 'rebind' : verb,
    source_id: id, request_id: requestId, ...(incarnation ? { expected_incarnation: incarnation } : {}),
    ...(dryRun ? { dry_run: true } : {}) };
  const common = new Set(['request-id', 'expected-incarnation', 'brain', 'json', 'dry-run']);
  const allowed = verb === 'add' ? new Set([...common, ...valued, 'federated', 'no-federated', 'force', 'no-harden'])
    : new Set([...common, ...(verb === 'set-path' ? ['path', 'force'] : []),
      ...(['remove', 'purge'].includes(verb) ? ['yes', 'confirm-destructive', 'keep-storage'] : []),
      ...(verb === 'restore' ? ['no-federate', 'refederate'] : [])]);
  for (const key of [...values.keys(), ...flags]) if (!allowed.has(key)) throw invalid(`--${key} does not apply to sources ${verb}.`);
  if (verb === 'set-path') {
    if (positionals.length && values.has('path')) throw invalid('Specify the set-path target once.');
    const target = positionals.shift() ?? values.get('path');
    if (!target) throw invalid('set-path requires the verified successor directory.');
    params.path = absolute(target);
  }
  if (positionals.length) throw invalid(`Unexpected argument: ${positionals[0]}.`);
  if (verb === 'restore') {
    if (flags.has('no-federate') && flags.has('refederate')) throw invalid('Choose one federation setting.');
    params.refederate = !flags.has('no-federate');
  }
  if (verb === 'remove' || verb === 'purge') {
    // --yes must never bypass the populated-source destructive confirmation.
    params.confirm_destructive = flags.has('confirm-destructive');
  }
  if (verb !== 'add') return { operation: 'source_lifecycle', params, brain: values.get('brain'), legacyOnly: false, json: flags.has('json') };

  if (flags.has('federated') && flags.has('no-federated')) throw invalid('Choose one federation setting.');
  const kind = values.get('kind');
  if (kind !== undefined && !['google', 'github'].includes(kind)) throw invalid('Source kind must be github or google.');
  if ([values.has('path'), values.has('url'), kind !== undefined].filter(Boolean).length > 1) throw invalid('--path, --url and --kind are mutually exclusive.');
  const kindOptions = ['account', 'access', 'token-command', 'services', 'history-days', 'calendar-id', 'scope', 'repos', 'dir', 'app-id', 'app-pem', 'app-install', 'token-env'];
  for (const key of kindOptions) if (values.has(key) && !kind) throw invalid(`--${key} requires --kind github or google.`);
  for (const key of ['account', 'access', 'token-command', 'services', 'history-days', 'calendar-id']) {
    if (values.has(key) && kind !== 'google') throw invalid(`--${key} requires --kind google.`);
  }
  for (const key of ['scope', 'repos', 'app-id', 'app-pem', 'app-install']) {
    if (values.has(key) && kind !== 'github') throw invalid(`--${key} requires --kind github.`);
  }
  const number = (key: string, fallback?: number): number | undefined => {
    if (!values.has(key)) return fallback;
    const value = Number(values.get(key));
    if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`--${key} must be a positive integer.`);
    return value;
  };
  const opts: AddSourceOpts = { id, requestId, expectedIncarnation: incarnation,
    name: values.get('name'), localPath: values.has('path') ? absolute(values.get('path')!) : null,
    remoteUrl: values.get('url'), cloneDir: values.has('clone-dir') ? absolute(values.get('clone-dir')!) : undefined,
    federated: flags.has('federated') ? true : flags.has('no-federated') ? false : null, force: flags.has('force') };
  if (kind === 'github') {
    const scope = values.get('scope') ?? 'auto';
    const repos = (values.get('repos') ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (!['auto', 'repos'].includes(scope) || scope === 'repos' && !repos.length || repos.some(repo => !isValidRepoName(repo))) {
      throw invalid('GitHub scope must be auto or repos; repos requires valid owner/name entries.');
    }
    if (values.has('app-id') !== values.has('app-pem')) throw invalid('--app-id and --app-pem are required together.');
    opts.github = { tokenEnv: values.get('token-env') ?? 'GH_TOKEN', handle: '', scope: scope as 'auto' | 'repos', repos,
      dir: absolute(values.get('dir') ?? defaultCloneDir(`${id}-github`)), involvement: true,
      appId: number('app-id'), appPemPath: values.has('app-pem') ? absolute(values.get('app-pem')!) : undefined,
      appInstallId: number('app-install') };
  }
  if (kind === 'google') {
    const account = values.get('account')?.trim().toLowerCase();
    const services = (values.get('services') ?? 'gmail,calendar,contacts').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    const access = values.get('access') ?? 'vault';
    if (!account || !services.length || services.some(service => !(ALL_GOOGLE_SERVICES as readonly string[]).includes(service))) throw invalid('Google requires --account and valid --services.');
    if (!['vault', 'command', 'env'].includes(access) || access === 'command' && !values.has('token-command')
      || access === 'env' && !values.has('token-env') || access === 'vault' && (values.has('token-command') || values.has('token-env'))) {
      throw invalid('Google access must be vault, command with --token-command, or env with --token-env.');
    }
    opts.google = { account, services, historyDays: number('history-days', 90)!, calendarId: values.get('calendar-id') ?? DEFAULT_CALENDAR_ID,
      dir: absolute(values.get('dir') ?? defaultCloneDir(`${id}-google`)), access: access as 'vault' | 'command' | 'env',
      tokenCommand: values.get('token-command'), tokenEnv: values.get('token-env') };
  }
  return { operation: 'source_add', params: { options: opts, request_id: requestId, ...(dryRun ? { dry_run: true } : {}) },
    brain: values.get('brain'), legacyOnly: values.has('pat-file'), json: flags.has('json') };
}

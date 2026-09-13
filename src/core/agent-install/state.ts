/** Filesystem-only contracts shared by the in-agent installer and recovery. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { GBrainConfig } from '../config.ts';
import { shouldDropAgentEnv } from './environment.ts';
import { shellQuote } from '../mcp-registration.ts';

export class AgentInstallError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'AgentInstallError'; }
}

export type AgentHarness = 'grok-bot' | 'muse';
export interface InstallArtifact {
  source_ref: string;
  version: string;
  bun_version: string;
  bun_sha256: string;
  package_sha256: string;
  /** Relative paths, confined to the installation root. */
  directory: string;
  cli: string;
  setup_entry: string;
}
export interface AgentInstallReceipt {
  format_version: 1;
  installation_id: string;
  root: string;
  harness: AgentHarness;
  source_id: string;
  database_path: string;
  state: 'installing' | 'ready';
  created_at: string;
  updated_at: string;
  artifact?: InstallArtifact;
  /** Kept until the installed runtime has successfully migrated existing memory. */
  pending_runtime_migration?: boolean;
  initialized: boolean;
  schema_version?: number;
  adopted: boolean;
  /** Only these trees belong to this installer. External sources are inventoried separately. */
  managed_paths: string[];
  owned_files: Record<string, string>;
  pending_files?: Record<string, { before: string | null; after: string }>;
  native: { skill_id: string; routine_id: string; verification: 'unverified' };
  capabilities?: { transport: 'local-cli'; engine: 'pglite'; finite_database_probe: 'passed'; native_runtime: 'unverified' };
  search_mode_confirmation_required: boolean;
  /** Non-secret, durable recovery and enablement state. Older receipts derive it on repair. */
  pending_steps?: string[];
  recovery?: { command: string; action: string };
  last_failure?: { code: string; at: string };
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Reject ambiguous roots and every existing symlink component before any write. */
export function checkedRoot(input: string): string {
  if (!isAbsolute(input) || input.split(/[\\/]/).includes('..') || input.includes('\0') || /[\r\n]/.test(input)) {
    throw new AgentInstallError('invalid_root', 'Storage root must be an absolute path without traversal or control characters.');
  }
  const root = resolve(input);
  if (dirname(root) === root) throw new AgentInstallError('invalid_root', 'The filesystem root cannot be an installation root.');
  assertNoSymlinks(root);
  return root;
}

export function assertNoSymlinks(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new AgentInstallError('symlink_path', `Refusing a symlink in managed path: ${current}`);
      if (current !== path && !stat.isDirectory()) throw new AgentInstallError('invalid_path', `Parent is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function confinedPath(root: string, relative: string): string {
  if (!relative || isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..') || /[\0\r\n]/.test(relative)) {
    throw new AgentInstallError('invalid_relative_path', `Invalid managed relative path: ${JSON.stringify(relative)}`);
  }
  const target = resolve(root, relative);
  if (!target.startsWith(root + sep)) throw new AgentInstallError('path_escape', 'Managed path escapes storage root.');
  assertNoSymlinks(target);
  return target;
}

export function privateWrite(path: string, contents: string | Uint8Array, mode = 0o600): void {
  assertNoSymlinks(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', mode);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* no temporary file after a failed write */ }
    throw error;
  }
}

export function installReceiptPath(root: string): string { return join(root, '.gbrain', 'agent-install', 'receipt.json'); }

/** A data inventory cannot include installer internals, credentials or another inventory root. */
export function checkedManagedPaths(root: string, input: unknown): string[] {
  if (!Array.isArray(input) || input.some(path => typeof path !== 'string')) throw new AgentInstallError('invalid_managed_paths', 'Invalid managed path inventory.');
  const paths = input as string[];
  for (const path of paths) {
    confinedPath(root, path);
    const first = path.split('/')[0];
    if (['.gbrain', 'runtime', 'bin', 'restore-receipt.json'].includes(first) || first.startsWith('.restore-') || first.startsWith('.gbrain-')) throw new AgentInstallError('invalid_managed_paths', 'Managed data cannot include installer, credential or restore state.');
  }
  if (paths.some((path, i) => paths.some((other, j) => i !== j && (path === other || path.startsWith(other + '/'))))) throw new AgentInstallError('invalid_managed_paths', 'Managed inventory paths overlap.');
  return paths;
}

export function readInstallReceipt(root: string): AgentInstallReceipt | null {
  const path = installReceiptPath(root);
  assertNoSymlinks(path);
  if (!existsSync(path)) return null;
  let value: AgentInstallReceipt;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new AgentInstallError('invalid_receipt', `Unreadable install receipt: ${path}. Preserve it and recover before setup.`); }
  if (!value || value.format_version !== 1 || !value.installation_id || !['grok-bot', 'muse'].includes(value.harness) || typeof value.source_id !== 'string' || !value.native || !value.owned_files || typeof value.owned_files !== 'object' || !['installing', 'ready'].includes(value.state)) {
    throw new AgentInstallError('invalid_receipt', `Unsupported or invalid install receipt: ${path}`);
  }
  if (value.root !== root || value.database_path !== join(root, '.gbrain', 'brain.pglite')) {
    throw new AgentInstallError('receipt_mismatch', 'Install receipt belongs to a different root/database; use backup restore to relocate it.');
  }
  checkedManagedPaths(root, value.managed_paths);
  for (const relative of [...Object.keys(value.owned_files), ...Object.keys(value.pending_files ?? {})]) confinedPath(root, relative);
  if (value.artifact) {
    for (const relative of [value.artifact.directory, value.artifact.cli, value.artifact.setup_entry]) confinedPath(root, relative);
  }
  return value;
}

export function writeInstallReceipt(receipt: AgentInstallReceipt): void {
  receipt.updated_at = new Date().toISOString();
  receipt.pending_steps = [
    ...(!receipt.artifact ? ['install_runtime'] : []),
    ...(!receipt.initialized ? ['initialize_database'] : []),
    ...(receipt.pending_runtime_migration ? ['migrate_database'] : []),
    ...(receipt.state !== 'ready' ? ['verify_local_installation'] : []),
    ...(receipt.search_mode_confirmation_required ? ['confirm_search_mode'] : []),
    'enable_native_skill', 'enable_native_maintenance', 'verify_new_conversation',
  ];
  const helper = join(receipt.root, 'bin', 'gbrain-setup');
  let helperOwned = false;
  try {
    assertNoSymlinks(helper);
    helperOwned = sha256(readFileSync(helper)) === receipt.owned_files['bin/gbrain-setup'];
  } catch { /* A missing or changed helper is repaired from the recorded package. */ }
  const ref = /^[a-f0-9]{40}$/.test(receipt.artifact?.source_ref ?? '') ? receipt.artifact!.source_ref : 'latest-stable';
  const command = helperOwned ? `bash ${shellQuote(helper)} --json`
    : `curl -fsSL https://raw.githubusercontent.com/garrytan/gbrain/${ref}/scripts/setup-in-agent.sh | bash -s -- --root ${shellQuote(receipt.root)} --harness ${shellQuote(receipt.harness)} --json`;
  receipt.recovery = { command, action: receipt.last_failure
    ? 'Preserve memory and owned files. Resolve the reported failure, then run the recorded repair command; never remove a live lock.'
    : 'Run the recorded command to repair software without reinitializing memory. Complete pending native and search-mode steps separately.' };
  privateWrite(installReceiptPath(receipt.root), JSON.stringify(receipt, null, 2) + '\n');
}

export type ConfigState = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'present'; config: GBrainConfig };
export function readFileConfigState(path: string): ConfigState {
  if (!existsSync(path)) return { kind: 'absent' };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' };
    return { kind: 'present', config: value };
  } catch { return { kind: 'invalid' }; }
}

/** A child receives only its selected installation's GBrain environment. */
export function isolatedAgentEnv(root: string, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && !shouldDropAgentEnv(key)) env[key] = value;
  }
  return { ...env, GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: 'default', GBRAIN_SKIP_STARTUP_HOOKS: '1' };
}

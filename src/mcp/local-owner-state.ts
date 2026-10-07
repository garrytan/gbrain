/** Private discovery for the automatically started, brain-keyed local MCP owner. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configPath, loadConfig } from '../core/config.ts';
import { assertNoSymlinks } from '../core/agent-install/state.ts';
import { protectNewBackupPath } from '../core/backup/private-path.ts';
import { VERSION } from '../version.ts';

export interface LocalOwnerRecord { protocol: 1; pid: number; port: number; secret: string; identity: string }
export function ownerProof(secret: string, role: 'server' | 'client', challenge: string, payload: string): string {
  return createHmac('sha256', secret).update(`${role}:${challenge}:${payload}`).digest('hex');
}
export function localOwnerPaths() {
  const cfg = loadConfig();
  if (cfg?.engine !== 'pglite' || !cfg.database_path) return null;
  const database = realpathSync(cfg.database_path);
  const directory = join(database, '.gbrain-mcp-owner');
  // Different installations/settings must not silently borrow the first launcher's config.
  const identity = createHash('sha256').update(JSON.stringify([database, realpathSync(configPath()), cfg, VERSION])).digest('hex');
  return { database, directory, record: join(directory, 'owner.json'), lock: `${database}.mcp-start.lock`, identity };
}

/** Validate existing paths as well as newly created paths; never repair a planted directory. */
export async function prepareOwnerDirectory(directory: string): Promise<void> {
  assertNoSymlinks(directory);
  let created = false;
  try { mkdirSync(directory, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (created) await protectNewBackupPath(directory, 'directory');
  assertNoSymlinks(directory);
  const st = lstatSync(directory);
  if (!st.isDirectory()) throw new Error('Invalid local MCP owner directory');
  if (process.platform !== 'win32') {
    if (st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error('Local MCP owner directory must be private');
  } else {
    // ACL verification is also required when reusing a previous owner's directory.
    const script = `$ErrorActionPreference='Stop'; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[IO.Directory]::GetAccessControl($env:GBRAIN_OWNER_DIRECTORY); if (!$a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $u.Value) { throw 'Owner mismatch' }; foreach ($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { if ($r.AccessControlType -ne 'Allow' -or $r.IdentityReference.Value -notin @($u.Value,'S-1-5-18')) { throw 'Not private' } }; [Console]::Write('private')`;
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, GBRAIN_OWNER_DIRECTORY: directory }, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
    if (out !== 'private') throw new Error('Cannot verify private local MCP owner directory');
  }
}

export function readOwnerRecord(path: string): LocalOwnerRecord | null {
  try {
    assertNoSymlinks(path);
    const st = lstatSync(path);
    if (!st.isFile() || st.nlink !== 1 || st.size > 4096) return null;
    if (process.platform !== 'win32' && (st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600)) return null;
    const r = JSON.parse(readFileSync(path, 'utf8'));
    if (r.protocol !== 1 || !Number.isInteger(r.pid) || r.pid <= 0 || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535
      || typeof r.secret !== 'string' || !/^[a-f0-9]{64}$/.test(r.secret) || typeof r.identity !== 'string') return null;
    return r;
  } catch { return null; }
}

export function writeOwnerRecord(path: string, record: Omit<LocalOwnerRecord, 'secret'>): LocalOwnerRecord {
  const r = { ...record, secret: randomBytes(32).toString('hex') };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(r), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return r;
}

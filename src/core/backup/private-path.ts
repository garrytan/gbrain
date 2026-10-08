import { execFile } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentInstallError, assertNoSymlinks } from '../agent-install/state.ts';

const protect = `
$ErrorActionPreference = 'Stop'
$path = $env:GBRAIN_BACKUP_PRIVATE_PATH
if ($env:GBRAIN_BACKUP_PRIVATE_KIND -notin @('directory', 'file')) { throw 'Unexpected path kind' }
$directory = $env:GBRAIN_BACKUP_PRIVATE_KIND -eq 'directory'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sids = @($user.Value)
if ($user.Value -ne 'S-1-5-18') { $sids += 'S-1-5-18' }
$attributes = [IO.File]::GetAttributes($path)
if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw 'Unexpected path type' }
if ($directory) {
  if ([IO.Directory]::GetFileSystemEntries($path).Length -ne 0) { throw 'Directory is not empty' }
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  if ([IO.FileInfo]::new($path).Length -ne 0) { throw 'File is not empty' }
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in $sids) {
  $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
if ($directory) { [IO.Directory]::SetAccessControl($path, $acl) } else { [IO.File]::SetAccessControl($path, $acl) }
$actual = if ($directory) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Owner or inheritance mismatch' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $sids.Count) { throw 'Unexpected access rules' }
$seen = @{}
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $sids -notcontains $rule.IdentityReference.Value -or $seen.ContainsKey($rule.IdentityReference.Value) -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne 'None') { throw 'Access rule mismatch' }
  $seen[$rule.IdentityReference.Value] = $true
}
[Console]::Write('private')
`;

export async function protectNewBackupPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    assertNoSymlinks(path);
    const before = lstatSync(path, { bigint: true });
    if (!before.ino || (kind === 'directory' ? !before.isDirectory() || readdirSync(path).length !== 0 : !before.isFile() || before.size !== 0n || before.nlink !== 1n)) throw new Error('Expected a new empty path with stable identity');
    const result = await new Promise<string>((resolve, reject) => {
      let inputFailed = false;
      const child = execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(protect, 'utf16le').toString('base64')], {
          env: { ...process.env, GBRAIN_BACKUP_PRIVATE_PATH: path, GBRAIN_BACKUP_PRIVATE_KIND: kind },
          encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
        }, (error, stdout) => error || inputFailed ? reject(error ?? new Error('Private path input failed')) : resolve(stdout));
      const inputFailure = () => { inputFailed = true; child.kill(); };
      if (!child.stdin) { inputFailure(); return; }
      child.stdin.once('error', inputFailure);
      try { child.stdin.end(); } catch { inputFailure(); }
    });
    assertNoSymlinks(path);
    const after = lstatSync(path, { bigint: true });
    if (result !== 'private' || before.dev !== after.dev || before.ino !== after.ino
      || before.birthtimeNs !== after.birthtimeNs
      || (kind === 'directory' ? readdirSync(path).length !== 0 : after.size !== 0n || after.nlink !== 1n)) throw new Error('Private path verification failed');
  } catch {
    throw new AgentInstallError('private_backup_path_unavailable', 'Windows could not establish owner-only backup access (plus SYSTEM). No payload was written to this new path. Use a new private destination on a local filesystem with Windows ACL support, ensure built-in Windows PowerShell is available and permitted, then retry. Existing files and parent permissions were not changed.');
  }
}

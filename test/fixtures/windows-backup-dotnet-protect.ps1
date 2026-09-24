$ErrorActionPreference = 'Stop'
$path = $env:GBRAIN_BACKUP_PRIVATE_PATH
if ($env:GBRAIN_BACKUP_PRIVATE_KIND -ne 'directory') { throw 'Expected a directory probe' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sids = @($user.Value)
if ($user.Value -ne 'S-1-5-18') { $sids += 'S-1-5-18' }
$attributes = [IO.File]::GetAttributes($path)
if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Unexpected path type' }
if ([IO.Directory]::GetFileSystemEntries($path).Length -ne 0) { throw 'Directory is not empty' }
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in $sids) {
  $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($path, $acl)
$actual = [IO.Directory]::GetAccessControl($path)
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Owner or inheritance mismatch' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $sids.Count) { throw 'Unexpected access rules' }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $sids -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne 'None') { throw 'Access rule mismatch' }
}
[Console]::Write('private')

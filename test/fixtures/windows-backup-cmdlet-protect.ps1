
$ErrorActionPreference = 'Stop'
$path = $env:GBRAIN_BACKUP_PRIVATE_PATH
$directory = $env:GBRAIN_BACKUP_PRIVATE_KIND -eq 'directory'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sids = @($user.Value, 'S-1-5-18' | Select-Object -Unique)
$item = Get-Item -LiteralPath $path -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory) { throw 'Unexpected path type' }
if ($directory) {
  if ([IO.Directory]::GetFileSystemEntries($path).Length -ne 0) { throw 'Directory is not empty' }
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  if ($item.Length -ne 0) { throw 'File is not empty' }
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in $sids) {
  $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
$actual = Get-Acl -LiteralPath $path
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Owner or inheritance mismatch' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $sids.Count) { throw 'Unexpected access rules' }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $sids -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne 'None') { throw 'Access rule mismatch' }
}
[Console]::Write('private')

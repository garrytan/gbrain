param([string]$Name, [string]$Ready)
$ErrorActionPreference = 'Stop'
$security = New-Object System.Security.AccessControl.MutexSecurity
$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object System.Security.AccessControl.MutexAccessRule($everyone, 'FullControl', 'Deny')
$security.AddAccessRule($rule)
$created = $false
$mutex = New-Object System.Threading.Mutex($false, $Name, [ref]$created, $security)
try {
  if (-not $created) { throw 'Fixture mutex already exists' }
  [System.IO.File]::WriteAllText($Ready, 'ready')
  [Console]::ReadLine() | Out-Null
} finally { $mutex.Dispose() }

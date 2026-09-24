$ErrorActionPreference = 'Stop'
$path = $env:GBRAIN_TEST_ACL_PATH
$attributes = [IO.File]::GetAttributes($path)
if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected reparse point' }
$a = if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
$u = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value
$rules = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$json = [Text.StringBuilder]::new()
[void]$json.Append('{"user":"').Append($u).Append('","owner":"').Append($owner).Append('","protected":').Append($a.AreAccessRulesProtected.ToString().ToLowerInvariant()).Append(',"rules":[')
for ($i = 0; $i -lt $rules.Count; $i++) {
  if ($i -ne 0) { [void]$json.Append(',') }
  $rule = $rules[$i]
  [void]$json.Append('{"sid":"').Append($rule.IdentityReference.Value).Append('","inherited":').Append($rule.IsInherited.ToString().ToLowerInvariant()).Append(',"allow":"').Append($rule.AccessControlType.ToString()).Append('","rights":').Append(([int]$rule.FileSystemRights).ToString([Globalization.CultureInfo]::InvariantCulture)).Append(',"inheritance":').Append(([int]$rule.InheritanceFlags).ToString([Globalization.CultureInfo]::InvariantCulture)).Append(',"propagation":').Append(([int]$rule.PropagationFlags).ToString([Globalization.CultureInfo]::InvariantCulture)).Append('}')
}
[Console]::Write($json.Append(']}').ToString())

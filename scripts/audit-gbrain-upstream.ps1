[CmdletBinding()]
param(
  [string]$UpstreamPath = 'D:\cursor-claude\gbrain',
  [string]$BaselineFile,
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

if (-not $BaselineFile) {
  $BaselineFile = Join-Path $PSScriptRoot '..\.upstream\gbrain-baseline.json'
}

function Invoke-GitReadOnly {
  param(
    [Parameter(Mandatory)]
    [string]$Repository,
    [Parameter(Mandatory)]
    [string[]]$Arguments
  )

  $result = & git -C $Repository @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed in $Repository`n$($result -join "`n")"
  }
  return @($result)
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$upstreamRoot = [System.IO.Path]::GetFullPath($UpstreamPath)
$baselinePath = [System.IO.Path]::GetFullPath($BaselineFile)

if (-not (Test-Path -LiteralPath $upstreamRoot -PathType Container)) {
  throw "Upstream repository does not exist: $upstreamRoot"
}
if (-not (Test-Path -LiteralPath $baselinePath -PathType Leaf)) {
  throw "Baseline file does not exist: $baselinePath"
}

$baseline = Get-Content -LiteralPath $baselinePath -Raw -Encoding UTF8 | ConvertFrom-Json
$reviewedHead = [string]$baseline.reviewed_head
$upstreamHead = (@(Invoke-GitReadOnly -Repository $upstreamRoot -Arguments @('rev-parse', 'HEAD')))[0].Trim()
$upstreamBranch = (@(Invoke-GitReadOnly -Repository $upstreamRoot -Arguments @('branch', '--show-current')))[0].Trim()

Invoke-GitReadOnly -Repository $upstreamRoot -Arguments @('cat-file', '-e', "$reviewedHead^{commit}") | Out-Null
$commits = @(Invoke-GitReadOnly -Repository $upstreamRoot -Arguments @(
  'log',
  '--no-merges',
  '--date=short',
  '--pretty=format:%h`t%ad`t%s',
  "$reviewedHead..$upstreamHead"
))
$changedFiles = @(Invoke-GitReadOnly -Repository $upstreamRoot -Arguments @(
  'diff',
  '--name-only',
  $reviewedHead,
  $upstreamHead
))

$riskRules = [ordered]@{
  'data-and-migrations' = '^(src/core/(engine|pglite-engine|postgres-engine|migrate|types)|src/(schema\.sql|core/.*schema))'
  'retrieval-and-rag' = '^src/core/search/'
  'dream-and-workers' = '^(src/core/cycle|src/commands/(dream|autopilot|jobs)|src/core/minions/)'
  'mcp-and-auth' = '^(src/mcp/|src/commands/serve-http|src/core/operations)'
  'admin-console' = '^(admin/|src/admin/)'
  'desktop' = '^(desktop/|electron/)'
  'docs-and-tests' = '^(docs/|test/)'
}

$riskRows = foreach ($rule in $riskRules.GetEnumerator()) {
  $matches = @($changedFiles | Where-Object { $_ -match $rule.Value })
  if ($matches.Count -gt 0) {
    [pscustomobject]@{
      Area = $rule.Key
      Count = $matches.Count
      Examples = ($matches | Select-Object -First 5) -join ', '
    }
  }
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('# GBrain upstream read-only audit')
$lines.Add('')
$lines.Add("- PMBrain: $projectRoot")
$lines.Add("- Upstream: $upstreamRoot")
$lines.Add("- Upstream branch: $upstreamBranch")
$lines.Add("- Reviewed baseline: ``$reviewedHead``")
$lines.Add("- Current upstream HEAD: ``$upstreamHead``")
$lines.Add("- New commits: $($commits.Count)")
$lines.Add("- Changed files: $($changedFiles.Count)")
$lines.Add('')
$lines.Add('## New commits')
$lines.Add('')
if ($commits.Count -eq 0) {
  $lines.Add('- None.')
} else {
  foreach ($commit in $commits) {
    $lines.Add("- $commit")
  }
}
$lines.Add('')
$lines.Add('## Risk areas')
$lines.Add('')
if (@($riskRows).Count -eq 0) {
  $lines.Add('- No known risk areas changed.')
} else {
  $lines.Add('| Area | Files | Examples |')
  $lines.Add('|---|---:|---|')
  foreach ($row in $riskRows) {
    $lines.Add("| $($row.Area) | $($row.Count) | $($row.Examples) |")
  }
}
$lines.Add('')
$lines.Add('## Grafting gates')
$lines.Add('')
$lines.Add('1. Classify as A copy, B algorithm plus adapter, C minimal diff, or D defer.')
$lines.Add('2. Never auto merge, rebase, or cherry-pick. This script reads both repositories only.')
$lines.Add('3. Confirm design before changing engines, migrations, or shared CLI capabilities.')
$lines.Add('4. Record source commit, PMBrain files, tests, compatibility, and rollback.')
$lines.Add('5. Update .upstream/gbrain-baseline.json manually after review is complete.')

$report = $lines -join [Environment]::NewLine
if ($OutputPath) {
  $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
  $outputDirectory = Split-Path -Parent $resolvedOutput
  if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
  }
  Set-Content -LiteralPath $resolvedOutput -Value $report -Encoding UTF8
  Write-Output "Audit report written: $resolvedOutput"
} else {
  Write-Output $report
}

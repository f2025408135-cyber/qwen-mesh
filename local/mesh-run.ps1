# mesh-run.ps1 - one-command hybrid qwen deep research:
#   local fire (residential IP, ~1-3 min pod time) -> GitHub Actions poll + collect
# Usage:
#   .\local\mesh-run.ps1 -Topic "<scoping-template topic>" [-Account 1] [-MaxWait 1800] [-Wait]
param(
  [Parameter(Mandatory = $true)][string]$Topic,
  [string]$Focus = "",
  [string]$Audience = "",
  [int]$Account = 1,
  [int]$MaxWait = 1800,
  [switch]$Wait,
  [string]$OutDir = "F:\FREE CODE BY MOIZ\.opencode\skills\qwen\outputs",
  [string]$Repo = "f2025408135-cyber/qwen-mesh"
)
$ErrorActionPreference = "Stop"

# 1) fire locally
$env:FIRE_TOPIC = $Topic
$env:FIRE_FOCUS = $Focus
$env:FIRE_AUDIENCE = $Audience
$env:FIRE_ACCOUNT_INDEX = "$Account"
$fire = node "$PSScriptRoot\fire-local.mjs" 2>$null | Where-Object { $_ -like '{*' } | Select-Object -Last 1
if (-not $fire) { Write-Error "fire-local produced no JSON (see [fire] stderr above)"; exit 1 }
$f = $fire | ConvertFrom-Json
if (-not $f.ok) { Write-Error "fire failed: $($f.error)"; exit 1 }
Write-Output "fired: chat_id=$($f.chat_id) account=$($f.account_index) notice_seen=$($f.notice_seen)"

# 2) dispatch remote collector
$topicArg = $Topic -replace '"', "'"
gh workflow run deep-research.yml -R $Repo `
  -f mode=collect -f chat_id=$($f.chat_id) -f account_index=$Account `
  -f max_wait_seconds=$MaxWait -f topic="collect $($f.chat_id)"
Start-Sleep -Seconds 10
$runId = gh run list -R $Repo --workflow deep-research -L 1 --json databaseId -q ".[0].databaseId"
Write-Output "collect run: https://github.com/$Repo/actions/runs/$runId"

if (-not $Wait) { Write-Output "watch/download later: gh run watch $runId -R $Repo; gh run download $runId -R $Repo -n research-$runId -D <dir>"; exit 0 }

# 3) wait + collect
gh run watch $runId -R $Repo --exit-status --interval 20
if ($LASTEXITCODE -ne 0) { Write-Error "collect run failed - check the run log"; exit 1 }
$tmp = Join-Path $env:TEMP "qwen-mesh-$runId"
gh run download $runId -R $Repo -n "research-$runId" -D $tmp
$res = Get-Content (Join-Path $tmp "result.json") -Raw | ConvertFrom-Json

# 4) save per the qwen-deepresearch save protocol + verify
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$mdPath = Join-Path $OutDir "qwen-research-$ts.md"
Copy-Item (Join-Path $tmp "report.md") $mdPath -Force
$pdfSrc = Join-Path $tmp "report.pdf"
$pdfPath = "n/a"
if (Test-Path $pdfSrc) { $pdfPath = Join-Path $OutDir "qwen-research-$ts.pdf"; Copy-Item $pdfSrc $pdfPath -Force }
$head = (Get-Content $mdPath -TotalCount 1)
$bytes = (Get-Item $mdPath).Length
Write-Output ""
Write-Output "Done."
Write-Output "- What: deep research (chat $($f.chat_id), account $($f.account_index), $($res.references_count) refs, remote collect $($res.elapsed_sec)s)"
Write-Output "- Files:"
Write-Output "  - $mdPath ($bytes bytes)"
Write-Output "  - $pdfPath"
Write-Output "- Verified: md head = $head"
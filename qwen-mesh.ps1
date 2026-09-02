# qwen-mesh.ps1 - single-command deep research (fire + collect + save)
#
# Usage:
#   .\qwen-mesh.ps1 "your fully-scoped research topic here"
#   .\qwen-mesh.ps1 "topic" -Account 2 -Wait
#   .\qwen-mesh.ps1 -Wave @("topic1","topic2","topic3") -Wait
#   .\qwen-mesh.ps1 "topic" -DryRun
#
param(
  [Parameter(Position=0)][string]$Topic,
  [string[]]$Wave,
  [int]$Account = 0,
  [int]$MaxWait = 1500,
  [switch]$Wait,
  [switch]$DryRun,
  [string]$OutDir = "F:\FREE CODE BY MOIZ\.opencode\skills\qwen\outputs",
  [string]$MeshDir = "F:\FREE CODE BY MOIZ\services\remote-mesh",
  [string]$Repo = "f2025408135-cyber/qwen-mesh",
  [string]$EnvFile = "F:\FREE CODE BY MOIZ\.env.freecode"
)

# --- helpers (ASCII only for PS 5.1 compat) ---
function Fail($msg) { Write-Error $msg; exit 1 }
function Log($msg) { Write-Output "[qwen-mesh] $msg" }

# Pull the newest report for an account from the PRIVATE repo (reports never public).
# Returns a hashtable { md, pdf, result } file paths, or $null if not found.
function Get-PrivateReport([int]$acct) {
  $priv = "f2025408135-cyber/qwen-research"
  if (-not $env:GH_TOKEN) { try { $env:GH_TOKEN = (gh auth token 2>$null).Trim() } catch { } }
  $tmp = Join-Path $env:TEMP "qwen-mesh-pull-$acct"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  git clone --quiet --depth 1 "https://x-access-token:$env:GH_TOKEN@github.com/$priv.git" $tmp 2>$null
  if (-not (Test-Path (Join-Path $tmp "reports"))) { return $null }
  $files = Get-ChildItem (Join-Path $tmp "reports") -Filter "*acct$acct.*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending
  $md = $files | Where-Object { $_.Extension -eq ".md" } | Select-Object -First 1
  $pdf = $files | Where-Object { $_.Extension -eq ".pdf" } | Select-Object -First 1
  $rj = $files | Where-Object { $_.Extension -eq ".result.json" } | Select-Object -First 1
  if (-not $md) { return $null }
  return @{ md = $md.FullName; pdf = $pdf.FullName; result = $rj.FullName; dir = $tmp }
}

# --- validate inputs ---
$hasWave = $Wave -and $Wave.Count -gt 0
if (-not $Topic -and -not $hasWave) { Fail "Provide a topic or -Wave @('t1','t2')" }
if ($hasWave -and $Topic) { Fail "Use -Topic for single or -Wave for multi; not both" }

# --- pre-flight checks ---
Log "pre-flight checks..."

# 1) Chrome
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Fail "chrome.exe not found" }
Log "chrome: OK"

# 2) gh auth
$env:GH_TOKEN = (gh auth token 2>$null)
if (-not $env:GH_TOKEN) { Fail "gh not authenticated (run: gh auth login)" }
$who = gh api user -q ".login" 2>$null
Log "gh auth: $who"

# 3) Node
$nodeVer = node --version 2>$null
if (-not $nodeVer) { Fail "node not found" }
Log "node: $nodeVer"

# 4) Env file
if (-not (Test-Path $EnvFile)) { Fail "env file not found: $EnvFile" }
Log "env: OK"

# 5) JWT validity probe (quick: create a chat, 401 = expired)
Log "probing JWT validity..."
$probeEnv = @{ FIRE_ACCOUNT_INDEX = "1"; FIRE_TOPIC = "preflight probe"; FIRE_CAP_SECONDS = "10"; FIRE_ENV_FILE = $EnvFile }
foreach ($k in $probeEnv.Keys) { Set-Item "env:$k" $probeEnv[$k] }
$probeOut = node "$MeshDir\local\fire-local.mjs" 2>$null | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
if ($probeOut) {
  $probe = $probeOut | ConvertFrom-Json
  if ($probe.ok -and $probe.completions_status -eq 200) {
    Log "JWT: VALID (completions 200)"
  } elseif ($probe.ok) {
    Log "JWT: OK (completions_status=$($probe.completions_status) - stream timeout is normal)"
  } else {
    Log "JWT: EXPIRED or INVALID - $($probe.error)"
    Log "Fix: re-harvest the account, then: gh secret set QWEN_JWT_1 -R $Repo"
    Fail "JWT invalid - cannot proceed"
  }
} else {
  Log "JWT probe: no JSON output (fire-local failed to start)"
}

Log "pre-flight PASSED"
Write-Output ""

# --- single topic mode ---
function Run-Single($topicText, $acct) {
  if ($acct -eq 0) { $acct = 1 }

  if ($DryRun) {
    Log "DRY RUN: would fire topic='$topicText' account=$acct max_wait=$MaxWait"
    return
  }

  # fire
  Log "FIRE: account=$acct topic=$($topicText.Substring(0, [Math]::Min(80, $topicText.Length)))..."
  $env:FIRE_TOPIC = $topicText
  $env:FIRE_ACCOUNT_INDEX = "$acct"
  $env:FIRE_CAP_SECONDS = "300"
  $env:FIRE_ENV_FILE = $EnvFile
  $fireJson = node "$MeshDir\local\fire-local.mjs" 2>$null | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
  if (-not $fireJson) { Fail "fire-local produced no output" }
  $fire = $fireJson | ConvertFrom-Json
  if (-not $fire.ok) { Fail "fire failed: $($fire.error)" }
  Log "fired: chat=$($fire.chat_id) completions=$($fire.completions_status) seen=$($fire.notice_seen)"

  # dispatch collect
  Log "dispatching collect..."
  $chatIdStr = "$($fire.chat_id)"
  $acctStr = "$acct"
  $maxWaitStr = "$MaxWait"
  gh workflow run deep-research.yml -R $Repo -f "mode=collect" -f "chat_id=$chatIdStr" -f "account_index=$acctStr" -f "max_wait_seconds=$maxWaitStr" -f "topic=collect" 2>$null
  Start-Sleep -Seconds 8
  $runId = gh run list -R $Repo --workflow deep-research -L 1 --json databaseId -q ".[0].databaseId"
  Log "collect run: https://github.com/$Repo/actions/runs/$runId"

  if (-not $Wait) {
    Log "run 'gh run watch $runId -R $Repo --exit-status' to monitor"
    return @{ ok = $true; run_id = $runId; chat_id = $fire.chat_id }
  }

  # watch
  Log "watching collect..."
  gh run watch $runId -R $Repo --exit-status --interval 20
  if ($LASTEXITCODE -ne 0) { Fail "collect run failed" }

  # download from PRIVATE repo
  $rep = Get-PrivateReport $acct
  if (-not $rep) { Fail "no report in private repo for account $acct" }
  if ($rep.result) { $res = Get-Content $rep.result -Raw | ConvertFrom-Json }

  # save
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  $mdDst = "$OutDir\qwen-research-$ts.md"
  $pdfDst = "$OutDir\qwen-research-$ts.pdf"
  Copy-Item $rep.md $mdDst -Force
  if ($rep.pdf) { Copy-Item $rep.pdf $pdfDst -Force }

  # verify
  $head = Get-Content $mdDst -TotalCount 1
  $bytes = (Get-Item $mdDst).Length
  $refs = $res.references_count
  Log "DONE: $refs refs, $bytes bytes, elapsed $($res.elapsed_sec)s"
  Write-Output ""
  Write-Output "DONE"
  Write-Output "  refs: $refs"
  Write-Output "  md:   $mdDst ($bytes bytes)"
  Write-Output "  pdf:  $pdfDst"
  Write-Output "  head: $head"
  return @{ ok = $true; run_id = $runId; chat_id = $fire.chat_id; md = $mdDst; refs = $refs }
}

# --- wave mode (parallel) ---
function Run-Wave($topics, $startAcct) {
  $results = @()
  $chatIds = @()
  $fired = 0
  foreach ($t in $topics) {
    $fired++
    $acct = if ($startAcct -gt 0) { $startAcct } else { $fired }
    if ($acct -gt 5) { $acct = (($fired - 1) % 5) + 1 }
    Log "--- WAVE FIRE $fired/$($topics.Count) (account $acct) ---"
    $env:FIRE_TOPIC = $t
    $env:FIRE_ACCOUNT_INDEX = "$acct"
    $env:FIRE_CAP_SECONDS = "300"
    $env:FIRE_ENV_FILE = $EnvFile
    $fireJson = node "$MeshDir\local\fire-local.mjs" 2>$null | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
    if ($fireJson) {
      $f = $fireJson | ConvertFrom-Json
      if ($f.ok) {
        Log "fired: chat=$($f.chat_id) acct=$acct seen=$($f.notice_seen)"
        $chatIds += @{ chat = $f.chat_id; acct = $acct; topic = $t }
      } else { Log "FIRE FAILED: $($f.error)" }
    } else { Log "FIRE FAILED: no output" }
  }

  if ($chatIds.Count -eq 0) { Fail "no fires succeeded" }

  # dispatch all collects
  Log "dispatching $($chatIds.Count) collects..."
  foreach ($c in $chatIds) {
    $cChat = "$($c.chat)"
    $cAcct = "$($c.acct)"
    $cMaxWait = "$MaxWait"
    gh workflow run deep-research.yml -R $Repo -f "mode=collect" -f "chat_id=$cChat" -f "account_index=$cAcct" -f "max_wait_seconds=$cMaxWait" -f "topic=wave" 2>$null
  }
  Start-Sleep -Seconds 12
  $runs = gh run list -R $Repo --workflow deep-research -L $chatIds.Count --json databaseId -q ".[].databaseId"
  Log "$($runs.Count) collect runs dispatched"

  if (-not $Wait) {
    Log "watch with: gh run watch <run_id> -R $Repo --exit-status"
    return
  }

  # wait for all
  foreach ($runId in $runs) {
    Log "watching run $runId..."
    gh run watch $runId -R $Repo --exit-status --interval 20 2>$null
  }

  # download all (from PRIVATE repo)
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  $idx = 0
  foreach ($runId in $runs) {
    $idx++
    $acctForRun = $chatIds[$idx-1].acct
    $rep = Get-PrivateReport $acctForRun
    if ($rep) {
      if ($rep.result) { $res = Get-Content $rep.result -Raw | ConvertFrom-Json }
      $safeTopic = ($chatIds[$idx-1].topic -replace '[^a-zA-Z0-9]','-').Substring(0, [Math]::Min(40, $chatIds[$idx-1].topic.Length))
      $mdDst = "$OutDir\qwen-research-$safeTopic-$ts.md"
      Copy-Item $rep.md $mdDst -Force
      if ($rep.pdf) { Copy-Item $rep.pdf "$OutDir\qwen-research-$safeTopic-$ts.pdf" -Force }
      $head = Get-Content $mdDst -TotalCount 1
      $bytes = (Get-Item $mdDst).Length
      Log "WAVE $idx/$($runs.Count): $safeTopic -> $bytes bytes, $($res.references_count) refs"
    } else {
      Log "WAVE $idx/$($runs.Count): NO REPORT in private repo for acct $acctForRun"
    }
  }
  Write-Output ""
  Log "WAVE COMPLETE: $($runs.Count) reports saved to $OutDir"
}

# --- execute ---
if ($hasWave) {
  Run-Wave $Wave $Account
} else {
  Run-Single $Topic $Account
}

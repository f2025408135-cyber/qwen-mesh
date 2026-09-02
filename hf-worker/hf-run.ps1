# hf-run.ps1 - run a compute task on the free HF ZeroGPU space.
# The space is private, so requests need a signed URL (fetched from the space
# page iframe - or use hf access token via /gradio_api which may skip sign).
#
# Usage:
#   .\hf-run.ps1 -Script "print(2+3)"
#   .\hf-run.ps1 -Cmd "uname -a"          (shell commands not supported on
#                                          ZeroGPU - use Script instead)
#   .\hf-run.ps1 -Script "import torch; print(torch.cuda.is_available())" -GPU
param(
  [string]$Script = "",
  [switch]$GPU
)
$ErrorActionPreference = "Stop"
$sigFile = "C:\Users\hp\AppData\Local\Temp\opencode\hf-sig.txt"
if (-not (Test-Path $sigFile)) { Write-Error "no signed URL cached - open the space page in Opera first"; exit 1 }
$sig = Get-Content $sigFile -Raw
$BASE = "https://oxmoiz-qwen-mesh-agent.hf.space"
$SIGQ = "?__sign=$sig"

if ($GPU) { $task = "{`"gpu`": true}" }
elseif ($Script) { $task = (@{ script = $Script } | ConvertTo-Json -Compress) }
else { Write-Error "provide -Script or -GPU"; exit 1 }

$body = @{ data = @($task); event_data = $null } | ConvertTo-Json -Depth 5
$r = Invoke-WebRequest -Uri "$BASE/gradio_api/call/run_task$SIGQ" -Method POST -Headers @{ "Content-Type"="application/json" } -Body $body -TimeoutSec 120 -UseBasicParsing
$eid = (($r.Content | ConvertFrom-Json).event_id)
for ($i=0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 3
  try {
    $res = Invoke-WebRequest -Uri "$BASE/gradio_api/call/run_task/$eid$SIGQ" -TimeoutSec 60 -UseBasicParsing
    if ($res.Content -match "event: complete") {
      # extract the data array
      $dataMatch = [regex]::Match($res.Content, 'data: (\[.*\])')
      if ($dataMatch.Success) { $dataJson = $dataMatch.Groups[1].Value | ConvertFrom-Json; $dataJson[0] }
      break
    }
  } catch { }
}
Write-Output ""
Write-Output "Done."
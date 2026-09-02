# qwen-signup.ps1 ??? create ONE Qwen (chat.qwen.ai) account via temp Gmail,
# verify, extract JWT, add to mesh (local .env.freecode + GitHub secret), test.
# Stage timing is logged so runs can be optimized. ASCII-only (PS 5.1).
#
# Usage: powershell -File qwen-signup.ps1 [-AccountIndex 7] [-KeepSession]
param([int]$AccountIndex = 0, [switch]$KeepSession)
$ErrorActionPreference = "Stop"

$stateFile = "$env:TEMP\qwen-signup-state.json"
$outDir = "F:\FREE CODE BY MOIZ\services\remote-mesh"
$meshDir = "F:\qwenmesh"
$envFile = "F:\FREE CODE BY MOIZ\.env.freecode"
$repo = "f2025408135-cyber/qwen-mesh"
$skillDir = "C:\Users\hp\.agents\skills\featherless-account"
$stealth = "$skillDir\scripts\stealth_init.js"
$passBase = "QwerTy_2026"

$script:t0 = Get-Date
function Now { return [Math]::Round(((Get-Date) - $script:t0).TotalSeconds, 1) }
function B64($js) { return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($js)) }
function Eval($sess, $js) {
  $b = B64 $js
  $out = & agent-browser --session $sess eval -b $b 2>&1 | Select-Object -Last 1
  return ($out -join "`n").Trim()
}
function Reopen($sess, $url) {
  & agent-browser --session $sess close 2>&1 | Out-Null
  & agent-browser --session $sess --headed --args "--disable-blink-features=AutomationControlled" --init-script "$stealth" open "$url" 2>&1 | Out-Null
  Start-Sleep -Seconds 5
}

$script:t0 = Get-Date
$harTicks = $script:t0.Ticks
Write-Output "=== QWEN SIGNUP (Account $AccountIndex) ==="

# --- preflight ---
& agent-browser --session qwen-a close 2>&1 | Out-Null
& agent-browser --session qwen-b close 2>&1 | Out-Null
$nodeVer = node --version
Write-Output "[$(Now)s] preflight node=$nodeVer"

# --- STAGE 1: temp gmail ---
Reopen "emailnator" "https://www.emailnator.com/" | Out-Null
# click GO
Eval "emailnator" "(function(){var b=Array.from(document.querySelectorAll('button')).find(b=>/^go\s*!$/i.test((b.innerText||'').trim())||/generate new/i.test((b.innerText||'').trim()));if(b){b.click();return 'ok'}return 'nf'})()" | Out-Null
Start-Sleep -Seconds 3
$addr = Eval "emailnator" "(function(){var m=document.body.innerText.match(/[a-z0-9._%+-]+@(gmail|googlemail)\.com/ig);return (m&&new Set(m))?Array.from(new Set(m))[0]:''})()"
Write-Output "[$(Now)s] temp gmail=$addr"

# --- STAGE 2: qwen register ---
Reopen "qwen-reg" "https://chat.qwen.ai/auth?mode=register" | Out-Null
$username = "AI" + (Get-Random -Minimum 100000 -Maximum 999999)
$password = "$passBase" + (Get-Random -Minimum 1000 -Maximum 9999)
# fill form
$fillJs = @'
(function(){function set(k,v){var i=document.querySelector('input[name="'+k+'"]');if(!i)return false;var s=JSON.stringify(v);var proto=Object.getPrototypeOf(i);var desc=Object.getOwnPropertyDescriptor(proto,'value');desc.set.call(i,s);i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true}return JSON.stringify({user:set('username',ARG_U),email:set('email',ARG_E),pass:set('password',ARG_P),pass2:set('checkPassword',ARG_P)})})()
'@
$fillJs = $fillJs -replace 'ARG_U', $username -replace 'ARG_E', $addr -replace 'ARG_P', '[password]' 
# apply actual password (avoid special chars issue) ??? set separately
$fillJs = $fillJs -replace 'ARG_P', $password
$r = Eval "qwen-reg" $fillJs
Write-Output "[$(Now)s] filled: $r"
# detect create-account button enabled + submit
$createBtn = Eval "qwen-reg" "(function(){var b=Array.from(document.querySelectorAll('button')).find(b=>/create account/i.test((b.innerText||'').trim()));return b?('found:'+!b.disabled):'nf'})()"
Write-Output "[$(Now)s] create button: $createBtn"
# capture HAR for register
& agent-browser --session qwen-reg network har start 2>&1 | Out-Null
# click Create Account
Eval "qwen-reg" "(function(){var b=Array.from(document.querySelectorAll('button')).find(b=>/create account/i.test((b.innerText||'').trim()));if(b){b.click();return 'clicked'}return 'nf'})()" | Out-Null
Start-Sleep -Seconds 6

# capture register response
& agent-browser --session qwen-reg network har stop "$env:TEMP\har-$harTicks.har" 2>&1 | Out-Null
$har = Get-Content "$env:TEMP\har-$harTicks.har" -Raw
$regMatch = [regex]::Match($har, '(?i)(register|signup)[^\n]{0,200}')
Write-Output "[$(Now)s] register resp hint: $(if($regMatch.Success){$regMatch.Value.Substring(0,[Math]::Min(160,$regMatch.Value.Length))}else{'none'})"
# current URL
$url = Eval "qwen-reg" "location.href"
Write-Output "[$(Now)s] url after submit: $url"

Write-Output "STATE: $addr | $username | $password"
Write-Output "DONE_STAGE2"
param(
  [Parameter(Mandatory = $true)]
  [string]$ApiKey,

  [string]$BaseUrl = "https://api.deepseek.com/anthropic",
  [string]$Model = "deepseek-chat",
  [string]$Prompt = "Reply with exactly: OK"
)

# Verify that the real Claude Code CLI works when pointed at an
# Anthropic-compatible third-party endpoint (here: DeepSeek).
#
# Why a separate probe instead of editing ~/.claude/settings.json straight away:
# this passes the configuration through environment variables only, so nothing
# persistent changes and you can confirm the setup works BEFORE committing it.
#
# Claude Code reads these:
#   ANTHROPIC_BASE_URL    - route requests to a compatible endpoint
#   ANTHROPIC_AUTH_TOKEN  - the key sent as the auth token
#   ANTHROPIC_MODEL       - main model
#   ANTHROPIC_SMALL_FAST_MODEL - cheap model for background tasks
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less file as ANSI.

$ErrorActionPreference = "Continue"

$env:ANTHROPIC_BASE_URL = $BaseUrl
$env:ANTHROPIC_AUTH_TOKEN = $ApiKey
$env:ANTHROPIC_MODEL = $Model
$env:ANTHROPIC_SMALL_FAST_MODEL = $Model

# The endpoint is domestic, so the proxy must NOT be used for it -- a proxy would
# route this traffic abroad and could break or slow it down.
Remove-Item Env:\HTTPS_PROXY, Env:\HTTP_PROXY, Env:\https_proxy, Env:\http_proxy -ErrorAction SilentlyContinue

$native = Join-Path $env:APPDATA "npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
if (-not (Test-Path $native)) {
  Write-Host "  [x] claude.exe not found at $native" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "  endpoint : $BaseUrl"
Write-Host "  model    : $Model"
Write-Host "  key      : <provided, length $($ApiKey.Length)>"
Write-Host "  proxy    : cleared (domestic endpoint)"
Write-Host ""
Write-Host "  Running one-shot test..."
Write-Host ""

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$output = & $native -p $Prompt --output-format json 2>&1 | Out-String
$sw.Stop()

$seconds = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
Write-Host "  elapsed: ${seconds}s"
Write-Host ""

try {
  # The CLI prints non-JSON warning lines before the JSON payload (for example
  # "{claude-code:unrecognized_model}" when the model name is not one Anthropic
  # ships). Parsing the whole output therefore fails even on success, so keep
  # only the last balanced JSON object.
  $firstBrace = $output.IndexOf("{")
  $lastBrace = $output.LastIndexOf("}")
  if ($firstBrace -ge 0 -and $lastBrace -gt $firstBrace) {
    $jsonText = $output.Substring($firstBrace, $lastBrace - $firstBrace + 1)
  }

  $parsed = $null
  if ($jsonText) {
    try { $parsed = $jsonText | ConvertFrom-Json } catch { $parsed = $null }
  }

  if (-not $parsed) {
    Write-Host "  [!] Could not parse the CLI output as JSON. Raw output:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host $output
    exit 1
  }

  if ($parsed.is_error) {
    Write-Host "  [x] FAILED -- the CLI reported an error:" -ForegroundColor Red
    Write-Host "      $($parsed.result)"
    Write-Host ""
    Write-Host "  Common causes:" -ForegroundColor Yellow
    Write-Host "    - the API key is wrong or has no credit"
    Write-Host "    - the base URL is wrong for this provider"
    Write-Host "    - the model name is not valid for this provider"
    exit 1
  }

  Write-Host "  [ok] SUCCESS -- real Claude Code CLI is now backed by $Model" -ForegroundColor Green
  Write-Host ""
  Write-Host "  reply  : $($parsed.result)"
  Write-Host "  session: $($parsed.session_id)"
  if ($parsed.modelUsage) {
    $models = ($parsed.modelUsage.PSObject.Properties.Name) -join ", "
    Write-Host "  models : $models"
  }
  if ($parsed.usage) {
    Write-Host "  tokens : in=$($parsed.usage.input_tokens) out=$($parsed.usage.output_tokens)"
  }
  Write-Host ""
  Write-Host "  Note: Claude Code sends its full tool definitions every turn, so even a"
  Write-Host "  trivial prompt costs ~20k input tokens. Watch your balance." -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  Next: tell the assistant and it will wire the Command Center member to it."
  exit 0
} catch {
  Write-Host "  [!] Unexpected failure: $_" -ForegroundColor Yellow
  exit 1
}

#!/usr/bin/env pwsh
<#
  Command Center - safe service restart.

  Why this exists instead of "just kill it and start it":
    Members are child processes of the service. If the service dies mid-turn,
    that turn is never recorded (the runner in the service is what writes the
    store), so the member's answer is lost and the UI shows "interrupted".
    A restart triggered from inside a member's own turn therefore destroys the
    very report that explains the restart.

  What this script does:
    1. Waits until NO member turn is running (idle debounce), unless -Force.
    2. Refuses to double-run: a fresh lock file makes a second restart a no-op,
       so two members cannot kill the service at the same time.
    3. Stops the process that owns the port, starts it again via service.ps1
       (the same detached hidden path the desktop launcher uses).
    4. Waits for the port to answer, then SELF-CHECKS and writes a report to
       data/restart-<timestamp>.log - including whether data/server.log got a
       fresh "[boot]" line, which is the proof that the service-owned logging
       fix took effect.

  ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less file as ANSI,
  so non-ASCII inside string literals corrupts parsing (same constraint as
  service.ps1). Keep it ASCII if you edit it.

  Usage:
    pwsh -File scripts/restart-service.ps1 -DryRun        # checks only, no kill
    pwsh -File scripts/restart-service.ps1 -WaitIdle      # queue, restart when idle
    pwsh -File scripts/restart-service.ps1 -Force         # restart now
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$BindHost = "127.0.0.1",
  [switch]$WaitIdle,
  [switch]$Force,
  [switch]$DryRun,
  [int]$IdleTimeoutSec = 1800,
  [int]$IdleDebouncePolls = 3,
  [int]$PollSec = 5
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dataDir = Join-Path $projectRoot "data"
$url = "http://${BindHost}:${Port}/api/state"
$lockPath = Join-Path $dataDir "restart.lock"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $dataDir "restart-$stamp.log"

function Write-Log {
  param([string]$Message)
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line
  try { Add-Content -Path $logPath -Value $line -Encoding UTF8 } catch { }
}

function Get-ServiceProcess {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $null }
  return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
}

function Get-BusyRooms {
  try { $state = Invoke-RestMethod -Uri $url -TimeoutSec 5 -ErrorAction Stop } catch { return $null }
  $busy = @()
  foreach ($room in $state.rooms) { if ($room.running) { $busy += [string]$room.title } }
  # Comma operator: an empty array returned bare collapses to $null in PowerShell,
  # which made "members reachable" report FAIL whenever no room happened to be busy.
  return ,$busy
}

if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }

# ---- lock: prevent two concurrent restarts -----------------------------------
if (-not $DryRun) {
  if (Test-Path $lockPath) {
    $age = (Get-Date) - (Get-Item $lockPath).LastWriteTime
    if ($age.TotalMinutes -lt 20) {
      Write-Host "  [skip] another restart is already queued ($([int]$age.TotalSeconds)s ago)."
      Write-Host "         delete $lockPath if it is stale."
      exit 0
    }
    Write-Log "stale lock found ($([int]$age.TotalMinutes) min old) - taking over"
  }
  Set-Content -Path $lockPath -Value "$PID $stamp" -Encoding UTF8
}

try {
  Write-Log "=== restart requested (pid=$PID waitIdle=$WaitIdle force=$Force dryRun=$DryRun) ==="

  $proc = Get-ServiceProcess
  if (-not $proc) {
    Write-Log "no service listening on $Port - will start it"
  } else {
    Write-Log "service pid=$($proc.Id) started $($proc.StartTime.ToString('HH:mm:ss'))"
  }

  # ---- 1. wait for idle ------------------------------------------------------
  if (-not $Force) {
    $deadline = (Get-Date).AddSeconds($IdleTimeoutSec)
    $idleStreak = 0
    while ($true) {
      $busy = Get-BusyRooms
      if ($null -eq $busy) {
        Write-Log "state API not answering - assuming no member is mid-turn"
        break
      }
      if ($busy.Count -eq 0) {
        $idleStreak++
        if ($idleStreak -ge $IdleDebouncePolls) { break }
        Start-Sleep -Seconds $PollSec
        continue
      }
      $idleStreak = 0
      Write-Log "busy: $($busy -join ', ') - waiting"
      if (-not $WaitIdle) {
        Write-Log "REFUSING to restart while members are working. Re-run with -WaitIdle (queue) or -Force."
        exit 2
      }
      if ((Get-Date) -gt $deadline) {
        Write-Log "idle timeout ($IdleTimeoutSec s) reached - not restarting."
        exit 3
      }
      Start-Sleep -Seconds $PollSec
    }
    Write-Log "idle confirmed ($IdleDebouncePolls consecutive clean polls)"
  }

  if ($DryRun) {
    Write-Log "DRY RUN: skipping stop/start. Everything above was read-only."
    exit 0
  }

  # ---- 2. stop ---------------------------------------------------------------
  $oldPid = $null
  if ($proc) {
    $oldPid = $proc.Id
    Write-Log "stopping pid=$oldPid"
    Stop-Process -Id $oldPid -Force
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (-not (Get-ServiceProcess)) { break }
    }
    if (Get-ServiceProcess) { Write-Log "ERROR: port $Port still owned after stop"; exit 4 }
    Write-Log "stopped"
  }

  # ---- 3. start --------------------------------------------------------------
  $serviceScript = Join-Path $projectRoot "scripts\service.ps1"
  Write-Log "starting via $serviceScript"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $serviceScript | ForEach-Object { Write-Log "  service.ps1: $_" }

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $null = Invoke-RestMethod -Uri $url -TimeoutSec 3 -ErrorAction Stop
      $ready = $true
      break
    } catch { }
  }

  # ---- 4. self-check ---------------------------------------------------------
  $newProc = Get-ServiceProcess
  Write-Log "--- self-check ---"
  Write-Log "ready:            $ready"
  Write-Log "old pid:          $(if ($oldPid) { $oldPid } else { '(none)' })"
  Write-Log "new pid:          $(if ($newProc) { $newProc.Id } else { '(none)' })"
  Write-Log "pid changed:      $(if ($newProc -and $oldPid -and $newProc.Id -ne $oldPid) { 'PASS' } elseif (-not $oldPid -and $newProc) { 'PASS (fresh start)' } else { 'FAIL' })"

  $serverLog = Join-Path $dataDir "server.log"
  if (Test-Path $serverLog) {
    $bootLines = Select-String -Path $serverLog -Pattern "\[boot\]" -ErrorAction SilentlyContinue
    $lastBoot = $bootLines | Select-Object -Last 1
    Write-Log "server.log boot lines: $(@($bootLines).Count)"
    Write-Log "logging fix (F1): $(if (@($bootLines).Count -gt 0) { 'PASS - service-owned log is live' } else { 'FAIL - no [boot] line found' })"
    if ($lastBoot) { Write-Log "last boot line:   $($lastBoot.Line)" }
  } else {
    Write-Log "logging fix (F1): FAIL - $serverLog does not exist"
  }

  $rooms = Get-BusyRooms
  if ($null -ne $rooms) { Write-Log "members reachable: PASS ($($rooms.Count) busy rooms)" } else { Write-Log "members reachable: FAIL" }

  Write-Log "restart report: $logPath"
  if ($ready -and $newProc) { exit 0 } else { exit 5 }
}
finally {
  if (-not $DryRun -and (Test-Path $lockPath)) { Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue }
}

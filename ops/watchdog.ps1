param(
    [int]$IntervalSec = 5,
    [int]$MaxRestartsPer15Min = 4,
    [string]$ServerDir = ''
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($ServerDir)) { $ServerDir = if ($env:MC_SERVER_DIR) { $env:MC_SERVER_DIR } else { 'D:\server' } }
$ServerDir = $ServerDir.TrimEnd('\', '/')
$OpsDir    = $PSScriptRoot
$DataDir   = Join-Path $OpsDir 'data'
$LogDir    = Join-Path $ServerDir 'logs'
$StateFile = Join-Path $DataDir 'state.json'
$PidFile   = Join-Path $DataDir 'server.pid'
$WatchLog  = Join-Path $LogDir 'watchdog.log'

New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null

function Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $WatchLog -Value $line -Encoding UTF8
}

function Read-State {
    if (Test-Path $StateFile) {
        try { return Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    return [pscustomobject]@{ desired = $false; restarts = @(); lastCrash = $null }
}
function Write-State($s) { $s | ConvertTo-Json -Depth 8 | Set-Content -Path $StateFile -Encoding UTF8 }

function Get-ServerProcess {
    if (Test-Path $PidFile) {
        $raw = (Get-Content $PidFile -Raw).Trim()
        if ($raw -match '^\d+$') {
            $p = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -eq 'java') { return $p }
        }
    }
    return (Get-Process -Name java -ErrorAction SilentlyContinue |
        Where-Object { try { $_.Path -like "$ServerDir*" } catch { $false } } |
        Select-Object -First 1)
}

function Start-Server {
    $java = Join-Path $ServerDir 'java\bin\java.exe'
    $consoleScript = Join-Path $OpsDir 'server-console.ps1'
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $consoleScript, '-ServerDir', $ServerDir) -WorkingDirectory $ServerDir -WindowStyle Normal -PassThru
    Start-Sleep -Seconds 3
    $javaProc = Get-ServerProcess
    if ($javaProc) { $javaProc.Id | Set-Content $PidFile -Encoding ASCII }
    else { $p.Id | Set-Content $PidFile -Encoding ASCII }
    return $p
}

Log "watchdog started (pid $PID, interval ${IntervalSec}s)"
$pid | Set-Content (Join-Path $DataDir 'watchdog.pid') -Encoding ASCII

$lastKnownRunning = $null
$crashRecorded = $false

while ($true) {
    try {
        $state = Read-State
        $desired = [bool]$state.desired
        $proc = Get-ServerProcess
        $running = [bool]$proc

        if ($lastKnownRunning -eq $true -and -not $running -and $desired -and -not $crashRecorded) {
            $tail = ''
            $logPath = Join-Path $LogDir 'latest.log'
            if (-not (Test-Path $logPath) -or (Get-Item -LiteralPath $logPath).Length -eq 0) { $logPath = Join-Path $LogDir 'console.log' }
            if (Test-Path $logPath) { $tail = ((Get-Content -LiteralPath $logPath -Tail 40 -Encoding UTF8) -join "`n") }
            $crash = [pscustomobject]@{
                at   = (Get-Date).ToString('o')
                tail = $tail
            }
            $state | Add-Member -Force -NotePropertyName lastCrash -NotePropertyValue $crash
            Write-State $state
            Log "CRASH detected (process gone while desired=true)"
            $crashRecorded = $true
        }
        if ($running) { $crashRecorded = $false }

        if ($desired -and -not $running) {
            $recent = @($state.restarts | Where-Object { ([datetime]$_).ToUniversalTime() -gt (Get-Date).ToUniversalTime().AddMinutes(-15) })
            if ($recent.Count -ge $MaxRestartsPer15Min) {
                Log "RESTART LIMIT reached ($($recent.Count) in 15min) - giving up, manual intervention required"
                $state | Add-Member -Force -NotePropertyName desired -NotePropertyValue $false
                Write-State $state
            }
            else {
                Log "server down (desired=true) - restarting"
                try {
                    $p = Start-Server
                    $state = Read-State
                    $restarts = @($state.restarts) + @((Get-Date).ToString('o'))
                    if ($restarts.Count -gt 50) { $restarts = $restarts[-50..-1] }
                    $state | Add-Member -Force -NotePropertyName restarts -NotePropertyValue $restarts
                    $state | Add-Member -Force -NotePropertyName desired -NotePropertyValue $true
                    Write-State $state
                    Log "restarted (pid $($p.Id))"
                }
                catch {
                    Log "restart failed: $($_.Exception.Message)"
                }
            }
            Start-Sleep -Seconds 15
        }

        $lastKnownRunning = $running
    }
    catch {
        Log "watchdog loop error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $IntervalSec
}

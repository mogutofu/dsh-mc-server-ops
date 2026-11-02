param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'players', 'say', 'cmd', 'start', 'stop', 'restart', 'logs', 'crashinfo', 'whoami', 'help', 'bind', 'gamemode', 'bind-player', 'unbind-player', 'my-players', 'bindings', 'whitelist-sync', 'kubejs-backup', 'kubejs-reload', 'vote-start', 'vote-approve', 'vote-reject', 'vote-status', 'export-data', 'import-data', 'owner-add', 'owner-del', 'owner-list', 'watchdog')]
    [string]$Action,

    [string]$Arg = '',
    [string]$Actor = '',
    [Alias('Lines')]
    [int]$TailLines = 40,
    [string]$ServerDir = '',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if ([string]::IsNullOrWhiteSpace($ServerDir)) {
    if ($env:MC_SERVER_DIR) { $ServerDir = $env:MC_SERVER_DIR } else { $ServerDir = 'D:\server' }
}
$ServerDir = $ServerDir.TrimEnd('\', '/')
$OpsDir     = Join-Path $ServerDir 'ops'
$DataDir    = Join-Path $OpsDir 'data'
$LogDir     = Join-Path $ServerDir 'logs'
$LogFile    = Join-Path $LogDir 'latest.log'
$BindFile   = Join-Path $DataDir 'bindings.json'
$VoteFile   = Join-Path $DataDir 'votes.json'
$WhitelistFile = Join-Path $ServerDir 'whitelist.json'
$StateFile  = Join-Path $DataDir 'state.json'
$OwnerFile  = Join-Path $DataDir 'owners.json'
$ConfigFile = Join-Path $DataDir 'config.json'
$PidFile    = Join-Path $DataDir 'server.pid'
$PropsFile  = Join-Path $ServerDir 'server.properties'
$ForgeArgs  = '@libraries/net/minecraftforge/forge/1.20.1-47.2.23/win_args.txt'
if (-not (Test-Path (Join-Path $ServerDir $ForgeArgs.TrimStart('@')))) {
    $found = Get-ChildItem (Join-Path $ServerDir 'libraries') -Recurse -Filter 'win_args.txt' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $ForgeArgs = '@' + $found.FullName.Substring($ServerDir.Length + 1) }
}

New-Item -ItemType Directory -Force -Path $OpsDir, $DataDir, $LogDir | Out-Null

# ---------------- 基础工具 ----------------
function Read-Json([string]$path, $default) {
    if (Test-Path $path) {
        try { return ((Get-Content $path -Raw -Encoding UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json) } catch { return $default }
    }
    return $default
}
function Write-Json([string]$path, $obj) {
    $obj | ConvertTo-Json -Depth 8 | Set-Content -Path $path -Encoding UTF8
}
function Get-Prop($obj, [string]$name, $default) {
    if ($null -eq $obj) { return $default }
    $p = $obj.PSObject.Properties[$name]
    if ($null -eq $p -or $null -eq $p.Value) { return $default }
    return $p.Value
}
function Get-Owners {
    $doc = Read-Json $OwnerFile ([pscustomobject]@{ owners = @() })
    $list = @()
    foreach ($x in @(Get-Prop $doc 'owners' @())) { if ($x) { $list += [string]$x } }
    return $list
}

$config = Read-Json $ConfigFile ([pscustomobject]@{ ownerSecret = '' })
$secret = [string](Get-Prop $config 'ownerSecret' '')

$ownerIds = @(Get-Owners)
$role = 'unknown'
if ($Actor -and ($ownerIds -contains $Actor)) { $role = 'owner' }

function Get-Bindings {
    $doc = Read-Json $BindFile @()
    $list = @()
    foreach ($x in @($doc)) {
        if ($x -and $x.qq -and $x.name) {
            $list += [pscustomobject]@{ qq = [string]$x.qq; name = [string]$x.name; at = [string]$x.at }
        }
    }
    return $list
}

function Save-Bindings($list) {
    $json = ConvertTo-Json -InputObject @($list) -Depth 5
    [System.IO.File]::WriteAllText($BindFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-OfflineUuid([string]$name) {
    $md5 = [System.Security.Cryptography.MD5]::Create()
    $hash = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("OfflinePlayer:$name"))
    $hash[6] = ($hash[6] -band 0x0F) -bor 0x30
    $hash[8] = ($hash[8] -band 0x3F) -bor 0x80
    $h = ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
    return "$($h.Substring(0,8))-$($h.Substring(8,4))-$($h.Substring(12,4))-$($h.Substring(16,4))-$($h.Substring(20,12))"
}

function Read-Whitelist {
    if (-not (Test-Path $WhitelistFile)) { return @() }
    try {
        $txt = (Get-Content $WhitelistFile -Raw -Encoding UTF8).TrimStart([char]0xFEFF).Trim()
        if (-not $txt -or $txt -eq '[]') { return @() }
        $doc = $txt | ConvertFrom-Json
        if ($null -eq $doc) { return @() }
        $out = @()
        foreach ($x in @($doc)) {
            if ($x -and $x.name -and $x.uuid) { $out += [pscustomobject]@{ uuid = [string]$x.uuid; name = [string]$x.name } }
        }
        return $out
    } catch { return @() }
}

function Save-Whitelist($list) {
    $json = ConvertTo-Json -InputObject @($list) -Depth 5
    [System.IO.File]::WriteAllText($WhitelistFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Add-WhitelistName([string]$name) {
    # 注意：不能用 RCON 的 whitelist add —— 服务端会把名字转小写再算 UUID，
    # 和玩家实际登录时的 UUID（保留大小写）对不上，导致白名单失效。
    # 这里自己按原始大小写写 whitelist.json，再让服务端 reload。
    $list = @(Read-Whitelist | Where-Object { $_.name -ine $name })
    $list += [pscustomobject]@{ uuid = (Get-OfflineUuid $name); name = $name }
    Save-Whitelist $list
    if (Get-ServerProcess) {
        try { Invoke-Rcon 'whitelist reload' 5000 | Out-Null } catch { }
    }
}

function Remove-WhitelistName([string]$name) {
    $list = @(Read-Whitelist | Where-Object { $_.name -ine $name })
    Save-Whitelist $list
    if (Get-ServerProcess) {
        try { Invoke-Rcon 'whitelist reload' 5000 | Out-Null } catch { }
    }
}

function Enable-Whitelist {
    if (Get-ServerProcess) {
        try { Invoke-Rcon 'whitelist on' 5000 | Out-Null } catch { }
    }
}

$VoteConfigFile = Join-Path $DataDir 'vote-config.json'
$VoteApproveNeed = 2
$VoteRejectNeed = 1
$VoteTimeoutMinutes = 15
try {
    if (Test-Path $VoteConfigFile) {
        $vc = Get-Content $VoteConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($vc.approveNeed) { $VoteApproveNeed = [Math]::Max(1, [int]$vc.approveNeed) }
        if ($vc.rejectNeed) { $VoteRejectNeed = [Math]::Max(1, [int]$vc.rejectNeed) }
        if ($vc.timeoutMinutes) { $VoteTimeoutMinutes = [Math]::Max(1, [int]$vc.timeoutMinutes) }
    }
}
catch { }

# 到点没凑够门槛的投票自动作废，避免一直挂在「待确认」里
function Clear-ExpiredVotes {
    $all = @(Get-Votes)
    if ($all.Count -eq 0) { return }
    $changed = $false
    foreach ($v in $all) {
        if ($v.status -eq 'open' -and $v.expiresAt -and ((Get-Date) -gt [datetime]$v.expiresAt)) {
            $v.status = 'expired'
            $changed = $true
        }
    }
    if ($changed) { Save-Votes $all }
}

function Get-Votes {
    $doc = Read-Json $VoteFile @()
    $list = @()
    foreach ($x in @($doc)) {
        if ($x -and $x.id) {
            $list += [pscustomobject]@{
                id        = [string]$x.id
                desc      = [string]$x.desc
                need      = [int]$x.need
                votes     = @($x.votes)
                rejects   = @($x.rejects)
                status    = [string]$x.status
                createdAt = [string]$x.createdAt
                expiresAt = [string]$x.expiresAt
            }
        }
    }
    return $list
}

function Save-Votes($list) {
    $json = ConvertTo-Json -InputObject @($list) -Depth 6
    [System.IO.File]::WriteAllText($VoteFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-RconPassword {
    $hit = Select-String -Path $PropsFile -Pattern '^rcon\.password=' | Select-Object -First 1
    if (-not $hit) { return '' }
    return ($hit.Line -replace '^rcon\.password=', '').Trim()
}

function Invoke-Rcon([string]$Command, [int]$TimeoutMs = 8000) {
    $pass = Get-RconPassword
    if (-not $pass) { throw 'rcon password missing' }
    $tcp = New-Object System.Net.Sockets.TcpClient
    $ar = $tcp.BeginConnect('127.0.0.1', 25575, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { $tcp.Close(); throw 'rcon connect timeout' }
    $tcp.EndConnect($ar)
    $stream = $tcp.GetStream()
    $stream.ReadTimeout = $TimeoutMs

    function Send-Packet([int]$id, [int]$type, [string]$body) {
        $payload = [System.Text.Encoding]::UTF8.GetBytes($body)
        $len = 4 + 4 + $payload.Length + 2
        $buf = New-Object byte[] (4 + $len)
        [Array]::Copy([BitConverter]::GetBytes([int]$len), 0, $buf, 0, 4)
        [Array]::Copy([BitConverter]::GetBytes([int]$id), 0, $buf, 4, 4)
        [Array]::Copy([BitConverter]::GetBytes([int]$type), 0, $buf, 8, 4)
        [Array]::Copy($payload, 0, $buf, 12, $payload.Length)
        $stream.Write($buf, 0, $buf.Length); $stream.Flush()
    }
    function Read-Exact([int]$n) {
        $b = New-Object byte[] $n; $off = 0
        while ($off -lt $n) {
            $r = $stream.Read($b, $off, $n - $off)
            if ($r -le 0) { throw 'rcon connection closed' }
            $off += $r
        }
        return $b
    }
    function Read-Packet {
        $len = [BitConverter]::ToInt32((Read-Exact 4), 0)
        $data = Read-Exact $len
        return [pscustomobject]@{
            Id   = [BitConverter]::ToInt32($data, 0)
            Type = [BitConverter]::ToInt32($data, 4)
            Body = [System.Text.Encoding]::UTF8.GetString($data, 8, $len - 10)
        }
    }
    try {
        Send-Packet 1 3 $pass
        $auth = Read-Packet
        if ($auth.Id -eq -1) { throw 'rcon auth failed' }
        Send-Packet 2 2 $Command
        $resp = Read-Packet
        return $resp.Body.Trim()
    }
    finally { $tcp.Close() }
}

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

function Get-LiveLogPath {
    if (Test-Path $LogFile) {
        try { if ((Get-Item -LiteralPath $LogFile).Length -gt 0) { return $LogFile } } catch { }
    }
    return (Join-Path $LogDir 'console.log')
}

function Get-ConsoleTail([int]$count = 40) {
    $f = Get-LiveLogPath
    if (-not (Test-Path $f)) { return '' }
    try { $data = @(Get-Content -LiteralPath $f -Tail $count -Encoding UTF8) } catch { return '' }
    if ($data.Count -eq 0) { return '' }
    return ($data -join [Environment]::NewLine)
}

function Get-CleanLog([int]$count) {
    $raw = Get-ConsoleTail ([Math]::Max($count * 3, 60))
    $kept = @(($raw -split "`r?`n") | Where-Object { $_ -and ($_ -notmatch 'RCON (Client|Listener)') })
    if ($kept.Count -gt $count) { $kept = @($kept | Select-Object -Last $count) }
    return ($kept -join [Environment]::NewLine)
}

$WatchdogTask = 'CBC-Server-Watchdog'

# 有计划的看门狗任务就拉起任务，没有（别的机器上没配过）就直接起 watchdog.ps1
function Start-Watchdog {
    $taskExists = $false
    try {
        schtasks /Query /TN $WatchdogTask *> $null
        $taskExists = ($LASTEXITCODE -eq 0)
    } catch { }
    if ($taskExists) {
        try { schtasks /Run /TN $WatchdogTask *> $null } catch { }
        return
    }
    $wdScript = Join-Path $OpsDir 'watchdog.ps1'
    if (-not (Test-Path $wdScript)) { return }
    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $wdScript, '-ServerDir', $ServerDir) -WindowStyle Hidden | Out-Null
    } catch { }
}

function Start-McServer {
    $proc = Get-ServerProcess
    if ($proc) { return "already running (pid $($proc.Id))" }
    $java = Join-Path $ServerDir 'java\bin\java.exe'
    if (-not (Test-Path $java)) { throw "java not found: $java" }
    # 交给计划任务里的守护进程启动：父进程是任务计划服务，关闭 DSH 不会带走服务器
    $state = Read-Json $StateFile ([pscustomobject]@{})
    $state | Add-Member -Force -NotePropertyName desired -NotePropertyValue $true
    Write-Json $StateFile $state
    $wdAlive = $false
    $wpidFile = Join-Path $DataDir 'watchdog.pid'
    if (Test-Path $wpidFile) {
        $wid = (Get-Content $wpidFile -Raw).Trim()
        if ($wid -match '^\d+$' -and (Get-Process -Id ([int]$wid) -ErrorAction SilentlyContinue)) { $wdAlive = $true }
    }
    if (-not $wdAlive) { Start-Watchdog }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $javaProc = Get-ServerProcess
        if ($javaProc) {
            $javaProc.Id | Set-Content $PidFile -Encoding ASCII
            return "已启动（pid $($javaProc.Id)，前台控制台窗口已打开）"
        }
    }
    return '已请求启动，守护进程正在拉起服务器（加载约 40 秒）'
    try {
        $wdAlive = $false
        if (Test-Path (Join-Path $DataDir 'watchdog.pid')) {
            $wid = (Get-Content (Join-Path $DataDir 'watchdog.pid') -Raw).Trim()
            if ($wid -match '^\d+$' -and (Get-Process -Id ([int]$wid) -ErrorAction SilentlyContinue)) { $wdAlive = $true }
        }
        if (-not $wdAlive) { schtasks /Run /TN 'CBC-Server-Watchdog' 2>&1 | Out-Null }
    } catch { }
    $state = Read-Json $StateFile ([pscustomobject]@{})
    $state | Add-Member -Force -NotePropertyName desired -NotePropertyValue $true
    Write-Json $StateFile $state
    return "started (pid $($p.Id))"
}

function Stop-McServer([int]$WaitSec = 45, [switch]$Force) {
    $proc = Get-ServerProcess
    $state = Read-Json $StateFile ([pscustomobject]@{})
    $state | Add-Member -Force -NotePropertyName desired -NotePropertyValue $false
    Write-Json $StateFile $state
    if (-not $proc) { return 'not running' }
    try { Invoke-Rcon 'stop' 2500 | Out-Null } catch { }
    $wait = $WaitSec
    if ($Force) { $wait = 8 }
    $deadline = (Get-Date).AddSeconds($wait)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { return 'stopped' }
    }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    return 'force-killed'
}

function Get-StatusText {
    $proc = Get-ServerProcess
    $os = Get-CimInstance Win32_OperatingSystem
    $sysTotal = [math]::Round($os.TotalVisibleMemorySize / 1024)
    $sysFree = [math]::Round($os.FreePhysicalMemory / 1024)

    $health = Get-ServerHealth
    $healthText = '未运行'
    if ($health.state -eq 'healthy') { $healthText = '正常' }
    elseif ($health.state -eq 'lagging') { $healthText = '卡顿（TPS ' + $health.tps + '）' }
    elseif ($health.state -eq 'unresponsive') { $healthText = '无响应/假死' }
    elseif ($health.state -eq 'booting') { $healthText = '启动中' }

    $running = 'no'
    $pidText = '-'
    $uptime = '-'
    $cpu = '-'
    $mem = '-'
    $players = '-'
    $tps = '-'
    if ($proc) {
        $running = 'yes'
        $pidText = [string]$proc.Id
        try { $uptime = ((Get-Date) - $proc.StartTime).ToString('d\.hh\:mm\:ss') } catch { }
        try {
            $c1 = $proc.CPU
            Start-Sleep -Milliseconds 700
            $proc.Refresh()
            $c2 = $proc.CPU
            $cpu = [string][math]::Round((($c2 - $c1) / 0.7) * 100 / [Environment]::ProcessorCount, 1) + '%'
        } catch { }
        $mem = [string][math]::Round($proc.WorkingSet64 / 1MB) + ' MB'
        try {
            $list = Invoke-Rcon 'list' 4000
            if ($list -match 'There are (\d+) of a max of (\d+) players online:?\s*(.*)') {
                $players = $Matches[1] + '/' + $Matches[2]
                if ($Matches[3].Trim()) { $players = $players + ' (' + $Matches[3].Trim() + ')' }
            }
        } catch { }
        $tpsProbe = Get-ServerTps
        if ($null -ne $tpsProbe) { $tps = $tpsProbe }

    }

    $difficulty = '-'; $port = '35942'
    foreach ($line in (Get-Content $PropsFile -ErrorAction SilentlyContinue)) {
        if ($line -match '^difficulty=(.*)$') { $difficulty = $Matches[1] }
        if ($line -match '^server-port=(\d+)$') { $port = $Matches[1] }
    }
    $diskFree = '-'
    $driveLetter = (Get-Item $ServerDir).PSDrive.Name
    $drv = Get-PSDrive $driveLetter
    if ($drv) { $diskFree = [string][math]::Round($drv.Free / 1GB, 1) + ' GB' }
    $worldSize = '-'
    $worldDir = Join-Path $ServerDir 'world'
    if (Test-Path $worldDir) {
        $sum = (Get-ChildItem $worldDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        if ($sum) { $worldSize = [string][math]::Round($sum / 1MB) + ' MB' }
    }
    $state = Read-Json $StateFile ([pscustomobject]@{})
    $restarts = @(Get-Prop $state 'restarts' @()).Count

    $text = "运行: $running  健康: $healthText  pid: $pidText  在线: $players`n"
    $text += "CPU: $cpu  内存: $mem  系统剩余: $sysFree / $sysTotal MB`n"
    $text += "TPS: $tps  运行时长: $uptime  重启次数: $restarts`n"
    $text += "地图: $worldSize  磁盘剩余: $diskFree`n"
    if ($health.state -eq 'unresponsive') { $text += "`n`n[!] 服务器已假死：进程还在但没有响应（RCON 连续超时）。任何人现在都可以执行 restart 强制重启。" }
    elseif ($health.state -eq 'lagging') { $text += "`n`n[!] 服务器严重卡顿（TPS " + $health.tps + "），接近假死；如果持续不恢复，建议 restart。" }
    $text += "`n难度: $difficulty  端口: $port"
    return $text
}

function Get-RateFile { Join-Path $DataDir 'ratelimit.json' }

function Assert-SayRate {
    $rl = Read-Json (Get-RateFile) ([pscustomobject]@{})
    $now = (Get-Date).ToUniversalTime()
    $last = Get-Prop $rl 'sayAt' $null
    if ($last) {
        $dt = [datetime]$last
        if (($now - $dt.ToUniversalTime()).TotalSeconds -lt 5) { throw 'RATE_LIMIT: 广播太频繁，请等 5 秒再试。' }
    }
    $rl | Add-Member -Force -NotePropertyName sayAt -NotePropertyValue $now.ToString('o')
    Write-Json (Get-RateFile) $rl
}

function Assert-StartCooldown {
    $rl = Read-Json (Get-RateFile) ([pscustomobject]@{})
    $now = (Get-Date).ToUniversalTime()
    $last = Get-Prop $rl 'startAt' $null
    if ($last) {
        $dt = [datetime]$last
        if (($now - $dt.ToUniversalTime()).TotalSeconds -lt 90) { throw 'COOLDOWN: 刚发起过启动，服务器正在加载，请等大约 1 分钟再试。' }
    }
    $rl | Add-Member -Force -NotePropertyName startAt -NotePropertyValue $now.ToString('o')
    Write-Json (Get-RateFile) $rl
}

function Get-ServerTps {
    # 不同服务端 TPS 命令不一样：Forge/NeoForge=forge tps，Paper/Spigot= tps，Fabric(Carpet)=carpet tps，spark=spark tps
    $probes = @(
        @{ cmd = 'forge tps'; re = 'Mean TPS:\s*([\d.]+)' },
        @{ cmd = 'tps'; re = 'TPS[^\d]*([\d.]+)' },
        @{ cmd = 'spark tps'; re = 'TPS[^\d]*([\d.]+)' },
        @{ cmd = 'carpet tps'; re = 'TPS[^\d]*([\d.]+)' }
    )
    foreach ($p in $probes) {
        try {
            $out = Invoke-Rcon $p.cmd 3000
            if ($out -and ($out -match $p.re)) { return [double]$Matches[1] }
        }
        catch { }
    }
    return $null
}

function Get-ServerHealth {
    $proc = Get-ServerProcess
    if (-not $proc) {
        return [pscustomobject]@{ state = 'stopped'; tps = $null; rcon = $false; pid = $null; detail = '未运行' }
    }
    # 以 RCON 为准：日志按天滚动（latest.log 每天 0 点重建），靠日志里的 "Done (" 判断会误报「启动中」。
    $rconOk = $false
    $lastErr = ''
    for ($i = 0; $i -lt 2 -and -not $rconOk; $i++) {
        try { Invoke-Rcon 'list' 3000 | Out-Null; $rconOk = $true }
        catch { $lastErr = $_.Exception.Message; Start-Sleep -Milliseconds 400 }
    }
    if (-not $rconOk) {
        $age = 99999
        try { $age = ((Get-Date) - $proc.StartTime).TotalSeconds } catch { }
        if ($age -lt 180) {
            return [pscustomobject]@{ state = 'booting'; tps = $null; rcon = $false; pid = $proc.Id; detail = '启动中' }
        }
        return [pscustomobject]@{ state = 'unresponsive'; tps = $null; rcon = $false; pid = $proc.Id; detail = 'RCON 无响应，疑似假死' }
    }
    $tps = Get-ServerTps

    if ($null -ne $tps -and $tps -lt 3) {
        return [pscustomobject]@{ state = 'lagging'; tps = $tps; rcon = $true; pid = $proc.Id; detail = "TPS $tps，严重卡顿" }
    }
    return [pscustomobject]@{ state = 'healthy'; tps = $tps; rcon = $true; pid = $proc.Id; detail = '正常' }
}

function Get-ServerPhase {
    return (Get-ServerHealth).state
}

function Assert-Owner {
    if ($role -ne 'owner') {
        if ([string]::IsNullOrWhiteSpace($Actor)) {
            throw 'NO_ACTOR: 无法识别发送者身份（缺少 [昵称(ID)] 标记），已拒绝。'
        }
        throw 'FORBIDDEN: 该操作仅服主可用。'
    }
}

# ---------------- 动作 ----------------
$result = ''
try {
switch ($Action) {

    'status' { $result = Get-StatusText }

    'players' {
        if (-not (Get-ServerProcess)) { $result = '服务器未运行' }
        else { $result = (Invoke-Rcon 'list') }
    }

    'say' {
        if (-not $Arg) { throw 'USAGE: say <message>' }
        if (-not (Get-ServerProcess)) { throw '服务器未运行' }
        $msg = ($Arg -replace '[\r\n]+', ' ').Trim()
        if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) + '...' }
        Assert-SayRate
        Invoke-Rcon ('say ' + $msg) | Out-Null
        $result = "已广播: $msg"
    }

    'cmd' {
        Assert-Owner
        if (-not $Arg) { throw 'USAGE: cmd <minecraft command>' }
        if (-not (Get-ServerProcess)) { throw '服务器未运行' }
        $clean = $Arg.Trim().TrimStart('/')
        $r = Invoke-Rcon $clean
        if (-not $r) { $r = '已执行' }
        $result = $r
    }

    'start' {
        $health = Get-ServerHealth
        if ($health.state -eq 'stopped') {
            if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 无法识别发送者身份，已拒绝。' }
            if ($role -ne 'owner') { Assert-StartCooldown }
            $result = Start-McServer
        }
        elseif ($health.state -eq 'booting') {
            if ($role -eq 'owner') { $result = '服务器正在启动中（约 40 秒），如需强制重启用 restart' }
            else { throw 'DENIED: 服务器正在启动中，请等它加载完成（约 40 秒），不要重复启动。' }
        }
        elseif ($health.state -eq 'unresponsive') {
            throw 'DENIED: 服务器进程还在但已无响应（假死）。请改用 restart 强制重启（任何人可用）。'
        }
        else {
            if ($role -eq 'owner') { $result = '服务器在线且响应正常（' + $health.detail + '），无需启动' }
            else { throw 'DENIED: 服务器在线且响应正常，玩家无权启动/重启。只有确认关闭或确认无响应（假死）时，才能由玩家 restart。' }
        }
    }

    'stop' {
        Assert-Owner
        $result = Stop-McServer
    }

    'restart' {
        $health = Get-ServerHealth
        if ($health.state -eq 'stopped') {
            if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 无法识别发送者身份，已拒绝。' }
            if ($role -ne 'owner') { Assert-StartCooldown }
            $result = '服务器确认已关闭，直接启动：' + (Start-McServer)
        }
        elseif ($health.state -eq 'unresponsive') {
            if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 无法识别发送者身份，已拒绝。' }
            $stopped = Stop-McServer -Force
            Start-Sleep -Seconds 2
            $result = "检测到假死（$($health.detail)），已强制结束：$stopped；" + (Start-McServer)
        }
        else {
            if ($role -ne 'owner') {
                if ($health.state -eq 'booting') {
                    throw 'DENIED: 服务器正在启动中，玩家不能重启，等它加载完成（约 40 秒）。'
                }
                throw 'DENIED: 服务器在线且响应正常，玩家无权重启。只有确认关闭或确认无响应（假死）时才能由玩家重启；正常在线时的重启请找服主。'
            }
            $stopped = Stop-McServer
            Start-Sleep -Seconds 2
            $result = "停止: $stopped；" + (Start-McServer)
        }
    }

    'gamemode' {
        if (-not $Arg) { throw 'USAGE: gamemode <survival|spectator|creative|adventure> <玩家名>' }
        if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 无法识别发送者身份，已拒绝。' }
        $parts = @($Arg.Trim() -split '\s+', 2)
        if ($parts.Count -lt 2) { throw 'USAGE: gamemode <模式> <玩家名>' }
        $mode = $parts[0].ToLower()
        $target = $parts[1].Trim()
        if (@('survival', 'spectator', 'creative', 'adventure') -notcontains $mode) { throw 'USAGE: 模式只能是 survival / spectator / creative / adventure' }
        if (@('survival', 'spectator') -notcontains $mode) { Assert-Owner }
        elseif ($role -ne 'owner') {
            $mine = @(Get-Bindings | Where-Object { $_.qq -eq $Actor })
            $allowed = @($mine | Where-Object { $_.name -ieq $target })
            if ($allowed.Count -eq 0) {
                if ($mine.Count -eq 0) { throw 'FORBIDDEN: 你还没绑定游戏名。先发「绑定游戏名 你的ID」，绑好之后只能切自己的名字。' }
                throw ("FORBIDDEN: 只能切换自己绑定的游戏名（你绑了：" + (($mine | ForEach-Object { $_.name }) -join ', ') + "）。")
            }
        }
        if (-not (Get-ServerProcess)) { throw '服务器未运行' }
        $r = Invoke-Rcon ("gamemode " + $mode + " " + $target)
        if (-not $r) { $r = '已执行' }
        $result = $r
    }

    'bind-player' {
        if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 先在群里 @ 我一下再绑定。' }
        if (-not $Arg) { throw 'USAGE: bind-player <游戏名>' }
        $name = $Arg.Trim()
        if ($name -notmatch '^[A-Za-z0-9_]{1,16}$') { throw '游戏名只能是 1-16 位字母、数字或下划线。' }
        $all = @(Get-Bindings)
        $mine = @($all | Where-Object { $_.qq -eq $Actor })
        $dup = @($mine | Where-Object { $_.name -ieq $name })
        if ($dup.Count -gt 0) { $result = "已经绑过 $name 了。" }
        else {
            if ($mine.Count -ge 10) { throw 'FORBIDDEN: 一个 QQ 最多绑 10 个游戏名，先解绑几个吧。' }
            $owners = @($all | Where-Object { $_.name -ieq $name })
            if ($owners.Count -ge 3) { throw 'FORBIDDEN: 这个游戏名已经被 3 个 QQ 绑定，不能再绑了。' }
            $all += [pscustomobject]@{ qq = $Actor; name = $name; at = (Get-Date).ToString('o') }
            Save-Bindings $all
            Add-WhitelistName $name
            Enable-Whitelist
            $result = "绑定成功：$name（当前 $($mine.Count + 1)/10）。已经加进服务器白名单，可以进服了；切模式也只能用这个名字。"
        }
    }

    'unbind-player' {
        if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 先在群里 @ 我一下。' }
        if (-not $Arg) { throw 'USAGE: unbind-player <游戏名>' }
        $name = $Arg.Trim()
        $all = @(Get-Bindings)
        $kept = @($all | Where-Object { -not ($_.qq -eq $Actor -and $_.name -ieq $name) })
        if ($kept.Count -eq $all.Count) { $result = "没有找到这个绑定：$name" }
        else {
            Save-Bindings $kept
            $still = @($kept | Where-Object { $_.name -ieq $name })
            if ($still.Count -eq 0) { Remove-WhitelistName $name }
            $result = "已解绑 $name。" + $(if ($still.Count -eq 0) { "已同时从服务器白名单移除。" } else { "这个游戏名还有 $($still.Count) 个 QQ 绑定着，白名单保留。" })
        }
    }

    'my-players' {
        if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 先在群里 @ 我一下。' }
        $mine = @(Get-Bindings | Where-Object { $_.qq -eq $Actor })
        if ($mine.Count -eq 0) { $result = '你还没绑定游戏名，发「绑定游戏名 你的ID」就行。' }
        else {
            $online = @()
            try {
                $l = Invoke-Rcon 'list' 4000
                if ($l -match 'online:?\s*(.*)$') { $online = @($Matches[1] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
            } catch { }
            $lines = @()
            foreach ($b in $mine) {
                $tag = if ($online -contains $b.name) { '在线' } else { '离线' }
                $lines += "  $($b.name)  [$tag]"
            }
            $result = "你绑定的游戏名（$($mine.Count)/10）：`n" + ($lines -join "`n")
        }
    }

    'bindings' {
        Assert-Owner
        $all = @(Get-Bindings)
        if ($all.Count -eq 0) { $result = '还没有任何绑定。' }
        else {
            $result = (@($all | Group-Object qq | ForEach-Object { "$($_.Name): " + (($_.Group | ForEach-Object { $_.name }) -join ', ') })) -join "`n"
        }
    }

    'whitelist-sync' {
        Assert-Owner
        $all = @(Get-Bindings)
        $names = @($all | ForEach-Object { $_.name } | Select-Object -Unique)
        foreach ($n in $names) { Add-WhitelistName $n }
        Enable-Whitelist
        if ($names.Count -eq 0) { $result = '当前没有任何绑定，白名单是空的。' }
        else { $result = "已同步 $($names.Count) 个绑定名到白名单：" + ($names -join ', ') }
    }

    'kubejs-backup' {
        $src = Join-Path $ServerDir 'kubejs\server_scripts'
        if (-not (Test-Path $src)) { throw 'kubejs/server_scripts 不存在' }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $dst = Join-Path $ServerDir ("kubejs\backups\server_scripts-" + $stamp)
        New-Item -ItemType Directory -Force -Path $dst | Out-Null
        $items = @(Get-ChildItem -LiteralPath $src -Force -ErrorAction SilentlyContinue)
        foreach ($it in $items) { Copy-Item -LiteralPath $it.FullName -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue }
        $count = @(Get-ChildItem -LiteralPath $dst -Recurse -File -ErrorAction SilentlyContinue).Count
        $result = "已备份 $count 个脚本文件到 $dst"
    }

    'kubejs-reload' {
        if (-not (Get-ServerProcess)) { throw '服务器未运行' }
        $parts = @()
        try { $a = Invoke-Rcon 'kubejs reload server_scripts' 15000; if ($a) { $parts += $a } } catch { }
        try { $b = Invoke-Rcon 'reload' 15000; if ($b) { $parts += $b } } catch { }
        if ($parts.Count -eq 0) { $result = '已发送重载指令（KubeJS 不一定有回显）' }
        else { $result = ($parts -join "`n") }
    }

    'vote-start' {
        Clear-ExpiredVotes
        if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 先在群里 @ 我一下。' }
        if (-not $Arg) { throw 'USAGE: vote-start <要做什么的一句话说明>' }
        $all = @(Get-Votes)
        $open = @($all | Where-Object { $_.status -eq 'open' })
        if ($open.Count -ge 3) { throw '同时最多 3 个待确认投票，先等前面的处理完。' }
        $id = (Get-Date -Format 'HHmmss')
        $all += [pscustomobject]@{
            id        = $id
            desc      = $Arg.Trim()
            need      = $VoteApproveNeed
            votes     = @()
            rejects   = @()
            status    = 'open'
            createdAt = (Get-Date).ToString('o')
            expiresAt = (Get-Date).AddMinutes($VoteTimeoutMinutes).ToString('o')
        }
        Save-Votes $all
        $result = '投票已发起，编号 ' + $id + '。需要 ' + $VoteApproveNeed + ' 位群友回复「同意 ' + $id + '」才会放行；' + $(if ($VoteRejectNeed -le 1) { '凑够 ' + $VoteApproveNeed + ' 票之前只要有人回复「拒绝 ' + $id + '」，这次就不授权了。' } else { '凑够 ' + $VoteApproveNeed + ' 票之前有 ' + $VoteRejectNeed + ' 人回复「拒绝 ' + $id + '」，这次就不授权了。' })
    }

    'vote-approve' {
        Clear-ExpiredVotes
        if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 先在群里 @ 我一下。' }
        if (-not $Arg) { throw 'USAGE: vote-approve <编号>' }
        $id = $Arg.Trim()
        $all = @(Get-Votes)
        $vote = @($all | Where-Object { $_.id -eq $id }) | Select-Object -First 1
        if (-not $vote) { throw "没有找到编号 $id 的投票。" }
        if ($vote.status -eq 'rejected') { $result = "编号 $id 已经被否决了，这次不能授权，要动手得重新发起投票。" }
        elseif ($vote.status -ne 'open') { $result = "这个投票已经结束（$($vote.status)）。" }
        elseif ((Get-Date) -gt [datetime]$vote.expiresAt) {
            $vote.status = 'expired'
            Save-Votes $all
            $result = '这个投票已经过期了，重新发起吧。'
        }
        else {
            $voters = @($vote.votes | ForEach-Object { [string]$_.qq })
            if ($voters -contains $Actor) { $result = "你已经投过了（当前 $($voters.Count)/$($vote.need)）。" }
            else {
                $vote.votes = @($vote.votes) + @([pscustomobject]@{ qq = $Actor; at = (Get-Date).ToString('o') })
                $count = @($vote.votes).Count
                if ($count -ge $vote.need) {
                    $vote.status = 'passed'
                    $result = "投票通过（$count/$($vote.need)）：$($vote.desc)。已开放 10 分钟高权限窗口。"
                }
                else { $result = "已记录（$count/$($vote.need)），还需要 $($vote.need - $count) 位群友确认。" }
                Save-Votes $all
            }
        }
    }

    'vote-reject' {
        Clear-ExpiredVotes
        if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 先在群里 @ 我一下。' }
        if (-not $Arg) { throw 'USAGE: vote-reject <编号>' }
        $id = $Arg.Trim()
        $all = @(Get-Votes)
        $vote = @($all | Where-Object { $_.id -eq $id }) | Select-Object -First 1
        if (-not $vote) { throw "没有找到编号 $id 的投票。" }
        if ($vote.status -eq 'passed') { $result = "编号 $id 已经通过并授权了，这时候再拒绝无效。" }
        elseif ($vote.status -eq 'rejected') { $result = "编号 $id 已经否决过了，不用再点。" }
        elseif ($vote.status -ne 'open') { $result = "这个投票已经结束（$($vote.status)），拒绝无效。" }
        elseif ((Get-Date) -gt [datetime]$vote.expiresAt) {
            $vote.status = 'expired'
            Save-Votes $all
            $result = '这个投票已经过期了，不算数，重新发起吧。'
        }
        else {
            $already = @($vote.rejects | ForEach-Object { [string]$_.qq })
            if ($already -contains $Actor) {
                $result = "你已经投过反对了（当前 $(@($vote.rejects).Count)/$VoteRejectNeed）。"
            }
            else {
                $vote.rejects = @($vote.rejects) + @([pscustomobject]@{ qq = $Actor; at = (Get-Date).ToString('o') })
                $rejectCount = @($vote.rejects).Count
                if ($rejectCount -ge $VoteRejectNeed) {
                    $vote.status = 'rejected'
                    $approved = @($vote.votes).Count
                    Save-Votes $all
                    $result = "编号 $id 已被否决：$($vote.desc)。刚才只有 $approved/$($vote.need) 票同意、$rejectCount/$VoteRejectNeed 票反对，这次不授权了，谁再点同意也不算，要动手得重新发起投票。"
                }
                else {
                    Save-Votes $all
                    $result = "已记录反对（$rejectCount/$VoteRejectNeed），还差 $($VoteRejectNeed - $rejectCount) 票才会作废。"
                }
            }
        }
    }

    'export-data' {
        Assert-Owner
        if (-not $Arg) { throw 'USAGE: export-data <zip 路径>' }
        $dst = $Arg.Trim()
        if (-not [System.IO.Path]::IsPathRooted($dst)) { $dst = Join-Path $ServerDir $dst }
        $parent = Split-Path -Parent $dst
        if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        if (Test-Path $dst) { Remove-Item $dst -Force }
        if (-not (Test-Path $DataDir)) { throw '没有可导出的数据目录。' }
        Compress-Archive -Path (Join-Path $DataDir '*') -DestinationPath $dst -Force
        $result = "已导出到 $dst（绑定、投票、服主名单、口令、投票门槛；不含存档和日志）"
    }

    'import-data' {
        Assert-Owner
        if (-not $Arg) { throw 'USAGE: import-data <zip 路径>' }
        $src = $Arg.Trim()
        if (-not [System.IO.Path]::IsPathRooted($src)) { $src = Join-Path $ServerDir $src }
        if (-not (Test-Path $src)) { throw "找不到文件：$src" }
        # 防 zip slip：条目里带 .. 或绝对路径的直接拒绝
        try {
            Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
            $zip = [System.IO.Compression.ZipFile]::OpenRead($src)
            $bad = @($zip.Entries | Where-Object {
                $_.FullName -match '(^|[\\/])\.\.([\\/]|$)' -or $_.FullName.StartsWith('/') -or $_.FullName -match '^[a-zA-Z]:'
            })
            $zip.Dispose()
            if ($bad.Count -gt 0) { throw '压缩包里有可疑路径（含 .. 或绝对路径），已拒绝导入。' }
        }
        catch {
            if ($_.Exception.Message -like '*可疑路径*') { throw }
        }
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        Expand-Archive -Path $src -DestinationPath $DataDir -Force
        $result = "已从 $src 导入到 $DataDir（同名文件覆盖，其它保留）"
    }

    'vote-status' {
        Clear-ExpiredVotes
        $all = @(Get-Votes)
        $open = @($all | Where-Object { $_.status -eq 'open' })
        if ($Arg) {
            $vote = @($all | Where-Object { $_.id -eq $Arg.Trim() }) | Select-Object -First 1
            if (-not $vote) { $result = '没有这个投票。' }
            else {
                $approveCount = @($vote.votes).Count
                $rejectCount = @($vote.rejects).Count
                $extra = if ($rejectCount -gt 0) { "，$rejectCount 人点了拒绝" } else { '' }
                $result = "编号 $($vote.id)：$($vote.desc) —— 同意 $approveCount/$($vote.need)$extra，状态 $($vote.status)。"
            }
        }
        elseif ($open.Count -eq 0) { $result = '当前没有待确认的投票。' }
        else {
            $result = (@($open | ForEach-Object { "编号 $($_.id)：$($_.desc) —— 同意 $(@($_.votes).Count)/$($_.need)，回复「同意 $($_.id)」或「拒绝 $($_.id)」表决" })) -join "`n"
        }
    }

    'logs' {
        if ($Arg) {
            $raw = Get-CleanLog ([Math]::Max($TailLines * 4, 200))
            $hits = @(($raw -split "`r?`n") | Where-Object { $_ -like "*$Arg*" })
            if ($hits.Count -gt $TailLines) { $hits = @($hits | Select-Object -Last $TailLines) }
            $text = $hits -join [Environment]::NewLine
        }
        else { $text = Get-CleanLog $TailLines }
        if (-not $text) { $text = '(空)' }
        $result = $text
    }

    'crashinfo' {
        $sum = Read-Json $StateFile ([pscustomobject]@{})
        $crash = Get-Prop $sum 'lastCrash' $null
        if (-not $crash) { $result = '没有记录到崩溃' }
        else {
            $raw = [string](Get-Prop $crash 'tail' '')
            $kept = @(($raw -split "`r?`n") | Where-Object { $_ -and ($_ -notmatch 'RCON (Client|Listener)') })
            if ($kept.Count -gt 20) { $kept = @($kept | Select-Object -Last 20) }
            $result = "上次异常退出: $(Get-Prop $crash 'at' '-')`n" + ($kept -join [Environment]::NewLine)
        }
    }

    'whoami' {
        if ($Actor) { $result = "身份: $role`nID: $Actor" }
        else { $result = "身份: unknown`nID: (缺少 [昵称(ID)] 标记)" }
    }

    'help' {
        $result = @'
可用指令：
  状态 / 在线人数 / CPU / 内存 / TPS   -> status
  在线玩家名单                        -> players
  游戏内广播                          -> say <内容>
  查看日志                            -> logs [行数]
  崩溃原因摘要                        -> crashinfo
  启动 / 关闭 / 重启                  -> start / stop / restart
  执行后台指令（仅服主）              -> cmd <命令>
  查看自己的身份                      -> whoami

权限：玩家可用 status/players/say/logs/crashinfo；服务器已宕机时任何人可 start；
stop/restart/cmd（含 op/ban/kick 等）仅服主可用。
'@
    }

    'bind' {
        if (-not $Arg) { throw 'USAGE: bind <口令>' }
        if (-not $secret) { throw '尚未设置绑定口令' }
        if ([string]::IsNullOrWhiteSpace($Actor)) { throw 'NO_ACTOR: 请在群聊里 @机器人 发送该指令。' }
        if ($Arg.Trim() -ne $secret) { throw 'FORBIDDEN: 绑定口令错误。' }
        if ($ownerIds -contains $Actor) {
            $result = "已经是服主: $Actor"
        }
        else {
            $ownerIds = @($ownerIds) + $Actor
            Write-Json $OwnerFile ([pscustomobject]@{ owners = $ownerIds; boundAt = (Get-Date).ToString('o') })
            $result = "绑定成功，$Actor 已加入服主名单。"
        }
    }

    'owner-add' {
        Assert-Owner
        if (-not $Arg) { throw 'USAGE: owner-add <id>' }
        if ($ownerIds -notcontains $Arg) { $ownerIds = @($ownerIds) + $Arg }
        Write-Json $OwnerFile ([pscustomobject]@{ owners = $ownerIds; boundAt = (Get-Date).ToString('o') })
        $result = '服主列表: ' + ($ownerIds -join ', ')
    }

    'owner-del' {
        Assert-Owner
        if (-not $Arg) { throw 'USAGE: owner-del <id>' }
        $ownerIds = @($ownerIds | Where-Object { $_ -ne $Arg })
        Write-Json $OwnerFile ([pscustomobject]@{ owners = $ownerIds; boundAt = (Get-Date).ToString('o') })
        $result = '服主列表: ' + ($ownerIds -join ', ')
    }

    'owner-list' {
        if ($ownerIds.Count) { $result = '服主列表: ' + ($ownerIds -join ', ') }
        else { $result = '尚未绑定服主' }
    }

    'watchdog' {
        Assert-Owner
        $want = ($Arg -eq 'on')
        $state = Read-Json $StateFile ([pscustomobject]@{})
        $state | Add-Member -Force -NotePropertyName desired -NotePropertyValue $want
        Write-Json $StateFile $state
        $result = "自动守护: $want"
    }

    default { throw "unknown action: $Action" }
}
}
catch {
    $errMsg = $_.Exception.Message
    if ($Json) { [pscustomobject]@{ ok = $false; result = $errMsg } | ConvertTo-Json -Depth 6 }
    else { Write-Output $errMsg }
    exit 1
}

if ($Json) { [pscustomobject]@{ ok = $true; result = $result } | ConvertTo-Json -Depth 6 }
else { $result }

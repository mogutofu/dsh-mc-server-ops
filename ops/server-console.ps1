param(
    [string]$ServerDir = ''
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($ServerDir)) {
    if ($env:MC_SERVER_DIR) { $ServerDir = $env:MC_SERVER_DIR } else { $ServerDir = 'D:\server' }
}
$ServerDir = $ServerDir.TrimEnd('\', '/')
$Host.UI.RawUI.WindowTitle = 'Minecraft 服务器控制台'
Set-Location $ServerDir

$javaExe = Join-Path $ServerDir 'java\bin\java.exe'
if (-not (Test-Path $javaExe)) { $javaExe = 'java' }

# ── 启动方式自动识别 ─────────────────────────────────────────────
# 1) Forge / NeoForge / 大多数混合端：libraries/**/win_args.txt
# 2) Fabric / Quilt / Paper / Spigot / Purpur / 原版 / 其它 jar 端：根目录 jar
# 3) 脚本启动（run.bat）：兜底
# 可用环境变量覆盖：MC_JAR、MC_JVM_ARGS、MC_LAUNCH_ARGS
$argList = @()
$launchDesc = ''

$jvmArgs = @()
if ($env:MC_JVM_ARGS) { $jvmArgs = @($env:MC_JVM_ARGS) }
elseif (Test-Path (Join-Path $ServerDir 'user_jvm_args.txt')) { $jvmArgs = @('@user_jvm_args.txt') }

$forgeArgs = $null
if ($env:MC_JAR) {
    $jar = $env:MC_JAR
    if (-not [System.IO.Path]::IsPathRooted($jar)) { $jar = Join-Path $ServerDir $jar }
    $launchDesc = "jar: $(Split-Path -Leaf $jar)"
    $argList = @($jvmArgs) + @('-jar', $jar) + @('nogui')
}
else {
    $libDir = Join-Path $ServerDir 'libraries'
    if (Test-Path $libDir) {
        $forgeArgs = Get-ChildItem $libDir -Recurse -Filter 'win_args.txt' -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if ($forgeArgs) {
        $rel = '@' + $forgeArgs.FullName.Substring($ServerDir.Length + 1)
        $launchDesc = "forge args: $rel"
        $argList = @($jvmArgs) + @($rel) + @('nogui')
    }
    else {
        $preferred = @('fabric-server-launch.jar', 'fabric-server-launcher.jar', 'quilt-server-launch.jar')
        $jar = $null
        foreach ($name in $preferred) {
            $candidate = Join-Path $ServerDir $name
            if (Test-Path $candidate) { $jar = $candidate; break }
        }
        if (-not $jar) {
            $jar = Get-ChildItem $ServerDir -Filter '*.jar' -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notmatch '(installer|shim|base|sources|javadoc)' } |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($jar) { $jar = $jar.FullName }
        }
        if ($jar) {
            $launchDesc = "jar: $(Split-Path -Leaf $jar)"
            $argList = @($jvmArgs) + @('-jar', $jar) + @('nogui')
        }
        elseif (Test-Path (Join-Path $ServerDir 'run.bat')) {
            $launchDesc = 'run.bat'
            Write-Host "[启动] run.bat" -ForegroundColor Cyan
            & (Join-Path $ServerDir 'run.bat')
            exit $LASTEXITCODE
        }
        else {
            Write-Host "没有找到可用的启动目标：libraries\**\win_args.txt、*.jar 或 run.bat 都不存在。" -ForegroundColor Red
            Read-Host '按回车关闭'
            exit 1
        }
    }
}

if ($env:MC_LAUNCH_ARGS) { $argList = @($jvmArgs) + $env:MC_LAUNCH_ARGS.Split(' ') }

Write-Host "[启动] $launchDesc" -ForegroundColor Cyan
Write-Host "[java] $javaExe $($argList -join ' ')" -ForegroundColor DarkGray

& $javaExe @argList 2>&1 | ForEach-Object {
    $line = [string]$_
    if ($line -match '(?i)\b(error|fatal|severe)\b|Exception|Caused by:|at [a-z]') {
        Write-Host $line -ForegroundColor Red
    }
    elseif ($line -match '(?i)\bwarn(ing)?\b') {
        Write-Host $line -ForegroundColor Yellow
    }
    else {
        Write-Host $line
    }
}

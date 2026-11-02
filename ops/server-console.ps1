param(
    [string]$ServerDir = ''
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($ServerDir)) {
    if ($env:MC_SERVER_DIR) { $ServerDir = $env:MC_SERVER_DIR } else { $ServerDir = 'D:\server' }
}
$ServerDir = $ServerDir.TrimEnd('\', '/')
if (Test-Path (Join-Path $ServerDir 'server.properties')) {
    if (Get-Content (Join-Path $ServerDir 'server.properties') -TotalCount 40 | Select-String -Pattern '^level-name=' -Quiet) { }
}
$Host.UI.RawUI.WindowTitle = 'Minecraft 服务器控制台'
Set-Location $ServerDir

$javaExe = Join-Path $ServerDir 'java\bin\java.exe'
if (-not (Test-Path $javaExe)) { $javaExe = 'java' }
$jvmArgs = '@user_jvm_args.txt'
$forgeArgs = '@libraries\net\minecraftforge\forge\1.20.1-47.2.23\win_args.txt'
if (-not (Test-Path (Join-Path $ServerDir $forgeArgs.TrimStart('@')))) {
    $found = Get-ChildItem (Join-Path $ServerDir 'libraries') -Recurse -Filter 'win_args.txt' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $forgeArgs = '@' + $found.FullName.Substring($ServerDir.Length + 1) }
}

& $javaExe $jvmArgs $forgeArgs nogui 2>&1 | ForEach-Object {
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

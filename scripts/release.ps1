# 打包版本化发布：releases/<版本>/（含 manifest 校验信息）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\release.ps1 [-Version 0.1.1] [-SkipChecks]
param(
  [string]$Version = "",
  [switch]$SkipChecks
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not $Version) {
  $pkg = Get-Content "$projectRoot\package.json" -Raw | ConvertFrom-Json
  $Version = $pkg.version
}
# 版本号只允许 x.y.z：它是镜像 tag、.env 的 MYINFOBASE_TAG 值，也是发布目录名，
# 不做校验的话 `-Version ..\foo` 之类会把发布包写到 releases 之外
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Error "版本号必须是 x.y.z 形式（收到：$Version）"
}
$relDir = Join-Path $projectRoot "releases\$Version"
if (Test-Path $relDir) {
  Write-Error "releases\$Version 已存在，先删除或换版本号"
}

# 预检：类型与测试不过就不打包。镜像在 NAS 上才构建，本地 build 不是发布的一部分，
# 因此这里拦的是"代码本身有问题"，避免把坏版本推上 NAS 再回滚。
if (-not $SkipChecks) {
  Write-Host "== 预检：typecheck + 测试 ==" -ForegroundColor Cyan
  npm run typecheck
  if ($LASTEXITCODE -ne 0) { Write-Error "typecheck 未通过，已中止发布（确需跳过用 -SkipChecks）" }
  npm test
  if ($LASTEXITCODE -ne 0) { Write-Error "测试未通过，已中止发布（确需跳过用 -SkipChecks）" }
}

Write-Host "== 打包发布 $Version ==" -ForegroundColor Cyan

# 发布内容：程序与必要模板；排除源笔记、运行数据、开发数据、构建产物、依赖、生产环境配置
$excludeDirs = @('node_modules', 'dist', '.local', 'runtime', 'logs', 'releases', 'shots', '.playwright-mcp', 'data', '.vscode', '.git')
$excludeFiles = @('plan.md', '.gitignore')
$staging = Join-Path $projectRoot "releases\.staging-$Version"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

Get-ChildItem $projectRoot | Where-Object {
  ($_.PsIsContainer -and $excludeDirs -notcontains $_.Name) -or
  (-not $_.PsIsContainer -and $excludeFiles -notcontains $_.Name)
} | ForEach-Object {
  Copy-Item $_.FullName -Destination (Join-Path $staging $_.Name) -Recurse
}

# deploy/production 是 NAS 本机环境配置（含 .env），不进发布包
if (Test-Path "$staging\deploy\production") { Remove-Item "$staging\deploy\production" -Recurse -Force }

# Dockerfile 复制到发布包根（compose/docker build 的上下文 = 发布包根目录）
Copy-Item "$projectRoot\deploy\Dockerfile" "$staging\Dockerfile"

# 构建上下文瘦身：docs（含截图）与 tests 都不被 Dockerfile 引用，但会被整包传给 docker daemon
@'
docs
tests
plan.md
manifest.json
'@ | Set-Content (Join-Path $staging '.dockerignore') -Encoding UTF8

# 顺带放入部署脚本的可执行位说明文件（NAS 侧按 README 操作）
$manifest = [ordered]@{
  name        = 'myinfobase'
  version     = $Version
  builtAt     = (Get-Date).ToUniversalTime().ToString('o')
  builtOn     = $env:COMPUTERNAME
  targetArch  = '由 NAS 侧 docker build 决定（支持 amd64/arm64）'
  dataSchema  = '1'
  nodeEngines = (Get-Content "$projectRoot\package.json" -Raw | ConvertFrom-Json).engines.node
  files       = @()
}
Get-ChildItem $staging -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
  $sha = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  $manifest.files += @{ path = $rel; sha256 = $sha; size = $_.Length }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $staging 'manifest.json') -Encoding UTF8

if (Test-Path $relDir) { Remove-Item $relDir -Recurse -Force }
Move-Item $staging $relDir
Write-Host "发布包就绪：releases\$Version（$((Get-ChildItem $relDir -Recurse -File).Count) 个文件，含 manifest.json）" -ForegroundColor Green
Write-Host "NAS 更新：项目经共享盘自动同步，NAS 上执行 sudo sh deploy/nas-update.sh $Version"

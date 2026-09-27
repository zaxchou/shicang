# 打包版本化发布：releases/<版本>/（含 manifest 校验信息）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\release.ps1 [-Version 0.1.1]
param(
  [string]$Version = ""
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not $Version) {
  $pkg = Get-Content "$projectRoot\package.json" -Raw | ConvertFrom-Json
  $Version = $pkg.version
}
$relDir = Join-Path $projectRoot "releases\$Version"
if (Test-Path $relDir) {
  Write-Error "releases\$Version 已存在，先删除或换版本号"
}

Write-Host "== 打包发布 $Version ==" -ForegroundColor Cyan

# 发布内容：程序与必要模板；排除源笔记、运行数据、开发数据、构建产物、依赖、生产环境配置
$excludeDirs = @('node_modules', 'dist', '.local', 'runtime', 'logs', 'releases', 'shots', '.playwright-mcp', 'data', '.vscode')
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

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
# -Version 必须与 package.json 一致：nas-update.sh 的健康检查要求 health.version == 目录版本，
# 不一致要等容器**已经重建完**才报错——线上镜像 tag 与程序自报版本分裂，卡在"脚本失败、容器已换"的中间态
$pkgVersion = (Get-Content "$projectRoot\package.json" -Raw | ConvertFrom-Json).version
if ($Version -ne $pkgVersion) {
  Write-Error "-Version $Version 与 package.json（$pkgVersion）不一致，已中止；先改 package.json，或去掉 -Version 用默认值"
}
$relDir = Join-Path $projectRoot "releases\$Version"
if (Test-Path $relDir) {
  Write-Error "releases\$Version 已存在，先删除或换版本号"
}

# 预检：类型 + 测试。-SkipChecks 只跳过这两项。
if (-not $SkipChecks) {
  Write-Host "== 预检：typecheck + 测试 ==" -ForegroundColor Cyan
  npm run typecheck
  if ($LASTEXITCODE -ne 0) { Write-Error "typecheck 未通过，已中止发布（确需跳过用 -SkipChecks）" }
  npm test
  if ($LASTEXITCODE -ne 0) { Write-Error "测试未通过，已中止发布（确需跳过用 -SkipChecks）" }
}
# 构建**不参与** -SkipChecks：发布包直接携带 dist（Dockerfile 已不再编译），
# 跳过检查时若沿用旧产物，会把旧逻辑贴上按当前 package.json 写的新版本号并通过健康门
# （评审 R4 实测复现）。-SkipChecks 的语义只是"不跑类型检查和测试"，不是"允许发旧包"。
Write-Host "== 构建 dist（server + web）==" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "构建失败，已中止发布" }
# dist 不完整 = 镜像里没有程序。即便 -SkipChecks 也不放行（跳过检查不等于允许发空包）
if (-not (Test-Path "$projectRoot\dist\server\index.js") -or -not (Test-Path "$projectRoot\dist\web\index.html")) {
  Write-Error "dist 缺失或不完整（需要 dist\server\index.js 与 dist\web\index.html）；先跑 npm run build"
}

Write-Host "== 打包发布 $Version ==" -ForegroundColor Cyan

# 发布内容：程序与必要模板；排除源笔记、运行数据、开发数据、依赖、生产环境配置。
# **dist 不再排除**（v0.13.2 起）：镜像不编译，直接 COPY 这里构建好的纯 JS 产物。
# docs（18MB 截图）与 .zcode 也排除：它们已在项目根、共享盘同步整份项目时会再拷一遍，
# 放进发布包纯粹是每版多 18MB 的重复传输；NAS 侧要看文档读 $PROJ/docs 即可。
$excludeDirs = @('node_modules', 'docs', '.local', '.zcode', 'runtime', 'logs', 'releases', 'shots', '.playwright-mcp', 'data', '.vscode', '.git')
$excludeFiles = @('plan.md', '.gitignore')
$staging = Join-Path $projectRoot "releases\.staging-$Version"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

Get-ChildItem $projectRoot | Where-Object {
  # 根目录任何 .env* 都不进发布包（.gitignore 允许"任何位置的 .env"，这里防的是将来有人放根目录）
  ($_.Name -notlike '.env*') -and (
    ($_.PsIsContainer -and $excludeDirs -notcontains $_.Name) -or
    (-not $_.PsIsContainer -and $excludeFiles -notcontains $_.Name)
  )
} | ForEach-Object {
  Copy-Item $_.FullName -Destination (Join-Path $staging $_.Name) -Recurse
}

# deploy/production 是 NAS 本机环境配置（含 .env），不进发布包
if (Test-Path "$staging\deploy\production") { Remove-Item "$staging\deploy\production" -Recurse -Force }

# Dockerfile 复制到发布包根（compose/docker build 的上下文 = 发布包根目录）
Copy-Item "$projectRoot\deploy\Dockerfile" "$staging\Dockerfile"

# 构建上下文瘦身：只有 package.json / package-lock.json / VERSION / dist / config / data-seed / Dockerfile
# 是镜像真正要用的；源码（v0.13.2 起不编译）、docs 截图、测试一律不发给 docker daemon。
# 不能用 Set-Content -Encoding UTF8：PS 5.1 写 BOM + CRLF，首行模式被 ﻿污染后匹配不上 docs，
# 18MB 截图照进构建上下文（与 manifest.json 是同一个 BOM 坑，见下方注释）
$dockerIgnoreLines = @(
  'docs', 'tests', 'plan.md', 'README.md', 'manifest.json', '.env*',
  'src', 'server', 'shared', 'public', 'scripts', 'deploy',
  'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.web.json',
  'node_modules', 'releases', 'runtime', 'logs', 'shots', 'data', '.local', '.zcode', '.playwright-mcp'
)
$dockerIgnore = ($dockerIgnoreLines -join "`n") + "`n"
[System.IO.File]::WriteAllText((Join-Path $staging '.dockerignore'), $dockerIgnore, (New-Object System.Text.UTF8Encoding($false)))

# 版本号归一（部署提速的根）：发布包里的 package.json / package-lock.json 版本锁成 0.0.0，
# 真实版本另存 VERSION 文件（server/config.ts 的 readVersion 优先读它，健康检查仍会报真实版本）。
# Dockerfile 第一行就是 COPY 这两个文件——只要内容每次发版都变，那层缓存必失效，NAS 会连带
# 重跑 npm ci（数百 MB 下载）+ apk add，9 分钟部署里的一大半耗在这里。归一后这层内容逐字节
# 恒定，缓存永远命中，每次部署只剩「COPY dist」（~1.7MB）。
# 断言出现次数：package.json 1 次、package-lock 2 次（根 + packages[""]）；对不上就宁可发布失败，
# 也不能默默把"缓存又废了"带上线。
# 锁文件**必须结构感知**：每个依赖也有 "version" 键，可能恰好与发布版本同号
# （v0.17.0 实测撞上 react-refresh 0.17.0，裸字符串计数会把依赖版本一起改坏、断言拦停发布）——
# 只动 "name": "myinfobase" 紧跟的那两处。package.json 只有一个 "version" 键（依赖是 "包名": "范围"），裸匹配即可。
$lockPattern = '("name": "myinfobase",\s*"version": )"' + [regex]::Escape($Version) + '"'
foreach ($name in @('package.json', 'package-lock.json')) {
  $f = Join-Path $staging $name
  $text = [System.IO.File]::ReadAllText($f)
  if ($name -eq 'package.json') {
    $pattern = '"version": "' + [regex]::Escape($Version) + '"'
    $expected = 1
    $replacement = '"version": "0.0.0"'
  } else {
    $pattern = $lockPattern
    $expected = 2
    $replacement = '$1"0.0.0"'
  }
  $hits = [regex]::Matches($text, $pattern).Count
  if ($hits -ne $expected) { Write-Error "$name 里根版本出现 $hits 次（预期 $expected 次），版本归一失败，已中止" }
  $text = [regex]::Replace($text, $pattern, $replacement)
  [System.IO.File]::WriteAllText($f, $text, (New-Object System.Text.UTF8Encoding($false)))
}
[System.IO.File]::WriteAllText((Join-Path $staging 'VERSION'), "$Version`n", (New-Object System.Text.UTF8Encoding($false)))

# 顺带放入部署脚本的可执行位说明文件（NAS 侧按 README 操作）
$manifest = [ordered]@{
  name        = 'myinfobase'
  version     = $Version
  builtAt     = (Get-Date).ToUniversalTime().ToString('o')
  builtOn     = $env:COMPUTERNAME
  targetArch  = 'docker build 在 NAS 上执行（不编译，dist 由 Windows 侧预编译，纯 JS 架构无关）'
  dataSchema  = '1'
  nodeEngines = (Get-Content "$projectRoot\package.json" -Raw | ConvertFrom-Json).engines.node
  files       = @()
}
Get-ChildItem $staging -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
  $sha = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  $manifest.files += @{ path = $rel; sha256 = $sha; size = $_.Length }
}
# 不用 Set-Content -Encoding UTF8：PowerShell 5.1 会写入 BOM，manifest.json 就不是严格 JSON，
# 任何 JSON.parse 读它都会失败（v0.6.1 打包时发现）
$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText((Join-Path $staging 'manifest.json'), $manifestJson, (New-Object System.Text.UTF8Encoding($false)))

if (Test-Path $relDir) { Remove-Item $relDir -Recurse -Force }
Move-Item $staging $relDir
Write-Host "发布包就绪：releases\$Version（$((Get-ChildItem $relDir -Recurse -File).Count) 个文件，含 manifest.json）" -ForegroundColor Green
Write-Host "NAS 更新：项目经共享盘自动同步，NAS 上执行 sudo sh deploy/nas-update.sh $Version"

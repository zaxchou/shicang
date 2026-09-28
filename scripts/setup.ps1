# 首次安装 / 构建（开发环境，Windows PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
$ErrorActionPreference = 'Stop'

# 从脚本目录定位项目根（支持中文与空格路径）
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "== myinfobase 首次安装 ==" -ForegroundColor Cyan

$nodeVersion = & node --version 2>$null
if (-not $nodeVersion) {
  Write-Error "未检测到 Node.js，请先安装 Node.js 22 或更新版本：https://nodejs.org"
}
Write-Host "Node 版本：$nodeVersion"

Write-Host "[1/3] 安装依赖..." -ForegroundColor Yellow
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Write-Error "依赖安装失败" }

Write-Host "[2/3] 构建（服务端 + 前端）..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "构建失败" }

Write-Host "[3/3] 完成。" -ForegroundColor Green
Write-Host ""
Write-Host "开发环境启动：双击项目根目录 start.cmd"
Write-Host "开发数据保存在 .local\data，不会影响 NAS 上的生产数据。"

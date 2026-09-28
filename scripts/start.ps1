# Windows 开发启动（仅用于本机开发预览；日常使用请访问 NAS 上的服务）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\start.ps1
$ErrorActionPreference = 'Stop'

# 从脚本目录定位项目根（支持中文与空格路径）
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Test-Path "$projectRoot\dist\server\index.js") -or -not (Test-Path "$projectRoot\dist\web\index.html")) {
  Write-Host "未找到构建产物，先运行 scripts\setup.ps1 完成安装与构建。" -ForegroundColor Red
  pause
  exit 1
}

$port = 4317
$env:NODE_ENV = 'development'
$env:HOST = '127.0.0.1'
$env:PORT = [string]$port
# 开发数据与生产隔离：写入 .local\data
$env:DATA_DIR = Join-Path $projectRoot '.local\data'
$env:BACKUP_DIR = Join-Path $projectRoot '.local\backups'
$env:LOG_DIR = Join-Path $projectRoot 'logs'

Write-Host "启动 myinfobase（开发模式）http://127.0.0.1:$port" -ForegroundColor Cyan
Write-Host "开发数据目录：$env:DATA_DIR" -ForegroundColor DarkGray
Start-Process "http://127.0.0.1:$port"
node dist\server\index.js

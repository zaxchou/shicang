@echo off
rem Windows 开发入口（仅用于本机开发预览；日常使用请访问 NAS 上的服务）
rem 双击运行：定位到项目根并调用 scripts\start.ps1
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\start.ps1"
pause

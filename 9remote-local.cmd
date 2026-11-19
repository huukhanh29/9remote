@echo off
setlocal
cd /d "%~dp0"
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=setup"
node "%~dp0scripts\service2200.mjs" %ACTION%
if "%~1"=="" (
  echo.
  echo Mo trinh duyet tai: http://localhost:2200/workspace
  pause
)

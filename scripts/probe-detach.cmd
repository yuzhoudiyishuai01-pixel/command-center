@echo off
REM 诊断：比较几种"后台脱离启动服务"的方式，找出在当前环境下真正能存活的那种。
setlocal EnableExtensions
cd /d "%~dp0"

set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
set "ENTRY=%~dp0server\index.mjs"

echo.
echo   当前使用的 Node: %NODE%
echo   入口脚本:        %ENTRY%
echo.

echo   [方式 1] cmd /c start "" /b
cmd /c start "" /b "%NODE%" "%ENTRY%"
timeout /t 6 /nobreak >nul
call :probe "方式1"
call :killnode

echo   [方式 2] powershell Start-Process -WindowStyle Hidden
powershell -NoProfile -Command "Start-Process -FilePath '%NODE%' -ArgumentList '\"%ENTRY%\"' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
timeout /t 6 /nobreak >nul
call :probe "方式2"
call :killnode

echo   [方式 3] wscript 经 shell 启动
powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell; $s.Run('\"%NODE%\" \"%ENTRY%\"', 0, $false)"
timeout /t 6 /nobreak >nul
call :probe "方式3"
call :killnode

echo.
pause
exit /b 0

:probe
for /f "delims=" %%R in ('powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/state' -TimeoutSec 3 -UseBasicParsing).StatusCode}catch{''}" 2^>nul') do set "CODE=%%R"
if "%CODE%"=="200" (echo       %~1 结果: 存活 OK) else (echo       %~1 结果: 未存活)
goto :eof

:killnode
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*dsh-runtimes*' } | Stop-Process -Force" >nul 2>nul
timeout /t 2 /nobreak >nul
goto :eof

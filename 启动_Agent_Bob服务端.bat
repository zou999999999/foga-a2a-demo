@echo off
chcp 65001 >nul
title Agent Bob 服务端 (FOGA A2A Cell Provider)
echo ==================================================================
echo   🚀 正在启动 Agent Bob 服务端 (监听端口: 3001)
echo ==================================================================
echo.
cd /d "%~dp0"
node agent_bob_server.js
pause


@echo off
chcp 65001 >nul
title FOGA 双节点对称 P2P 演练启动器 (Peer 8888 ⇄ Peer 9999)
echo ==================================================================
echo   🌐 正在启动 FOGA 对称 P2P 双节点对等网络 (3001 ⇄ 3002)
echo   • 节点 A (Agent Bob, AID 8888)   : http://localhost:3001
echo   • 节点 B (Agent Alice, AID 9999) : http://localhost:3002
echo ==================================================================
echo.
cd /d "%~dp0"
start "FOGA Peer A - Agent Bob (Port 3001, AID 8888)" cmd /k "chcp 65001 >nul && node agent_bob_server.js"
timeout /t 2 >nul
start "FOGA Peer B - Agent Alice (Port 3002, AID 9999)" cmd /k "chcp 65001 >nul && node agent_bob_server.js --peer-b"
timeout /t 2 >nul
start http://localhost:3001
start http://localhost:3002
echo ✔ 双节点与双控制台已打开！可在任意节点页面点击按钮向对方发起 P2P 签名调用。
pause

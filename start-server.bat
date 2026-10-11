@echo off
setlocal EnableDelayedExpansion
title Chatterbox Server
cd /d "%~dp0"

set PORT=8000
set RULE=Chatterbox LAN TCP %PORT%
set RULE2=Chatterbox LAN TCP 8001

echo.
echo ==========================================
echo    Chatterbox - Local Network Server
echo ==========================================
echo.

rem ---- 1. Make sure the interpreter and script exist ----
where bonezegei >nul 2>&1
if errorlevel 1 (
    echo [ERROR] "bonezegei" was not found on this PC.
    echo         Install the Bonezegei interpreter and make sure it is on your PATH.
    echo.
    pause
    exit /b 1
)

if not exist "app.bzg" (
    echo [ERROR] app.bzg was not found next to this file.
    echo.
    pause
    exit /b 1
)

rem ---- 2. Windows Firewall: allow other devices to reach the port ----
netsh advfirewall firewall show rule name="%RULE2%" >nul 2>&1
if errorlevel 1 (
    net session >nul 2>&1
    if errorlevel 1 (
        echo [!] No firewall rule for port %PORT% yet, so other devices will be blocked.
        echo     Close this window, right-click start-server.bat and choose
        echo     "Run as administrator" once. After that you can run it normally.
        echo.
    ) else (
        netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=%PORT% profile=any >nul
        netsh advfirewall firewall add rule name="%RULE2%" dir=in action=allow protocol=TCP localport=8001 profile=any >nul
        echo [OK] Firewall rules added for ports %PORT% and 8001.
        echo.
    )
) else (
    echo [OK] Firewall rule for port %PORT% found.
    echo.
)

rem ---- 3. Show the addresses other devices should open ----
echo Open one of these on any phone or laptop on the SAME Wi-Fi:
echo.
set FOUND=0
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "IP=%%a"
    set "IP=!IP: =!"
    echo      http://!IP!:%PORT%
    set FOUND=1
)
if "!FOUND!"=="0" echo      No network address found. Connect to Wi-Fi first.
echo.
echo Usually the right one starts with 192.168 or 10.
echo On this PC you can also use http://localhost:%PORT%
echo.
echo Keep this window open while people are chatting.
echo Press Ctrl+C to stop the server.
echo ------------------------------------------
echo.

rem ---- 4. Start the accounts + chat history server (needs Node.js) ----
where node >nul 2>&1
if errorlevel 1 (
    echo [!] Node.js was not found, so log in, sign up and saved chats will NOT work.
    echo     Install Node.js from https://nodejs.org and run this file again.
    echo.
) else (
    start "Chatterbox Accounts" cmd /k node server\accounts.js
    echo [OK] Accounts server started in its own window ^(port 8001^).
    echo.
)

rem ---- 5. Run the chat server, restart it if it ever exits ----
:run
bonezegei app.bzg
echo.
echo [!] The server stopped. Restarting in 3 seconds. Press Ctrl+C to quit.
timeout /t 3 /nobreak >nul
echo.
goto run
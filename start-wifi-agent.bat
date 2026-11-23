
@echo off
chcp 65001 >nul
title HACKER TERMINAL WIFI AGENT

cd /d "%~dp0"

where node >nul 2>nul

if errorlevel 1 (
    echo Node.js is not installed.
    echo Install Node.js LTS from https://nodejs.org/
    pause
    exit /b 1
)

node wifi-agent.js

pause

@echo off
chcp 65001 >nul
title 寿司郎排队监控

cd /d "%~dp0"

echo ========================================
echo    🍣 寿司郎排队监控
echo ========================================
echo.

REM 检查 Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未找到 Python! 请先安装 Python 3.8+
    echo    下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

echo ✅ Python 已就绪
echo.

REM 安装依赖 (首次运行需要)
if not exist "venv\" (
    echo 📦 创建虚拟环境...
    python -m venv venv
    echo 📦 安装依赖...
    call venv\Scripts\activate.bat
    pip install -r requirements.txt -q
) else (
    call venv\Scripts\activate.bat
)

echo.
echo 🚀 启动监控...
echo.
echo    仪表盘地址: http://localhost:8888
echo.
echo    按 Ctrl+C 停止监控
echo ========================================
echo.

python monitor.py

pause

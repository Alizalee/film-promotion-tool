@echo off
chcp 65001 >nul 2>&1
title 影视剧宣发拉片工具 v2.0

echo.
echo ========================================
echo   🎬 影视剧宣发拉片工具 v2.0
echo ========================================
echo.

:: ─── 切换到脚本所在目录 ───
cd /d "%~dp0"

:: ─── 检查虚拟环境 ───
if not exist ".venv\Scripts\activate.bat" (
    echo ❌ 未找到虚拟环境 .venv，正在创建...
    python -m venv .venv
    if errorlevel 1 (
        echo ❌ 创建虚拟环境失败，请确保已安装 Python 3.10+
        pause
        exit /b 1
    )
    echo ✅ 虚拟环境创建成功
)

:: ─── 激活虚拟环境 ───
echo 📦 激活虚拟环境...
call .venv\Scripts\activate.bat

:: ─── 检查 Python 版本 ───
echo.
python --version
echo.

:: ─── 检查 FFmpeg ───
where ffmpeg >nul 2>&1
if errorlevel 1 (
    :: 尝试已知的 FFmpeg 路径
    if exist "D:\Ae Plug-ins Suite\Scripts\ScriptUI Panels\ffmpeg.exe" (
        set "FFMPEG_EXTRA_DIR=D:\Ae Plug-ins Suite\Scripts\ScriptUI Panels"
    )
)

:: 在 if 块外设置 PATH（避免延迟扩展问题）
if defined FFMPEG_EXTRA_DIR (
    set "PATH=%PATH%;%FFMPEG_EXTRA_DIR%"
    echo ✅ FFmpeg 已找到（AE插件目录）
) else (
    where ffmpeg >nul 2>&1
    if errorlevel 1 (
        echo ⚠️  未检测到 FFmpeg，视频裁剪导出功能将不可用
        echo    请从 https://ffmpeg.org/download.html 下载并添加到 PATH
        echo    后端将自动搜索常见 FFmpeg 安装路径
        echo.
    ) else (
        echo ✅ FFmpeg 已安装
    )
)

:: ─── 检查并安装依赖 ───
echo 📥 检查依赖...
pip install -q -r requirements.txt
if errorlevel 1 (
    echo ❌ 依赖安装失败，请检查网络连接
    pause
    exit /b 1
)
echo ✅ 依赖就绪
echo.

:: ─── 创建工作空间目录 ───
if not exist "workspace\uploads" mkdir "workspace\uploads"
if not exist "workspace\projects" mkdir "workspace\projects"

:: ─── 启动服务 ───
echo ========================================
echo   🚀 启动服务...
echo   地址：http://localhost:8088
echo   按 Ctrl+C 停止服务
echo ========================================
echo.

python -m uvicorn app:app --host 0.0.0.0 --port 8088 --reload

:: ─── 退出时暂停 ───
echo.
echo 服务已停止。
pause

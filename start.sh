#!/bin/bash
# ─── 影视剧宣发拉片工具 一键启动脚本 ───

set -e

# 项目根目录
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

echo "🎬 影视剧宣发拉片工具 v2.0"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── 检查 Python ───
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        PYTHON="$cmd"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "❌ 未找到 Python，请先安装 Python 3.10+"
    exit 1
fi

PYTHON_VER=$($PYTHON --version 2>&1)
echo "📦 Python: $PYTHON_VER"

# ─── 检查 FFmpeg ───
if command -v ffmpeg &>/dev/null; then
    echo "📦 FFmpeg: $(ffmpeg -version 2>&1 | head -1)"
else
    echo "⚠️  未检测到 FFmpeg，视频裁剪导出功能将不可用"
    echo "   安装方法：brew install ffmpeg"
fi

# ─── 创建虚拟环境 ───
VENV_DIR="$PROJECT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
    echo ""
    echo "🔧 创建虚拟环境..."
    $PYTHON -m venv "$VENV_DIR"
fi

# 激活虚拟环境
source "$VENV_DIR/bin/activate"

# ─── 安装依赖 ───
echo "📥 检查依赖..."
pip install -q -r requirements.txt

# ─── 检查模型目录 ───
MODELS_DIR="$PROJECT_DIR/models"
mkdir -p "$MODELS_DIR"
echo "✅ 模型目录就绪（YuNet ONNX 模型将在首次运行时自动下载）"

# ─── 创建工作空间 ───
mkdir -p "$PROJECT_DIR/workspace/uploads"
mkdir -p "$PROJECT_DIR/workspace/projects"

# ─── 启动服务 ───
echo ""
echo "🚀 启动服务..."
echo "   地址：http://localhost:8000"
echo "   按 Ctrl+C 停止"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload

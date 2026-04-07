# 影视剧宣发拉片工具 v2.0

面向影视剧宣发设计师的**本地化拉片工具**，支持自动场景检测、镜头管理、质量评估、视频裁剪导出。

## 快速开始

```bash
# 一键启动（自动安装依赖 + 下载模型）
chmod +x start.sh
./start.sh
```

启动后访问：http://localhost:8000

## 系统要求

- **Python** 3.10+
- **FFmpeg**（视频裁剪导出必需）
  - macOS: `brew install ffmpeg`
  - Ubuntu: `sudo apt install ffmpeg`

## 目录结构

```
project-root/
├── app.py                 # 后端服务入口（FastAPI）
├── requirements.txt       # Python 依赖
├── start.sh              # 一键启动脚本
├── models/               # 数据模型 & DNN 模型
│   ├── constants.py      # 配置常量
│   ├── schemas.py        # Pydantic 请求模型
│   ├── deploy.prototxt   # DNN 人脸检测（自动下载）
│   └── *.caffemodel      # DNN 权重文件（自动下载）
├── routes/               # API 路由层
│   ├── projects.py       # 项目管理
│   ├── videos.py         # 视频上传/分析/管理
│   ├── shots.py          # 镜头数据
│   ├── files.py          # 文件服务
│   └── export.py         # 导出
├── services/             # 业务逻辑层
│   ├── project_manager.py # 项目数据管理
│   ├── scene_detect.py    # 场景检测
│   ├── quality.py         # 画质评分
│   └── face_detect.py     # 人脸检测
├── static/               # 前端静态文件
│   ├── index.html        # HTML 骨架
│   ├── css/              # 样式模块
│   └── js/               # 脚本模块
└── workspace/            # 运行时数据（自动创建）
```

## 技术栈

| 层 | 技术 |
|---|------|
| 后端 | Python FastAPI |
| 前端 | 原生 HTML + CSS + JS（Apple 风格深色界面）|
| 图像处理 | OpenCV |
| 场景检测 | PySceneDetect |
| 视频裁剪 | FFmpeg |
| 数据存储 | JSON 文件 |

## 功能特性

- 🎬 自动场景检测与镜头分割
- 📊 画面质量智能评分（0-10分）
- 👤 人脸/人物自动检测
- ✂️ 镜头精确裁剪（帧级精度）
- 📋 多项目管理
- 🔍 多维度镜头筛选与搜索
- 📦 批量选择与导出
- 🔗 镜头合并
- 📱 全屏拖拽上传

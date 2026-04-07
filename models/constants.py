"""全局配置常量"""
import os

# 项目根目录
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 工作空间目录
WORKSPACE_DIR = os.path.join(BASE_DIR, "workspace")
UPLOADS_DIR = os.path.join(WORKSPACE_DIR, "uploads")
PROJECTS_DIR = os.path.join(WORKSPACE_DIR, "projects")
PROJECTS_INDEX = os.path.join(WORKSPACE_DIR, "projects.json")

# 模型目录
MODELS_DIR = os.path.join(BASE_DIR, "models")

# YuNet 人脸检测模型（OpenCV 内置，无需额外下载）
YUNET_SCORE_THRESHOLD = 0.6
YUNET_NMS_THRESHOLD = 0.3
YUNET_INPUT_SIZE = (320, 320)  # YuNet 默认输入尺寸

# 场景检测默认阈值（AdaptiveDetector 会自动映射此值）
DEFAULT_THRESHOLD = 27
MIN_THRESHOLD = 10
MAX_THRESHOLD = 60

# 质量评分权重
QUALITY_SHARPNESS_MAX = 3.0
QUALITY_CONTRAST_MAX = 2.5
QUALITY_COLOR_MAX = 2.5
QUALITY_BRIGHTNESS_MAX = 2.0

# 人脸检测（预筛用更低阈值，宁多勿漏）
YUNET_TRIAGE_SCORE = 0.4    # 预筛阶段用更低置信度
FACE_SAMPLE_POSITIONS = [0.25, 0.50, 0.75]

# JPEG 质量
JPEG_QUALITY = 95

# 缩略图设置（封面帧优化）
THUMBNAIL_WIDTH = 480
THUMBNAIL_JPEG_QUALITY = 80

# 人脸可辨识阈值（face_ratio >= 此值才计为可辨识人脸）
# YuNet 精度高、误检率低，降低阈值以覆盖远景/大全景小人脸
# 0.001 ≈ 1920×1080 画面中 45×45 像素的人脸
MIN_FACE_RATIO = 0.001

# HOG 人体检测最小面积比例（低于此值很可能是误检：柱子/文字/光影）
MIN_PERSON_RATIO = 0.02

# ── 宣发人像分类阈值（基于最大人脸占画面比例） ──
# 空镜: face_count == 0 且 face_ratio < 0.07%
# 远景人像: 0.07% ≤ face_ratio < 0.7%（含 face_count=0 但有小人脸的情况）
# 黄金人像: 0.7% ≤ face_ratio ≤ 3.7%
# 近景人像: face_ratio > 3.7%
FACE_RATIO_DISTANT_MIN = 0.0007  # 远景人像最低门槛（0.07%），兜底 face_count=0 但有小人脸
FACE_RATIO_TIER_LOW = 0.007      # 远景 / 黄金 分界线
FACE_RATIO_TIER_HIGH = 0.037     # 黄金 / 近景 分界线

# 视频支持格式
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".webm"}

# 静态文件目录
STATIC_DIR = os.path.join(BASE_DIR, "static")

# 确保必要目录存在
for d in [WORKSPACE_DIR, UPLOADS_DIR, PROJECTS_DIR, MODELS_DIR, STATIC_DIR]:
    os.makedirs(d, exist_ok=True)

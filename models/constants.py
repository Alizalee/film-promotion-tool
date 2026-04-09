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
# 0.002 ≈ 1920×1080 画面中 ~60×60 像素的人脸
MIN_FACE_RATIO = 0.002

# ── 人脸相对比例过滤（区分主体人物 vs 背景路人） ──
# 只有 face_ratio >= 最大脸 × FACE_RELATIVE_THRESHOLD 的脸才计入 face_count
# 0.3 = 30%: 两人对话构图中较远的脸约为较近的 50%~70% → 能通过
#            背景路人通常不到主体的 10% → 被过滤
FACE_RELATIVE_THRESHOLD = 0.3

# HOG 人体检测最小面积比例（低于此值很可能是误检：柱子/文字/光影）
MIN_PERSON_RATIO = 0.02

# ── 宣发人像分类阈值（基于最大人脸占画面比例） ──
# 空镜: face_count == 0 且 face_ratio < 0.07%
# 远景人像: 0.07% ≤ face_ratio < 0.7%（含 face_count=0 但有小人脸的情况）
# 黄金人像: 0.7% ≤ face_ratio ≤ 7%
# 近景人像: face_ratio > 7%
FACE_RATIO_DISTANT_MIN = 0.0007  # 远景人像最低门槛（0.07%），兜底 face_count=0 但有小人脸
FACE_RATIO_TIER_LOW = 0.007      # 远景 / 黄金 分界线
FACE_RATIO_TIER_HIGH = 0.07      # 黄金 / 近景 分界线（适配去黑边后 face_ratio 整体偏大）

# ── 构图安全性检测阈值（黄金人像优化） ──
# 黑边检测：像素均值低于此阈值视为黑边（0~255 灰度值）
BLACK_BAR_BRIGHTNESS_THRESHOLD = 20
# 黑边最小占比：黑边宽度/高度 < 画面的 3% 时忽略（防误检）
BLACK_BAR_MIN_RATIO = 0.03
# 裁头检测：头顶到画面上边缘的距离 < 人脸高度 × 此值 → 判定裁头
# 0.1 = 只有头顶非常贴近画面上边缘才判定裁头，减少中远景误判
HEAD_MARGIN_CROP_THRESHOLD = 0.1
# 头部扩展系数：YuNet 人脸框只到眉毛，头顶约在脸框上方 fh × 此值
# 0.4 = 补偿到发际线/头顶位置，不过度扩展（避免中远景误判裁头）
HEAD_EXTENSION_RATIO = 0.4
# 安全区域：画面内缩比例（类似 TV Action Safe Area）
SAFE_ZONE_MARGIN_RATIO = 0.05
# 贴边检测：人脸框边缘距画面边缘 < min(宽,高) × 此值 → 判定贴边
EDGE_THRESHOLD_RATIO = 0.02

# 视频支持格式
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".webm"}

# 静态文件目录
STATIC_DIR = os.path.join(BASE_DIR, "static")

# 确保必要目录存在
for d in [WORKSPACE_DIR, UPLOADS_DIR, PROJECTS_DIR, MODELS_DIR, STATIC_DIR]:
    os.makedirs(d, exist_ok=True)

"""全局配置常量"""
import os

# 项目根目录
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 工作空间目录
WORKSPACE_DIR = os.path.join(BASE_DIR, "workspace")
UPLOADS_DIR = os.path.join(WORKSPACE_DIR, "uploads")
PROJECTS_DIR = os.path.join(WORKSPACE_DIR, "projects")
PROJECTS_INDEX = os.path.join(WORKSPACE_DIR, "projects.json")

# DNN 人脸检测模型
MODELS_DIR = os.path.join(BASE_DIR, "models")
DNN_PROTOTXT = os.path.join(MODELS_DIR, "deploy.prototxt")
DNN_CAFFEMODEL = os.path.join(MODELS_DIR, "res10_300x300_ssd_iter_140000.caffemodel")

# DNN 模型下载 URL
DNN_PROTOTXT_URL = "https://raw.githubusercontent.com/opencv/opencv/master/samples/dnn/face_detector/deploy.prototxt"
DNN_CAFFEMODEL_URL = "https://raw.githubusercontent.com/opencv/opencv_3rdparty/dnn_samples_face_detector_20170830/res10_300x300_ssd_iter_140000.caffemodel"

# 场景检测默认阈值（AdaptiveDetector 会自动映射此值）
DEFAULT_THRESHOLD = 27
MIN_THRESHOLD = 10
MAX_THRESHOLD = 60

# 质量评分权重
QUALITY_SHARPNESS_MAX = 3.0
QUALITY_CONTRAST_MAX = 2.5
QUALITY_COLOR_MAX = 2.5
QUALITY_BRIGHTNESS_MAX = 2.0

# 人脸检测
DNN_CONFIDENCE_THRESHOLD = 0.5
HAAR_SCALE_FACTOR = 1.05
HAAR_MIN_NEIGHBORS = 3
HAAR_IOU_THRESHOLD = 0.35
FACE_SAMPLE_POSITIONS = [0.05, 0.15, 0.30, 0.50, 0.70, 0.85, 0.95]

# JPEG 质量
JPEG_QUALITY = 95

# 视频支持格式
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".webm"}

# 静态文件目录
STATIC_DIR = os.path.join(BASE_DIR, "static")

# 确保必要目录存在
for d in [WORKSPACE_DIR, UPLOADS_DIR, PROJECTS_DIR, MODELS_DIR, STATIC_DIR]:
    os.makedirs(d, exist_ok=True)

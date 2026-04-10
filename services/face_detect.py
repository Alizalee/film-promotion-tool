"""人脸检测服务 — YuNet 人脸检测，多帧采样"""
import os
import cv2
import logging
import numpy as np
from typing import Optional, List, Dict, Tuple

from models.constants import (
    YUNET_SCORE_THRESHOLD,
    YUNET_NMS_THRESHOLD,
    YUNET_TRIAGE_SCORE,
    MODELS_DIR,
    MIN_FACE_RATIO,
    FACE_RATIO_TIER_LOW,
    FACE_RATIO_TIER_HIGH,
    FACE_RATIO_DISTANT_MIN,
    FACE_RELATIVE_THRESHOLD,
    BLACK_BAR_BRIGHTNESS_THRESHOLD,
    BLACK_BAR_MIN_RATIO,
    HEAD_MARGIN_CROP_THRESHOLD,
    HEAD_EXTENSION_RATIO,
    SAFE_ZONE_MARGIN_RATIO,
    EDGE_THRESHOLD_RATIO,
)

logger = logging.getLogger(__name__)

# ─── 全局加载模型（避免每次调用重复加载） ───

_yunet_detector = None


def _load_yunet(input_w: int = 320, input_h: int = 320):
    """
    加载 YuNet 人脸检测器（OpenCV 4.5.4+ 内置，零额外依赖）。
    全局单例，按需更新 input size。
    """
    global _yunet_detector

    # 尝试查找 YuNet ONNX 模型文件
    model_path = os.path.join(MODELS_DIR, "face_detection_yunet_2023mar.onnx")

    if not os.path.exists(model_path):
        # OpenCV 自带的模型路径（某些发行版）
        alt_paths = [
            os.path.join(os.path.dirname(cv2.__file__), "data", "face_detection_yunet_2023mar.onnx"),
        ]
        for ap in alt_paths:
            if os.path.exists(ap):
                model_path = ap
                break
        else:
            # 自动下载 YuNet 模型
            _download_yunet_model(model_path)

    if not os.path.exists(model_path):
        logger.warning("YuNet 模型文件不存在，人脸检测将不可用")
        return None

    if _yunet_detector is not None:
        _yunet_detector.setInputSize((input_w, input_h))
        return _yunet_detector

    try:
        _yunet_detector = cv2.FaceDetectorYN.create(
            model=model_path,
            config="",
            input_size=(input_w, input_h),
            score_threshold=YUNET_SCORE_THRESHOLD,
            nms_threshold=YUNET_NMS_THRESHOLD,
            top_k=50,
        )
        logger.info("YuNet 人脸检测器加载成功")
        return _yunet_detector
    except Exception as e:
        logger.warning(f"YuNet 加载失败: {e}")
        return None


def _download_yunet_model(save_path: str):
    """下载 YuNet ONNX 模型文件"""
    import urllib.request

    url = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
    os.makedirs(os.path.dirname(save_path), exist_ok=True)

    try:
        logger.info("正在下载 YuNet 模型 ...")
        urllib.request.urlretrieve(url, save_path)
        logger.info("YuNet 模型下载完成")
    except Exception as e:
        logger.warning(f"YuNet 模型下载失败: {e}")


def _detect_faces_yunet(frame: np.ndarray, score_threshold: float = None) -> list:
    """
    使用 YuNet 检测人脸，返回 [(x, y, w, h, score), ...]。
    YuNet 对侧脸、遮挡的检测能力远超 SSD ResNet-10。

    Args:
        frame: BGR 图像
        score_threshold: 自定义置信度阈值（None 则用默认值）

    Returns:
        人脸框列表 [(x, y, w, h, score), ...]，模型不可用返回 None
    """
    h, w = frame.shape[:2]
    detector = _load_yunet(w, h)
    if detector is None:
        return None

    # 临时调整阈值
    if score_threshold is not None:
        detector.setScoreThreshold(score_threshold)

    try:
        _, faces = detector.detect(frame)
    except Exception as e:
        logger.warning(f"YuNet 检测失败: {e}")
        if score_threshold is not None:
            detector.setScoreThreshold(YUNET_SCORE_THRESHOLD)
        return None
    finally:
        # 恢复默认阈值
        if score_threshold is not None:
            detector.setScoreThreshold(YUNET_SCORE_THRESHOLD)

    if faces is None:
        return []

    result = []
    for face in faces:
        x, y, fw, fh = int(face[0]), int(face[1]), int(face[2]), int(face[3])
        score = float(face[-1])
        if fw > 0 and fh > 0:
            result.append((x, y, fw, fh, score))

    return result


def _calc_box_ratio(box, frame_shape) -> float:
    """计算框面积占画面面积的比例"""
    h, w = frame_shape[:2]
    frame_area = w * h
    if frame_area == 0:
        return 0.0
    box_area = box[2] * box[3]  # w * h of box
    return box_area / frame_area


# ─── 黑边检测缓存（每个视频只需检测一次） ───
_effective_region_cache: Dict[str, Optional[Tuple[int, int, int, int]]] = {}


def detect_effective_region(
    frame: np.ndarray,
    threshold: int = BLACK_BAR_BRIGHTNESS_THRESHOLD,
    min_ratio: float = BLACK_BAR_MIN_RATIO,
) -> Tuple[int, int, int, int]:
    """
    检测有效画面区域，去除上下/左右黑边（letterbox / pillarbox）。

    算法：
    1. 转灰度
    2. 从上/下/左/右四个方向逐行/逐列扫描
    3. 当某行/列的像素均值 > threshold 时，认为进入有效区域
    4. min_ratio 防误检：黑边至少占画面 3% 才认为是真正的黑边

    Args:
        frame: BGR 图像
        threshold: 黑边亮度阈值（灰度值 0~255）
        min_ratio: 黑边最小占比（低于此值忽略）

    Returns:
        (y_top, y_bottom, x_left, x_right) — 有效区域的像素坐标边界
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    min_black_rows = int(h * min_ratio)
    min_black_cols = int(w * min_ratio)

    # 上黑边：从顶部向下扫描
    y_top = 0
    for i in range(h // 2):
        if np.mean(gray[i, :]) > threshold:
            y_top = i
            break

    # 下黑边：从底部向上扫描
    y_bottom = h
    for i in range(h - 1, h // 2, -1):
        if np.mean(gray[i, :]) > threshold:
            y_bottom = i + 1
            break

    # 左黑边（pillarbox）
    x_left = 0
    for j in range(w // 2):
        if np.mean(gray[:, j]) > threshold:
            x_left = j
            break

    # 右黑边
    x_right = w
    for j in range(w - 1, w // 2, -1):
        if np.mean(gray[:, j]) > threshold:
            x_right = j + 1
            break

    # 防误检：黑边太窄（< min_ratio）则忽略
    if y_top < min_black_rows:
        y_top = 0
    if (h - y_bottom) < min_black_rows:
        y_bottom = h
    if x_left < min_black_cols:
        x_left = 0
    if (w - x_right) < min_black_cols:
        x_right = w

    return (y_top, y_bottom, x_left, x_right)


def get_effective_region_cached(
    video_path: str, frame: Optional[np.ndarray] = None
) -> Optional[Tuple[int, int, int, int]]:
    """
    获取视频的有效画面区域（带缓存）。每个视频只检测一次。

    Args:
        video_path: 视频文件路径
        frame: 可选的已读帧（避免重新打开视频读帧）

    Returns:
        (y_top, y_bottom, x_left, x_right) 或 None
    """
    if video_path in _effective_region_cache:
        return _effective_region_cache[video_path]

    if frame is not None:
        region = detect_effective_region(frame)
        _effective_region_cache[video_path] = region
        return region

    # 没有传入帧时，从视频第 30 帧读取（跳过片头黑屏）
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        _effective_region_cache[video_path] = None
        return None

    try:
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        target_frame = min(30, max(0, total - 1))
        cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
        ret, f = cap.read()
        if not ret or f is None:
            _effective_region_cache[video_path] = None
            return None
        region = detect_effective_region(f)
        _effective_region_cache[video_path] = region
        return region
    finally:
        cap.release()


def _calc_box_ratio_effective(
    box, frame_shape, effective_region: Optional[Tuple[int, int, int, int]] = None
) -> float:
    """
    计算人脸框面积占【有效画面】面积的比例（排除黑边）。

    Args:
        box: (x, y, w, h, ...) 检测框
        frame_shape: 原始帧 shape
        effective_region: (y_top, y_bottom, x_left, x_right) 有效区域，None 则退化为全帧

    Returns:
        面积比例 (0~1)
    """
    if effective_region:
        y_top, y_bottom, x_left, x_right = effective_region
        eff_h = y_bottom - y_top
        eff_w = x_right - x_left
        frame_area = eff_w * eff_h
    else:
        h, w = frame_shape[:2]
        frame_area = w * h

    if frame_area <= 0:
        return 0.0

    box_area = box[2] * box[3]
    return box_area / frame_area


def check_face_composition(
    face_box,
    frame_shape,
    effective_region: Optional[Tuple[int, int, int, int]] = None,
) -> dict:
    """
    检测人脸在有效画面中的构图质量。

    判断维度：
    1. 裁头检测：人脸框上边缘是否被画面上边缘截断
    2. 安全区域：人脸中心是否在画面的安全区域内（类似 TV safe area）
    3. 贴边检测：人脸框是否紧贴画面任意边缘

    Args:
        face_box: (x, y, w, h, ...) 人脸检测框
        frame_shape: 帧 shape (h, w, ...)
        effective_region: (y_top, y_bottom, x_left, x_right)

    Returns:
        {
            "is_cropped": bool,         # 人脸被裁切（头顶被切）
            "is_edge": bool,            # 人脸贴边
            "in_safe_zone": bool,       # 人脸中心在安全区域内
            "head_margin_ratio": float, # 头顶到上边缘的距离 / 人脸高度
        }
    """
    fx, fy, fw, fh = face_box[:4]

    if effective_region:
        y_top, y_bottom, x_left, x_right = effective_region
    else:
        h, w = frame_shape[:2]
        y_top, y_bottom, x_left, x_right = 0, h, 0, w

    eff_h = y_bottom - y_top
    eff_w = x_right - x_left

    if eff_h <= 0 or eff_w <= 0 or fh <= 0:
        return {
            "is_cropped": False,
            "is_edge": False,
            "in_safe_zone": True,
            "head_margin_ratio": 1.0,
        }

    # 人脸框相对于有效区域的坐标
    rel_x = fx - x_left
    rel_y = fy - y_top

    # —— 裁头检测 ——
    # ★ YuNet 人脸框只框脸部（眉毛→下巴），不含头顶/发际线/头饰
    # 估算头顶位置 = 人脸框上边缘 - fh × HEAD_EXTENSION_RATIO
    estimated_head_top = rel_y - fh * HEAD_EXTENSION_RATIO
    head_margin = estimated_head_top  # 估算头顶到画面上边缘的距离
    head_margin_ratio = head_margin / fh if fh > 0 else 0
    is_cropped = head_margin_ratio < HEAD_MARGIN_CROP_THRESHOLD

    # —— 安全区域检测（Action Safe = 画面内缩 5%）——
    safe_margin_x = eff_w * SAFE_ZONE_MARGIN_RATIO
    safe_margin_y = eff_h * SAFE_ZONE_MARGIN_RATIO
    face_center_x = rel_x + fw / 2
    face_center_y = rel_y + fh / 2

    in_safe_zone = (
        safe_margin_x <= face_center_x <= eff_w - safe_margin_x
        and safe_margin_y <= face_center_y <= eff_h - safe_margin_y
    )

    # —— 贴边检测 ——
    edge_threshold = min(eff_w, eff_h) * EDGE_THRESHOLD_RATIO
    is_edge = (
        rel_x < edge_threshold
        or rel_y < edge_threshold
        or (rel_x + fw) > (eff_w - edge_threshold)
        or (rel_y + fh) > (eff_h - edge_threshold)
    )

    return {
        "is_cropped": is_cropped,
        "is_edge": is_edge,
        "in_safe_zone": in_safe_zone,
        "head_margin_ratio": round(head_margin_ratio, 3),
    }


def detect_face_info(
    frame: np.ndarray,
    effective_region: Optional[Tuple[int, int, int, int]] = None,
) -> dict:
    """
    对单帧进行 YuNet 人脸检测，返回:
    {
        "has_person": bool,
        "face_ratio": float,    # 最大人脸占【有效画面】比例 (0~1)
        "good_composition": bool,
        "face_count": int,      # 可辨识人脸数量
        "face_cropped": bool,   # 最大人脸是否被裁头
        "face_in_safe_zone": bool,  # 最大人脸是否在安全区内
        "head_margin_ratio": float, # 头顶留白比例
        "has_black_bars": bool, # 帧是否有黑边
    }

    Args:
        frame: BGR 图像
        effective_region: (y_top, y_bottom, x_left, x_right)，None 则不做黑边修正
    """
    result = {
        "has_person": False,
        "face_ratio": 0.0,
        "good_composition": False,
        "face_count": 0,
        "face_cropped": False,
        "face_in_safe_zone": True,
        "head_margin_ratio": 1.0,
        "has_black_bars": False,
    }

    # 判断是否有黑边（有效区域 != 全帧）
    if effective_region:
        h, w = frame.shape[:2]
        y_top, y_bottom, x_left, x_right = effective_region
        if y_top > 0 or y_bottom < h or x_left > 0 or x_right < w:
            result["has_black_bars"] = True

    max_face_ratio = 0.0
    all_face_ratios = []
    best_face_box = None  # 跟踪最大人脸框（用于构图检测）

    # ── YuNet 人脸检测 ──
    yunet_faces = _detect_faces_yunet(frame)
    if yunet_faces is not None and len(yunet_faces) > 0:
        result["has_person"] = True
        for face in yunet_faces:
            # ★ 使用有效区域面积计算 face_ratio（去黑边）
            ratio = _calc_box_ratio_effective(face, frame.shape, effective_region)
            if ratio > max_face_ratio:
                max_face_ratio = ratio
                best_face_box = face
            all_face_ratios.append(ratio)

    # 统计"视觉显著"的人脸数量（相对比例过滤）
    if all_face_ratios:
        relative_threshold = max(max_face_ratio * FACE_RELATIVE_THRESHOLD, MIN_FACE_RATIO)
        valid_face_count = sum(1 for r in all_face_ratios if r >= relative_threshold)
    else:
        valid_face_count = 0

    # ── 构图安全性检测（对最大人脸做检查）──
    if best_face_box is not None:
        composition = check_face_composition(best_face_box, frame.shape, effective_region)
        result["face_cropped"] = composition["is_cropped"]
        result["face_in_safe_zone"] = composition["in_safe_zone"]
        result["head_margin_ratio"] = composition["head_margin_ratio"]

    result["face_ratio"] = round(float(max_face_ratio), 4)
    # 黄金人像：face_ratio 在区间内 + 构图合格（未裁头 + 在安全区内）
    ratio_in_range = FACE_RATIO_TIER_LOW <= max_face_ratio <= FACE_RATIO_TIER_HIGH
    composition_ok = not result["face_cropped"] and result["face_in_safe_zone"]
    result["good_composition"] = bool(ratio_in_range and composition_ok)
    result["face_count"] = valid_face_count

    return result


def _classify_frame_label(face_ratio: float, face_count: int,
                          face_cropped: bool, face_in_safe_zone: bool) -> str:
    """
    对单帧做独立分类（与 shot_type_detect.classify_shot_label 逻辑一致）。
    内联在此处避免循环 import，阈值完全复用 constants.py。
    """
    if face_ratio > FACE_RATIO_TIER_HIGH:
        return "近景人像"
    elif face_ratio >= FACE_RATIO_TIER_LOW:
        if face_cropped or not face_in_safe_zone:
            return "近景人像"
        return "黄金人像"
    elif face_ratio >= FACE_RATIO_DISTANT_MIN:
        return "远景人像"
    if face_count > 0:
        return "远景人像"
    return "空镜"


# 帧分类优先级：黄金人像 > 近景人像 > 远景人像 > 空镜
_FRAME_LABEL_PRIORITY = {"黄金人像": 0, "近景人像": 1, "远景人像": 2, "空镜": 3}


def detect_face_info_from_frames(
    frames: Dict[int, np.ndarray],
    resize_width: int = 640,
    effective_region: Optional[Tuple[int, int, int, int]] = None,
) -> dict:
    """
    对已读取的多帧进行人脸检测（复用帧，避免重复读取视频）。

    ★ 聚合策略（v2 — 逐帧独立分类，选最优帧）：
    - 每帧独立做人脸检测 + 构图检测 + 分类
    - 按优先级选最优帧：黄金人像 > 近景人像 > 远景人像 > 空镜
    - 最优帧的 face_ratio / 构图信息作为整个镜头的代表值
    - face_count 取所有帧最大值（不变）
    - 返回 best_frame_num，供调用方更新封面

    Args:
        frames: {frame_num: BGR_image, ...} 已读好的帧字典
        resize_width: 检测前降采样的目标宽度
        effective_region: 原始分辨率下的有效区域 (y_top, y_bottom, x_left, x_right)，
                          会按降采样比例同步缩放

    Returns:
        {
            "has_person": bool,
            "face_ratio": float,
            "good_composition": bool,
            "face_count": int,
            "face_cropped": bool,
            "face_in_safe_zone": bool,
            "head_margin_ratio": float,
            "has_black_bars": bool,
            "best_frame_num": int | None,  # ★ 最优帧帧号，供封面更新
            "per_frame": {frame_num: {face_ratio, face_count}, ...}
        }
    """
    default_result = {
        "has_person": False, "face_ratio": 0.0,
        "good_composition": False, "face_count": 0,
        "face_cropped": False, "face_in_safe_zone": True, "head_margin_ratio": 1.0,
        "has_black_bars": False,
        "best_frame_num": None,
        "per_frame": {},
    }

    if not frames:
        return default_result

    best_has_person = False
    best_has_black_bars = False
    per_frame = {}

    # face_count 取所有帧最大值（不变）
    best_face_count = 0

    # ★ 逐帧独立分类，记录每帧的分类结果
    frame_classifications = []  # [(fn, info, label, priority), ...]

    for fn, frame in frames.items():
        if frame is None:
            continue

        # 降采样
        h, w = frame.shape[:2]
        if w > resize_width:
            scale = resize_width / w
            resized = cv2.resize(frame, (resize_width, int(h * scale)))
            # ★ 同步缩放有效区域坐标
            if effective_region:
                er = effective_region
                scaled_region = (
                    int(er[0] * scale),
                    int(er[1] * scale),
                    int(er[2] * scale),
                    int(er[3] * scale),
                )
            else:
                scaled_region = None
        else:
            resized = frame
            scaled_region = effective_region

        info = detect_face_info(resized, effective_region=scaled_region)

        per_frame[fn] = {
            "face_ratio": info["face_ratio"],
            "face_count": info["face_count"],
        }

        if info["has_person"]:
            best_has_person = True
        if info["has_black_bars"]:
            best_has_black_bars = True

        best_face_count = max(best_face_count, info["face_count"])

        # ★ 逐帧独立分类
        label = _classify_frame_label(
            face_ratio=info["face_ratio"],
            face_count=info["face_count"],
            face_cropped=info["face_cropped"],
            face_in_safe_zone=info["face_in_safe_zone"],
        )
        priority = _FRAME_LABEL_PRIORITY.get(label, 3)
        frame_classifications.append((fn, info, label, priority))

    if not frame_classifications:
        return default_result

    # ★ 按优先级排序：黄金 > 近景 > 远景 > 空镜
    # 同优先级时，优先选 face_ratio 更大的帧（构图更饱满）
    frame_classifications.sort(key=lambda x: (x[3], -x[1]["face_ratio"]))

    # 选最优帧作为整个镜头的代表
    best_fn, best_info, best_label, _ = frame_classifications[0]

    return {
        "has_person": best_has_person,
        "face_ratio": round(float(best_info["face_ratio"]), 4),
        "good_composition": bool(best_info["good_composition"]),
        "face_count": best_face_count,
        "face_cropped": best_info["face_cropped"],
        "face_in_safe_zone": best_info["face_in_safe_zone"],
        "head_margin_ratio": best_info["head_margin_ratio"],
        "has_black_bars": best_has_black_bars,
        "best_frame_num": best_fn,
        "per_frame": per_frame,
    }


def detect_face_info_multi_frame(
    video_path: str,
    start_frame: int,
    end_frame: int,
    sample_count: int = 3,
    effective_region: Optional[Tuple[int, int, int, int]] = None,
) -> dict:
    """
    多帧采样人脸检测 — 在镜头的 25%、50%、75% 位置采样，
    取各指标的最大值，大幅提高检测命中率。

    Args:
        video_path: 视频文件路径
        start_frame: 镜头起始帧
        end_frame: 镜头结束帧
        sample_count: 采样帧数（默认 3）
        effective_region: 有效画面区域 (y_top, y_bottom, x_left, x_right)，
                          传入后裁头检测和 face_ratio 都会基于有效区域计算；
                          未传入时自动从缓存获取

    Returns:
        同 detect_face_info_from_frames 的返回值
    """
    default_result = {
        "has_person": False, "face_ratio": 0.0,
        "good_composition": False, "face_count": 0,
        "per_frame": {},
    }

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return default_result

    try:
        frame_count = end_frame - start_frame
        if frame_count < 1:
            return default_result

        # 生成采样位置：25%, 50%, 75%（避开首尾，首帧常有转场残影）
        positions = [0.25, 0.50, 0.75]
        if frame_count < 10:
            positions = [0.50]

        frames = {}
        for p in positions[:sample_count]:
            fn = start_frame + int(frame_count * p)
            fn = max(start_frame, min(fn, end_frame - 1))
            cap.set(cv2.CAP_PROP_POS_FRAMES, fn)
            ret, frame = cap.read()
            if ret and frame is not None:
                frames[fn] = frame

        # ★ 若未传入 effective_region，从缓存获取（确保裁头检测和 face_ratio 考虑黑边）
        if effective_region is None:
            effective_region = get_effective_region_cached(video_path)

        return detect_face_info_from_frames(frames, effective_region=effective_region)
    finally:
        cap.release()


def quick_triage_from_frames(frames: Dict[int, np.ndarray]) -> dict:
    """
    快速预筛：基于已读帧，判断镜头是否值得深度分析。
    仅使用 YuNet 人脸检测。

    Args:
        frames: {frame_num: BGR_image, ...}

    Returns:
        {"worth": bool, "best_face_count": int, "best_face_ratio": float}
    """
    best_face_count = 0
    best_face_ratio = 0.0

    for fn, frame in frames.items():
        if frame is None:
            continue

        # 缩到 480px 做检测
        h, w = frame.shape[:2]
        if w > 480:
            scale = 480 / w
            small = cv2.resize(frame, (480, int(h * scale)))
        else:
            small = frame

        # YuNet 人脸检测（预筛用更低置信度）
        faces = _detect_faces_yunet(small, score_threshold=YUNET_TRIAGE_SCORE)
        if faces:
            valid_count = 0
            max_ratio = 0.0
            for f in faces:
                ratio = _calc_box_ratio(f, small.shape)
                max_ratio = max(max_ratio, ratio)
                if ratio >= MIN_FACE_RATIO:
                    valid_count += 1
            best_face_count = max(best_face_count, valid_count)
            best_face_ratio = max(best_face_ratio, max_ratio)

    return {
        "worth": best_face_count > 0,
        "best_face_count": best_face_count,
        "best_face_ratio": best_face_ratio,
    }

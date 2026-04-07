"""人脸 + 人体检测服务 — YuNet 人脸 + HOG 人体 双维度检测，多帧采样"""
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
    MIN_PERSON_RATIO,
    FACE_RATIO_TIER_LOW,
    FACE_RATIO_TIER_HIGH,
)

logger = logging.getLogger(__name__)

# ─── 全局加载模型（避免每次调用重复加载） ───

_yunet_detector = None
_hog_detector = None


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


def _load_hog_detector():
    """加载 HOG 人体检测器（OpenCV 内置，零依赖）"""
    global _hog_detector
    if _hog_detector is None:
        _hog_detector = cv2.HOGDescriptor()
        _hog_detector.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    return _hog_detector


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


def _detect_person_hog(frame: np.ndarray) -> list:
    """
    使用 HOG + SVM 人体检测器检测人体，返回人体框 [(x, y, w, h), ...]
    能检测到侧身、背影等无脸的人像
    """
    hog = _load_hog_detector()

    # HOG 检测需要一定分辨率，降采样到 480px 宽
    h, w = frame.shape[:2]
    scale = 1.0
    if w > 480:
        scale = 480 / w
        frame = cv2.resize(frame, (480, int(h * scale)))

    try:
        rects, weights = hog.detectMultiScale(
            frame,
            winStride=(8, 8),
            padding=(4, 4),
            scale=1.05,
            hitThreshold=0.3,  # 提高 SVM 决策阈值，减少误报（默认 0 太宽松）
        )
    except Exception:
        return []

    if len(rects) == 0:
        return []

    # 还原到原图坐标
    persons = []
    for (x, y, bw, bh) in rects:
        ox = int(x / scale)
        oy = int(y / scale)
        obw = int(bw / scale)
        obh = int(bh / scale)
        persons.append((ox, oy, obw, obh))

    # NMS 去重
    if len(persons) > 1:
        weights_np = np.array(weights).flatten() if len(weights) > 0 else np.ones(len(persons))
        indices = cv2.dnn.NMSBoxes(
            [[x, y, w, h] for (x, y, w, h) in persons],
            weights_np.tolist(),
            score_threshold=0.0,
            nms_threshold=0.4,
        )
        if len(indices) > 0:
            indices = indices.flatten() if hasattr(indices, 'flatten') else indices
            persons = [persons[i] for i in indices]

    return persons


def _calc_box_ratio(box, frame_shape) -> float:
    """计算框面积占画面面积的比例"""
    h, w = frame_shape[:2]
    frame_area = w * h
    if frame_area == 0:
        return 0.0
    box_area = box[2] * box[3]  # w * h of box
    return box_area / frame_area


def detect_face_info(frame: np.ndarray) -> dict:
    """
    对单帧进行 YuNet 人脸 + HOG 人体检测，返回:
    {
        "has_person": bool,
        "face_ratio": float,    # 最大人脸占画面比例 (0~1)
        "person_ratio": float,  # 最大人体占画面比例 (0~1)
        "good_composition": bool,
        "face_count": int,      # 可辨识人脸数量
        "person_count": int,    # HOG 检测到的人体数量
    }
    """
    result = {
        "has_person": False,
        "face_ratio": 0.0,
        "person_ratio": 0.0,
        "good_composition": False,
        "face_count": 0,
        "person_count": 0,
    }

    max_face_ratio = 0.0
    max_person_ratio = 0.0
    all_face_ratios = []

    # ── 1. YuNet 人脸检测 ──
    yunet_faces = _detect_faces_yunet(frame)
    if yunet_faces is not None and len(yunet_faces) > 0:
        result["has_person"] = True
        for face in yunet_faces:
            ratio = _calc_box_ratio(face, frame.shape)
            max_face_ratio = max(max_face_ratio, ratio)
            all_face_ratios.append(ratio)

    # ── 2. HOG 人体检测（能捕获背影/侧身）──
    persons = _detect_person_hog(frame)
    if len(persons) > 0:
        valid_person_count = 0
        for person in persons:
            ratio = _calc_box_ratio(person, frame.shape)
            max_person_ratio = max(max_person_ratio, ratio)
            if ratio >= MIN_PERSON_RATIO:
                valid_person_count += 1
        if valid_person_count > 0:
            result["has_person"] = True
        result["person_count"] = valid_person_count

    # 统计可辨识人脸数量（face_ratio >= MIN_FACE_RATIO 的才算）
    valid_face_count = sum(1 for r in all_face_ratios if r >= MIN_FACE_RATIO)

    result["face_ratio"] = round(float(max_face_ratio), 4)
    result["person_ratio"] = round(float(max_person_ratio), 4)
    # 黄金人像：face_ratio 在 0.7%~3.7% 区间
    result["good_composition"] = bool(FACE_RATIO_TIER_LOW <= max_face_ratio <= FACE_RATIO_TIER_HIGH)
    result["face_count"] = valid_face_count

    return result


def detect_face_info_from_frames(frames: Dict[int, np.ndarray], resize_width: int = 640) -> dict:
    """
    对已读取的多帧进行人脸 + 人体检测（复用帧，避免重复读取视频）。

    Args:
        frames: {frame_num: BGR_image, ...} 已读好的帧字典
        resize_width: 检测前降采样的目标宽度

    Returns:
        {
            "has_person": bool,
            "face_ratio": float,
            "person_ratio": float,
            "good_composition": bool,
            "face_count": int,
            "person_count": int,
            "per_frame": {frame_num: {face_ratio, person_ratio, face_count, person_count}, ...}
        }
    """
    default_result = {
        "has_person": False, "face_ratio": 0.0, "person_ratio": 0.0,
        "good_composition": False, "face_count": 0, "person_count": 0,
        "per_frame": {},
    }

    if not frames:
        return default_result

    best_has_person = False
    best_face_ratio = 0.0
    best_person_ratio = 0.0
    best_good_composition = False
    per_frame = {}

    # 收集每帧的人数（用于中位数投票）
    all_face_counts = []
    all_person_counts = []

    for fn, frame in frames.items():
        if frame is None:
            continue

        # 降采样
        h, w = frame.shape[:2]
        if w > resize_width:
            scale = resize_width / w
            resized = cv2.resize(frame, (resize_width, int(h * scale)))
        else:
            resized = frame

        info = detect_face_info(resized)

        per_frame[fn] = {
            "face_ratio": info["face_ratio"],
            "person_ratio": info["person_ratio"],
            "face_count": info["face_count"],
            "person_count": info["person_count"],
        }

        if info["has_person"]:
            best_has_person = True
        best_face_ratio = max(best_face_ratio, info["face_ratio"])
        best_person_ratio = max(best_person_ratio, info["person_ratio"])
        if info["good_composition"]:
            best_good_composition = True
        all_face_counts.append(info["face_count"])
        all_person_counts.append(info["person_count"])

    # 取中位数而非 max — 避免单帧 HOG 误检膨胀结果
    import statistics
    best_face_count = int(statistics.median(all_face_counts)) if all_face_counts else 0
    best_person_count = int(statistics.median(all_person_counts)) if all_person_counts else 0

    return {
        "has_person": best_has_person,
        "face_ratio": round(float(best_face_ratio), 4),
        "person_ratio": round(float(best_person_ratio), 4),
        "good_composition": best_good_composition,
        "face_count": best_face_count,
        "person_count": best_person_count,
        "per_frame": per_frame,
    }


def detect_face_info_multi_frame(
    video_path: str,
    start_frame: int,
    end_frame: int,
    sample_count: int = 3,
) -> dict:
    """
    多帧采样人脸 + 人体检测 — 在镜头的 25%、50%、75% 位置采样，
    取各指标的最大值，大幅提高检测命中率。

    Args:
        video_path: 视频文件路径
        start_frame: 镜头起始帧
        end_frame: 镜头结束帧
        sample_count: 采样帧数（默认 3）

    Returns:
        同 detect_face_info_from_frames 的返回值
    """
    default_result = {
        "has_person": False, "face_ratio": 0.0, "person_ratio": 0.0,
        "good_composition": False, "face_count": 0, "person_count": 0,
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

        return detect_face_info_from_frames(frames)
    finally:
        cap.release()


def detect_face_info_mid_frame(
    video_path: str, mid_frame: int
) -> dict:
    """
    只对镜头中间帧做人脸 + 人体检测（兼容旧调用）
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"has_person": False, "face_ratio": 0.0, "person_ratio": 0.0, "good_composition": False}

    try:
        cap.set(cv2.CAP_PROP_POS_FRAMES, mid_frame)
        ret, frame = cap.read()
        if not ret or frame is None:
            return {"has_person": False, "face_ratio": 0.0, "person_ratio": 0.0, "good_composition": False}

        # 降采样到 640px 宽度加速检测
        h, w = frame.shape[:2]
        if w > 640:
            scale = 640 / w
            frame = cv2.resize(frame, (640, int(h * scale)))

        return detect_face_info(frame)
    finally:
        cap.release()


def quick_triage_from_frames(frames: Dict[int, np.ndarray]) -> dict:
    """
    快速预筛：基于已读帧，判断镜头是否值得深度分析。
    YuNet 人脸 + HOG 人体兜底，宁多勿漏。

    Args:
        frames: {frame_num: BGR_image, ...}

    Returns:
        {"worth": bool, "best_face_count": int, "best_face_ratio": float, "has_person_body": bool}
    """
    best_face_count = 0
    best_face_ratio = 0.0
    has_person_body = False

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

        # 1) YuNet 人脸检测（预筛用更低置信度）
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

        # 2) 人脸没检测到时，HOG 检测人体兜底（侧身/背影/远景小人）
        if best_face_count == 0 and not has_person_body:
            # HOG 用 320px 快速跑一次
            if w > 320:
                scale_hog = 320 / w
                hog_frame = cv2.resize(frame, (320, int(h * scale_hog)))
            else:
                hog_frame = frame
            persons = _detect_person_hog(hog_frame)
            if len(persons) > 0:
                # 只有面积比例足够大的人体才算有效（过滤柱子/文字/光影误检）
                for p in persons:
                    if _calc_box_ratio(p, hog_frame.shape) >= MIN_PERSON_RATIO:
                        has_person_body = True
                        break

    return {
        "worth": best_face_count > 0 or has_person_body,
        "best_face_count": best_face_count,
        "best_face_ratio": best_face_ratio,
        "has_person_body": has_person_body,
    }

"""人脸 + 人体检测服务 — DNN人脸 + HOG人体 双维度检测，多帧采样"""
import os
import cv2
import logging
import urllib.request
import numpy as np
from typing import Optional, List, Tuple

from models.constants import (
    DNN_PROTOTXT,
    DNN_CAFFEMODEL,
    DNN_PROTOTXT_URL,
    DNN_CAFFEMODEL_URL,
    DNN_CONFIDENCE_THRESHOLD,
    HAAR_SCALE_FACTOR,
    HAAR_MIN_NEIGHBORS,
    HAAR_IOU_THRESHOLD,
    MODELS_DIR,
)

logger = logging.getLogger(__name__)

# ─── 全局加载模型（避免每次调用重复加载） ───

_dnn_net = None
_dnn_download_attempted = False
_haar_face = None
_haar_profile = None
_hog_detector = None


def _download_dnn_model():
    """自动下载 DNN 人脸检测模型文件"""
    global _dnn_download_attempted
    if _dnn_download_attempted:
        return
    _dnn_download_attempted = True

    os.makedirs(MODELS_DIR, exist_ok=True)

    for url, path, name in [
        (DNN_PROTOTXT_URL, DNN_PROTOTXT, "deploy.prototxt"),
        (DNN_CAFFEMODEL_URL, DNN_CAFFEMODEL, "caffemodel"),
    ]:
        if os.path.exists(path):
            continue
        try:
            logger.info(f"正在下载 DNN 模型: {name} ...")
            urllib.request.urlretrieve(url, path)
            logger.info(f"DNN 模型下载完成: {name}")
        except Exception as e:
            logger.warning(f"DNN 模型下载失败 ({name}): {e}")


def _load_dnn_model():
    """加载 DNN 人脸检测模型（全局单例），不存在时自动下载"""
    global _dnn_net
    if _dnn_net is not None:
        return _dnn_net

    # 文件不存在时尝试自动下载
    if not os.path.exists(DNN_PROTOTXT) or not os.path.exists(DNN_CAFFEMODEL):
        _download_dnn_model()

    if os.path.exists(DNN_PROTOTXT) and os.path.exists(DNN_CAFFEMODEL):
        try:
            _dnn_net = cv2.dnn.readNetFromCaffe(DNN_PROTOTXT, DNN_CAFFEMODEL)
            logger.info("DNN 人脸检测模型加载成功")
            return _dnn_net
        except Exception as e:
            logger.warning(f"DNN 模型加载失败: {e}")
    return None


def _load_haar_cascades():
    """加载 Haar 级联检测器（全局单例）"""
    global _haar_face, _haar_profile

    if _haar_face is None:
        _haar_face = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
    if _haar_profile is None:
        _haar_profile = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_profileface.xml"
        )

    return _haar_face, _haar_profile


def _load_hog_detector():
    """加载 HOG 人体检测器（OpenCV 内置，零依赖）"""
    global _hog_detector
    if _hog_detector is None:
        _hog_detector = cv2.HOGDescriptor()
        _hog_detector.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    return _hog_detector


def _detect_faces_dnn(frame: np.ndarray) -> list:
    """
    使用 DNN 检测器检测人脸，返回所有人脸框 [(x, y, w, h, confidence), ...]
    如果模型不可用返回 None
    """
    net = _load_dnn_model()
    if net is None:
        return None

    h, w = frame.shape[:2]
    blob = cv2.dnn.blobFromImage(
        cv2.resize(frame, (300, 300)), 1.0, (300, 300), (104.0, 177.0, 123.0)
    )
    net.setInput(blob)
    detections = net.forward()

    faces = []
    for i in range(detections.shape[2]):
        confidence = detections[0, 0, i, 2]
        if confidence > DNN_CONFIDENCE_THRESHOLD:
            box = detections[0, 0, i, 3:7] * np.array([w, h, w, h])
            x1, y1, x2, y2 = box.astype(int)
            fw = x2 - x1
            fh = y2 - y1
            if fw > 0 and fh > 0:
                faces.append((x1, y1, fw, fh, float(confidence)))

    return faces


def _detect_faces_haar(frame: np.ndarray) -> list:
    """
    使用 Haar 级联检测器检测人脸，返回人脸框 [(x, y, w, h), ...]
    """
    haar_face, haar_profile = _load_haar_cascades()
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    all_boxes = []

    # 正脸检测
    faces = haar_face.detectMultiScale(
        gray, scaleFactor=HAAR_SCALE_FACTOR, minNeighbors=HAAR_MIN_NEIGHBORS
    )
    if len(faces) > 0:
        all_boxes.extend(faces.tolist())

    # 左侧脸检测
    profiles = haar_profile.detectMultiScale(
        gray, scaleFactor=HAAR_SCALE_FACTOR, minNeighbors=HAAR_MIN_NEIGHBORS
    )
    if len(profiles) > 0:
        all_boxes.extend(profiles.tolist())

    # 右侧脸检测（水平翻转）
    flipped = cv2.flip(gray, 1)
    profiles_r = haar_profile.detectMultiScale(
        flipped, scaleFactor=HAAR_SCALE_FACTOR, minNeighbors=HAAR_MIN_NEIGHBORS
    )
    if len(profiles_r) > 0:
        w = gray.shape[1]
        for (x, y, pw, ph) in profiles_r:
            all_boxes.append([w - x - pw, y, pw, ph])

    # IoU 去重
    if all_boxes:
        result = [all_boxes[0]]
        for box in all_boxes[1:]:
            is_dup = False
            for existing in result:
                # 简单 IoU
                x1 = max(box[0], existing[0])
                y1 = max(box[1], existing[1])
                x2 = min(box[0] + box[2], existing[0] + existing[2])
                y2 = min(box[1] + box[3], existing[1] + existing[3])
                inter = max(0, x2 - x1) * max(0, y2 - y1)
                area_a = box[2] * box[3]
                area_b = existing[2] * existing[3]
                union = area_a + area_b - inter
                if union > 0 and inter / union > HAAR_IOU_THRESHOLD:
                    is_dup = True
                    break
            if not is_dup:
                result.append(box)
        return result

    return []


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
        boxes_np = np.array([[x, y, x + w, y + h] for (x, y, w, h) in persons])
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
    对单帧进行人脸 + 人体检测，返回:
    {
        "has_person": bool,
        "face_ratio": float,    # 最大人脸占画面比例 (0~1)
        "person_ratio": float,  # 最大人体占画面比例 (0~1)
        "good_composition": bool,
    }
    """
    result = {
        "has_person": False,
        "face_ratio": 0.0,
        "person_ratio": 0.0,
        "good_composition": False,
    }

    max_face_ratio = 0.0
    max_person_ratio = 0.0

    # ── 1. 人脸检测（DNN 优先，Haar 兜底）──
    dnn_faces = _detect_faces_dnn(frame)
    if dnn_faces is not None and len(dnn_faces) > 0:
        result["has_person"] = True
        for face in dnn_faces:
            ratio = _calc_box_ratio(face, frame.shape)
            max_face_ratio = max(max_face_ratio, ratio)
    elif dnn_faces is None:
        # DNN 不可用，回退到 Haar
        haar_faces = _detect_faces_haar(frame)
        if len(haar_faces) > 0:
            result["has_person"] = True
            for face in haar_faces:
                ratio = _calc_box_ratio(face, frame.shape)
                max_face_ratio = max(max_face_ratio, ratio)

    # ── 2. 人体检测（HOG，能捕获背影/侧身）──
    persons = _detect_person_hog(frame)
    if len(persons) > 0:
        result["has_person"] = True
        for person in persons:
            ratio = _calc_box_ratio(person, frame.shape)
            max_person_ratio = max(max_person_ratio, ratio)

    result["face_ratio"] = round(float(max_face_ratio), 4)
    result["person_ratio"] = round(float(max_person_ratio), 4)
    result["good_composition"] = bool(0.03 <= max_face_ratio <= 0.15)

    return result


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
        {"has_person": bool, "face_ratio": float, "person_ratio": float, "good_composition": bool}
    """
    default_result = {"has_person": False, "face_ratio": 0.0, "person_ratio": 0.0, "good_composition": False}

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
            # 很短的镜头，只采样中间帧
            positions = [0.50]

        sample_frames = []
        for p in positions[:sample_count]:
            fn = start_frame + int(frame_count * p)
            fn = max(start_frame, min(fn, end_frame - 1))
            sample_frames.append(fn)

        best_has_person = False
        best_face_ratio = 0.0
        best_person_ratio = 0.0
        best_good_composition = False

        for fn in sample_frames:
            cap.set(cv2.CAP_PROP_POS_FRAMES, fn)
            ret, frame = cap.read()
            if not ret or frame is None:
                continue

            # 降采样到 640px 宽度（比原来的 320px 更清晰，人脸检出率更高）
            h, w = frame.shape[:2]
            if w > 640:
                scale = 640 / w
                frame = cv2.resize(frame, (640, int(h * scale)))

            info = detect_face_info(frame)

            if info["has_person"]:
                best_has_person = True
            best_face_ratio = max(best_face_ratio, info["face_ratio"])
            best_person_ratio = max(best_person_ratio, info["person_ratio"])
            if info["good_composition"]:
                best_good_composition = True

        return {
            "has_person": best_has_person,
            "face_ratio": round(float(best_face_ratio), 4),
            "person_ratio": round(float(best_person_ratio), 4),
            "good_composition": best_good_composition,
        }
    finally:
        cap.release()


def detect_face_info_mid_frame(
    video_path: str, mid_frame: int
) -> dict:
    """
    只对镜头中间帧做人脸 + 人体检测（兼容旧调用）

    Args:
        video_path: 视频文件路径
        mid_frame: 中间帧号

    Returns:
        {"has_person": bool, "face_ratio": float, "person_ratio": float, "good_composition": bool}
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

"""场景检测核心逻辑 — 使用 PySceneDetect 自动识别镜头切换点"""
import os
import cv2
import hashlib
import numpy as np
from typing import Optional, Callable

from scenedetect import open_video, SceneManager
from scenedetect.detectors import AdaptiveDetector

from models.constants import DEFAULT_THRESHOLD, JPEG_QUALITY, THUMBNAIL_WIDTH, THUMBNAIL_JPEG_QUALITY

# 镜头边界安全裁剪帧数（修复卡到相邻镜头的问题）
BOUNDARY_TRIM_FRAMES = 2


def _video_hash(video_path: str) -> str:
    """生成视频文件的短哈希（用于 shot ID）"""
    h = hashlib.md5(video_path.encode()).hexdigest()[:6]
    return h


def _frame_to_timecode(frame_num: int, fps: float) -> str:
    """帧号 → 时间码 HH-MM-SS-FFf（用于文件名和 ID）"""
    total_seconds = frame_num / fps
    hours = int(total_seconds // 3600)
    minutes = int((total_seconds % 3600) // 60)
    seconds = int(total_seconds % 60)
    remaining_frames = int(frame_num % fps)
    return f"{hours:02d}-{minutes:02d}-{seconds:02d}-{remaining_frames:02d}f"


def _frame_to_display_timecode(frame_num: int, fps: float) -> str:
    """帧号 → 显示用时间码 HH:MM:SS:FF"""
    total_seconds = frame_num / fps
    hours = int(total_seconds // 3600)
    minutes = int((total_seconds % 3600) // 60)
    seconds = int(total_seconds % 60)
    remaining_frames = int(frame_num % fps)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{remaining_frames:02d}"


def detect_scenes(video_path: str, threshold: Optional[int] = None) -> tuple:
    """
    检测视频中的场景切换点。
    使用 AdaptiveDetector（自适应阈值），对渐变/闪光的处理更鲁棒。

    Args:
        video_path: 视频文件路径
        threshold: 灵敏度阈值 (10-60)，越小越灵敏，默认 27

    Returns:
        (scene_list, fps, total_frames)
        scene_list: [(start_frame, end_frame), ...]
        fps: 视频帧率
        total_frames: 总帧数
    """
    if threshold is None:
        threshold = DEFAULT_THRESHOLD

    video = open_video(video_path)
    fps = video.frame_rate
    total_frames = video.duration.get_frames()

    # 将用户阈值（10-60 范围）映射为 AdaptiveDetector 的 adaptive_threshold
    # 用户阈值 10（灵敏）→ adaptive 2.0,  27（默认）→ 3.0,  60（迟钝）→ 5.0
    adaptive_th = 2.0 + (threshold - 10) * (3.0 / 50.0)
    # 同时设置 min_content_val，防止噪声触发
    min_cv = max(10.0, threshold * 0.5)

    scene_manager = SceneManager()
    scene_manager.downscale = 3  # 降采样加速场景检测
    scene_manager.add_detector(AdaptiveDetector(
        adaptive_threshold=adaptive_th,
        min_scene_len=15,
        min_content_val=min_cv,
        window_width=2,
    ))
    scene_manager.detect_scenes(video)

    scene_list = scene_manager.get_scene_list()

    # 转换为 (start_frame, end_frame) 元组列表
    scenes = []
    for scene in scene_list:
        start_frame = scene[0].get_frames()
        end_frame = scene[1].get_frames()

        # 安全裁剪：end_time 前移几帧，避免卡到后一个镜头
        end_frame = max(start_frame + 1, end_frame - BOUNDARY_TRIM_FRAMES)

        scenes.append((start_frame, end_frame))

    # 如果没有检测到任何场景（可能整个视频就是一个镜头）
    if not scenes and total_frames > 0:
        scenes = [(0, max(1, total_frames - BOUNDARY_TRIM_FRAMES))]

    return scenes, fps, total_frames


def extract_frame(video_path: str, frame_num: int) -> Optional[np.ndarray]:
    """
    从视频中提取指定帧。

    Args:
        video_path: 视频文件路径
        frame_num: 帧号

    Returns:
        BGR 格式的 numpy 数组，失败返回 None
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None

    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
    ret, frame = cap.read()
    cap.release()

    if ret:
        return frame
    return None


def _safe_imwrite(path: str, img: np.ndarray, params: list):
    """
    安全的图片写入 — 兼容中文/非 ASCII 路径。
    OpenCV 4.x 的 cv2.imwrite 在某些平台 + Python 版本下
    不支持路径含非 ASCII 字符，改用 imencode + 手动写文件。
    """
    ext = os.path.splitext(path)[1] or '.jpg'
    ok, buf = cv2.imencode(ext, img, params)
    if ok:
        os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(path) else None
        with open(path, 'wb') as f:
            f.write(buf.tobytes())
        return True
    return False


def save_frame_jpeg(frame: np.ndarray, output_path: str):
    """将帧保存为 JPEG 文件"""
    _safe_imwrite(output_path, frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])


def save_thumbnail(frame: np.ndarray, output_path: str):
    """将帧缩放到缩略图尺寸后保存为 JPEG"""
    h, w = frame.shape[:2]
    if w > THUMBNAIL_WIDTH:
        scale = THUMBNAIL_WIDTH / w
        frame = cv2.resize(frame, (THUMBNAIL_WIDTH, int(h * scale)))
    _safe_imwrite(output_path, frame, [cv2.IMWRITE_JPEG_QUALITY, THUMBNAIL_JPEG_QUALITY])


def build_shots_fast(
    scenes: list,
    fps: float,
    video_path: str,
    frames_dir: str,
    index_offset: int = 0,
    cancel_check: Callable[[], bool] = None,
) -> list:
    """
    快速构建 Shot 数据 — 只做镜头拆分 + 提取中间帧缩略图。
    跳过动态值计算和人脸检测，让用户快速进入主页面。

    Args:
        scenes: [(start_frame, end_frame), ...]
        fps: 视频帧率
        video_path: 视频文件路径
        frames_dir: 帧输出目录
        index_offset: 全局序号偏移
        cancel_check: 取消检查回调

    Returns:
        Shot 字典列表
    """
    os.makedirs(frames_dir, exist_ok=True)
    video_hash = _video_hash(video_path)
    shots = []

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return shots

    # 按中间帧帧号排序，减少随机 seek（封面取中间帧）
    indexed_scenes = list(enumerate(scenes))
    sorted_scenes = sorted(indexed_scenes, key=lambda x: (x[1][0] + x[1][1]) // 2)

    # 先按排序顺序提取帧
    frame_data = {}  # orig_idx -> (frame_file, frame_path)

    try:
        for orig_idx, (start_frame, end_frame) in sorted_scenes:
            if cancel_check and orig_idx % 5 == 0 and cancel_check():
                break

            idx = orig_idx + index_offset
            timecode = _frame_to_timecode(start_frame, fps)
            shot_id = f"shot_{idx:04d}_{video_hash}_{timecode}"
            frame_file = f"{shot_id}.jpg"
            frame_path = os.path.join(frames_dir, frame_file)

            # 提取中间帧并保存为缩略图（避免黑屏过渡导致封面全黑）
            mid = (start_frame + end_frame) // 2
            cap.set(cv2.CAP_PROP_POS_FRAMES, mid)
            ret, frame = cap.read()
            if ret and frame is not None:
                save_thumbnail(frame, frame_path)

            frame_data[orig_idx] = frame_file

        # 按原始顺序构建 shot 列表
        for i, (start_frame, end_frame) in enumerate(scenes):
            if cancel_check and cancel_check():
                break

            idx = i + index_offset
            mid_frame = (start_frame + end_frame) // 2
            timecode = _frame_to_timecode(start_frame, fps)
            timecode_display = _frame_to_display_timecode(start_frame, fps)

            shot_id = f"shot_{idx:04d}_{video_hash}_{timecode}"
            frame_file = frame_data.get(i, f"{shot_id}.jpg")

            start_time = round(start_frame / fps, 3)
            end_time = round(end_frame / fps, 3)
            duration = round(end_time - start_time, 3)

            shot = {
                "id": shot_id,
                "index": idx,
                "timecode": timecode,
                "timecode_display": timecode_display,
                "start_frame": start_frame,
                "end_frame": end_frame,
                "mid_frame": mid_frame,
                "start_time": start_time,
                "end_time": end_time,
                "duration": duration,
                "has_person": False,
                "face_ratio": 0.0,
                "face_count": 0,
                "good_composition": False,
                "motion_score": 0.0,
                "shot_type": "",
                "face_detected": False,
                "shot_type_detected": False,
                "face_cropped": False,
                "face_in_safe_zone": True,
                "head_margin_ratio": 1.0,
                "has_black_bars": False,
                "favorite": False,
                "saved": False,
                "frame_file": frame_file,
                "source_video": os.path.abspath(video_path),
            }
            shots.append(shot)
    finally:
        cap.release()

    return shots


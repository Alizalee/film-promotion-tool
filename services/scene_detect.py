"""场景检测核心逻辑 — 使用 PySceneDetect 自动识别镜头切换点"""
import os
import cv2
import hashlib
import numpy as np
from typing import Optional, Callable

from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector, AdaptiveDetector

from models.constants import DEFAULT_THRESHOLD, JPEG_QUALITY, THUMBNAIL_WIDTH, THUMBNAIL_JPEG_QUALITY, MIN_FACE_RATIO

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


def save_frame_jpeg(frame: np.ndarray, output_path: str):
    """将帧保存为 JPEG 文件"""
    cv2.imwrite(output_path, frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])


def _calc_motion_score_from_frames(first_frame: np.ndarray, last_frame: np.ndarray) -> float:
    """
    计算首尾帧差作为镜头动态值（基础值）。
    后续 _calc_motion_score_multi 会做更精准的多帧采样。

    Args:
        first_frame: 首帧 (BGR)
        last_frame: 尾帧 (BGR)

    Returns:
        动态值 0.0 ~ 100.0
    """
    if first_frame is None or last_frame is None:
        return 0.0

    f1, f2 = first_frame, last_frame

    # 降采样到 120px 宽加速
    h, w = f1.shape[:2]
    if w > 120:
        scale = 120 / w
        f1 = cv2.resize(f1, (120, int(h * scale)))
        f2 = cv2.resize(f2, (120, int(h * scale)))

    # 转灰度计算帧差
    gray1 = cv2.cvtColor(f1, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray2 = cv2.cvtColor(f2, cv2.COLOR_BGR2GRAY).astype(np.float32)
    diff = np.abs(gray1 - gray2).mean()

    # 归一化到 0-100
    score = min(100.0, (diff / 25.0) * 100.0)
    return round(float(score), 1)


def _calc_motion_score_multi(cap, start_frame: int, end_frame: int) -> float:
    """
    多帧采样动态差异 — 更准确地反映镜头运动强度。

    策略：
    1. 在镜头内均匀采样 5 个点，计算相邻帧对之间的差分
    2. 对每对使用光流向量的平均幅度来度量运动
    3. 取所有帧对的运动量平均值，归一化到 0-100

    这解决了首尾帧差法的问题：
    - 来回运动：采样中间帧可以捕捉到运动
    - 慢推/慢拉：光流比像素差更敏感
    - 静止镜头：会得到非常低的分数

    Args:
        cap: 已打开的 VideoCapture
        start_frame: 起始帧号
        end_frame: 结束帧号

    Returns:
        动态值 0.0 ~ 100.0
    """
    frame_count = end_frame - start_frame
    if frame_count < 2:
        return 0.0

    # 均匀采样 5 个帧位置（最多不超过帧数）
    num_samples = min(5, frame_count)
    if num_samples < 2:
        return 0.0

    sample_frames = []
    for i in range(num_samples):
        fn = start_frame + int(i * frame_count / (num_samples - 1))
        fn = min(fn, end_frame)
        sample_frames.append(fn)

    # 读取采样帧并转为灰度
    gray_frames = []
    for fn in sample_frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, fn)
        ret, frame = cap.read()
        if ret and frame is not None:
            h, w = frame.shape[:2]
            if w > 160:
                scale = 160 / w
                frame = cv2.resize(frame, (160, int(h * scale)))
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            gray_frames.append(gray)
        else:
            gray_frames.append(None)

    if len([g for g in gray_frames if g is not None]) < 2:
        return 0.0

    # 计算相邻帧对之间的运动量
    motion_values = []
    for i in range(len(gray_frames) - 1):
        g1 = gray_frames[i]
        g2 = gray_frames[i + 1]
        if g1 is None or g2 is None:
            continue

        try:
            # 使用 Farneback 光流
            flow = cv2.calcOpticalFlowFarneback(
                g1, g2,
                None,
                pyr_scale=0.5,
                levels=3,
                winsize=15,
                iterations=3,
                poly_n=5,
                poly_sigma=1.2,
                flags=0,
            )
            # 计算光流向量的幅度
            mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
            # 使用 90 百分位幅度（忽略极端值，避免噪声影响）
            motion = float(np.percentile(mag, 90))
            motion_values.append(motion)
        except Exception:
            # 光流计算失败时降级为帧差法
            diff = np.abs(g1.astype(np.float32) - g2.astype(np.float32)).mean()
            motion_values.append(diff * 0.1)  # 缩放到类似光流的量级

    if not motion_values:
        return 0.0

    # 取平均运动量
    avg_motion = np.mean(motion_values)

    # 归一化到 0-100
    # 光流幅度通常在 0~30 范围，映射到 0~100
    score = min(100.0, (avg_motion / 15.0) * 100.0)
    return round(float(score), 1)


def build_shots_from_scenes(
    scenes: list,
    fps: float,
    video_path: str,
    frames_dir: str,
    index_offset: int = 0,
    face_func=None,
    cancel_check: Callable[[], bool] = None,
) -> list:
    """
    从场景列表构建完整的 Shot 数据列表，并提取关键帧。
    
    性能优化：
    - 只打开一次 VideoCapture
    - 封面取首帧（导演剪辑切点，画面最稳定）
    - 动态值 = 多帧采样光流法（更准确反映镜头运动强度）
    - 人脸检测延迟到用户筛选时触发（初始分析不做）
    - 支持取消回调

    Args:
        scenes: [(start_frame, end_frame), ...]
        fps: 视频帧率
        video_path: 视频文件路径
        frames_dir: 帧输出目录
        index_offset: 全局序号偏移
        face_func: 未使用（保持兼容）
        cancel_check: 取消检查回调，返回 True 时中断

    Returns:
        Shot 字典列表
    """
    os.makedirs(frames_dir, exist_ok=True)
    video_hash = _video_hash(video_path)
    shots = []

    # ★ 只打开一次视频
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return shots

    try:
        for i, (start_frame, end_frame) in enumerate(scenes):
            # ★ 每 5 个镜头检查一次取消状态
            if cancel_check and i % 5 == 0 and cancel_check():
                break

            idx = i + index_offset
            mid_frame = (start_frame + end_frame) // 2
            timecode = _frame_to_timecode(start_frame, fps)
            timecode_display = _frame_to_display_timecode(start_frame, fps)

            shot_id = f"shot_{idx:04d}_{video_hash}_{timecode}"
            frame_file = f"{shot_id}.jpg"

            start_time = round(start_frame / fps, 3)
            end_time = round(end_frame / fps, 3)
            duration = round(end_time - start_time, 3)

            # ★ 第 1 次 seek：提取首帧（用于封面）
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
            ret_first, first_frame = cap.read()

            if ret_first and first_frame is not None:
                # 保存首帧作为封面
                frame_path = os.path.join(frames_dir, frame_file)
                save_frame_jpeg(first_frame, frame_path)

            # ★ 动态值 = 多帧采样光流法（更准确的运动量评估）
            motion_score = _calc_motion_score_multi(cap, start_frame, end_frame)

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
                "good_composition": False,
                "motion_score": float(motion_score),
                "favorite": False,
                "saved": False,
                "frame_file": frame_file,
                "source_video": os.path.abspath(video_path),
            }
            shots.append(shot)
    finally:
        cap.release()

    return shots


def save_thumbnail(frame: np.ndarray, output_path: str):
    """将帧缩放到缩略图尺寸后保存为 JPEG"""
    h, w = frame.shape[:2]
    if w > THUMBNAIL_WIDTH:
        scale = THUMBNAIL_WIDTH / w
        frame = cv2.resize(frame, (THUMBNAIL_WIDTH, int(h * scale)))
    cv2.imwrite(output_path, frame, [cv2.IMWRITE_JPEG_QUALITY, THUMBNAIL_JPEG_QUALITY])


def build_shots_fast(
    scenes: list,
    fps: float,
    video_path: str,
    frames_dir: str,
    index_offset: int = 0,
    cancel_check: Callable[[], bool] = None,
) -> list:
    """
    快速构建 Shot 数据 — 只做镜头拆分 + 提取首帧缩略图。
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

    # 收集所有首帧帧号并排序，减少随机 seek
    indexed_scenes = list(enumerate(scenes))
    sorted_scenes = sorted(indexed_scenes, key=lambda x: x[1][0])

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

            # 提取首帧并保存为缩略图
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
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


def select_representative_frame(
    cap, start_frame: int, end_frame: int, shot_label: str, face_info_by_pos: dict
) -> tuple:
    """
    根据镜头分类结果，选择最能代表该镜头的帧。

    Args:
        cap: VideoCapture
        start_frame / end_frame: 帧范围
        shot_label: "近景人像" | "黄金人像" | "远景人像" | "空镜"
        face_info_by_pos: {frame_num: {face_ratio, face_count}} 各采样帧的检测结果

    Returns:
        (frame_num, frame_image) 最佳代表帧的帧号和图像
    """
    if shot_label in ("近景人像", "黄金人像", "远景人像") and face_info_by_pos:
        # 选人脸占比最大的帧
        best_fn = max(
            face_info_by_pos.keys(),
            key=lambda fn: face_info_by_pos[fn].get("face_ratio", 0)
        )
        cap.set(cv2.CAP_PROP_POS_FRAMES, best_fn)
        ret, frame = cap.read()
        if ret:
            return best_fn, frame

    # 空镜或回退：取中间帧（比首帧更有代表性）
    mid = (start_frame + end_frame) // 2
    cap.set(cv2.CAP_PROP_POS_FRAMES, mid)
    ret, frame = cap.read()
    if ret:
        return mid, frame

    return start_frame, None


def _calc_motion_score_fast(cap, start_frame: int, end_frame: int) -> float:
    """
    快速动态值 — 3帧 Lab 彩色帧差（替代光流法），速度提升 5-8 倍。
    使用 Lab 色彩空间替代灰度，能更好捕捉特效光影、色彩变化等人眼可感知的动态。

    Args:
        cap: 已打开的 VideoCapture
        start_frame: 起始帧号
        end_frame: 结束帧号

    Returns:
        动态值 0.0 ~ 100.0
    """
    frame_count = end_frame - start_frame
    if frame_count < 2:
        return 0.0

    # 只采样 3 个位置：25%, 50%, 75%
    positions = [0.25, 0.50, 0.75]
    labs = []
    for p in positions:
        fn = start_frame + int(frame_count * p)
        cap.set(cv2.CAP_PROP_POS_FRAMES, fn)
        ret, frame = cap.read()
        if ret and frame is not None:
            h, w = frame.shape[:2]
            if w > 160:
                scale = 160 / w
                frame = cv2.resize(frame, (160, int(h * scale)))
            # Lab 色彩空间：L(亮度) a(绿→红) b(蓝→黄)，更贴近人眼感知
            labs.append(cv2.cvtColor(frame, cv2.COLOR_BGR2Lab).astype(np.float32))

    if len(labs) < 2:
        return 0.0

    diffs = [np.abs(labs[i] - labs[i + 1]).mean() for i in range(len(labs) - 1)]
    score = min(100.0, (np.mean(diffs) / 25.0) * 100.0)
    return round(float(score), 1)

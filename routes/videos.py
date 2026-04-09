"""视频上传、分析与管理 API 路由 — 快速返回 + 后台异步分析"""
import os
import cv2
import time
import shutil
import logging
import threading
import asyncio
import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile, File, Query
from typing import Optional

from models.schemas import AnalyzeRequest, AnalyzeAppendRequest, VideoDeleteRequest, ReanalyzeRequest, BatchAnalyzeRequest
from models.constants import (
    UPLOADS_DIR,
    SUPPORTED_VIDEO_EXTENSIONS,
    DEFAULT_THRESHOLD,
    MIN_FACE_RATIO,
)
from services.project_manager import (
    get_active_project_id,
    load_project_data,
    save_project_data,
    get_project_dir,
    update_project_info,
    load_projects_index,
)
from services.scene_detect import (
    detect_scenes,
    build_shots_from_scenes,
    build_shots_fast,
    save_thumbnail,
    select_representative_frame,
)
from services.face_detect import (
    detect_face_info_from_frames,
    quick_triage_from_frames,
    _calc_box_ratio,
    get_effective_region_cached,
)
from services.shot_type_detect import classify_shot_label

logger = logging.getLogger(__name__)

router = APIRouter()

# ── 分析取消机制 ──
_cancel_flag = threading.Event()

# ── 后台任务状态 ──
_bg_task_status = {
    "running": False,
    "stage": "idle",      # idle | splitting | analyzing | done
    "progress": 0,        # 进度百分比 0-100
    "project_id": None,
    "current_video": "",   # 当前正在拆分的视频文件名
    "split_queue": 0,      # 拆分队列剩余数
    "split_done": 0,       # 已完成拆分的视频数
    "analyzed_count": 0,   # 已分析完成的镜头数
    "total_count": 0,      # 镜头总数
}
_bg_task_lock = threading.Lock()
_bg_task_thread: threading.Thread | None = None  # 当前后台线程引用


def _stop_running_bg_task(timeout: float = 30):
    """
    如果有后台任务正在运行，取消它并等待线程退出。
    确保新任务启动前不会与旧任务产生竞争。
    """
    global _bg_task_thread
    with _bg_task_lock:
        is_running = _bg_task_status["running"]
    if is_running and _bg_task_thread and _bg_task_thread.is_alive():
        _cancel_flag.set()
        _bg_task_thread.join(timeout=timeout)
        # join 后重置
        _cancel_flag.clear()
    _bg_task_thread = None


def is_cancelled() -> bool:
    """检查是否已请求取消"""
    return _cancel_flag.is_set()


def _get_active_project_or_fail() -> str:
    """获取活跃项目 ID，不存在则抛出异常"""
    pid = get_active_project_id()
    if not pid:
        raise HTTPException(status_code=400, detail="没有活跃项目，请先创建项目")
    return pid


def _validate_video_path(video_path: str):
    """验证视频路径是否有效"""
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail=f"视频文件不存在: {video_path}")
    ext = os.path.splitext(video_path)[1].lower()
    if ext not in SUPPORTED_VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的视频格式: {ext}")


def _update_bg_status(stage: str, progress: int = 0, running: bool = True, project_id: str = None,
                      current_video: str = None, split_queue: int = None, split_done: int = None,
                      analyzed_count: int = None, total_count: int = None):
    """线程安全地更新后台任务状态"""
    with _bg_task_lock:
        _bg_task_status["stage"] = stage
        _bg_task_status["progress"] = progress
        _bg_task_status["running"] = running
        if project_id is not None:
            _bg_task_status["project_id"] = project_id
        if current_video is not None:
            _bg_task_status["current_video"] = current_video
        if split_queue is not None:
            _bg_task_status["split_queue"] = split_queue
        if split_done is not None:
            _bg_task_status["split_done"] = split_done
        if analyzed_count is not None:
            _bg_task_status["analyzed_count"] = analyzed_count
        if total_count is not None:
            _bg_task_status["total_count"] = total_count


def _read_sample_frames(cap, start_frame: int, end_frame: int) -> dict:
    """
    读取镜头的采样帧（25%, 50%, 75%），统一复用于预筛、深度分析和动态值计算。
    短镜头（<10帧）采两端帧（25%, 75%），极短镜头（<3帧）只采中间帧。

    Returns:
        {frame_num: BGR_image, ...}
    """
    frame_count = end_frame - start_frame
    if frame_count < 1:
        return {}

    positions = [0.25, 0.50, 0.75]
    if frame_count < 3:
        positions = [0.50]
    elif frame_count < 10:
        positions = [0.25, 0.75]

    frames = {}
    for p in positions:
        fn = start_frame + int(frame_count * p)
        fn = max(start_frame, min(fn, end_frame - 1))
        if fn in frames:
            continue
        cap.set(cv2.CAP_PROP_POS_FRAMES, fn)
        ret, frame = cap.read()
        if ret and frame is not None:
            frames[fn] = frame

    return frames


def _calc_motion_from_frames(frames: dict) -> float:
    """
    从已读帧计算动态值（Lab 彩色帧差法），复用采样帧，避免重复读取。
    相比灰度帧差法，Lab 色彩空间能更好地捕捉特效光影、色彩变化等人眼可感知的动态。

    Args:
        frames: {frame_num: BGR_image, ...}

    Returns:
        动态值 0.0 ~ 100.0
    """
    if len(frames) < 2:
        return 0.0

    # 按帧号排序
    sorted_fns = sorted(frames.keys())
    labs = []
    for fn in sorted_fns:
        frame = frames[fn]
        if frame is None:
            continue
        h, w = frame.shape[:2]
        if w > 160:
            scale = 160 / w
            small = cv2.resize(frame, (160, int(h * scale)))
        else:
            small = frame
        # Lab 色彩空间：L(亮度) a(绿→红) b(蓝→黄)，更贴近人眼感知
        labs.append(cv2.cvtColor(small, cv2.COLOR_BGR2Lab).astype(np.float32))

    if len(labs) < 2:
        return 0.0

    diffs = [np.abs(labs[i] - labs[i + 1]).mean() for i in range(len(labs) - 1)]
    score = min(100.0, (np.mean(diffs) / 25.0) * 100.0)
    return round(float(score), 1)


def _background_analysis(project_id: str, video_paths: list):
    """
    后台分析任务 — 单遍扫描（支持断点续传）：
    每个镜头只读一次帧（25%, 50%, 75%），同时完成：
      ① 快速预筛（YuNet 人脸 + HOG 人体兜底）
      ② 深度人像检测 + 人数统计 + 景别分类 + 智能选帧
      ③ 动态值计算（灰度帧差）
    断点续传：跳过已完成分析的镜头（face_detected=True），避免重复计算。
    取消时保存：被取消时保存已完成的中间结果到磁盘。
    """
    try:
        project_data = load_project_data(project_id)
        if not project_data:
            _update_bg_status("done", 100, False, project_id,
                              analyzed_count=0, total_count=0)
            return

        shots = project_data.get("shots", [])
        if not shots:
            _update_bg_status("done", 100, False, project_id,
                              analyzed_count=0, total_count=0)
            return

        total_shots = len(shots)

        # ★ 断点续传：统计已完成的镜头数
        already_done = sum(1 for s in shots if s.get("face_detected", False))

        if already_done >= total_shots:
            # 所有镜头都已分析完成
            _update_bg_status("done", 100, False, project_id,
                              analyzed_count=total_shots, total_count=total_shots)
            return

        _update_bg_status("analyzing", int(already_done / max(total_shots, 1) * 100),
                          True, project_id,
                          analyzed_count=already_done, total_count=total_shots)

        # 按视频分组
        from collections import defaultdict
        video_shots = defaultdict(list)
        for shot in shots:
            vpath = shot.get("source_video", "")
            if vpath:
                video_shots[vpath].append(shot)

        processed = already_done
        dirty = False  # 标记是否有新的分析结果需要保存

        for vpath, shot_list in video_shots.items():
            if not os.path.exists(vpath):
                # 计算跳过的未分析镜头数（它们无法处理）
                skipped = sum(1 for s in shot_list if not s.get("face_detected", False))
                processed += skipped
                continue

            cap = cv2.VideoCapture(vpath)
            if not cap.isOpened():
                skipped = sum(1 for s in shot_list if not s.get("face_detected", False))
                processed += skipped
                continue

            proj_dir = get_project_dir(project_id)
            frames_dir = os.path.join(proj_dir, "frames")

            # ★ 每个视频只做一次黑边检测（从第 30 帧取有效区域）
            effective_region = get_effective_region_cached(vpath)

            try:
                for shot in shot_list:
                    if _cancel_flag.is_set():
                        cap.release()
                        # ★ 取消时保存已完成的中间结果
                        if dirty:
                            save_project_data(project_id, project_data)
                            logger.info(f"后台分析被取消，已保存中间结果: {processed}/{total_shots}")
                        _update_bg_status("done", 0, False, project_id,
                                          analyzed_count=processed, total_count=total_shots)
                        return

                    # ★ 断点续传：跳过已完成分析的镜头
                    if shot.get("face_detected", False):
                        continue

                    start_f = shot.get("start_frame", 0)
                    end_f = shot.get("end_frame", start_f + 1)

                    # ★ 统一读取采样帧（后续所有检测都复用这批帧）
                    sampled_frames = _read_sample_frames(cap, start_f, end_f)

                    if not sampled_frames:
                        shot["face_count"] = 0
                        shot["shot_type"] = "空镜"
                        shot["face_detected"] = True
                        shot["shot_type_detected"] = True
                        shot["motion_score"] = 0.0
                        processed += 1
                        dirty = True
                        _update_bg_status("analyzing", int(processed / max(total_shots, 1) * 100),
                                          analyzed_count=processed, total_count=total_shots)
                        continue

                    # ── ① 快速预筛（YuNet + HOG 兜底）──
                    triage = quick_triage_from_frames(sampled_frames)

                    if triage["worth"]:
                        # ── ② 深度人像检测（复用同一批帧，传入有效区域去黑边）──
                        face_result = detect_face_info_from_frames(
                            sampled_frames,
                            effective_region=effective_region,
                        )

                        shot["has_person"] = bool(face_result["has_person"])
                        shot["face_ratio"] = float(face_result["face_ratio"])
                        shot["person_ratio"] = float(face_result.get("person_ratio", 0.0))
                        shot["good_composition"] = bool(face_result["good_composition"])
                        shot["face_count"] = int(face_result.get("face_count", 0))
                        shot["person_count"] = int(face_result.get("person_count", 0))
                        shot["face_detected"] = True
                        # ★ 新增构图信息字段
                        shot["face_cropped"] = bool(face_result.get("face_cropped", False))
                        shot["face_in_safe_zone"] = bool(face_result.get("face_in_safe_zone", True))
                        shot["head_margin_ratio"] = float(face_result.get("head_margin_ratio", 1.0))
                        shot["has_black_bars"] = bool(face_result.get("has_black_bars", False))

                        # 景别分类（基于人脸占比 + 构图安全性）
                        shot["shot_type"] = classify_shot_label(
                            face_count=shot["face_count"],
                            face_ratio=shot.get("face_ratio", 0.0),
                            face_cropped=shot.get("face_cropped", False),
                            face_in_safe_zone=shot.get("face_in_safe_zone", True),
                        )
                        shot["shot_type_detected"] = True

                        # 智能选帧：根据景别替换封面
                        per_frame = face_result.get("per_frame", {})
                        if per_frame and shot["shot_type"] in ("近景人像", "黄金人像", "远景人像"):
                            best_fn, best_frame = select_representative_frame(
                                cap,
                                start_f,
                                end_f,
                                shot["shot_type"],
                                per_frame,
                            )
                            if best_frame is not None and best_fn != start_f:
                                frame_path = os.path.join(frames_dir, shot.get("frame_file", ""))
                                save_thumbnail(best_frame, frame_path)
                                shot["cover_frame"] = best_fn
                    else:
                        # 预筛未通过 → 空镜
                        shot["face_count"] = 0
                        shot["has_person"] = False
                        shot["person_count"] = 0
                        shot["shot_type"] = "空镜"
                        shot["face_detected"] = True
                        shot["shot_type_detected"] = True

                    # ── ③ 动态值计算（复用同一批帧）──
                    shot["motion_score"] = float(_calc_motion_from_frames(sampled_frames))

                    processed += 1
                    dirty = True
                    _update_bg_status("analyzing", int(processed / max(total_shots, 1) * 100),
                                      analyzed_count=processed, total_count=total_shots)

                    # ★ 让出 GIL，避免长时间阻塞 FastAPI 事件循环处理帧请求
                    time.sleep(0.01)

            finally:
                cap.release()

        # 保存最终结果
        save_project_data(project_id, project_data)
        logger.info(f"后台分析完成: {processed} 个镜头")

        _update_bg_status("done", 100, False, project_id,
                          analyzed_count=total_shots, total_count=total_shots)

    except Exception as e:
        logger.error(f"后台分析异常: {e}", exc_info=True)
        _update_bg_status("done", 0, False, project_id)


def _start_background_analysis(project_id: str, video_paths: list):
    """启动后台分析线程（先停止旧任务）"""
    global _bg_task_thread
    _stop_running_bg_task()
    _cancel_flag.clear()
    t = threading.Thread(
        target=_background_analysis,
        args=(project_id, video_paths),
        daemon=True,
    )
    _bg_task_thread = t
    t.start()


def _batch_background_task(project_id: str, video_paths: list, threshold: int):
    """
    后台批量分析 — 逐个视频拆分镜头，每拆完一个立即保存（前端轮询可见）。
    全部拆分完成后，启动深度分析（人脸/景别/动态值）。
    """
    try:
        total = len(video_paths)
        _update_bg_status("splitting", 0, True, project_id,
                          current_video=os.path.basename(video_paths[0]),
                          split_queue=total, split_done=0)

        all_new_video_paths = []

        for i, vpath in enumerate(video_paths):
            if _cancel_flag.is_set():
                break

            vpath = os.path.abspath(vpath)
            _update_bg_status("splitting", int(i / total * 50), True, project_id,
                              current_video=os.path.basename(vpath),
                              split_queue=total - i, split_done=i)

            try:
                # 场景检测
                scenes, fps, total_frames = detect_scenes(vpath, threshold)

                if _cancel_flag.is_set():
                    break

                # 加载最新项目数据（其他拆分可能已追加）
                project_data = load_project_data(project_id) or {
                    "video_path": None,
                    "video_paths": [],
                    "shots": [],
                    "fps": 0,
                    "total_frames": 0,
                }

                existing_shots = project_data.get("shots", [])
                index_offset = len(existing_shots)

                # 帧输出目录
                proj_dir = get_project_dir(project_id)
                frames_dir = os.path.join(proj_dir, "frames")
                os.makedirs(frames_dir, exist_ok=True)

                # 快速构建新 Shot 数据
                new_shots = build_shots_fast(
                    scenes=scenes,
                    fps=fps,
                    video_path=vpath,
                    frames_dir=frames_dir,
                    index_offset=index_offset,
                    cancel_check=is_cancelled,
                )

                if _cancel_flag.is_set():
                    break

                # 追加到项目数据
                all_shots = existing_shots + new_shots
                existing_vpaths = project_data.get("video_paths", [])
                if vpath not in existing_vpaths:
                    existing_vpaths.append(vpath)

                project_data["video_path"] = vpath
                project_data["video_paths"] = existing_vpaths
                project_data["shots"] = all_shots
                project_data["fps"] = fps
                project_data["total_frames"] = total_frames

                # ★ 拆分完成后立即保存 → 前端轮询刷新可以看到新镜头
                save_project_data(project_id, project_data)

                # 更新项目索引
                update_project_info(
                    project_id,
                    shot_count=len(all_shots),
                    video_count=len(existing_vpaths),
                )

                all_new_video_paths.append(vpath)

                logger.info(f"后台拆分完成: {os.path.basename(vpath)} → {len(new_shots)} 个镜头")

            except Exception as e:
                logger.error(f"后台拆分 {os.path.basename(vpath)} 失败: {e}", exc_info=True)
                continue

            # 更新拆分完成计数
            _update_bg_status("splitting", int((i + 1) / total * 50), True, project_id,
                              current_video="",
                              split_queue=total - i - 1, split_done=i + 1)

        # 全部拆分完成，进入深度分析阶段
        if not _cancel_flag.is_set():
            # 重新加载最终的 video_paths 列表做深度分析
            final_data = load_project_data(project_id)
            final_vpaths = final_data.get("video_paths", []) if final_data else []
            # 注意：_background_analysis 内部会设置 "analyzing" stage
            _background_analysis(project_id, final_vpaths)
        else:
            _update_bg_status("done", 0, False, project_id,
                              current_video="", split_queue=0, split_done=0)

    except Exception as e:
        logger.error(f"后台批量分析异常: {e}", exc_info=True)
        _update_bg_status("done", 0, False, project_id,
                          current_video="", split_queue=0, split_done=0)


def _start_batch_background(project_id: str, video_paths: list, threshold: int):
    """启动后台批量分析线程（先停止旧任务）"""
    global _bg_task_thread
    _stop_running_bg_task()
    _cancel_flag.clear()
    t = threading.Thread(
        target=_batch_background_task,
        args=(project_id, video_paths, threshold),
        daemon=True,
    )
    _bg_task_thread = t
    t.start()


@router.post("/cancel_analyze")
async def cancel_analyze():
    """取消正在进行的分析"""
    _cancel_flag.set()
    return {"success": True, "message": "已请求取消分析"}


@router.post("/analyze_batch_bg")
async def analyze_batch_bg(req: BatchAnalyzeRequest):
    """
    后台批量分析 — 立即返回，后台线程依次拆分 + 深度分析。
    前端通过 /api/bg_task_status 轮询进度。
    如果已有后台任务在运行，会先取消旧任务再启动新任务。
    """
    project_id = _get_active_project_or_fail()

    # 验证所有路径
    for vp in req.video_paths:
        _validate_video_path(vp)

    threshold = req.threshold or DEFAULT_THRESHOLD

    # _start_batch_background 内部会先停止旧任务
    _start_batch_background(project_id, req.video_paths, threshold)

    return {"success": True, "queued": len(req.video_paths)}


@router.post("/check_duplicate_videos")
async def check_duplicate_videos(req: dict):
    """
    检查待上传的视频文件名是否与当前项目中已有视频重复。
    请求体: { "filenames": ["a.mp4", "b.mov", ...] }
    返回: { "duplicates": ["a.mp4"] }  — 重复的文件名列表
    """
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    filenames = req.get("filenames", [])
    if not filenames or not project_data:
        return {"duplicates": []}

    # 获取项目中已有视频的文件名集合
    existing_names = set()
    for vpath in project_data.get("video_paths", []):
        existing_names.add(os.path.basename(vpath))

    # 同时检查 uploads 目录中是否存在同名文件
    if os.path.exists(UPLOADS_DIR):
        for fname in os.listdir(UPLOADS_DIR):
            existing_names.add(fname)

    duplicates = [fn for fn in filenames if fn in existing_names]
    return {"duplicates": duplicates}


@router.post("/upload_video")
async def upload_video(file: UploadFile = File(...)):
    """上传视频文件到 workspace/uploads/"""
    # 验证文件扩展名
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in SUPPORTED_VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的视频格式: {ext}")

    # 确保活跃项目存在
    _get_active_project_or_fail()

    # 保存文件
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    save_path = os.path.join(UPLOADS_DIR, file.filename)

    # 如果文件已存在，加后缀
    base, extension = os.path.splitext(file.filename)
    counter = 1
    while os.path.exists(save_path):
        save_path = os.path.join(UPLOADS_DIR, f"{base}_{counter}{extension}")
        counter += 1

    with open(save_path, "wb") as f:
        content = await file.read()
        f.write(content)

    return {"success": True, "video_path": os.path.abspath(save_path)}


@router.post("/analyze")
async def analyze_video(req: AnalyzeRequest):
    """
    首次分析视频 — 快速返回（只做镜头拆分+首帧提取），后台异步做深度分析。
    """
    project_id = _get_active_project_or_fail()
    _validate_video_path(req.video_path)

    # 清除取消标志
    _cancel_flag.clear()

    threshold = req.threshold or DEFAULT_THRESHOLD
    video_path = os.path.abspath(req.video_path)

    # 场景检测（已降采样加速）
    scenes, fps, total_frames = detect_scenes(video_path, threshold)

    if is_cancelled():
        return {"success": False, "cancelled": True, "message": "分析已取消"}

    # 准备帧输出目录
    proj_dir = get_project_dir(project_id)
    frames_dir = os.path.join(proj_dir, "frames")

    # 清空旧帧文件
    if os.path.exists(frames_dir):
        shutil.rmtree(frames_dir)
    os.makedirs(frames_dir, exist_ok=True)

    # ★ 快速构建 Shot 数据（只提取首帧缩略图，跳过动态值和人脸检测）
    shots = build_shots_fast(
        scenes=scenes,
        fps=fps,
        video_path=video_path,
        frames_dir=frames_dir,
        index_offset=0,
        cancel_check=is_cancelled,
    )

    if is_cancelled():
        return {"success": False, "cancelled": True, "message": "分析已取消"}

    # 保存项目数据（让用户立即进入主页面）
    project_data = {
        "video_path": video_path,
        "video_paths": [video_path],
        "shots": shots,
        "fps": fps,
        "total_frames": total_frames,
    }
    save_project_data(project_id, project_data)

    # 更新项目索引
    update_project_info(
        project_id,
        shot_count=len(shots),
        video_count=1,
    )

    # ★ 启动后台异步分析（人像检测+景别分类+智能选帧+动态值）
    _start_background_analysis(project_id, [video_path])

    return {
        "success": True,
        "total_shots": len(shots),
        "fps": fps,
        "video_path": video_path,
        "bg_analyzing": True,
    }


@router.post("/analyze_append")
async def analyze_append(req: AnalyzeAppendRequest):
    """追加分析视频 — 快速返回，后台异步深度分析"""
    project_id = _get_active_project_or_fail()
    _validate_video_path(req.video_path)

    # 清除取消标志
    _cancel_flag.clear()

    threshold = req.threshold or DEFAULT_THRESHOLD
    video_path = os.path.abspath(req.video_path)

    # 加载已有数据
    project_data = load_project_data(project_id) or {
        "video_path": None,
        "video_paths": [],
        "shots": [],
        "fps": 0,
        "total_frames": 0,
    }

    existing_shots = project_data.get("shots", [])
    index_offset = len(existing_shots)

    # 场景检测
    scenes, fps, total_frames = detect_scenes(video_path, threshold)

    if is_cancelled():
        return {"success": False, "cancelled": True, "message": "分析已取消"}

    # 帧输出目录
    proj_dir = get_project_dir(project_id)
    frames_dir = os.path.join(proj_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    # ★ 快速构建新 Shot 数据
    new_shots = build_shots_fast(
        scenes=scenes,
        fps=fps,
        video_path=video_path,
        frames_dir=frames_dir,
        index_offset=index_offset,
        cancel_check=is_cancelled,
    )

    if is_cancelled():
        return {"success": False, "cancelled": True, "message": "分析已取消"}

    # 追加到已有列表
    all_shots = existing_shots + new_shots
    video_paths = project_data.get("video_paths", [])
    if video_path not in video_paths:
        video_paths.append(video_path)

    # 更新项目数据
    project_data["video_path"] = video_path
    project_data["video_paths"] = video_paths
    project_data["shots"] = all_shots
    project_data["fps"] = fps
    project_data["total_frames"] = total_frames
    save_project_data(project_id, project_data)

    # 更新项目索引
    update_project_info(
        project_id,
        shot_count=len(all_shots),
        video_count=len(video_paths),
    )

    # ★ 启动后台异步分析
    _start_background_analysis(project_id, video_paths)

    return {
        "success": True,
        "new_shots": len(new_shots),
        "total_shots": len(all_shots),
        "fps": fps,
        "video_path": video_path,
        "bg_analyzing": True,
    }


def _reanalyze_background_task(project_id: str, video_paths: list, threshold: int, favorite_ranges: list):
    """
    后台重新分析任务 — 用新灵敏度重新切分所有视频的镜头。
    在后台线程中执行，避免阻塞 FastAPI 事件循环。
    """
    try:
        total = len(video_paths)
        _update_bg_status("splitting", 0, True, project_id,
                          current_video=os.path.basename(video_paths[0]) if video_paths else "",
                          split_queue=total, split_done=0)

        # 准备帧输出目录
        proj_dir = get_project_dir(project_id)
        frames_dir = os.path.join(proj_dir, "frames")

        # 清空旧帧文件
        if os.path.exists(frames_dir):
            shutil.rmtree(frames_dir)
        os.makedirs(frames_dir, exist_ok=True)

        # 清空有效区域缓存（重新分析时应重新检测黑边）
        from services.face_detect import _effective_region_cache
        _effective_region_cache.clear()

        # 对所有视频重新进行场景检测 + 快速构建
        all_new_shots = []
        latest_fps = 24
        latest_total_frames = 0

        for i, vpath in enumerate(video_paths):
            if _cancel_flag.is_set():
                break

            if not os.path.exists(vpath):
                continue

            _update_bg_status("splitting", int(i / total * 50), True, project_id,
                              current_video=os.path.basename(vpath),
                              split_queue=total - i, split_done=i)

            try:
                scenes, fps, total_frames = detect_scenes(vpath, threshold)
                latest_fps = fps
                latest_total_frames = total_frames

                if _cancel_flag.is_set():
                    break

                new_shots = build_shots_fast(
                    scenes=scenes,
                    fps=fps,
                    video_path=vpath,
                    frames_dir=frames_dir,
                    index_offset=len(all_new_shots),
                    cancel_check=is_cancelled,
                )
                all_new_shots.extend(new_shots)

            except Exception as e:
                logger.error(f"重新分析 {os.path.basename(vpath)} 失败: {e}", exc_info=True)
                continue

            _update_bg_status("splitting", int((i + 1) / total * 50), True, project_id,
                              current_video="",
                              split_queue=total - i - 1, split_done=i + 1)

        if _cancel_flag.is_set():
            _update_bg_status("done", 0, False, project_id,
                              current_video="", split_queue=0, split_done=0)
            return

        # 恢复收藏状态：新 shot 的时间范围与旧收藏 shot 有重叠 → 标记为收藏
        for new_shot in all_new_shots:
            new_start = new_shot.get("start_time", 0)
            new_end = new_shot.get("end_time", 0)
            new_source = new_shot.get("source_video")
            new_mid = (new_start + new_end) / 2

            for fav in favorite_ranges:
                if fav["source_video"] != new_source:
                    continue
                if fav["start_time"] <= new_mid <= fav["end_time"]:
                    new_shot["favorite"] = True
                    break

        # 更新项目数据
        project_data = load_project_data(project_id) or {}
        project_data["shots"] = all_new_shots
        project_data["fps"] = latest_fps
        project_data["total_frames"] = latest_total_frames
        save_project_data(project_id, project_data)

        # 更新项目索引
        update_project_info(
            project_id,
            shot_count=len(all_new_shots),
        )

        logger.info(f"重新分析拆分完成: {len(all_new_shots)} 个镜头")

        # 全部拆分完成，进入深度分析阶段
        if not _cancel_flag.is_set():
            _background_analysis(project_id, video_paths)
        else:
            _update_bg_status("done", 0, False, project_id,
                              current_video="", split_queue=0, split_done=0)

    except Exception as e:
        logger.error(f"后台重新分析异常: {e}", exc_info=True)
        _update_bg_status("done", 0, False, project_id,
                          current_video="", split_queue=0, split_done=0)


def _start_reanalyze_background(project_id: str, video_paths: list, threshold: int, favorite_ranges: list):
    """启动后台重新分析线程（先停止旧任务）"""
    global _bg_task_thread
    _stop_running_bg_task()
    _cancel_flag.clear()
    t = threading.Thread(
        target=_reanalyze_background_task,
        args=(project_id, video_paths, threshold, favorite_ranges),
        daemon=True,
    )
    _bg_task_thread = t
    t.start()


@router.post("/reanalyze")
async def reanalyze_all(req: ReanalyzeRequest):
    """
    重新分析 — 用新灵敏度阈值重新切分所有视频的镜头。
    ★ 快速返回模式：验证参数 → 启动后台线程 → 立即返回。
    保留用户的收藏状态（通过时间范围匹配旧 shot 映射 favorite）。
    """
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    video_paths = project_data.get("video_paths", [])
    if not video_paths:
        raise HTTPException(status_code=400, detail="没有视频可以重新分析")

    threshold = req.threshold or DEFAULT_THRESHOLD

    # 保存旧镜头的收藏状态（用时间范围做匹配，传给后台线程）
    old_shots = project_data.get("shots", [])
    favorite_ranges = []
    for shot in old_shots:
        if shot.get("favorite"):
            favorite_ranges.append({
                "source_video": shot.get("source_video"),
                "start_time": shot.get("start_time", 0),
                "end_time": shot.get("end_time", 0),
            })

    # ★ 启动后台线程处理重切分 + 深度分析，接口立即返回
    _start_reanalyze_background(project_id, video_paths, threshold, favorite_ranges)

    return {
        "success": True,
        "bg_analyzing": True,
        "video_count": len(video_paths),
    }


@router.get("/bg_task_status")
async def get_bg_task_status():
    """查询后台分析任务状态"""
    with _bg_task_lock:
        return {
            "running": _bg_task_status["running"],
            "stage": _bg_task_status["stage"],
            "progress": _bg_task_status["progress"],
            "done": _bg_task_status["stage"] == "done" or not _bg_task_status["running"],
            "current_video": _bg_task_status.get("current_video", ""),
            "split_queue": _bg_task_status.get("split_queue", 0),
            "split_done": _bg_task_status.get("split_done", 0),
            "analyzed_count": _bg_task_status.get("analyzed_count", 0),
            "total_count": _bg_task_status.get("total_count", 0),
        }


@router.get("/analysis_completeness")
async def get_analysis_completeness():
    """检查当前项目的镜头分析完成度"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        return {"total": 0, "analyzed": 0, "pending": 0, "complete": True, "progress": 100}

    shots = project_data.get("shots", [])
    total = len(shots)

    if total == 0:
        return {"total": 0, "analyzed": 0, "pending": 0, "complete": True, "progress": 100}

    # 判断标准：face_detected=True 表示该镜头已完成分析
    analyzed = sum(1 for s in shots if s.get("face_detected", False))
    pending = total - analyzed

    return {
        "total": total,
        "analyzed": analyzed,
        "pending": pending,
        "complete": pending == 0,
        "progress": int(analyzed / max(total, 1) * 100),
    }


@router.post("/resume_analysis")
async def resume_analysis():
    """恢复未完成的后台分析（断点续传）"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        return {"success": False, "message": "无项目数据"}

    video_paths = project_data.get("video_paths", [])
    if not video_paths:
        return {"success": False, "message": "无视频"}

    # 检查是否有未完成的镜头
    shots = project_data.get("shots", [])
    total = len(shots)
    pending = sum(1 for s in shots if not s.get("face_detected", False))
    if pending == 0:
        return {"success": True, "message": "所有镜头已分析完成", "pending": 0, "total": total}

    # 启动后台分析（会自动跳过已完成的镜头）
    _start_background_analysis(project_id, video_paths)

    return {"success": True, "pending": pending, "total": total}


@router.get("/videos")
async def get_videos():
    """获取当前项目已上传的视频列表"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        return {"videos": []}

    video_paths = project_data.get("video_paths", [])
    shots = project_data.get("shots", [])

    videos = []
    for vpath in video_paths:
        # 统计该视频对应的镜头数
        shot_count = sum(1 for s in shots if s.get("source_video") == vpath)

        # 获取文件大小
        size_mb = 0
        if os.path.exists(vpath):
            size_mb = round(os.path.getsize(vpath) / (1024 * 1024), 1)

        videos.append({
            "path": vpath,
            "filename": os.path.basename(vpath),
            "size_mb": size_mb,
            "shot_count": shot_count,
        })

    return {"videos": videos}


async def _pre_clip_favorite_shots(shots: list, proj_dir: str):
    """
    为收藏镜头预裁剪独立 MP4 文件（在源视频删除前调用）。
    裁剪后的文件保存在项目 shots/ 目录下，并更新镜头的 clip_file 字段。
    """
    shots_dir = os.path.join(proj_dir, "shots")
    os.makedirs(shots_dir, exist_ok=True)

    for shot in shots:
        if not shot.get("favorite"):
            continue
        # 如果已有 clip_file 且文件存在，跳过
        existing_clip = shot.get("clip_file", "")
        if existing_clip and os.path.exists(os.path.join(shots_dir, existing_clip)):
            continue

        video_path = shot.get("source_video", "")
        if not video_path or not os.path.exists(video_path):
            continue

        start_time = shot.get("start_time", 0)
        duration = shot.get("duration", 0)
        if duration <= 0:
            continue

        clip_filename = f"{shot['id']}_clip.mp4"
        clip_path = os.path.join(shots_dir, clip_filename)

        # 使用双 -ss 精确裁剪策略
        safe_start = max(0, start_time - 5)
        offset = round(start_time - safe_start, 6)

        cmd = [
            "ffmpeg", "-y",
            "-ss", str(safe_start),
            "-i", video_path,
            "-ss", str(offset),
            "-t", str(duration),
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "18",
            "-c:a", "aac",
            "-b:a", "192k",
            "-avoid_negative_ts", "make_zero",
            clip_path,
        ]

        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await process.communicate()

            if process.returncode == 0 and os.path.exists(clip_path):
                shot["clip_file"] = clip_filename
                logger.info(f"预裁剪收藏镜头: {shot['id']} → {clip_filename}")
            else:
                logger.warning(f"预裁剪失败: {shot['id']}: {stderr.decode()[:100]}")
        except Exception as e:
            logger.warning(f"预裁剪异常: {shot['id']}: {e}")


@router.post("/videos/delete")
async def delete_video(req: VideoDeleteRequest):
    """删除单个视频及其关联的非收藏镜头数据、帧文件和上传文件，保留已收藏的镜头"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    video_path = req.video_path
    video_paths = project_data.get("video_paths", [])

    if video_path not in video_paths:
        raise HTTPException(status_code=404, detail="该视频不在项目中")

    proj_dir = get_project_dir(project_id)
    frames_dir = os.path.join(proj_dir, "frames")
    saved_frames_dir = os.path.join(proj_dir, "saved_frames")

    # ★ 在删除源视频前，先为该视频的收藏镜头预裁剪独立 MP4
    fav_shots_to_clip = [
        s for s in project_data.get("shots", [])
        if s.get("source_video") == video_path and s.get("favorite")
    ]
    if fav_shots_to_clip:
        await _pre_clip_favorite_shots(fav_shots_to_clip, proj_dir)

    # 分离收藏/非收藏镜头
    remaining_shots = []
    favorites_kept = 0
    for shot in project_data.get("shots", []):
        if shot.get("source_video") == video_path:
            if shot.get("favorite"):
                # ★ 已收藏的镜头保留，不删除帧文件
                remaining_shots.append(shot)
                favorites_kept += 1
            else:
                # 非收藏镜头：删除帧文件
                frame_path = os.path.join(frames_dir, shot.get("frame_file", ""))
                if os.path.exists(frame_path):
                    os.remove(frame_path)
                # 删除保存的静帧
                for suffix in ["_saved.jpg", f"_custom_{shot.get('mid_frame', 0)}.jpg"]:
                    saved_path = os.path.join(saved_frames_dir, f"{shot['id']}{suffix}")
                    if os.path.exists(saved_path):
                        os.remove(saved_path)
        else:
            remaining_shots.append(shot)

    # 重排 index
    for i, shot in enumerate(remaining_shots):
        shot["index"] = i

    # 从视频列表中移除
    video_paths.remove(video_path)

    # 更新 video_path 指向
    project_data["video_paths"] = video_paths
    project_data["video_path"] = video_paths[-1] if video_paths else None
    project_data["shots"] = remaining_shots
    save_project_data(project_id, project_data)

    # 更新索引
    update_project_info(
        project_id,
        shot_count=len(remaining_shots),
        video_count=len(video_paths),
    )

    # 删除上传目录中的视频文件（只删除 workspace/uploads 内的）
    uploads_norm = os.path.normpath(os.path.abspath(UPLOADS_DIR)) + os.sep
    if os.path.exists(video_path) and os.path.normpath(os.path.abspath(video_path)).startswith(uploads_norm):
        try:
            os.remove(video_path)
        except Exception:
            pass

    return {
        "success": True,
        "remaining_shots": len(remaining_shots),
        "remaining_videos": len(video_paths),
        "favorites_kept": favorites_kept,
    }


@router.post("/videos/clear")
async def clear_videos():
    """清空项目所有视频和非收藏镜头数据，保留已收藏的镜头"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        return {"success": True, "favorites_kept": 0}

    proj_dir = get_project_dir(project_id)

    # ★ 在删除源视频前，先为所有收藏镜头预裁剪独立 MP4
    fav_shots_to_clip = [s for s in project_data.get("shots", []) if s.get("favorite")]
    if fav_shots_to_clip:
        await _pre_clip_favorite_shots(fav_shots_to_clip, proj_dir)

    # 删除 uploads 中的关联视频文件
    uploads_norm = os.path.normpath(os.path.abspath(UPLOADS_DIR)) + os.sep
    for vpath in project_data.get("video_paths", []):
        if vpath and os.path.normpath(os.path.abspath(vpath)).startswith(uploads_norm) and os.path.exists(vpath):
            try:
                os.remove(vpath)
            except Exception:
                pass

    frames_dir = os.path.join(proj_dir, "frames")
    saved_frames_dir = os.path.join(proj_dir, "saved_frames")

    # ★ 收集已收藏镜头及其帧文件和裁剪文件路径（需要保留）
    favorite_shots = []
    keep_frame_files = set()
    keep_saved_files = set()
    keep_clip_files = set()

    for shot in project_data.get("shots", []):
        if shot.get("favorite"):
            favorite_shots.append(shot)
            # 记录需要保留的帧文件名
            ff = shot.get("frame_file", "")
            if ff:
                keep_frame_files.add(ff)
            # 记录需要保留的已保存静帧
            for suffix in ["_saved.jpg", f"_custom_{shot.get('mid_frame', 0)}.jpg"]:
                keep_saved_files.add(f"{shot['id']}{suffix}")
            # 记录需要保留的预裁剪 clip 文件
            cf = shot.get("clip_file", "")
            if cf:
                keep_clip_files.add(cf)

    # 清理帧目录中 **非保留** 的文件
    for sub, keep_set in [("frames", keep_frame_files), ("saved_frames", keep_saved_files)]:
        sub_dir = os.path.join(proj_dir, sub)
        if os.path.exists(sub_dir):
            for fname in os.listdir(sub_dir):
                if fname not in keep_set:
                    try:
                        os.remove(os.path.join(sub_dir, fname))
                    except Exception:
                        pass

    # 清理 shots 缓存目录中 **非保留** 的文件（保留收藏镜头的 clip 文件）
    shots_cache_dir = os.path.join(proj_dir, "shots")
    if os.path.exists(shots_cache_dir):
        for fname in os.listdir(shots_cache_dir):
            if fname not in keep_clip_files:
                try:
                    os.remove(os.path.join(shots_cache_dir, fname))
                except Exception:
                    pass

    # 重排保留镜头的 index
    for i, shot in enumerate(favorite_shots):
        shot["index"] = i

    # 更新项目数据（保留收藏镜头）
    project_data["video_path"] = None
    project_data["video_paths"] = []
    project_data["shots"] = favorite_shots
    project_data["fps"] = project_data.get("fps", 0) if favorite_shots else 0
    project_data["total_frames"] = 0
    save_project_data(project_id, project_data)

    # 更新索引
    update_project_info(project_id, shot_count=len(favorite_shots), video_count=0)

    return {"success": True, "favorites_kept": len(favorite_shots)}

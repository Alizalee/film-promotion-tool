"""视频上传、分析与管理 API 路由 — 完整实现"""
import os
import shutil
import threading
from fastapi import APIRouter, HTTPException, UploadFile, File, Query
from typing import Optional

from models.schemas import AnalyzeRequest, AnalyzeAppendRequest, VideoDeleteRequest, ReanalyzeRequest
from models.constants import (
    UPLOADS_DIR,
    SUPPORTED_VIDEO_EXTENSIONS,
    DEFAULT_THRESHOLD,
)
from services.project_manager import (
    get_active_project_id,
    load_project_data,
    save_project_data,
    get_project_dir,
    update_project_info,
    load_projects_index,
)
from services.scene_detect import detect_scenes, build_shots_from_scenes

router = APIRouter()

# ── 分析取消机制 ──
_cancel_flag = threading.Event()


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


@router.post("/cancel_analyze")
async def cancel_analyze():
    """取消正在进行的分析"""
    _cancel_flag.set()
    return {"success": True, "message": "已请求取消分析"}


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
    """首次分析视频 — 清除旧数据，重新检测"""
    project_id = _get_active_project_or_fail()
    _validate_video_path(req.video_path)

    # 清除取消标志
    _cancel_flag.clear()

    threshold = req.threshold or DEFAULT_THRESHOLD
    video_path = os.path.abspath(req.video_path)

    # 场景检测
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

    # 构建 Shot 数据（含人脸检测和动态值）
    shots = build_shots_from_scenes(
        scenes=scenes,
        fps=fps,
        video_path=video_path,
        frames_dir=frames_dir,
        index_offset=0,
        cancel_check=is_cancelled,
    )

    if is_cancelled():
        return {"success": False, "cancelled": True, "message": "分析已取消"}

    # 保存项目数据
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

    return {
        "success": True,
        "total_shots": len(shots),
        "fps": fps,
        "video_path": video_path,
    }


@router.post("/analyze_append")
async def analyze_append(req: AnalyzeAppendRequest):
    """追加分析视频 — 新镜头追加到已有列表"""
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

    # 构建新的 Shot 数据
    new_shots = build_shots_from_scenes(
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

    return {
        "success": True,
        "new_shots": len(new_shots),
        "total_shots": len(all_shots),
        "fps": fps,
        "video_path": video_path,
    }


@router.post("/reanalyze")
async def reanalyze_all(req: ReanalyzeRequest):
    """
    重新分析 — 用新灵敏度阈值重新切分所有视频的镜头。
    保留用户的收藏状态（通过时间范围匹配旧 shot 映射 favorite）。
    清除旧的人脸检测和景别缓存标记，以便下次触发时用新算法重新检测。
    """
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    video_paths = project_data.get("video_paths", [])
    if not video_paths:
        raise HTTPException(status_code=400, detail="没有视频可以重新分析")

    # 清除取消标志
    _cancel_flag.clear()

    threshold = req.threshold or DEFAULT_THRESHOLD

    # 保存旧镜头的收藏状态（用时间范围做匹配）
    old_shots = project_data.get("shots", [])
    favorite_ranges = []
    for shot in old_shots:
        if shot.get("favorite"):
            favorite_ranges.append({
                "source_video": shot.get("source_video"),
                "start_time": shot.get("start_time", 0),
                "end_time": shot.get("end_time", 0),
            })

    # 准备帧输出目录
    proj_dir = get_project_dir(project_id)
    frames_dir = os.path.join(proj_dir, "frames")

    # 清空旧帧文件
    if os.path.exists(frames_dir):
        shutil.rmtree(frames_dir)
    os.makedirs(frames_dir, exist_ok=True)

    # 对所有视频重新进行场景检测
    all_new_shots = []
    latest_fps = project_data.get("fps", 24)
    latest_total_frames = project_data.get("total_frames", 0)

    for vpath in video_paths:
        if not os.path.exists(vpath):
            continue

        if is_cancelled():
            return {"success": False, "cancelled": True, "message": "重新分析已取消"}

        scenes, fps, total_frames = detect_scenes(vpath, threshold)
        latest_fps = fps
        latest_total_frames = total_frames

        if is_cancelled():
            return {"success": False, "cancelled": True, "message": "重新分析已取消"}

        new_shots = build_shots_from_scenes(
            scenes=scenes,
            fps=fps,
            video_path=vpath,
            frames_dir=frames_dir,
            index_offset=len(all_new_shots),
            cancel_check=is_cancelled,
        )
        all_new_shots.extend(new_shots)

    if is_cancelled():
        return {"success": False, "cancelled": True, "message": "重新分析已取消"}

    # 恢复收藏状态：新 shot 的时间范围与旧收藏 shot 有重叠 → 标记为收藏
    for new_shot in all_new_shots:
        new_start = new_shot.get("start_time", 0)
        new_end = new_shot.get("end_time", 0)
        new_source = new_shot.get("source_video")
        new_mid = (new_start + new_end) / 2

        for fav in favorite_ranges:
            if fav["source_video"] != new_source:
                continue
            # 新镜头的中点落在旧收藏镜头的时间范围内 → 认为匹配
            if fav["start_time"] <= new_mid <= fav["end_time"]:
                new_shot["favorite"] = True
                break

    # 更新项目数据
    project_data["shots"] = all_new_shots
    project_data["fps"] = latest_fps
    project_data["total_frames"] = latest_total_frames
    save_project_data(project_id, project_data)

    # 更新项目索引
    update_project_info(
        project_id,
        shot_count=len(all_new_shots),
    )

    return {
        "success": True,
        "total_shots": len(all_new_shots),
        "fps": latest_fps,
        "favorites_restored": sum(1 for s in all_new_shots if s.get("favorite")),
    }


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


@router.post("/videos/delete")
async def delete_video(req: VideoDeleteRequest):
    """删除单个视频及其关联的所有镜头数据、帧文件和上传文件"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    video_path = req.video_path
    video_paths = project_data.get("video_paths", [])

    if video_path not in video_paths:
        raise HTTPException(status_code=404, detail="该视频不在项目中")

    # 移除关联的镜头和帧文件
    proj_dir = get_project_dir(project_id)
    frames_dir = os.path.join(proj_dir, "frames")
    saved_frames_dir = os.path.join(proj_dir, "saved_frames")

    remaining_shots = []
    for shot in project_data.get("shots", []):
        if shot.get("source_video") == video_path:
            # 删除帧文件
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

    # 删除上传目录中的视频文件（只删除 workspace 内的）
    if os.path.exists(video_path) and UPLOADS_DIR in video_path:
        try:
            os.remove(video_path)
        except Exception:
            pass

    return {
        "success": True,
        "remaining_shots": len(remaining_shots),
        "remaining_videos": len(video_paths),
    }


@router.post("/videos/clear")
async def clear_videos():
    """清空项目所有视频、镜头和帧数据，含上传文件清理"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        return {"success": True}

    # 删除 uploads 中的关联视频文件
    for vpath in project_data.get("video_paths", []):
        if vpath and UPLOADS_DIR in vpath and os.path.exists(vpath):
            try:
                os.remove(vpath)
            except Exception:
                pass

    # 清空帧目录
    proj_dir = get_project_dir(project_id)
    for sub in ["frames", "shots", "saved_frames"]:
        sub_dir = os.path.join(proj_dir, sub)
        if os.path.exists(sub_dir):
            shutil.rmtree(sub_dir)
        os.makedirs(sub_dir, exist_ok=True)

    # 重置项目数据
    project_data["video_path"] = None
    project_data["video_paths"] = []
    project_data["shots"] = []
    project_data["fps"] = 0
    project_data["total_frames"] = 0
    save_project_data(project_id, project_data)

    # 更新索引
    update_project_info(project_id, shot_count=0, video_count=0)

    return {"success": True}

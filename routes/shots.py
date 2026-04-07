"""镜头数据 API 路由 — 完整实现"""
import os
import cv2
import asyncio
import logging
from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from models.schemas import (
    FavoriteRequest,
    TrimShotRequest,
    SaveFrameRequest,
    SaveCustomFrameRequest,
    MergeShotsRequest,
)
from services.project_manager import (
    get_active_project_id,
    load_project_data,
    save_project_data,
    get_project_dir,
    update_project_info,
)

logger = logging.getLogger(__name__)
from services.scene_detect import extract_frame, save_frame_jpeg, _video_hash, _frame_to_timecode, _frame_to_display_timecode
from services.face_detect import detect_face_info, detect_face_info_multi_frame
from services.shot_type_detect import classify_shot_type, classify_shot_label

router = APIRouter()


def _get_active_project_or_fail() -> str:
    pid = get_active_project_id()
    if not pid:
        raise HTTPException(status_code=400, detail="没有活跃项目")
    return pid


@router.get("/shots")
async def get_shots(
    sort: Optional[str] = Query("time", description="排序方式: time | motion"),
    has_person: Optional[bool] = Query(None, description="只看有人"),
    favorite_only: Optional[bool] = Query(None, description="只看收藏"),
    search: Optional[str] = Query(None, description="时间码搜索"),
    source_video: Optional[str] = Query(None, description="视频源路径筛选"),
    shot_type: Optional[str] = Query(None, description="景别筛选: 特写|近景|中景|远景|全景"),
):
    """获取镜头列表，支持排序和多维度筛选"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        return {"shots": [], "total": 0}

    shots = list(project_data.get("shots", []))

    # 筛选 - 有人
    if has_person:
        shots = [s for s in shots if s.get("has_person")]

    # 筛选 - 收藏
    if favorite_only:
        shots = [s for s in shots if s.get("favorite")]

    # 筛选 - 视频源
    if source_video:
        shots = [s for s in shots if s.get("source_video") == source_video]

    # 筛选 - 景别
    if shot_type:
        shots = [s for s in shots if s.get("shot_type") == shot_type]

    # 筛选 - 时间码搜索
    if search:
        search = search.strip()
        shots = [
            s for s in shots
            if search in s.get("timecode_display", "") or search in s.get("timecode", "")
        ]

    # 排序
    if sort == "motion":
        shots.sort(key=lambda s: s.get("motion_score", 0), reverse=True)
    else:
        # 时间排序：先按视频源在 video_paths 中的顺序分组，再按 start_frame 排序
        # 这样不同视频源的镜头不会混排
        video_paths = project_data.get("video_paths", [])
        video_order = {vp: idx for idx, vp in enumerate(video_paths)}
        shots.sort(key=lambda s: (
            video_order.get(s.get("source_video", ""), 999),
            s.get("start_frame", 0)
        ))

    # 收藏总数 & 全量总数：基于全量数据（不受任何筛选条件影响）
    all_shots = project_data.get("shots", [])
    total_all = len(all_shots)
    favorite_count = sum(1 for s in all_shots if s.get("favorite"))

    # 各景别分类计数（基于全量数据，不受筛选影响）
    shot_type_counts = {}
    for s in all_shots:
        st = s.get("shot_type", "")
        if st:
            shot_type_counts[st] = shot_type_counts.get(st, 0) + 1

    # ★ 为每个镜头标注源视频是否存在（前端据此决定播放模式）
    for s in shots:
        vp = s.get("source_video", "")
        s["source_video_exists"] = bool(vp and os.path.exists(vp))

    return {
        "shots": shots,
        "total": len(shots),
        "total_all": total_all,
        "favorite_count": favorite_count,
        "shot_type_counts": shot_type_counts,
    }


@router.post("/detect_faces")
async def detect_faces_on_demand():
    """
    按需人脸检测 — 只在用户点击「仅看有人」筛选时触发。
    - 只检测 has_person 仍为 False 且 face_detected 未标记的镜头
    - 检测结果写回 project data（缓存），下次不再重复检测
    - 返回检测了多少个镜头、有多少个包含人物
    """
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        return {"detected": 0, "with_person": 0, "cached": True}

    shots = project_data.get("shots", [])

    # 找出尚未做过人脸检测的镜头
    pending = [s for s in shots if not s.get("face_detected", False)]

    if not pending:
        # 全部已检测过 → 直接返回缓存结果
        person_count = sum(1 for s in shots if s.get("has_person", False))
        return {"detected": 0, "with_person": person_count, "cached": True}

    # 按视频分组，每个视频只打开一次 VideoCapture
    from collections import defaultdict
    video_shots = defaultdict(list)
    for shot in pending:
        vpath = shot.get("source_video", "")
        if vpath:
            video_shots[vpath].append(shot)

    detected_count = 0
    person_count = 0

    for vpath, shot_list in video_shots.items():
        if not os.path.exists(vpath):
            continue

        for shot in shot_list:
            # ★ 多帧采样检测（25%、50%、75% 位置），替代只看首帧
            face_info = detect_face_info_multi_frame(
                video_path=vpath,
                start_frame=shot.get("start_frame", 0),
                end_frame=shot.get("end_frame", shot.get("start_frame", 0) + 1),
                sample_count=3,
            )
            shot["has_person"] = bool(face_info["has_person"])
            shot["face_ratio"] = float(face_info["face_ratio"])
            shot["person_ratio"] = float(face_info.get("person_ratio", 0.0))
            shot["good_composition"] = bool(face_info["good_composition"])
            shot["face_count"] = int(face_info.get("face_count", 0))
            shot["person_count"] = int(face_info.get("person_count", 0))
            shot["per_frame_debug"] = face_info.get("per_frame", {})

            # 标记已检测（缓存标志）
            shot["face_detected"] = True
            detected_count += 1
            if shot["has_person"]:
                person_count += 1

    # 写回缓存
    save_project_data(project_id, project_data)

    total_person = sum(1 for s in shots if s.get("has_person", False))
    return {"detected": detected_count, "with_person": total_person, "cached": False}


@router.post("/detect_shot_types")
async def detect_shot_types():
    """
    按需镜头分类 — 只在用户点击分类筛选标签时触发。
    - 基于人脸占比分类：近景人像/黄金人像/远景人像/空镜
    - 需先做过人脸检测（如没做过，自动先做人脸检测）
    - 结果写回 project data（缓存），下次不再重复
    - 如果有旧的标签数据，自动迁移
    """
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        return {"detected": 0, "cached": True}

    shots = project_data.get("shots", [])

    # 迁移旧标签 → 新标签（旧五档景别 + 旧人物分类标签 → 需要重新检测）
    # 注意：新标签（近景人像/黄金人像/远景人像/空镜）不在此列表中，避免每次都重新检测
    migrated = 0
    old_labels = ("特写", "近景", "中景", "远景", "全景", "双人", "群像", "人物", "单人", "多人")
    for s in shots:
        old_type = s.get("shot_type", "")
        if old_type in old_labels:
            # 旧标签需要清除重新检测
            s["shot_type"] = ""
            s["shot_type_detected"] = False
            migrated += 1

    # 找出尚未做过景别检测的镜头
    pending = [s for s in shots if not s.get("shot_type_detected", False)]

    if not pending and migrated == 0:
        return {"detected": 0, "cached": True}

    # 先确保人脸检测已完成（景别依赖 face_count）
    face_pending = [s for s in pending if not s.get("face_detected", False)]
    if face_pending:
        from collections import defaultdict
        video_shots = defaultdict(list)
        for shot in face_pending:
            vpath = shot.get("source_video", "")
            if vpath:
                video_shots[vpath].append(shot)

        for vpath, shot_list in video_shots.items():
            if not os.path.exists(vpath):
                continue

            for shot in shot_list:
                # ★ 多帧采样检测（25%、50%、75% 位置）
                face_info = detect_face_info_multi_frame(
                    video_path=vpath,
                    start_frame=shot.get("start_frame", 0),
                    end_frame=shot.get("end_frame", shot.get("start_frame", 0) + 1),
                    sample_count=3,
                )
                shot["has_person"] = bool(face_info["has_person"])
                shot["face_ratio"] = float(face_info["face_ratio"])
                shot["person_ratio"] = float(face_info.get("person_ratio", 0.0))
                shot["good_composition"] = bool(face_info["good_composition"])
                shot["face_count"] = int(face_info.get("face_count", 0))
                shot["person_count"] = int(face_info.get("person_count", 0))
                shot["per_frame_debug"] = face_info.get("per_frame", {})
                shot["face_detected"] = True

    # 所有 pending 镜头进行分类（基于 face_count + face_ratio）
    detected_count = 0
    for shot in pending:
        face_count = shot.get("face_count", 0)
        face_ratio = shot.get("face_ratio", 0.0)
        shot["shot_type"] = classify_shot_label(face_count=face_count, face_ratio=face_ratio)
        shot["shot_type_detected"] = True
        detected_count += 1

    # 写回缓存
    save_project_data(project_id, project_data)

    return {"detected": detected_count + migrated, "cached": False}


async def _clip_single_shot(shot: dict, proj_dir: str):
    """
    为单个镜头预裁剪独立 MP4 文件。
    裁剪后的文件保存在项目 shots/ 目录下，并更新镜头的 clip_file 字段。
    """
    shots_dir = os.path.join(proj_dir, "shots")
    os.makedirs(shots_dir, exist_ok=True)

    # 如果已有 clip_file 且文件存在，跳过
    existing_clip = shot.get("clip_file", "")
    if existing_clip and os.path.exists(os.path.join(shots_dir, existing_clip)):
        return True

    video_path = shot.get("source_video", "")
    if not video_path or not os.path.exists(video_path):
        return False

    start_time = shot.get("start_time", 0)
    duration = shot.get("duration", 0)
    if duration <= 0:
        return False

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
            logger.info(f"预裁剪镜头: {shot['id']} → {clip_filename}")
            return True
        else:
            logger.warning(f"预裁剪失败: {shot['id']}: {stderr.decode()[:100]}")
            return False
    except Exception as e:
        logger.warning(f"预裁剪异常: {shot['id']}: {e}")
        return False


@router.post("/favorite")
async def toggle_favorite(req: FavoriteRequest):
    """切换镜头收藏状态 — 收藏时自动预裁剪独立 MP4"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    proj_dir = get_project_dir(project_id)
    found = False
    target_shot = None
    for shot in project_data.get("shots", []):
        if shot["id"] == req.shot_id:
            shot["favorite"] = req.favorite
            target_shot = shot
            found = True
            break

    if not found:
        raise HTTPException(status_code=404, detail="镜头不存在")

    # ★ 收藏时，如果源视频存在且没有 clip_file，立即预裁剪
    clip_ready = False
    if req.favorite and target_shot:
        clip_ready = await _clip_single_shot(target_shot, proj_dir)

    save_project_data(project_id, project_data)
    return {
        "success": True,
        "favorite": req.favorite,
        "clip_file": target_shot.get("clip_file", "") if target_shot else "",
    }


@router.post("/ensure_favorite_clips")
async def ensure_favorite_clips():
    """
    补偿接口：扫描所有收藏镜头，为缺少 clip_file 的镜头预裁剪。
    用于修复已有收藏镜头没有 clip_file 导致无法播放/导出的问题。
    前端在加载镜头时会自动调用此接口。
    如果源视频不存在且 clip 文件丢失，会清除无效的 clip_file 字段。
    """
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        return {"success": True, "clipped": 0, "failed": 0}

    proj_dir = get_project_dir(project_id)
    shots_dir = os.path.join(proj_dir, "shots")

    clipped = 0
    failed = 0
    changed = False

    for shot in project_data.get("shots", []):
        if not shot.get("favorite"):
            continue

        # 检查是否已有有效的 clip_file
        existing_clip = shot.get("clip_file", "")
        if existing_clip and os.path.exists(os.path.join(shots_dir, existing_clip)):
            continue

        # clip_file 字段有值但文件不存在 → 先清除
        if existing_clip:
            shot.pop("clip_file", None)
            changed = True

        # 尝试预裁剪
        success = await _clip_single_shot(shot, proj_dir)
        if success:
            clipped += 1
            changed = True
        else:
            failed += 1

    if changed:
        save_project_data(project_id, project_data)

    return {"success": True, "clipped": clipped, "failed": failed}


@router.post("/trim_shot")
async def trim_shot(req: TrimShotRequest):
    """裁剪镜头入出点"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    fps = project_data.get("fps", 24)

    for shot in project_data.get("shots", []):
        if shot["id"] == req.shot_id:
            # 更新时间范围
            shot["start_time"] = round(req.new_start, 3)
            shot["end_time"] = round(req.new_end, 3)
            shot["duration"] = round(req.new_end - req.new_start, 3)
            shot["start_frame"] = int(req.new_start * fps)
            shot["end_frame"] = int(req.new_end * fps)
            shot["mid_frame"] = (shot["start_frame"] + shot["end_frame"]) // 2

            # 更新时间码显示
            shot["timecode_display"] = _frame_to_display_timecode(shot["start_frame"], fps)

            # 清除该镜头的缓存裁剪视频（入出点变了，旧缓存已过期）
            proj_dir = get_project_dir(project_id)
            shots_cache_dir = os.path.join(proj_dir, "shots")
            if os.path.isdir(shots_cache_dir):
                import glob
                # 删除所有该 shot_id 相关的缓存文件（包括 clip）
                for cached_file in glob.glob(os.path.join(shots_cache_dir, f"{req.shot_id}*")):
                    try:
                        os.remove(cached_file)
                    except OSError:
                        pass

            # ★ 清除旧的 clip_file（入出点变了需要重新裁剪）
            shot.pop("clip_file", None)

            # ★ 如果是收藏镜头，立即重新生成 clip_file
            if shot.get("favorite"):
                await _clip_single_shot(shot, proj_dir)

            save_project_data(project_id, project_data)
            return {
                "success": True,
                "start_time": shot["start_time"],
                "end_time": shot["end_time"],
                "duration": shot["duration"],
                "clip_file": shot.get("clip_file", ""),
            }

    raise HTTPException(status_code=404, detail="镜头不存在")


@router.post("/save_frame")
async def save_frame(req: SaveFrameRequest):
    """保存镜头中间帧为静帧"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    for shot in project_data.get("shots", []):
        if shot["id"] == req.shot_id:
            video_path = shot.get("source_video")
            if not video_path or not os.path.exists(video_path):
                raise HTTPException(status_code=404, detail="源视频文件不存在")

            frame = extract_frame(video_path, shot["mid_frame"])
            if frame is None:
                raise HTTPException(status_code=500, detail="无法提取帧")

            proj_dir = get_project_dir(project_id)
            saved_dir = os.path.join(proj_dir, "saved_frames")
            os.makedirs(saved_dir, exist_ok=True)

            filename = f"{shot['id']}_saved.jpg"
            save_path = os.path.join(saved_dir, filename)
            save_frame_jpeg(frame, save_path)

            shot["saved"] = True
            save_project_data(project_id, project_data)

            return {"success": True, "filename": filename, "path": save_path}

    raise HTTPException(status_code=404, detail="镜头不存在")


@router.post("/save_custom_frame")
async def save_custom_frame(req: SaveCustomFrameRequest):
    """保存指定时间偏移处的帧"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    fps = project_data.get("fps", 24)

    for shot in project_data.get("shots", []):
        if shot["id"] == req.shot_id:
            video_path = shot.get("source_video")
            if not video_path or not os.path.exists(video_path):
                raise HTTPException(status_code=404, detail="源视频文件不存在")

            # 计算目标帧号
            target_time = shot["start_time"] + req.time_offset
            target_frame = int(target_time * fps)
            target_frame = max(shot["start_frame"], min(target_frame, shot["end_frame"]))

            frame = extract_frame(video_path, target_frame)
            if frame is None:
                raise HTTPException(status_code=500, detail="无法提取帧")

            proj_dir = get_project_dir(project_id)
            saved_dir = os.path.join(proj_dir, "saved_frames")
            os.makedirs(saved_dir, exist_ok=True)

            filename = f"{shot['id']}_custom_{target_frame}.jpg"
            save_path = os.path.join(saved_dir, filename)
            save_frame_jpeg(frame, save_path)

            return {"success": True, "filename": filename, "path": save_path}

    raise HTTPException(status_code=404, detail="镜头不存在")


@router.post("/merge_shots")
async def merge_shots(req: MergeShotsRequest):
    """合并两个镜头"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    shots = project_data.get("shots", [])
    fps = project_data.get("fps", 24)

    # 找到两个镜头
    shot_a = None
    shot_b = None
    idx_a = -1
    idx_b = -1

    for i, shot in enumerate(shots):
        if shot["id"] == req.shot_id_a:
            shot_a = shot
            idx_a = i
        elif shot["id"] == req.shot_id_b:
            shot_b = shot
            idx_b = i

    if shot_a is None or shot_b is None:
        raise HTTPException(status_code=404, detail="找不到指定的镜头")

    if req.shot_id_a == req.shot_id_b:
        raise HTTPException(status_code=400, detail="不能合并同一个镜头")

    # 检查视频源是否相同
    if shot_a.get("source_video") != shot_b.get("source_video"):
        raise HTTPException(status_code=400, detail="不同视频来源的镜头无法合并")

    video_path = shot_a["source_video"]

    # 计算合并后的元数据
    new_start_frame = min(shot_a["start_frame"], shot_b["start_frame"])
    new_end_frame = max(shot_a["end_frame"], shot_b["end_frame"])
    new_mid_frame = (new_start_frame + new_end_frame) // 2
    new_start_time = round(new_start_frame / fps, 3)
    new_end_time = round(new_end_frame / fps, 3)
    new_duration = round(new_end_time - new_start_time, 3)

    # 生成新 ID
    earlier_idx = min(idx_a, idx_b)
    video_hash = _video_hash(video_path)
    timecode = _frame_to_timecode(new_start_frame, fps)
    timecode_display = _frame_to_display_timecode(new_start_frame, fps)
    new_id = f"shot_{earlier_idx:04d}_{video_hash}_{timecode}"
    frame_file = f"{new_id}.jpg"

    # 提取新的中间帧
    frame = extract_frame(video_path, new_mid_frame)
    has_person = shot_a.get("has_person", False) or shot_b.get("has_person", False)
    face_ratio = max(shot_a.get("face_ratio", 0), shot_b.get("face_ratio", 0))
    good_composition = shot_a.get("good_composition", False) or shot_b.get("good_composition", False)
    motion_score = max(shot_a.get("motion_score", 0), shot_b.get("motion_score", 0))

    if frame is not None:
        proj_dir = get_project_dir(project_id)
        frames_dir = os.path.join(proj_dir, "frames")
        os.makedirs(frames_dir, exist_ok=True)
        save_frame_jpeg(frame, os.path.join(frames_dir, frame_file))

    # 构建合并后的镜头
    merged_shot = {
        "id": new_id,
        "index": earlier_idx,
        "timecode": timecode,
        "timecode_display": timecode_display,
        "start_frame": new_start_frame,
        "end_frame": new_end_frame,
        "mid_frame": new_mid_frame,
        "start_time": new_start_time,
        "end_time": new_end_time,
        "duration": new_duration,
        "has_person": has_person,
        "face_ratio": face_ratio,
        "face_count": max(shot_a.get("face_count", 0), shot_b.get("face_count", 0)),
        "person_ratio": max(shot_a.get("person_ratio", 0), shot_b.get("person_ratio", 0)),
        "good_composition": good_composition,
        "motion_score": motion_score,
        "shot_type": shot_a.get("shot_type", "") or shot_b.get("shot_type", ""),
        "face_detected": shot_a.get("face_detected", False) and shot_b.get("face_detected", False),
        "shot_type_detected": shot_a.get("shot_type_detected", False) and shot_b.get("shot_type_detected", False),
        "favorite": shot_a.get("favorite", False) or shot_b.get("favorite", False),
        "saved": False,
        "frame_file": frame_file,
        "source_video": video_path,
    }

    # 删除旧帧文件
    proj_dir = get_project_dir(project_id)
    frames_dir = os.path.join(proj_dir, "frames")
    for old_shot in [shot_a, shot_b]:
        old_frame = os.path.join(frames_dir, old_shot.get("frame_file", ""))
        if os.path.exists(old_frame):
            os.remove(old_frame)

    # 从列表中移除原两个镜头，插入合并后镜头
    removed_ids = [shot_a["id"], shot_b["id"]]
    shots = [s for s in shots if s["id"] not in removed_ids]
    shots.insert(earlier_idx, merged_shot)

    # 重排 index
    for i, shot in enumerate(shots):
        shot["index"] = i

    project_data["shots"] = shots
    save_project_data(project_id, project_data)
    update_project_info(project_id, shot_count=len(shots))

    return {
        "success": True,
        "merged_shot": merged_shot,
        "removed_ids": removed_ids,
    }

"""镜头数据 API 路由 — 完整实现"""
import os
import cv2
import asyncio
import subprocess
import logging
from datetime import datetime
from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from models.schemas import (
    FavoriteRequest,
    TrimShotRequest,
    SaveFrameRequest,
    SaveCustomFrameRequest,
    MergeShotsRequest,
    SplitShotRequest,
    BatchDeleteShotsRequest,
)
from services.project_manager import (
    get_active_project_id,
    load_project_data,
    save_project_data,
    get_project_dir,
    update_project_info,
)

logger = logging.getLogger(__name__)
from services.scene_detect import extract_frame, save_frame_jpeg, save_thumbnail, _video_hash, _frame_to_timecode, _frame_to_display_timecode
from services.face_detect import detect_face_info, detect_face_info_multi_frame, get_effective_region_cached
from services.shot_type_detect import classify_shot_label

router = APIRouter()


def _get_active_project_or_fail() -> str:
    pid = get_active_project_id()
    if not pid:
        raise HTTPException(status_code=400, detail="没有活跃项目")
    return pid


def _apply_favorites_to_shots(shots: list, favorites: list):
    """
    根据 favorites 列表动态给 shots 标记 favorite 字段。
    匹配规则：source_video 相同 + shot 中点落在 favorite 时间范围内。
    对于 __orphan__ 类型的 shot，直接保留其已有的 favorite 标记。
    """
    if not favorites:
        # 没有 favorites → 清除所有非孤儿 shot 的 favorite 标记
        for shot in shots:
            if shot.get("source_video") != "__orphan__":
                shot["favorite"] = False
        return

    for shot in shots:
        # 孤儿 shot 保持自身的 favorite 状态不变
        if shot.get("source_video") == "__orphan__":
            continue

        shot_mid = (shot.get("start_time", 0) + shot.get("end_time", 0)) / 2
        shot_src = shot.get("source_video", "")
        matched = False
        for fav in favorites:
            if fav.get("source_video") != shot_src:
                continue
            if fav.get("start_time", 0) <= shot_mid <= fav.get("end_time", 0):
                matched = True
                break
        shot["favorite"] = matched


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

    # ★ 数据迁移：老项目没有 favorites 字段时，从 shot.favorite 属性中提取
    if "favorites" not in project_data:
        favorites = []
        for shot in project_data.get("shots", []):
            if shot.get("favorite"):
                favorites.append({
                    "source_video": shot.get("source_video", ""),
                    "start_time": shot.get("start_time", 0),
                    "end_time": shot.get("end_time", 0),
                    "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                })
        project_data["favorites"] = favorites
        save_project_data(project_id, project_data)

    shots = list(project_data.get("shots", []))

    # ★ 动态匹配 favorites → 给 shot 标记 favorite
    favorites = project_data.get("favorites", [])
    _apply_favorites_to_shots(shots, favorites)

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

    # ★ 全量数据（不受任何筛选影响）— 供侧边栏使用
    all_shots = project_data.get("shots", [])
    total_all_global = len(all_shots)
    favorite_count = sum(1 for s in all_shots if s.get("favorite"))

    # ★ 分类计数的基准集：应用除景别筛选外的其他筛选条件
    # 这样当用户选"已收藏"时，分类标签的计数只反映收藏镜头中各分类的数量
    base_shots = list(all_shots)
    if has_person:
        base_shots = [s for s in base_shots if s.get("has_person")]
    if favorite_only:
        base_shots = [s for s in base_shots if s.get("favorite")]
    if source_video:
        base_shots = [s for s in base_shots if s.get("source_video") == source_video]
    if search:
        base_shots = [s for s in base_shots if search in s.get("timecode_display", "") or search in s.get("timecode", "")]

    total_all = len(base_shots)

    # 各景别分类计数（基于筛选后的基准集，不受景别筛选影响）
    shot_type_counts = {}
    for s in base_shots:
        st = s.get("shot_type", "")
        if st:
            shot_type_counts[st] = shot_type_counts.get(st, 0) + 1

    # ★ 为每个镜头标注源视频是否存在（前端据此决定播放模式）
    for s in shots:
        vp = s.get("source_video", "")
        s["source_video_exists"] = bool(vp and os.path.exists(vp))

    # ★ 数据就绪标记 — 前端据此在分析未完成时给出准确提示
    motion_data_ready = any(s.get("motion_score", 0) > 0 for s in all_shots) if len(all_shots) > 0 else True
    shot_type_data_ready = all(s.get("shot_type_detected", False) for s in all_shots) if len(all_shots) > 0 else True

    return {
        "shots": shots,
        "total": len(shots),
        "total_all": total_all,
        "total_all_global": total_all_global,
        "favorite_count": favorite_count,
        "shot_type_counts": shot_type_counts,
        "motion_data_ready": motion_data_ready,
        "shot_type_data_ready": shot_type_data_ready,
    }


def _update_cover_frame(shot: dict, best_frame_num: int, video_path: str, project_id: str):
    """
    根据最优帧号更新镜头封面 — 当最优帧不是原 mid_frame 时，
    重新提取该帧并覆盖封面 JPEG。

    Args:
        shot: 镜头字典
        best_frame_num: 最优帧帧号
        video_path: 视频文件路径
        project_id: 项目 ID
    """
    if best_frame_num is None:
        return

    old_mid = shot.get("mid_frame")
    if best_frame_num == old_mid:
        return  # 最优帧就是原来的 mid_frame，无需更新

    # 提取新帧
    new_frame = extract_frame(video_path, best_frame_num)
    if new_frame is None:
        return

    # 更新 mid_frame
    shot["mid_frame"] = best_frame_num

    # 覆盖封面 JPEG（使用缩略图格式，与 build_shots_fast 一致）
    proj_dir = get_project_dir(project_id)
    frames_dir = os.path.join(proj_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    frame_file = shot.get("frame_file", "")
    if frame_file:
        frame_path = os.path.join(frames_dir, frame_file)
        save_thumbnail(new_frame, frame_path)
        logger.info(f"封面已更新: {shot['id']} → 最优帧 F{best_frame_num}")


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

        # ★ 获取视频有效区域（去黑边），传入人脸检测
        effective_region = get_effective_region_cached(vpath)

        for shot in shot_list:
            # ★ 多帧采样检测（25%、50%、75% 位置），替代只看首帧
            face_info = detect_face_info_multi_frame(
                video_path=vpath,
                start_frame=shot.get("start_frame", 0),
                end_frame=shot.get("end_frame", shot.get("start_frame", 0) + 1),
                sample_count=3,
                effective_region=effective_region,
            )
            shot["has_person"] = bool(face_info["has_person"])
            shot["face_ratio"] = float(face_info["face_ratio"])
            shot["good_composition"] = bool(face_info["good_composition"])
            shot["face_count"] = int(face_info.get("face_count", 0))
            shot["per_frame_debug"] = face_info.get("per_frame", {})
            # ★ 补写构图安全性字段（裁头/安全区/黑边）
            shot["face_cropped"] = bool(face_info.get("face_cropped", False))
            shot["face_in_safe_zone"] = bool(face_info.get("face_in_safe_zone", True))
            shot["head_margin_ratio"] = float(face_info.get("head_margin_ratio", 1.0))
            shot["has_black_bars"] = bool(face_info.get("has_black_bars", False))

            # ★ 根据最优帧更新封面（推镜头等场景，选最佳帧作为封面）
            best_fn = face_info.get("best_frame_num")
            _update_cover_frame(shot, best_fn, vpath, project_id)

            # ★ 构图瑕疵标记（不影响分类，仅供前端展示）
            issues = []
            if shot["face_cropped"]:
                issues.append("裁头")
            if not shot["face_in_safe_zone"]:
                issues.append("贴边")
            shot["composition_issue"] = "/".join(issues)

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

            # ★ 获取视频有效区域（去黑边），传入人脸检测
            effective_region = get_effective_region_cached(vpath)

            for shot in shot_list:
                # ★ 多帧采样检测（25%、50%、75% 位置）
                face_info = detect_face_info_multi_frame(
                    video_path=vpath,
                    start_frame=shot.get("start_frame", 0),
                    end_frame=shot.get("end_frame", shot.get("start_frame", 0) + 1),
                    sample_count=3,
                    effective_region=effective_region,
                )
                shot["has_person"] = bool(face_info["has_person"])
                shot["face_ratio"] = float(face_info["face_ratio"])
                shot["good_composition"] = bool(face_info["good_composition"])
                shot["face_count"] = int(face_info.get("face_count", 0))
                shot["per_frame_debug"] = face_info.get("per_frame", {})
                # ★ 补写构图安全性字段（裁头/安全区/黑边）
                shot["face_cropped"] = bool(face_info.get("face_cropped", False))
                shot["face_in_safe_zone"] = bool(face_info.get("face_in_safe_zone", True))
                shot["head_margin_ratio"] = float(face_info.get("head_margin_ratio", 1.0))
                shot["has_black_bars"] = bool(face_info.get("has_black_bars", False))

                # ★ 根据最优帧更新封面
                best_fn = face_info.get("best_frame_num")
                _update_cover_frame(shot, best_fn, vpath, project_id)

                # ★ 构图瑕疵标记
                issues = []
                if shot["face_cropped"]:
                    issues.append("裁头")
                if not shot["face_in_safe_zone"]:
                    issues.append("贴边")
                shot["composition_issue"] = "/".join(issues)
                shot["face_detected"] = True

    # 所有 pending 镜头进行分类（基于 face_count + face_ratio + 构图安全性）
    detected_count = 0
    for shot in pending:
        face_count = shot.get("face_count", 0)
        face_ratio = shot.get("face_ratio", 0.0)
        face_cropped = shot.get("face_cropped", False)
        face_in_safe_zone = shot.get("face_in_safe_zone", True)
        shot["shot_type"] = classify_shot_label(
            face_count=face_count,
            face_ratio=face_ratio,
            face_cropped=face_cropped,
            face_in_safe_zone=face_in_safe_zone,
        )
        # ★ 补写构图瑕疵标记（可能之前人脸检测时没有写入）
        if not shot.get("composition_issue") and shot.get("composition_issue") != "":
            issues = []
            if face_cropped:
                issues.append("裁头")
            if not face_in_safe_zone:
                issues.append("贴边")
            shot["composition_issue"] = "/".join(issues)
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
        def _run_ffmpeg():
            return subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

        result = await asyncio.get_event_loop().run_in_executor(None, _run_ffmpeg)

        if result.returncode == 0 and os.path.exists(clip_path):
            shot["clip_file"] = clip_filename
            logger.info(f"预裁剪镜头: {shot['id']} → {clip_filename}")
            return True
        else:
            logger.warning(f"预裁剪失败: {shot['id']}: {result.stderr.decode(errors='replace')[:100]}")
            return False
    except Exception as e:
        logger.warning(f"预裁剪异常: {shot['id']}: {e}")
        return False


@router.post("/favorite")
async def toggle_favorite(req: FavoriteRequest):
    """切换镜头收藏状态 — 收藏时自动预裁剪独立 MP4，操作 favorites 独立数组"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    proj_dir = get_project_dir(project_id)

    # 找到目标 shot
    target_shot = None
    for shot in project_data.get("shots", []):
        if shot["id"] == req.shot_id:
            target_shot = shot
            break

    if not target_shot:
        raise HTTPException(status_code=404, detail="镜头不存在")

    # 操作 favorites 数组
    favorites = project_data.get("favorites", [])

    if req.favorite:
        # 添加收藏记录（去重：检查是否已存在相同的 source_video + 时间范围）
        src = target_shot.get("source_video", "")
        start_t = target_shot.get("start_time", 0)
        end_t = target_shot.get("end_time", 0)

        already_exists = any(
            f.get("source_video") == src
            and abs(f.get("start_time", 0) - start_t) < 0.05
            and abs(f.get("end_time", 0) - end_t) < 0.05
            for f in favorites
        )
        if not already_exists:
            favorites.append({
                "source_video": src,
                "start_time": start_t,
                "end_time": end_t,
                "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            })
    else:
        # 移除收藏记录
        src = target_shot.get("source_video", "")
        shot_mid = (target_shot.get("start_time", 0) + target_shot.get("end_time", 0)) / 2

        # 对于 __orphan__ shot，直接设置其 favorite 标记为 false（不需要操作 favorites）
        if src == "__orphan__":
            target_shot["favorite"] = False
            project_data["favorites"] = favorites
            save_project_data(project_id, project_data)
            return {
                "success": True,
                "favorite": False,
                "clip_file": target_shot.get("clip_file", ""),
            }

        # 正常 shot：从 favorites 中移除匹配记录
        new_favorites = []
        for f in favorites:
            if f.get("source_video") != src:
                new_favorites.append(f)
                continue
            # 时间范围匹配：shot 中点落在 favorite 范围内
            if f.get("start_time", 0) <= shot_mid <= f.get("end_time", 0):
                continue  # 移除此条
            new_favorites.append(f)
        favorites = new_favorites

    project_data["favorites"] = favorites

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
    motion_score = max(shot_a.get("motion_score", 0), shot_b.get("motion_score", 0))

    if frame is not None:
        proj_dir = get_project_dir(project_id)
        frames_dir = os.path.join(proj_dir, "frames")
        os.makedirs(frames_dir, exist_ok=True)
        save_thumbnail(frame, os.path.join(frames_dir, frame_file))

    # ── 对合并后的镜头做独立的人脸检测 + 景别分类 ──
    effective_region = get_effective_region_cached(video_path)
    face_info = detect_face_info_multi_frame(
        video_path=video_path,
        start_frame=new_start_frame,
        end_frame=new_end_frame,
        sample_count=3,
        effective_region=effective_region,
    )

    # ★ 根据最优帧更新封面
    best_fn = face_info.get("best_frame_num")
    if best_fn is not None and best_fn != new_mid_frame:
        best_frame_img = extract_frame(video_path, best_fn)
        if best_frame_img is not None:
            new_mid_frame = best_fn
            if not proj_dir:
                proj_dir = get_project_dir(project_id)
            frames_dir = os.path.join(proj_dir, "frames")
            os.makedirs(frames_dir, exist_ok=True)
            save_thumbnail(best_frame_img, os.path.join(frames_dir, frame_file))

    merged_has_person = bool(face_info["has_person"])
    merged_face_ratio = float(face_info["face_ratio"])
    merged_good_composition = bool(face_info["good_composition"])
    merged_face_count = int(face_info.get("face_count", 0))
    merged_face_cropped = bool(face_info.get("face_cropped", False))
    merged_face_in_safe_zone = bool(face_info.get("face_in_safe_zone", True))
    merged_head_margin_ratio = float(face_info.get("head_margin_ratio", 1.0))
    merged_has_black_bars = bool(face_info.get("has_black_bars", False))

    # 构图瑕疵标记
    issues = []
    if merged_face_cropped:
        issues.append("裁头")
    if not merged_face_in_safe_zone:
        issues.append("贴边")
    merged_composition_issue = "/".join(issues)

    # 景别分类
    merged_shot_type = classify_shot_label(
        face_count=merged_face_count,
        face_ratio=merged_face_ratio,
        face_cropped=merged_face_cropped,
        face_in_safe_zone=merged_face_in_safe_zone,
    )

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
        "has_person": merged_has_person,
        "face_ratio": merged_face_ratio,
        "face_count": merged_face_count,
        "good_composition": merged_good_composition,
        "motion_score": motion_score,
        "shot_type": merged_shot_type,
        "face_detected": True,
        "shot_type_detected": True,
        "face_cropped": merged_face_cropped,
        "face_in_safe_zone": merged_face_in_safe_zone,
        "head_margin_ratio": merged_head_margin_ratio,
        "has_black_bars": merged_has_black_bars,
        "composition_issue": merged_composition_issue,
        "per_frame_debug": face_info.get("per_frame", {}),
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


@router.post("/split_shot")
async def split_shot(req: SplitShotRequest):
    """
    拆分镜头 — 在指定时间点将一个镜头拆为前后两段。
    与 merge_shots 对称的逆操作。
    """
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    shots = project_data.get("shots", [])
    fps_val = project_data.get("fps", 24)

    # 找到原镜头
    orig_shot = None
    orig_idx = -1
    for i, shot in enumerate(shots):
        if shot["id"] == req.shot_id:
            orig_shot = shot
            orig_idx = i
            break

    if orig_shot is None:
        raise HTTPException(status_code=404, detail="镜头不存在")

    video_path = orig_shot.get("source_video", "")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(status_code=400, detail="源视频文件不存在，无法拆分")

    split_time = req.split_time
    orig_start = orig_shot["start_time"]
    orig_end = orig_shot["end_time"]

    # 校验拆分点在镜头范围内
    min_gap = 2 / fps_val  # 至少 2 帧
    if split_time <= orig_start + min_gap or split_time >= orig_end - min_gap:
        raise HTTPException(status_code=400, detail="拆分点需在镜头范围内且距头尾至少2帧")

    video_hash = _video_hash(video_path)
    proj_dir = get_project_dir(project_id)
    frames_dir = os.path.join(proj_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    # ── 构建镜头 A（前半段） ──
    a_start_frame = orig_shot["start_frame"]
    a_end_frame = int(split_time * fps_val)
    a_mid_frame = (a_start_frame + a_end_frame) // 2
    a_start_time = orig_start
    a_end_time = round(split_time, 3)
    a_duration = round(a_end_time - a_start_time, 3)
    a_timecode = _frame_to_timecode(a_start_frame, fps_val)
    a_timecode_display = _frame_to_display_timecode(a_start_frame, fps_val)
    a_id = f"shot_{orig_idx:04d}_{video_hash}_{a_timecode}"
    a_frame_file = f"{a_id}.jpg"

    # 提取镜头 A 中间帧
    frame_a = extract_frame(video_path, a_mid_frame)
    if frame_a is not None:
        save_frame_jpeg(frame_a, os.path.join(frames_dir, a_frame_file))

    shot_a = {
        "id": a_id,
        "index": orig_idx,
        "timecode": a_timecode,
        "timecode_display": a_timecode_display,
        "start_frame": a_start_frame,
        "end_frame": a_end_frame,
        "mid_frame": a_mid_frame,
        "start_time": a_start_time,
        "end_time": a_end_time,
        "duration": a_duration,
        "motion_score": orig_shot.get("motion_score", 0),
        "favorite": False,
        "saved": False,
        "frame_file": a_frame_file,
        "source_video": video_path,
    }

    # ── 构建镜头 B（后半段） ──
    b_start_frame = a_end_frame
    b_end_frame = orig_shot["end_frame"]
    b_mid_frame = (b_start_frame + b_end_frame) // 2
    b_start_time = round(split_time, 3)
    b_end_time = orig_end
    b_duration = round(b_end_time - b_start_time, 3)
    b_timecode = _frame_to_timecode(b_start_frame, fps_val)
    b_timecode_display = _frame_to_display_timecode(b_start_frame, fps_val)
    b_id = f"shot_{orig_idx + 1:04d}_{video_hash}_{b_timecode}"
    b_frame_file = f"{b_id}.jpg"

    # 提取镜头 B 中间帧
    frame_b = extract_frame(video_path, b_mid_frame)
    if frame_b is not None:
        save_frame_jpeg(frame_b, os.path.join(frames_dir, b_frame_file))

    shot_b = {
        "id": b_id,
        "index": orig_idx + 1,
        "timecode": b_timecode,
        "timecode_display": b_timecode_display,
        "start_frame": b_start_frame,
        "end_frame": b_end_frame,
        "mid_frame": b_mid_frame,
        "start_time": b_start_time,
        "end_time": b_end_time,
        "duration": b_duration,
        "motion_score": orig_shot.get("motion_score", 0),
        "favorite": False,
        "saved": False,
        "frame_file": b_frame_file,
        "source_video": video_path,
    }

    # ── 对拆分后的两个镜头分别做人脸检测 + 景别分类 ──
    effective_region = get_effective_region_cached(video_path)

    for new_shot in [shot_a, shot_b]:
        face_info = detect_face_info_multi_frame(
            video_path=video_path,
            start_frame=new_shot["start_frame"],
            end_frame=new_shot["end_frame"],
            sample_count=3,
            effective_region=effective_region,
        )
        new_shot["has_person"] = bool(face_info["has_person"])
        new_shot["face_ratio"] = float(face_info["face_ratio"])
        new_shot["good_composition"] = bool(face_info["good_composition"])
        new_shot["face_count"] = int(face_info.get("face_count", 0))
        new_shot["per_frame_debug"] = face_info.get("per_frame", {})
        new_shot["face_cropped"] = bool(face_info.get("face_cropped", False))
        new_shot["face_in_safe_zone"] = bool(face_info.get("face_in_safe_zone", True))
        new_shot["head_margin_ratio"] = float(face_info.get("head_margin_ratio", 1.0))
        new_shot["has_black_bars"] = bool(face_info.get("has_black_bars", False))

        # ★ 根据最优帧更新封面
        best_fn = face_info.get("best_frame_num")
        _update_cover_frame(new_shot, best_fn, video_path, project_id)

        # 构图瑕疵标记
        issues = []
        if new_shot["face_cropped"]:
            issues.append("裁头")
        if not new_shot["face_in_safe_zone"]:
            issues.append("贴边")
        new_shot["composition_issue"] = "/".join(issues)

        # 景别分类
        new_shot["shot_type"] = classify_shot_label(
            face_count=new_shot["face_count"],
            face_ratio=new_shot["face_ratio"],
            face_cropped=new_shot["face_cropped"],
            face_in_safe_zone=new_shot["face_in_safe_zone"],
        )
        new_shot["face_detected"] = True
        new_shot["shot_type_detected"] = True

    # ── 删除原镜头帧文件 ──
    old_frame = os.path.join(frames_dir, orig_shot.get("frame_file", ""))
    if os.path.exists(old_frame):
        try:
            os.remove(old_frame)
        except OSError:
            pass

    # ── 删除原镜头的 clip 缓存 ──
    shots_cache_dir = os.path.join(proj_dir, "shots")
    if os.path.isdir(shots_cache_dir):
        import glob
        for cached_file in glob.glob(os.path.join(shots_cache_dir, f"{req.shot_id}*")):
            try:
                os.remove(cached_file)
            except OSError:
                pass

    # ── 替换列表：移除原镜头，插入两个新镜头 ──
    removed_id = orig_shot["id"]
    shots.pop(orig_idx)
    shots.insert(orig_idx, shot_b)
    shots.insert(orig_idx, shot_a)

    # 重排 index
    for i, shot in enumerate(shots):
        shot["index"] = i

    project_data["shots"] = shots
    save_project_data(project_id, project_data)
    update_project_info(project_id, shot_count=len(shots))

    # ★ 为返回数据标注源视频是否存在
    shot_a["source_video_exists"] = os.path.exists(video_path)
    shot_b["source_video_exists"] = os.path.exists(video_path)

    return {
        "success": True,
        "shot_a": shot_a,
        "shot_b": shot_b,
        "removed_id": removed_id,
    }


@router.post("/shots/delete")
async def batch_delete_shots(req: BatchDeleteShotsRequest):
    """
    批量删除镜头 — 从 shots 数组中移除指定镜头，清理帧/clip 文件。
    如果被删镜头有 favorite 记录，同步从 favorites 中移除。
    """
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    proj_dir = get_project_dir(project_id)
    frames_dir = os.path.join(proj_dir, "frames")
    saved_frames_dir = os.path.join(proj_dir, "saved_frames")
    shots_dir = os.path.join(proj_dir, "shots")

    delete_ids = set(req.shot_ids)
    shots = project_data.get("shots", [])
    favorites = project_data.get("favorites", [])

    # 收集被删除的 shot 信息（用于清理 favorites）
    deleted_shots = [s for s in shots if s["id"] in delete_ids]

    # 清理文件
    for shot in deleted_shots:
        # 删除帧文件
        frame_path = os.path.join(frames_dir, shot.get("frame_file", ""))
        if os.path.exists(frame_path):
            try:
                os.remove(frame_path)
            except OSError:
                pass
        # 删除 clip 文件
        clip_file = shot.get("clip_file", "")
        if clip_file:
            clip_path = os.path.join(shots_dir, clip_file)
            if os.path.exists(clip_path):
                try:
                    os.remove(clip_path)
                except OSError:
                    pass
        # 删除保存的静帧
        for suffix in ["_saved.jpg", f"_custom_{shot.get('mid_frame', 0)}.jpg"]:
            saved_path = os.path.join(saved_frames_dir, f"{shot['id']}{suffix}")
            if os.path.exists(saved_path):
                try:
                    os.remove(saved_path)
                except OSError:
                    pass

    # 从 favorites 中移除对应记录
    new_favorites = []
    for fav in favorites:
        fav_src = fav.get("source_video", "")
        fav_start = fav.get("start_time", 0)
        fav_end = fav.get("end_time", 0)

        # 检查是否有被删的 shot 匹配此 favorite
        matched_deleted = False
        for ds in deleted_shots:
            ds_src = ds.get("source_video", "")
            if ds_src != fav_src:
                continue
            ds_mid = (ds.get("start_time", 0) + ds.get("end_time", 0)) / 2
            if fav_start <= ds_mid <= fav_end:
                matched_deleted = True
                break
        if not matched_deleted:
            new_favorites.append(fav)

    # 更新 shots 和 favorites
    remaining_shots = [s for s in shots if s["id"] not in delete_ids]
    for i, shot in enumerate(remaining_shots):
        shot["index"] = i

    project_data["shots"] = remaining_shots
    project_data["favorites"] = new_favorites
    save_project_data(project_id, project_data)
    update_project_info(project_id, shot_count=len(remaining_shots))

    return {
        "success": True,
        "deleted": len(deleted_shots),
        "remaining": len(remaining_shots),
    }

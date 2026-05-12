"""镜头信息丰富化服务 — 人脸检测 + 构图标记 + 景别分类的统一入口"""
import os
import logging
from typing import Optional

from services.face_detect import detect_face_info_multi_frame, get_effective_region_cached
from services.shot_type_detect import classify_shot_label
from services.scene_detect import extract_frame, save_thumbnail

logger = logging.getLogger(__name__)


def enrich_shot_with_face_info(
    shot: dict,
    video_path: str,
    project_id: str,
    proj_dir: str,
    effective_region=None,
    sample_count: int = 3,
):
    """
    对单个镜头进行人脸检测 + 构图标记 + 景别分类的完整丰富化。

    Args:
        shot: 镜头字典（会被原地修改）
        video_path: 视频文件路径
        project_id: 项目 ID
        proj_dir: 项目目录路径
        effective_region: 预计算的视频有效区域（None 时自动获取）
        sample_count: 多帧采样数量

    Returns:
        shot（原地修改后的引用）
    """
    if effective_region is None:
        effective_region = get_effective_region_cached(video_path)

    # ★ 多帧采样人脸检测
    face_info = detect_face_info_multi_frame(
        video_path=video_path,
        start_frame=shot.get("start_frame", 0),
        end_frame=shot.get("end_frame", shot.get("start_frame", 0) + 1),
        sample_count=sample_count,
        effective_region=effective_region,
    )

    # 写入人脸检测结果
    shot["has_person"] = bool(face_info["has_person"])
    shot["face_ratio"] = float(face_info["face_ratio"])
    shot["good_composition"] = bool(face_info["good_composition"])
    shot["face_count"] = int(face_info.get("face_count", 0))
    shot["per_frame_debug"] = face_info.get("per_frame", {})

    # 构图安全性字段
    shot["face_cropped"] = bool(face_info.get("face_cropped", False))
    shot["face_in_safe_zone"] = bool(face_info.get("face_in_safe_zone", True))
    shot["head_margin_ratio"] = float(face_info.get("head_margin_ratio", 1.0))
    shot["has_black_bars"] = bool(face_info.get("has_black_bars", False))

    # ★ 根据最优帧更新封面
    best_fn = face_info.get("best_frame_num")
    _update_cover_frame(shot, best_fn, video_path, proj_dir)

    # ★ 构图瑕疵标记
    issues = []
    if shot["face_cropped"]:
        issues.append("裁头")
    if not shot["face_in_safe_zone"]:
        issues.append("贴边")
    shot["composition_issue"] = "/".join(issues)

    # 标记已检测
    shot["face_detected"] = True

    # ★ 景别分类
    shot["shot_type"] = classify_shot_label(
        face_count=shot["face_count"],
        face_ratio=shot["face_ratio"],
        face_cropped=shot["face_cropped"],
        face_in_safe_zone=shot["face_in_safe_zone"],
    )
    shot["shot_type_detected"] = True

    return shot


def _update_cover_frame(shot: dict, best_frame_num: Optional[int], video_path: str, proj_dir: str):
    """
    根据最优帧号更新镜头封面 — 当最优帧不是原 mid_frame 时，
    重新提取该帧并覆盖封面 JPEG。
    """
    if best_frame_num is None:
        return

    old_mid = shot.get("mid_frame")
    if best_frame_num == old_mid:
        return

    # 提取新帧
    new_frame = extract_frame(video_path, best_frame_num)
    if new_frame is None:
        return

    # 更新 mid_frame
    shot["mid_frame"] = best_frame_num

    # 覆盖封面 JPEG
    frames_dir = os.path.join(proj_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    frame_file = shot.get("frame_file", "")
    if frame_file:
        frame_path = os.path.join(frames_dir, frame_file)
        save_thumbnail(new_frame, frame_path)
        logger.info(f"封面已更新: {shot.get('id', '?')} → 最优帧 F{best_frame_num}")

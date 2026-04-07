"""导出 API 路由 — 批量导出镜头 MP4"""
import os
import shutil
import asyncio
from fastapi import APIRouter, HTTPException

from models.schemas import ExportShotsRequest
from services.project_manager import (
    get_active_project_id,
    load_project_data,
    get_project_dir,
)

router = APIRouter()


@router.post("/export_shots")
async def export_shots(req: ExportShotsRequest):
    """批量导出选中的镜头为 MP4 文件"""
    pid = get_active_project_id()
    if not pid:
        raise HTTPException(status_code=400, detail="没有活跃项目")

    project_data = load_project_data(pid)
    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    # 验证输出目录
    output_dir = req.output_dir
    if not os.path.exists(output_dir):
        try:
            os.makedirs(output_dir, exist_ok=True)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"无法创建输出目录: {e}")

    if not os.path.isdir(output_dir):
        raise HTTPException(status_code=400, detail="输出路径不是目录")

    # 查找所有指定的镜头
    shots_map = {}
    for shot in project_data.get("shots", []):
        if shot["id"] in req.shot_ids:
            shots_map[shot["id"]] = shot

    results = []

    # 获取项目目录（用于查找 clip_file）
    proj_dir = get_project_dir(pid)
    shots_dir = os.path.join(proj_dir, "shots")

    for shot_id in req.shot_ids:
        shot = shots_map.get(shot_id)
        if not shot:
            results.append({"shot_id": shot_id, "error": "镜头不存在"})
            continue

        video_path = shot.get("source_video")
        has_source = video_path and os.path.exists(video_path)

        # ★ 如果源视频不存在，尝试使用预裁剪的 clip_file
        clip_file = shot.get("clip_file", "")
        clip_path = os.path.join(shots_dir, clip_file) if clip_file else ""
        has_clip = clip_file and os.path.exists(clip_path)

        if not has_source and not has_clip:
            results.append({"shot_id": shot_id, "error": "源视频文件不存在"})
            continue

        # 输出文件名为时间码格式
        timecode_safe = shot.get("timecode_display", shot_id).replace(":", "-")
        output_filename = f"{timecode_safe}.mp4"
        output_path = os.path.join(output_dir, output_filename)

        # 避免文件名冲突
        counter = 1
        base_name = timecode_safe
        while os.path.exists(output_path):
            output_filename = f"{base_name}_{counter}.mp4"
            output_path = os.path.join(output_dir, output_filename)
            counter += 1

        try:
            if has_source:
                # 从源视频精确裁剪
                start_time = shot["start_time"]
                duration = shot["duration"]

                # 精确裁剪：使用双 -ss 策略，避免关键帧偏移导致导出到前后镜头的帧
                # 第一个 -ss（input seeking）快速跳到目标附近的关键帧
                # 第二个 -ss（output seeking）精确偏移到目标位置
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
                    output_path,
                ]

                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, stderr = await process.communicate()

                if process.returncode == 0:
                    results.append({"shot_id": shot_id, "path": output_path})
                else:
                    results.append({
                        "shot_id": shot_id,
                        "error": f"FFmpeg 错误: {stderr.decode()[:100]}",
                    })
            else:
                # ★ 源视频不存在，直接复制预裁剪的 clip 文件
                shutil.copy2(clip_path, output_path)
                results.append({"shot_id": shot_id, "path": output_path})

        except Exception as e:
            results.append({"shot_id": shot_id, "error": str(e)})

    return {"exported": results}

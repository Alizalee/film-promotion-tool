"""导出 API 路由 — 批量导出镜头 MP4"""
import os
import asyncio
from fastapi import APIRouter, HTTPException

from models.schemas import ExportShotsRequest
from services.project_manager import (
    get_active_project_id,
    load_project_data,
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

    for shot_id in req.shot_ids:
        shot = shots_map.get(shot_id)
        if not shot:
            results.append({"shot_id": shot_id, "error": "镜头不存在"})
            continue

        video_path = shot.get("source_video")
        if not video_path or not os.path.exists(video_path):
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
            start_time = shot["start_time"]
            duration = shot["duration"]

            cmd = [
                "ffmpeg", "-y",
                "-ss", str(start_time),
                "-i", video_path,
                "-t", str(duration),
                "-c", "copy",
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

        except Exception as e:
            results.append({"shot_id": shot_id, "error": str(e)})

    return {"exported": results}

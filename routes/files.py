"""文件服务 API 路由 — 视频流、静帧、目录浏览"""
import os
import asyncio
import subprocess
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from typing import Optional

from services.project_manager import (
    get_active_project_id,
    load_project_data,
    get_project_dir,
)

router = APIRouter()


def _get_active_project_or_fail() -> str:
    pid = get_active_project_id()
    if not pid:
        raise HTTPException(status_code=400, detail="没有活跃项目")
    return pid


@router.get("/frames/{filename}")
async def get_frame(filename: str):
    """获取关键帧 JPEG 图片"""
    project_id = _get_active_project_or_fail()
    proj_dir = get_project_dir(project_id)
    frame_path = os.path.join(proj_dir, "frames", filename)

    if not os.path.exists(frame_path):
        raise HTTPException(status_code=404, detail="帧文件不存在")

    return FileResponse(frame_path, media_type="image/jpeg")


@router.get("/saved_frames/{filename}")
async def get_saved_frame(filename: str):
    """获取已保存的静帧"""
    project_id = _get_active_project_or_fail()
    proj_dir = get_project_dir(project_id)
    frame_path = os.path.join(proj_dir, "saved_frames", filename)

    if not os.path.exists(frame_path):
        raise HTTPException(status_code=404, detail="帧文件不存在")

    return FileResponse(frame_path, media_type="image/jpeg")


@router.get("/video")
async def stream_video(request: Request, source: Optional[str] = Query(None)):
    """
    流式视频播放（支持 Range 请求实现拖动进度条）
    """
    project_id = _get_active_project_or_fail()

    if source:
        video_path = source
    else:
        project_data = load_project_data(project_id)
        if not project_data or not project_data.get("video_path"):
            raise HTTPException(status_code=404, detail="没有视频文件")
        video_path = project_data["video_path"]

    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="视频文件不存在")

    file_size = os.path.getsize(video_path)
    range_header = request.headers.get("range")

    # 根据文件扩展名确定 MIME 类型
    ext = os.path.splitext(video_path)[1].lower()
    mime_types = {
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
    }
    content_type = mime_types.get(ext, "video/mp4")

    if range_header:
        # 解析 Range 请求
        range_str = range_header.replace("bytes=", "")
        parts = range_str.split("-")
        start = int(parts[0])
        end = int(parts[1]) if parts[1] else file_size - 1
        end = min(end, file_size - 1)
        content_length = end - start + 1

        def iter_file():
            with open(video_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk_size = min(8192, remaining)
                    data = f.read(chunk_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            iter_file(),
            status_code=206,
            media_type=content_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(content_length),
            },
        )
    else:
        return FileResponse(
            video_path,
            media_type=content_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
            },
        )


@router.get("/shot_video/{shot_id}")
async def get_shot_video(shot_id: str):
    """导出单镜头 MP4（FFmpeg 裁剪）"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    # 查找镜头
    shot = None
    for s in project_data.get("shots", []):
        if s["id"] == shot_id:
            shot = s
            break

    if not shot:
        raise HTTPException(status_code=404, detail="镜头不存在")

    video_path = shot.get("source_video")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="源视频文件不存在")

    # 检查缓存
    proj_dir = get_project_dir(project_id)
    shots_dir = os.path.join(proj_dir, "shots")
    os.makedirs(shots_dir, exist_ok=True)
    output_path = os.path.join(shots_dir, f"{shot_id}.mp4")

    if not os.path.exists(output_path):
        # 使用 FFmpeg 异步裁剪
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

        if process.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"FFmpeg 裁剪失败: {stderr.decode()[:200]}",
            )

    return FileResponse(
        output_path,
        media_type="video/mp4",
        filename=f"{shot.get('timecode_display', shot_id).replace(':', '-')}.mp4",
    )


@router.get("/shot_video_range/{shot_id}")
async def get_shot_video_range(shot_id: str, request: Request):
    """单镜头视频 Range 播放（复用主视频流，限定时间范围）"""
    project_id = _get_active_project_or_fail()
    project_data = load_project_data(project_id)

    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    shot = None
    for s in project_data.get("shots", []):
        if s["id"] == shot_id:
            shot = s
            break

    if not shot:
        raise HTTPException(status_code=404, detail="镜头不存在")

    video_path = shot.get("source_video")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="源视频文件不存在")

    # 先确保裁剪过的视频存在
    proj_dir = get_project_dir(project_id)
    shots_dir = os.path.join(proj_dir, "shots")
    os.makedirs(shots_dir, exist_ok=True)
    output_path = os.path.join(shots_dir, f"{shot_id}.mp4")

    if not os.path.exists(output_path):
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
        await process.communicate()

    if not os.path.exists(output_path):
        raise HTTPException(status_code=500, detail="无法生成镜头视频")

    # 支持 Range 请求
    file_size = os.path.getsize(output_path)
    range_header = request.headers.get("range")

    if range_header:
        range_str = range_header.replace("bytes=", "")
        parts = range_str.split("-")
        start = int(parts[0])
        end = int(parts[1]) if parts[1] else file_size - 1
        end = min(end, file_size - 1)
        content_length = end - start + 1

        def iter_file():
            with open(output_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk_size = min(8192, remaining)
                    data = f.read(chunk_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            iter_file(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(content_length),
            },
        )

    return FileResponse(output_path, media_type="video/mp4")


@router.get("/browse_dir")
async def browse_directory(path: Optional[str] = Query(None)):
    """浏览本地目录结构（用于选择导出路径）"""
    if not path:
        path = os.path.expanduser("~")

    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="路径不存在")

    if not os.path.isdir(path):
        raise HTTPException(status_code=400, detail="不是目录")

    items = []
    try:
        for name in sorted(os.listdir(path)):
            full_path = os.path.join(path, name)
            if name.startswith("."):
                continue  # 跳过隐藏文件
            if os.path.isdir(full_path):
                items.append({
                    "name": name,
                    "path": full_path,
                    "is_dir": True,
                })
    except PermissionError:
        raise HTTPException(status_code=403, detail="没有访问权限")

    return {
        "current_path": path,
        "parent_path": os.path.dirname(path),
        "items": items,
    }

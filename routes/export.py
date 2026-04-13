"""导出 API 路由 — 批量导出镜头 MP4（支持选择本地目录导出）"""
import os
import shutil
import asyncio
import subprocess
import tempfile
import zipfile
import threading
from urllib.parse import quote
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import List, Optional

from services.project_manager import (
    get_active_project_id,
    load_project_data,
    get_project_dir,
)

router = APIRouter()

# ── 记住上次选择的导出目录 ─────────────────────────────────────
_last_export_dir: Optional[str] = None

# ── FFmpeg 自动发现 ──────────────────────────────────────────────
_FFMPEG_SEARCH_PATHS = [
    r"D:\Ae Plug-ins Suite\Scripts\ScriptUI Panels",
    r"C:\ffmpeg\bin",
    r"C:\Program Files\ffmpeg\bin",
    r"C:\Program Files (x86)\ffmpeg\bin",
    os.path.expanduser(r"~\ffmpeg\bin"),
]


def _find_ffmpeg() -> str:
    """
    返回可用的 ffmpeg 可执行文件路径。
    优先使用系统 PATH 中的 ffmpeg，找不到则搜索常见安装路径。
    """
    # 1. 系统 PATH 中已有
    found = shutil.which("ffmpeg")
    if found:
        return found

    # 2. 搜索常见路径
    for search_dir in _FFMPEG_SEARCH_PATHS:
        candidate = os.path.join(search_dir, "ffmpeg.exe")
        if os.path.isfile(candidate):
            # 将该目录加入当前进程的 PATH，后续调用就不用再搜了
            os.environ["PATH"] = os.environ.get("PATH", "") + os.pathsep + search_dir
            return candidate

    return ""


class ExportDownloadRequest(BaseModel):
    shot_ids: List[str]


class ExportToDirRequest(BaseModel):
    shot_ids: List[str]
    output_dir: str


# ── 选择导出目录（系统文件夹选择对话框）──────────────────────
@router.get("/select_export_dir")
async def select_export_dir():
    """
    弹出系统原生文件夹选择对话框，返回用户选择的目录路径。
    在线程中执行以避免阻塞事件循环。
    """
    global _last_export_dir

    def _pick_folder() -> str:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()                    # 隐藏主窗口
        root.attributes("-topmost", True)  # 置顶，防止对话框被浏览器遮住
        root.update()

        initial_dir = _last_export_dir if _last_export_dir and os.path.isdir(_last_export_dir) else os.path.expanduser("~")

        selected = filedialog.askdirectory(
            title="选择导出保存目录",
            initialdir=initial_dir,
        )
        root.destroy()
        return selected or ""

    loop = asyncio.get_event_loop()
    path = await loop.run_in_executor(None, _pick_folder)

    if not path:
        raise HTTPException(status_code=400, detail="用户取消了目录选择")

    _last_export_dir = path
    return {"path": path}


# ── 获取上次选择的导出目录 ─────────────────────────────────────
@router.get("/last_export_dir")
async def last_export_dir():
    """返回上次选择的导出目录（如果存在且有效）"""
    if _last_export_dir and os.path.isdir(_last_export_dir):
        return {"path": _last_export_dir}
    return {"path": ""}


# ── 导出到指定本地目录 ─────────────────────────────────────────
@router.post("/export_to_dir")
async def export_to_dir(req: ExportToDirRequest):
    """
    批量导出镜头到用户指定的本地目录，直接写入文件。
    """
    global _last_export_dir

    pid = get_active_project_id()
    if not pid:
        raise HTTPException(status_code=400, detail="没有活跃项目")

    project_data = load_project_data(pid)
    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    output_dir = req.output_dir
    if not os.path.isdir(output_dir):
        try:
            os.makedirs(output_dir, exist_ok=True)
        except OSError as e:
            raise HTTPException(status_code=400, detail=f"无法创建目录: {e}")

    _last_export_dir = output_dir

    shots_map = {}
    for shot in project_data.get("shots", []):
        if shot["id"] in req.shot_ids:
            shots_map[shot["id"]] = shot

    proj_dir = get_project_dir(pid)
    shots_dir = os.path.join(proj_dir, "shots")

    results = []
    success_count = 0

    for shot_id in req.shot_ids:
        shot = shots_map.get(shot_id)
        if not shot:
            results.append({"shot_id": shot_id, "error": "镜头不存在"})
            continue

        result = await _export_shot_to_dir(shot, output_dir, shots_dir)
        results.append(result)
        if "path" in result:
            success_count += 1

    if success_count == 0:
        error_msgs = [r.get("error", "未知错误") for r in results if "error" in r]
        raise HTTPException(status_code=400, detail=f"导出失败: {'; '.join(error_msgs)}")

    return {
        "success": True,
        "total": len(req.shot_ids),
        "exported": success_count,
        "output_dir": output_dir,
        "results": results,
    }


async def _export_shot_to_dir(shot: dict, output_dir: str, shots_dir: str) -> dict:
    """将单个镜头导出到指定目录，返回结果信息"""
    shot_id = shot["id"]
    video_path = shot.get("source_video")
    has_source = video_path and os.path.exists(video_path)

    clip_file = shot.get("clip_file", "")
    clip_path = os.path.join(shots_dir, clip_file) if clip_file else ""
    has_clip = clip_file and os.path.exists(clip_path)

    if not has_source and not has_clip:
        return {"shot_id": shot_id, "error": "源视频文件不存在"}

    # 输出文件名：视频名_时间码
    source_name = os.path.splitext(os.path.basename(video_path or "clip"))[0]
    timecode_safe = shot.get("timecode_display", shot_id).replace(":", "-")
    output_filename = f"{source_name}_{timecode_safe}.mp4"
    output_path = os.path.join(output_dir, output_filename)

    # 避免文件名冲突
    counter = 1
    base_name = f"{source_name}_{timecode_safe}"
    while os.path.exists(output_path):
        output_filename = f"{base_name}_{counter}.mp4"
        output_path = os.path.join(output_dir, output_filename)
        counter += 1

    try:
        if has_source:
            # 自动查找 FFmpeg
            ffmpeg_bin = _find_ffmpeg()
            if not ffmpeg_bin:
                return {"shot_id": shot_id, "error": "FFmpeg 未安装或不在系统 PATH 中，无法导出视频。请安装 FFmpeg 后重试。"}

            start_time = shot["start_time"]
            duration = shot["duration"]
            safe_start = max(0, start_time - 5)
            offset = round(start_time - safe_start, 6)

            cmd = [
                ffmpeg_bin, "-y",
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

            # 使用 subprocess.run 在线程池中执行，避免 Windows asyncio 子进程兼容性问题
            def _run_ffmpeg():
                return subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )

            result = await asyncio.get_event_loop().run_in_executor(None, _run_ffmpeg)

            if result.returncode == 0:
                return {"shot_id": shot_id, "filename": output_filename, "path": output_path}
            else:
                return {"shot_id": shot_id, "error": f"FFmpeg 错误: {result.stderr.decode(errors='replace')[:200]}"}
        else:
            shutil.copy2(clip_path, output_path)
            return {"shot_id": shot_id, "filename": output_filename, "path": output_path}

    except FileNotFoundError:
        return {"shot_id": shot_id, "error": "FFmpeg 未安装或不在系统 PATH 中，无法导出视频。请安装 FFmpeg 后重试。"}
    except PermissionError as e:
        return {"shot_id": shot_id, "error": f"文件权限错误: {e}"}
    except OSError as e:
        return {"shot_id": shot_id, "error": f"文件系统错误: {e}"}
    except Exception as e:
        return {"shot_id": shot_id, "error": f"导出异常: {type(e).__name__}: {e}"}


@router.post("/export_download")
async def export_download(req: ExportDownloadRequest):
    """
    批量导出镜头 — 浏览器下载方式。
    单个镜头直接返回 MP4 文件，多个镜头打包为 ZIP。
    """
    pid = get_active_project_id()
    if not pid:
        raise HTTPException(status_code=400, detail="没有活跃项目")

    project_data = load_project_data(pid)
    if not project_data:
        raise HTTPException(status_code=404, detail="项目数据不存在")

    # 查找所有指定的镜头
    shots_map = {}
    for shot in project_data.get("shots", []):
        if shot["id"] in req.shot_ids:
            shots_map[shot["id"]] = shot

    proj_dir = get_project_dir(pid)
    shots_dir = os.path.join(proj_dir, "shots")

    # 创建临时目录存放导出文件
    tmp_dir = tempfile.mkdtemp(prefix="export_")

    try:
        results = []
        exported_files = []

        for shot_id in req.shot_ids:
            shot = shots_map.get(shot_id)
            if not shot:
                results.append({"shot_id": shot_id, "error": "镜头不存在"})
                continue

            result = await _export_shot_to_dir(shot, tmp_dir, shots_dir)
            results.append(result)
            if "path" in result:
                exported_files.append(result)

        if not exported_files:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            error_msgs = [r.get("error", "未知错误") for r in results if "error" in r]
            raise HTTPException(status_code=400, detail=f"导出失败: {'; '.join(error_msgs)}")

        # 单个文件 → 直接返回 MP4
        if len(exported_files) == 1:
            file_path = exported_files[0]["path"]
            filename = exported_files[0]["filename"]

            async def cleanup_single():
                """读取文件后清理临时目录"""
                try:
                    with open(file_path, "rb") as f:
                        while True:
                            chunk = f.read(65536)
                            if not chunk:
                                break
                            yield chunk
                finally:
                    shutil.rmtree(tmp_dir, ignore_errors=True)

            return StreamingResponse(
                cleanup_single(),
                media_type="video/mp4",
                headers={
                    "Content-Disposition": f"attachment; filename=\"{quote(filename)}\"; filename*=UTF-8''{quote(filename)}",
                    "Content-Length": str(os.path.getsize(file_path)),
                },
            )

        # 多个文件 → 打包为 ZIP
        zip_path = os.path.join(tmp_dir, "导出镜头.zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
            for item in exported_files:
                zf.write(item["path"], item["filename"])

        async def cleanup_zip():
            """流式返回 ZIP 后清理"""
            try:
                with open(zip_path, "rb") as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        yield chunk
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)

        return StreamingResponse(
            cleanup_zip(),
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="exported_shots.zip"',
                "Content-Length": str(os.path.getsize(zip_path)),
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"导出失败: {e}")

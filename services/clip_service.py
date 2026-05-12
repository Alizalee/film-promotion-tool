"""FFmpeg 裁剪服务 — 统一的视频裁剪逻辑"""
import os
import shutil
import asyncio
import subprocess
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# ── FFmpeg 自动发现 ──────────────────────────────────────────────
_FFMPEG_SEARCH_PATHS = [
    r"D:\Ae Plug-ins Suite\Scripts\ScriptUI Panels",
    r"C:\ffmpeg\bin",
    r"C:\Program Files\ffmpeg\bin",
    r"C:\Program Files (x86)\ffmpeg\bin",
    os.path.expanduser(r"~\ffmpeg\bin"),
]


def find_ffmpeg() -> str:
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
            os.environ["PATH"] = os.environ.get("PATH", "") + os.pathsep + search_dir
            return candidate

    return ""


async def clip_video_segment(
    video_path: str,
    output_path: str,
    start_time: float,
    duration: float,
    ffmpeg_bin: Optional[str] = None,
) -> tuple[bool, str]:
    """
    使用双 -ss 精确裁剪策略从视频中裁剪片段。

    Args:
        video_path: 源视频路径
        output_path: 输出文件路径
        start_time: 开始时间（秒）
        duration: 持续时间（秒）
        ffmpeg_bin: FFmpeg 可执行文件路径（None 时自动查找）

    Returns:
        (success, error_message) — 成功时 error_message 为空字符串
    """
    if not ffmpeg_bin:
        ffmpeg_bin = find_ffmpeg()
    if not ffmpeg_bin:
        ffmpeg_bin = "ffmpeg"  # 回退到 PATH 中的 ffmpeg

    # 双 -ss 精确裁剪策略
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

    try:
        def _run_ffmpeg():
            return subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

        result = await asyncio.get_event_loop().run_in_executor(None, _run_ffmpeg)

        if result.returncode == 0 and os.path.exists(output_path):
            return True, ""
        else:
            err_msg = result.stderr.decode(errors="replace")[:200]
            return False, err_msg
    except FileNotFoundError:
        return False, "FFmpeg 未安装或不在系统 PATH 中"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


async def clip_single_shot(shot: dict, proj_dir: str) -> bool:
    """
    为单个镜头预裁剪独立 MP4 文件。
    裁剪后的文件保存在项目 shots/ 目录下，并更新镜头的 clip_file 字段。

    Returns:
        True 表示成功（或已有缓存），False 表示失败
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

    success, err_msg = await clip_video_segment(
        video_path=video_path,
        output_path=clip_path,
        start_time=start_time,
        duration=duration,
    )

    if success:
        shot["clip_file"] = clip_filename
        logger.info(f"预裁剪镜头: {shot['id']} → {clip_filename}")
        return True
    else:
        logger.warning(f"预裁剪失败: {shot['id']}: {err_msg}")
        return False


async def pre_clip_favorite_shots(shots: list, proj_dir: str):
    """
    为收藏镜头批量预裁剪独立 MP4 文件（在源视频删除前调用）。
    裁剪后的文件保存在项目 shots/ 目录下，并更新镜头的 clip_file 字段。
    """
    for shot in shots:
        if not shot.get("favorite"):
            continue
        await clip_single_shot(shot, proj_dir)

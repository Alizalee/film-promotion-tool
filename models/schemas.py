"""Pydantic 请求/响应模型"""
from pydantic import BaseModel
from typing import Optional


# ─── 项目管理 ───

class ProjectCreateRequest(BaseModel):
    name: str
    description: Optional[str] = ""


class ProjectSwitchRequest(BaseModel):
    project_id: str


class ProjectRenameRequest(BaseModel):
    project_id: str
    name: str
    description: Optional[str] = None


class ProjectDeleteRequest(BaseModel):
    project_id: str


# ─── 视频分析 ───

class AnalyzeRequest(BaseModel):
    video_path: str
    threshold: Optional[int] = None


class AnalyzeAppendRequest(BaseModel):
    video_path: str
    threshold: Optional[int] = None


# ─── 镜头操作 ───

class FavoriteRequest(BaseModel):
    shot_id: str
    favorite: bool


class TrimShotRequest(BaseModel):
    shot_id: str
    new_start: float
    new_end: float


class SaveFrameRequest(BaseModel):
    shot_id: str


class SaveCustomFrameRequest(BaseModel):
    shot_id: str
    time_offset: float


class MergeShotsRequest(BaseModel):
    shot_id_a: str
    shot_id_b: str


class SplitShotRequest(BaseModel):
    shot_id: str
    split_time: float  # 拆分时间点（源视频绝对时间）


# ─── 导出 ───

class ExportShotsRequest(BaseModel):
    shot_ids: list[str]
    output_dir: str


# ─── 视频管理 ───

class VideoDeleteRequest(BaseModel):
    video_path: str
    keep_favorites: bool = True  # 是否保留已收藏片段（裁剪后放入"其他片段"）


class ReanalyzeRequest(BaseModel):
    threshold: Optional[int] = None


class BatchAnalyzeRequest(BaseModel):
    video_paths: list[str]
    threshold: Optional[int] = None


class BatchDeleteShotsRequest(BaseModel):
    shot_ids: list[str]

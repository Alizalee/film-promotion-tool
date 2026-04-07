"""项目数据管理服务 — 负责 JSON 数据的加载、保存、迁移"""
import os
import json
import uuid
import numpy as np
from datetime import datetime
from typing import Optional


class _NumpyEncoder(json.JSONEncoder):
    """自定义 JSON 编码器，处理 numpy 类型"""
    def default(self, obj):
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, (np.bool_,)):
            return bool(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)

from models.constants import WORKSPACE_DIR, PROJECTS_DIR, PROJECTS_INDEX


def _now_str() -> str:
    """返回当前时间字符串"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _gen_project_id() -> str:
    """生成项目 ID"""
    return f"proj_{uuid.uuid4().hex[:8]}"


def load_projects_index() -> dict:
    """加载项目索引"""
    if os.path.exists(PROJECTS_INDEX):
        with open(PROJECTS_INDEX, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"projects": [], "active_project_id": None}


def save_projects_index(data: dict):
    """保存项目索引"""
    with open(PROJECTS_INDEX, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_project_dir(project_id: str) -> str:
    """获取项目目录路径"""
    return os.path.join(PROJECTS_DIR, project_id)


def load_project_data(project_id: str) -> Optional[dict]:
    """加载某个项目的完整数据"""
    proj_dir = get_project_dir(project_id)
    data_file = os.path.join(proj_dir, "project.json")
    if os.path.exists(data_file):
        with open(data_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def save_project_data(project_id: str, data: dict):
    """保存项目数据"""
    proj_dir = get_project_dir(project_id)
    os.makedirs(proj_dir, exist_ok=True)
    data_file = os.path.join(proj_dir, "project.json")
    with open(data_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, cls=_NumpyEncoder)


def create_project(name: str, description: str = "") -> dict:
    """创建新项目，返回 ProjectInfo"""
    project_id = _gen_project_id()
    now = _now_str()

    # 创建项目目录结构
    proj_dir = get_project_dir(project_id)
    for sub in ["frames", "shots", "saved_frames"]:
        os.makedirs(os.path.join(proj_dir, sub), exist_ok=True)

    # 初始化项目数据
    project_data = {
        "video_path": None,
        "video_paths": [],
        "shots": [],
        "fps": 0,
        "total_frames": 0,
    }
    save_project_data(project_id, project_data)

    # 项目信息
    project_info = {
        "id": project_id,
        "name": name,
        "description": description,
        "created_at": now,
        "updated_at": now,
        "shot_count": 0,
        "video_count": 0,
    }

    # 更新索引
    index = load_projects_index()
    index["projects"].append(project_info)
    index["active_project_id"] = project_id
    save_projects_index(index)

    return project_info


def get_active_project_id() -> Optional[str]:
    """获取当前活跃项目 ID"""
    index = load_projects_index()
    return index.get("active_project_id")


def update_project_info(project_id: str, **kwargs):
    """更新项目索引中的项目信息"""
    index = load_projects_index()
    for proj in index["projects"]:
        if proj["id"] == project_id:
            proj.update(kwargs)
            proj["updated_at"] = _now_str()
            break
    save_projects_index(index)

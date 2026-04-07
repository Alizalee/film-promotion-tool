"""项目管理 API 路由 — 完整实现"""
import os
import shutil
from fastapi import APIRouter, HTTPException

from models.schemas import (
    ProjectCreateRequest,
    ProjectSwitchRequest,
    ProjectRenameRequest,
    ProjectDeleteRequest,
)
from services.project_manager import (
    load_projects_index,
    save_projects_index,
    load_project_data,
    create_project,
    get_project_dir,
    get_active_project_id,
    update_project_info,
)

router = APIRouter()


@router.get("/projects")
async def get_projects():
    """获取所有项目列表"""
    index = load_projects_index()
    return {
        "projects": index.get("projects", []),
        "active_project_id": index.get("active_project_id"),
    }


@router.post("/projects/create")
async def create_project_api(req: ProjectCreateRequest):
    """创建新项目"""
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="项目名称不能为空")

    project_info = create_project(req.name.strip(), req.description or "")
    return {"success": True, "project": project_info}


@router.post("/projects/switch")
async def switch_project(req: ProjectSwitchRequest):
    """切换活跃项目"""
    index = load_projects_index()
    project_ids = [p["id"] for p in index["projects"]]

    if req.project_id not in project_ids:
        raise HTTPException(status_code=404, detail="项目不存在")

    index["active_project_id"] = req.project_id
    save_projects_index(index)

    return {"success": True, "active_project_id": req.project_id}


@router.post("/projects/rename")
async def rename_project(req: ProjectRenameRequest):
    """重命名项目"""
    index = load_projects_index()
    target = None
    for proj in index["projects"]:
        if proj["id"] == req.project_id:
            target = proj
            break

    if target is None:
        raise HTTPException(status_code=404, detail="项目不存在")

    if not req.name.strip():
        raise HTTPException(status_code=400, detail="项目名称不能为空")

    target["name"] = req.name.strip()
    if req.description is not None:
        target["description"] = req.description

    from datetime import datetime
    target["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    save_projects_index(index)

    return {"success": True, "project": target}


@router.post("/projects/delete")
async def delete_project(req: ProjectDeleteRequest):
    """删除项目（含清理关联的上传视频文件）"""
    index = load_projects_index()
    project_ids = [p["id"] for p in index["projects"]]

    if req.project_id not in project_ids:
        raise HTTPException(status_code=404, detail="项目不存在")

    # 先读取项目数据，获取关联视频路径
    project_data = load_project_data(req.project_id)
    video_paths_to_clean = []
    if project_data:
        from models.constants import UPLOADS_DIR
        uploads_norm = os.path.normpath(os.path.abspath(UPLOADS_DIR)) + os.sep
        for vpath in project_data.get("video_paths", []):
            # 只清理 workspace/uploads 目录下的文件
            if vpath and os.path.normpath(os.path.abspath(vpath)).startswith(uploads_norm) and os.path.exists(vpath):
                video_paths_to_clean.append(vpath)

    # 删除项目目录（帧、saved_frames 等）
    proj_dir = get_project_dir(req.project_id)
    if os.path.exists(proj_dir):
        shutil.rmtree(proj_dir)

    # 清理关联的上传视频文件
    for vpath in video_paths_to_clean:
        try:
            os.remove(vpath)
        except Exception:
            pass

    # 从索引中移除
    index["projects"] = [p for p in index["projects"] if p["id"] != req.project_id]

    # 如果删除的是当前活跃项目，切换到第一个或设为 null
    if index["active_project_id"] == req.project_id:
        if index["projects"]:
            index["active_project_id"] = index["projects"][0]["id"]
        else:
            index["active_project_id"] = None

    save_projects_index(index)

    return {"success": True, "active_project_id": index["active_project_id"]}


@router.get("/project_info")
async def get_project_info():
    """获取当前活跃项目的详细信息"""
    index = load_projects_index()
    active_id = index.get("active_project_id")

    if not active_id:
        return {
            "video_path": None,
            "video_paths": [],
            "total_shots": 0,
            "fps": 0,
            "active_project": None,
            "active_project_id": None,
            "has_projects": len(index.get("projects", [])) > 0,
        }

    # 找到活跃项目信息
    active_project = None
    for proj in index["projects"]:
        if proj["id"] == active_id:
            active_project = proj
            break

    # 加载项目数据
    project_data = load_project_data(active_id)
    if project_data is None:
        project_data = {"video_path": None, "video_paths": [], "shots": [], "fps": 0}

    return {
        "video_path": project_data.get("video_path"),
        "video_paths": project_data.get("video_paths", []),
        "total_shots": len(project_data.get("shots", [])),
        "fps": project_data.get("fps", 0),
        "active_project": active_project,
        "active_project_id": active_id,
        "has_projects": True,
    }

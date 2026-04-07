"""
影视剧宣发拉片工具 — FastAPI 后端入口
"""
import os
import sys

# 确保项目根目录在 sys.path 中
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from models.constants import STATIC_DIR, WORKSPACE_DIR, UPLOADS_DIR, PROJECTS_DIR

# 确保工作空间目录存在
for d in [WORKSPACE_DIR, UPLOADS_DIR, PROJECTS_DIR]:
    os.makedirs(d, exist_ok=True)

# 创建 FastAPI 应用
app = FastAPI(title="影视剧宣发拉片工具", version="2.0")

# ─── 注册路由 ───
from routes.projects import router as projects_router
from routes.videos import router as videos_router
from routes.shots import router as shots_router
from routes.files import router as files_router
from routes.export import router as export_router

app.include_router(projects_router, prefix="/api", tags=["项目管理"])
app.include_router(videos_router, prefix="/api", tags=["视频分析与管理"])
app.include_router(shots_router, prefix="/api", tags=["镜头数据"])
app.include_router(files_router, prefix="/api", tags=["文件服务"])
app.include_router(export_router, prefix="/api", tags=["导出"])

# ─── 静态文件服务 ───
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ─── 前端入口 ───
@app.get("/")
async def serve_frontend():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)

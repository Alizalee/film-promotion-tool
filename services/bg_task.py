"""后台任务管理服务 — 线程控制、取消机制、状态管理"""
import threading
from typing import Optional


# ── 分析取消机制 ──
_cancel_flag = threading.Event()

# ── 后台任务状态 ──
_bg_task_status = {
    "running": False,
    "stage": "idle",      # idle | splitting | analyzing | done
    "progress": 0,        # 进度百分比 0-100
    "project_id": None,
    "current_video": "",   # 当前正在拆分的视频文件名
    "split_queue": 0,      # 拆分队列剩余数
    "split_done": 0,       # 已完成拆分的视频数
    "analyzed_count": 0,   # 已分析完成的镜头数
    "total_count": 0,      # 镜头总数
}
_bg_task_lock = threading.Lock()
_bg_task_thread: Optional[threading.Thread] = None  # 当前后台线程引用


def stop_running_bg_task(timeout: float = 30):
    """
    如果有后台任务正在运行，取消它并等待线程退出。
    确保新任务启动前不会与旧任务产生竞争。
    """
    global _bg_task_thread
    with _bg_task_lock:
        is_running = _bg_task_status["running"]
    if is_running and _bg_task_thread and _bg_task_thread.is_alive():
        _cancel_flag.set()
        _bg_task_thread.join(timeout=timeout)
        # join 后重置
        _cancel_flag.clear()
    _bg_task_thread = None


def is_cancelled() -> bool:
    """检查是否已请求取消"""
    return _cancel_flag.is_set()


def set_cancel():
    """设置取消标志"""
    _cancel_flag.set()


def clear_cancel():
    """清除取消标志"""
    _cancel_flag.clear()


def update_status(stage: str, progress: int = 0, running: bool = True,
                  project_id: str = None, current_video: str = None,
                  split_queue: int = None, split_done: int = None,
                  analyzed_count: int = None, total_count: int = None):
    """线程安全地更新后台任务状态"""
    with _bg_task_lock:
        _bg_task_status["stage"] = stage
        _bg_task_status["progress"] = progress
        _bg_task_status["running"] = running
        if project_id is not None:
            _bg_task_status["project_id"] = project_id
        if current_video is not None:
            _bg_task_status["current_video"] = current_video
        if split_queue is not None:
            _bg_task_status["split_queue"] = split_queue
        if split_done is not None:
            _bg_task_status["split_done"] = split_done
        if analyzed_count is not None:
            _bg_task_status["analyzed_count"] = analyzed_count
        if total_count is not None:
            _bg_task_status["total_count"] = total_count


def get_status() -> dict:
    """线程安全地读取后台任务状态副本"""
    with _bg_task_lock:
        return dict(_bg_task_status)


def set_thread(thread: Optional[threading.Thread]):
    """设置当前后台线程引用"""
    global _bg_task_thread
    _bg_task_thread = thread


def get_thread() -> Optional[threading.Thread]:
    """获取当前后台线程引用"""
    return _bg_task_thread

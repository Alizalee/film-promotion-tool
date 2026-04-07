/* ═══════════════════════════════════════════════════
   工具函数 — Toast、时间格式化、DOM 辅助
   ═══════════════════════════════════════════════════ */

/**
 * Toast 通知
 */
function showToast(message, type = '') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type ? 'toast-' + type : ''}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 200);
    }, 3000);
}

/**
 * 秒数 → 显示时间码 HH:MM:SS:FF
 */
function secondsToTimecode(seconds, frameRate = 24) {
    if (!seconds || seconds < 0) seconds = 0;
    const totalFrames = Math.round(seconds * frameRate);
    const h = Math.floor(totalFrames / (frameRate * 3600));
    const m = Math.floor((totalFrames % (frameRate * 3600)) / (frameRate * 60));
    const s = Math.floor((totalFrames % (frameRate * 60)) / frameRate);
    const f = totalFrames % frameRate;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

/**
 * 秒数 → 简洁时长 (如 "2.3s", "1m12s")
 */
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    if (seconds < 60) {
        return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
    }
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/**
 * 顶部进度条
 */
function showProgress(percent) {
    const bar = document.getElementById('topProgressBar');
    bar.classList.remove('hidden');
    bar.style.width = `${percent}%`;
    bar.style.opacity = '1';
}

function hideProgress() {
    const bar = document.getElementById('topProgressBar');
    bar.style.width = '100%';
    setTimeout(() => {
        bar.style.opacity = '0';
        setTimeout(() => {
            bar.classList.add('hidden');
            bar.style.width = '0%';
        }, 300);
    }, 200);
}

/**
 * 创建确认弹窗
 */
function showConfirm(title, message, confirmText, onConfirm, isDanger = false) {
    // 移除已有弹窗
    const existing = document.querySelector('.modal-overlay.confirm-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-overlay';
    overlay.innerHTML = `
        <div class="modal-box confirm-modal">
            <h3>${title}</h3>
            <p>${message}</p>
            <div class="form-actions">
                <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
                <button class="${isDanger ? 'btn-danger' : 'btn-primary'}" id="confirmBtn">${confirmText}</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    // 确认按钮
    overlay.querySelector('#confirmBtn').addEventListener('click', () => {
        overlay.remove();
        onConfirm();
    });

    // ESC 关闭
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

/**
 * 获取帧图片 URL
 */
function getFrameUrl(frameFile) {
    return `/api/frames/${encodeURIComponent(frameFile)}`;
}

/**
 * 获取视频流 URL
 */
function getVideoUrl(sourcePath) {
    if (sourcePath) {
        return `/api/video?source=${encodeURIComponent(sourcePath)}`;
    }
    return '/api/video';
}

/**
 * 文件大小格式化
 */
function formatFileSize(mb) {
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb} MB`;
}

/**
 * 防抖
 */
function debounce(fn, delay) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

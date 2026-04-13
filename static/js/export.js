/* ═══════════════════════════════════════════════════
   导出 — 批量导出镜头（选择本地目录保存）
   ═══════════════════════════════════════════════════ */

/** 当前选中的导出目录 */
let _exportDir = '';

/**
 * 打开导出面板
 */
function openExportPanel() {
    if (selectedShots.size === 0) {
        showToast('请先选择要导出的镜头', 'error');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'exportOverlay';

    const count = selectedShots.size;

    overlay.innerHTML = `
        <div class="modal-box export-panel">
            <h3>导出镜头</h3>
            <div class="export-info">
                已选择 <strong>${count}</strong> 个镜头（高画质精确裁剪）
            </div>

            <!-- 保存目录选择 -->
            <div class="export-dir-section">
                <div class="export-dir-label">保存到</div>
                <div class="export-dir-row">
                    <div class="export-dir-display" id="exportDirDisplay" title="点击选择目录">
                        <span class="export-dir-icon">📁</span>
                        <span class="export-dir-path" id="exportDirPath">点击选择保存目录…</span>
                    </div>
                    <button class="btn-secondary export-dir-btn" id="selectDirBtn" onclick="selectExportDir()">选择目录</button>
                </div>
            </div>

            <div class="export-progress hidden" id="exportProgress">
                <div class="export-progress-bar">
                    <div class="export-progress-fill" id="exportProgressFill" style="width:0%"></div>
                </div>
                <div class="export-progress-text" id="exportProgressText">准备中…</div>
            </div>
            <div class="export-actions">
                <button class="btn-secondary" onclick="closeExportPanel()">取消</button>
                <button class="btn-primary" id="exportBtn" onclick="doExport()" disabled>导出 ${count} 个镜头</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeExportPanel();
    });

    // 尝试加载上次选择的目录
    _loadLastExportDir();
}

/**
 * 加载上次选择的导出目录
 */
async function _loadLastExportDir() {
    try {
        const res = await fetch('/api/last_export_dir');
        if (res.ok) {
            const data = await res.json();
            if (data.path) {
                _setExportDir(data.path);
            }
        }
    } catch (_) {
        // 忽略
    }
}

/**
 * 设置导出目录并更新 UI
 */
function _setExportDir(path) {
    _exportDir = path;
    const pathEl = document.getElementById('exportDirPath');
    const exportBtn = document.getElementById('exportBtn');

    if (pathEl) {
        if (path) {
            pathEl.textContent = path;
            pathEl.parentElement.classList.add('has-path');
        } else {
            pathEl.textContent = '点击选择保存目录…';
            pathEl.parentElement.classList.remove('has-path');
        }
    }
    if (exportBtn) {
        exportBtn.disabled = !path;
    }
}

/**
 * 点击选择导出目录
 */
async function selectExportDir() {
    const btn = document.getElementById('selectDirBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '选择中…';
    }

    try {
        const res = await fetch('/api/select_export_dir');
        if (res.ok) {
            const data = await res.json();
            if (data.path) {
                _setExportDir(data.path);
                showToast('已选择目录: ' + _shortenPath(data.path), 'success');
            }
        } else {
            let errMsg = '选择目录失败';
            try {
                const err = await res.json();
                if (err.detail) errMsg = err.detail;
            } catch (_) {}
            // 用户取消选择不提示错误
            if (!errMsg.includes('取消')) {
                showToast(errMsg, 'error');
            }
        }
    } catch (err) {
        showToast('选择目录失败: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '选择目录';
        }
    }
}

/**
 * 缩短路径显示（超长路径只显示首尾）
 */
function _shortenPath(p) {
    if (p.length <= 40) return p;
    const parts = p.replace(/\\/g, '/').split('/');
    if (parts.length <= 3) return p;
    return parts[0] + '/…/' + parts.slice(-2).join('/');
}

/**
 * 关闭导出面板
 */
function closeExportPanel() {
    const overlay = document.getElementById('exportOverlay');
    if (overlay) overlay.remove();
}

/**
 * 执行导出 — 调用后端直接写入指定目录
 */
async function doExport() {
    if (!_exportDir) {
        showToast('请先选择保存目录', 'error');
        return;
    }

    const shotIds = Array.from(selectedShots);

    // 显示进度
    document.getElementById('exportProgress').classList.remove('hidden');
    document.getElementById('exportBtn').disabled = true;
    document.getElementById('selectDirBtn').disabled = true;

    try {
        document.getElementById('exportProgressText').textContent = `正在导出 ${shotIds.length} 个镜头…`;
        document.getElementById('exportProgressFill').style.width = '30%';

        const res = await fetch('/api/export_to_dir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shot_ids: shotIds, output_dir: _exportDir }),
        });

        if (!res.ok) {
            let errMsg = `导出失败 (HTTP ${res.status})`;
            try {
                const err = await res.json();
                if (err.detail) errMsg = err.detail;
            } catch (_) {
                try {
                    const text = await res.text();
                    if (text && text.length < 200) errMsg = text;
                } catch (__) { /* ignore */ }
            }
            throw new Error(errMsg);
        }

        const data = await res.json();

        document.getElementById('exportProgressFill').style.width = '100%';
        document.getElementById('exportProgressText').textContent =
            `导出完成！${data.exported}/${data.total} 个镜头已保存到目录`;

        showToast(`成功导出 ${data.exported} 个镜头到 ${_shortenPath(_exportDir)}`, 'success');

        // 2 秒后关闭面板
        setTimeout(() => {
            closeExportPanel();
            toggleSelectMode();
        }, 2000);

    } catch (err) {
        showToast(`导出失败: ${err.message}`, 'error');
        document.getElementById('exportProgressText').textContent = '导出失败';
        document.getElementById('exportBtn').disabled = false;
        document.getElementById('selectDirBtn').disabled = false;
    }
}

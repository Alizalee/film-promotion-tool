/* ═══════════════════════════════════════════════════
   导出 — 批量导出面板
   ═══════════════════════════════════════════════════ */

let exportOutputDir = '';

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

    overlay.innerHTML = `
        <div class="modal-box export-panel">
            <h3>导出镜头</h3>
            <div class="export-path-row">
                <input type="text" id="exportPathInput" placeholder="选择导出目录" value="${exportOutputDir}">
                <button class="btn-secondary" onclick="browseExportDir()" style="height:36px;white-space:nowrap">浏览</button>
            </div>
            <div class="export-info">
                将导出 <strong>${selectedShots.size}</strong> 个镜头为 MP4 文件（高画质精确裁剪）
            </div>
            <div class="export-progress hidden" id="exportProgress">
                <div class="export-progress-bar">
                    <div class="export-progress-fill" id="exportProgressFill" style="width:0%"></div>
                </div>
                <div class="export-progress-text" id="exportProgressText">准备中…</div>
            </div>
            <div class="export-actions">
                <button class="btn-secondary" onclick="closeExportPanel()">取消</button>
                <button class="btn-primary" id="exportBtn" onclick="doExport()">导出 ${selectedShots.size} 个镜头</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeExportPanel();
    });
}

/**
 * 关闭导出面板
 */
function closeExportPanel() {
    const overlay = document.getElementById('exportOverlay');
    if (overlay) overlay.remove();
}

/**
 * 浏览目录
 */
async function browseExportDir() {
    try {
        const currentPath = document.getElementById('exportPathInput').value.trim();
        const data = await API.browseDir(currentPath || null);

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.zIndex = '5500';

        let html = `
            <div class="modal-box" style="width:400px;max-height:60vh;padding:var(--space-5)">
                <h3 style="font-size:15px;margin-bottom:12px">选择导出目录</h3>
                <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;word-break:break-all">${data.current_path}</div>
                <div style="max-height:300px;overflow-y:auto">
        `;

        if (data.parent_path && data.parent_path !== data.current_path) {
            html += `<div class="video-list-item" style="cursor:pointer" onclick="selectExportDir('${escapeHtml(data.parent_path)}', this)">📁 ..</div>`;
        }

        data.items.forEach(item => {
            if (item.is_dir) {
                html += `<div class="video-list-item" style="cursor:pointer" onclick="selectExportDir('${escapeHtml(item.path)}', this)">📁 ${escapeHtml(item.name)}</div>`;
            }
        });

        html += `
                </div>
                <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:16px">
                    <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
                    <button class="btn-primary" onclick="confirmExportDir('${escapeHtml(data.current_path)}');this.closest('.modal-overlay').remove()">选择此目录</button>
                </div>
            </div>
        `;

        overlay.innerHTML = html;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
    } catch (err) {
        showToast('无法浏览目录', 'error');
    }
}

function selectExportDir(path, el) {
    // 进入子目录
    el.closest('.modal-overlay').remove();
    document.getElementById('exportPathInput').value = path;
    exportOutputDir = path;
    browseExportDir();
}

function confirmExportDir(path) {
    document.getElementById('exportPathInput').value = path;
    exportOutputDir = path;
}

/**
 * 执行导出
 */
async function doExport() {
    const outputDir = document.getElementById('exportPathInput').value.trim();
    if (!outputDir) {
        showToast('请选择导出目录', 'error');
        return;
    }

    exportOutputDir = outputDir;
    const shotIds = Array.from(selectedShots);

    // 显示进度
    document.getElementById('exportProgress').classList.remove('hidden');
    document.getElementById('exportBtn').disabled = true;

    try {
        document.getElementById('exportProgressText').textContent = `正在导出 ${shotIds.length} 个镜头…`;
        document.getElementById('exportProgressFill').style.width = '50%';

        const result = await API.exportShots(shotIds, outputDir);

        document.getElementById('exportProgressFill').style.width = '100%';

        const successCount = result.exported.filter(r => !r.error).length;
        const failCount = result.exported.filter(r => r.error).length;

        if (failCount > 0) {
            document.getElementById('exportProgressText').textContent = `完成！成功 ${successCount}，失败 ${failCount}`;
            showToast(`导出完成：${successCount} 成功，${failCount} 失败`, 'error');
        } else {
            document.getElementById('exportProgressText').textContent = `全部导出成功！`;
            showToast(`成功导出 ${successCount} 个镜头到 ${outputDir}`, 'success');
        }

        // 3 秒后关闭面板
        setTimeout(() => {
            closeExportPanel();
            toggleSelectMode(); // 退出选择模式
        }, 2000);

    } catch (err) {
        showToast(`导出失败: ${err.message}`, 'error');
        document.getElementById('exportProgressText').textContent = '导出失败';
    }

    document.getElementById('exportBtn').disabled = false;
}

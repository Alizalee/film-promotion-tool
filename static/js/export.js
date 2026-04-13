/* ═══════════════════════════════════════════════════
   导出 — 批量导出面板（浏览器下载方式）
   ═══════════════════════════════════════════════════ */

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
    const fileHint = count === 1 ? '将直接下载 MP4 文件' : `将下载包含 ${count} 个 MP4 的 ZIP 压缩包`;

    overlay.innerHTML = `
        <div class="modal-box export-panel">
            <h3>导出镜头</h3>
            <div class="export-info">
                已选择 <strong>${count}</strong> 个镜头（高画质精确裁剪）
            </div>
            <div class="export-info" style="font-size:12px;color:var(--text-secondary);margin-top:4px">
                ${fileHint}，保存位置由浏览器决定
            </div>
            <div class="export-progress hidden" id="exportProgress">
                <div class="export-progress-bar">
                    <div class="export-progress-fill" id="exportProgressFill" style="width:0%"></div>
                </div>
                <div class="export-progress-text" id="exportProgressText">准备中…</div>
            </div>
            <div class="export-actions">
                <button class="btn-secondary" onclick="closeExportPanel()">取消</button>
                <button class="btn-primary" id="exportBtn" onclick="doExport()">导出 ${count} 个镜头</button>
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
 * 执行导出 — 请求后端生成文件，浏览器自动弹出保存对话框
 */
async function doExport() {
    const shotIds = Array.from(selectedShots);

    // 显示进度
    document.getElementById('exportProgress').classList.remove('hidden');
    document.getElementById('exportBtn').disabled = true;

    try {
        document.getElementById('exportProgressText').textContent = `正在导出 ${shotIds.length} 个镜头…`;
        document.getElementById('exportProgressFill').style.width = '30%';

        const res = await fetch('/api/export_download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shot_ids: shotIds }),
        });

        if (!res.ok) {
            let errMsg = `导出失败 (HTTP ${res.status})`;
            try {
                const err = await res.json();
                if (err.detail) errMsg = err.detail;
            } catch (_) {
                // 后端返回非 JSON（如 500 HTML 页面），尝试读取文本
                try {
                    const text = await res.text();
                    if (text && text.length < 200) errMsg = text;
                } catch (__) { /* ignore */ }
            }
            throw new Error(errMsg);
        }

        document.getElementById('exportProgressFill').style.width = '80%';
        document.getElementById('exportProgressText').textContent = '正在下载…';

        // 从响应头获取文件名（支持 RFC 5987 filename* 编码）
        const disposition = res.headers.get('Content-Disposition') || '';
        let filename = 'exported_shots.zip';
        const matchStar = disposition.match(/filename\*=UTF-8''([^;\s]+)/i);
        if (matchStar) {
            filename = decodeURIComponent(matchStar[1]);
        } else {
            const match = disposition.match(/filename="?([^"]+)"?/);
            if (match) {
                filename = decodeURIComponent(match[1]);
            }
        }

        // 将响应转为 Blob 并触发浏览器下载
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        document.getElementById('exportProgressFill').style.width = '100%';
        document.getElementById('exportProgressText').textContent = '导出完成！';
        showToast(`成功导出 ${shotIds.length} 个镜头`, 'success');

        // 2 秒后关闭面板
        setTimeout(() => {
            closeExportPanel();
            toggleSelectMode();
        }, 2000);

    } catch (err) {
        showToast(`导出失败: ${err.message}`, 'error');
        document.getElementById('exportProgressText').textContent = '导出失败';
    }

    document.getElementById('exportBtn').disabled = false;
}

/* ═══════════════════════════════════════════════════
   视频上传 — 拖拽上传 + 文件选择 + 分析
   ═══════════════════════════════════════════════════ */

// 取消标志（前端）
let _analysisCancelled = false;

/**
 * 取消分析
 */
async function cancelAnalyze() {
    _analysisCancelled = true;
    try {
        await API.cancelAnalyze();
        showToast('正在取消分析…');
    } catch (err) {
        console.error('取消分析失败:', err);
    }
}

/**
 * 初始化全屏拖拽上传
 */
function initDragDrop() {
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        if (dragCounter === 1) {
            document.getElementById('dragOverlay').classList.add('visible');
        }
    });

    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            document.getElementById('dragOverlay').classList.remove('visible');
        }
    });

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        document.getElementById('dragOverlay').classList.remove('visible');

        const files = Array.from(e.dataTransfer.files).filter(f => {
            const ext = f.name.toLowerCase().split('.').pop();
            return ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'].includes(ext);
        });

        if (files.length === 0) {
            showToast('请拖入视频文件（MP4、MOV 等格式）', 'error');
            return;
        }

        handleVideoFiles(files);
    });
}

/**
 * 触发文件选择
 */
function triggerFileSelect() {
    let input = document.getElementById('fileInput');
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'fileInput';
        input.accept = 'video/*';
        input.multiple = true;
        input.style.display = 'none';
        input.onchange = (e) => handleFileSelect(e);
        document.body.appendChild(input);
    }
    input.click();
}

/**
 * 处理文件选择事件
 */
function handleFileSelect(event) {
    const files = Array.from(event.target.files);
    if (files.length > 0) {
        handleVideoFiles(files);
    }
    event.target.value = ''; // 重置以允许重复选择同一文件
}

/**
 * 处理视频文件（上传 + 分析）
 * 上传前检查重复文件，允许用户选择跳过或继续上传。
 *
 * 优化策略：
 *   场景1 — 空项目单视频：同步分析第1个 → 进入主页 → 后台深度分析
 *   场景2 — 已有镜头新上传：主页面不动 → 全部后台拆分 → 自动追加
 *   场景3 — 空项目批量视频：同步分析第1个 → 进入主页 → 后台拆分剩余
 */
async function handleVideoFiles(files) {
    // 如果没有活跃项目，先创建一个
    if (!currentProjectId) {
        showToast('请先创建一个项目', 'error');
        showCreateProjectModal();
        return;
    }

    // ══════════════════════════════════════════
    // 预检：检查是否有重复文件名
    // ══════════════════════════════════════════
    const filenames = Array.from(files).map(f => f.name);
    let filesToUpload = Array.from(files);

    try {
        const dupResult = await API.checkDuplicateVideos(filenames);
        const duplicates = dupResult.duplicates || [];

        if (duplicates.length > 0) {
            // 弹出确认对话框，让用户选择
            const userChoice = await showDuplicateConfirm(duplicates, files.length);

            if (userChoice === 'cancel') {
                // 用户取消整个上传
                return;
            } else if (userChoice === 'skip') {
                // 跳过重复文件
                const dupSet = new Set(duplicates);
                filesToUpload = filesToUpload.filter(f => !dupSet.has(f.name));
                if (filesToUpload.length === 0) {
                    showToast('所有文件均已存在，已全部跳过', 'info');
                    return;
                }
                showToast(`已跳过 ${duplicates.length} 个重复文件`, 'info');
            }
            // userChoice === 'upload' → 继续上传全部（包括重复的）
        }
    } catch (err) {
        console.warn('检查重复文件失败，继续上传:', err);
    }

    _analysisCancelled = false;
    const isFirstEver = totalShots === 0; // 项目是否完全空白

    // ══════════════════════════════════════════
    // 阶段1: 逐个上传所有文件（收集服务端路径）
    // ══════════════════════════════════════════
    const uploadedPaths = [];

    if (isFirstEver) {
        // 空项目：显示全屏进度，上传所有文件
        isAnalyzing = true;
        for (let i = 0; i < filesToUpload.length; i++) {
            if (_analysisCancelled) break;
            const file = filesToUpload[i];

            const sizeMB = file.size / (1024 * 1024);
            const estSeconds = Math.max(5, Math.round(sizeMB * 0.15));
            showAnalyzeProgress(`正在上传 ${file.name}（${i + 1}/${filesToUpload.length}）…`, estSeconds);

            try {
                const result = await API.uploadVideo(file, (p) => {
                    showProgress(p * 0.3);
                });
                if (result.success) {
                    uploadedPaths.push(result.video_path);
                } else {
                    showToast(`上传 ${file.name} 失败`, 'error');
                }
            } catch (err) {
                showToast(`上传 ${file.name} 失败: ${err.message}`, 'error');
            }
        }
    } else {
        // 已有镜头：不遮挡主页面，用 Toast 提示上传进度
        for (let i = 0; i < filesToUpload.length; i++) {
            if (_analysisCancelled) break;
            const file = filesToUpload[i];

            showToast(`正在上传 ${file.name}（${i + 1}/${filesToUpload.length}）…`);

            try {
                const result = await API.uploadVideo(file);
                if (result.success) {
                    uploadedPaths.push(result.video_path);
                } else {
                    showToast(`上传 ${file.name} 失败`, 'error');
                }
            } catch (err) {
                showToast(`上传 ${file.name} 失败: ${err.message}`, 'error');
            }
        }
    }

    if (uploadedPaths.length === 0) {
        if (isFirstEver) {
            hideProgress();
            isAnalyzing = false;
        }
        return;
    }

    // ══════════════════════════════════════════
    // 阶段2: 根据场景决定同步/异步分析
    // ══════════════════════════════════════════
    if (isFirstEver) {
        // 场景1 & 3: 项目空白 → 同步分析第1个视频的镜头拆分，立即进入主页面
        const firstFile = filesToUpload[0];
        const sizeMB = firstFile.size / (1024 * 1024);
        const estSeconds = Math.max(5, Math.round(sizeMB * 0.15));
        showAnalyzeProgress(`正在分析 ${firstFile.name}…`, estSeconds);
        showProgress(50);

        try {
            const result = await API.analyze(uploadedPaths[0], threshold);

            if (result.cancelled || _analysisCancelled) {
                showToast('分析已取消', 'success');
                hideProgress();
                isAnalyzing = false;
                return;
            }

            if (result.success) {
                totalShots = result.total_shots || 0;
                fps = result.fps || fps;
                showProgress(100);
                hideProgress();
                isAnalyzing = false;

                // ✅ 立即进入主页面
                const projData = await API.getProjects();
                allProjects = projData.projects || [];
                await initProjectView();

                showToast(`${firstFile.name} 镜头拆分完成，检测到 ${result.total_shots || 0} 个镜头`, 'success');

                // 如果还有剩余视频 → 全部丢给后台批量分析
                if (uploadedPaths.length > 1) {
                    const remaining = uploadedPaths.slice(1);
                    // 先停止第1个视频的深度分析轮询，后端会自动取消旧任务
                    stopBgTaskPolling();
                    await API.analyzeBatchBg(remaining, threshold);
                    startBgTaskPolling();
                } else if (result.bg_analyzing) {
                    // 仅单个视频 → 后台深度分析
                    startBgTaskPolling();
                }
            } else {
                showToast(`分析 ${firstFile.name} 失败`, 'error');
                hideProgress();
                isAnalyzing = false;
            }
        } catch (err) {
            console.error('分析视频失败:', err);
            if (!_analysisCancelled) {
                showToast(`分析失败: ${err.message}`, 'error');
            }
            hideProgress();
            isAnalyzing = false;
        }
    } else {
        // 场景2: 已有镜头 → 全部视频丢后台，主页面不动
        showToast(`正在后台分析 ${uploadedPaths.length} 个视频…`);
        try {
            // 先停止旧的轮询，后端会自动取消旧任务
            stopBgTaskPolling();
            await API.analyzeBatchBg(uploadedPaths, threshold);
            startBgTaskPolling();
        } catch (err) {
            console.error('启动后台分析失败:', err);
            showToast('启动后台分析失败', 'error');
        }
    }
}

/**
 * 从路径分析（设置面板）
 */
async function analyzeFromPath() {
    const input = document.getElementById('videoPathInput');
    const path = input.value.trim();

    if (!path) {
        showToast('请输入视频文件路径', 'error');
        input.focus();
        return;
    }

    if (!currentProjectId) {
        showToast('请先创建一个项目', 'error');
        return;
    }

    _analysisCancelled = false;

    // 关闭项目下拉
    if (projectDropdownOpen) toggleProjectDropdown();

    const isFirst = totalShots === 0;

    if (isFirst) {
        // 空项目：同步分析，全屏进度
        isAnalyzing = true;
        showAnalyzeProgress('正在分析视频…');
        showProgress(30);

        try {
            const result = await API.analyze(path, threshold);

            if (result.cancelled || _analysisCancelled) {
                showToast('分析已取消', 'success');
            } else if (result.success) {
                totalShots = result.total_shots || 0;
                fps = result.fps || fps;
                showProgress(100);
                showToast(`分析完成，检测到 ${result.total_shots || 0} 个镜头`, 'success');
                if (result.bg_analyzing) {
                    startBgTaskPolling();
                }
            } else {
                showToast('分析失败', 'error');
            }
        } catch (err) {
            if (!_analysisCancelled) {
                showToast(`分析失败: ${err.message}`, 'error');
            }
        }

        hideProgress();
        isAnalyzing = false;

        const projData = await API.getProjects();
        allProjects = projData.projects || [];
        await initProjectView();
    } else {
        // 已有镜头：后台分析，不阻塞主页面
        showToast('正在后台分析视频…');

        try {
            stopBgTaskPolling();
            await API.analyzeBatchBg([path], threshold);
            startBgTaskPolling();
        } catch (err) {
            showToast(`启动后台分析失败: ${err.message}`, 'error');
        }
    }
}

/**
 * 显示重复文件确认弹窗
 * @param {string[]} duplicates - 重复的文件名列表
 * @param {number} totalCount - 总文件数
 * @returns {Promise<'upload'|'skip'|'cancel'>} 用户选择
 */
function showDuplicateConfirm(duplicates, totalCount) {
    return new Promise((resolve) => {
        // 创建遮罩
        const overlay = document.createElement('div');
        overlay.className = 'dup-overlay';
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                overlay.remove();
                resolve('cancel');
            }
        };

        const dupListHTML = duplicates.map(name =>
            `<div class="dup-file-item">
                <span class="dup-file-icon">🎬</span>
                <span class="dup-file-name">${name}</span>
            </div>`
        ).join('');

        const nonDupCount = totalCount - duplicates.length;
        const hasNonDup = nonDupCount > 0;

        overlay.innerHTML = `
            <div class="dup-modal">
                <div class="dup-modal-header">
                    <span class="dup-modal-icon">⚠️</span>
                    <h3>检测到重复文件</h3>
                </div>
                <p class="dup-modal-desc">
                    以下 <strong>${duplicates.length}</strong> 个文件已存在于项目或上传目录中：
                </p>
                <div class="dup-file-list">
                    ${dupListHTML}
                </div>
                ${hasNonDup ? `<p class="dup-modal-extra">另有 ${nonDupCount} 个新文件待上传。</p>` : ''}
                <div class="dup-modal-actions">
                    <button class="btn-secondary dup-btn" id="dupBtnCancel">取消上传</button>
                    ${hasNonDup ? `<button class="btn-secondary dup-btn" id="dupBtnSkip">跳过重复文件</button>` : ''}
                    <button class="btn-primary dup-btn" id="dupBtnUpload">全部上传</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // 绑定按钮事件
        overlay.querySelector('#dupBtnCancel').onclick = () => {
            overlay.remove();
            resolve('cancel');
        };
        if (hasNonDup) {
            overlay.querySelector('#dupBtnSkip').onclick = () => {
                overlay.remove();
                resolve('skip');
            };
        }
        overlay.querySelector('#dupBtnUpload').onclick = () => {
            overlay.remove();
            resolve('upload');
        };
    });
}

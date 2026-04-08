/* ═══════════════════════════════════════════════════
   项目管理 — 创建/切换/重命名/删除
   ═══════════════════════════════════════════════════ */

/**
 * 应用初始化入口
 */
async function initApp() {
    // 初始化拖拽上传
    initDragDrop();

    // 加载项目列表
    await loadProjects();
}

/**
 * 加载项目列表并初始化视图
 */
async function loadProjects() {
    try {
        const data = await API.getProjects();
        allProjects = data.projects || [];
        currentProjectId = data.active_project_id;

        if (currentProjectId) {
            const proj = allProjects.find(p => p.id === currentProjectId);
            currentProjectName = proj ? proj.name : '';
            document.getElementById('currentProjectName').textContent = currentProjectName || '未选择项目';
            // 同步更新 topbar 项目名
            const topbarName = document.getElementById('topbarProjectName');
            if (topbarName) topbarName.textContent = currentProjectName || '未选择项目';
            await initProjectView();
        } else if (allProjects.length > 0) {
            // 有项目但没有活跃项目，切换到第一个
            await switchToProject(allProjects[0].id);
        } else {
            // 没有任何项目
            showNoProjectState();
        }
    } catch (err) {
        console.error('加载项目失败:', err);
        showToast('加载项目失败', 'error');
    }
}

/**
 * 初始化项目视图
 */
async function initProjectView() {
    // 重置筛选/检测状态
    faceDetected = false;
    faceDetecting = false;
    personFilter = false;
    shotTypeDetected = false;
    shotTypeDetecting = false;
    shotTypeFilter = null;
    currentSort = 'time';
    thresholdChanged = false;
    sourceVideoFilters.clear();

    // 同步排序控件 UI
    document.querySelectorAll('#sortControl .filter-chip').forEach(el => {
        el.classList.toggle('active', el.dataset.sort === 'time');
    });
    // 同步分类筛选控件 UI
    document.querySelectorAll('#shotTypeControl .filter-chip').forEach(el => {
        el.classList.toggle('active', el.dataset.type === '');
    });

    // 同步收藏筛选 UI
    favoriteOnly = false;
    const filterAll = document.getElementById('filterAll');
    const filterFav = document.getElementById('filterFavorite');
    if (filterAll) filterAll.classList.add('active');
    if (filterFav) filterFav.classList.remove('active');

    const personBtn = document.getElementById('filterPerson');
    if (personBtn) {
        personBtn.classList.remove('active', 'loading');
        personBtn.textContent = '仅看有人';
    }

    try {
        // 隐藏重新分析按钮
        hideReanalyzeBtn();
        
        const info = await API.getProjectInfo();
        videoPath = info.video_path;
        videoPaths = info.video_paths || [];
        totalShots = info.total_shots || 0;
        fps = info.fps || 24;

        if (totalShots > 0) {
            showShotsView();
            await loadShots();
            updateVideoSourceTags();
        } else {
            showEmptyProjectView();
            updateVideoSourceTags();
        }

        // ★ 刷新后自动恢复后台分析轮询（解决刷新页面卡住的问题）
        try {
            const bgStatus = await API.getBgTaskStatus();
            if (bgStatus.running && !bgStatus.done) {
                console.log('检测到后台分析任务仍在运行，恢复轮询', bgStatus);
                startBgTaskPolling();
            } else {
                // ★ 后台没有在运行 → 检查是否有未完成的分析 → 自动续传
                try {
                    const completeness = await API.getAnalysisCompleteness();
                    if (!completeness.complete && completeness.pending > 0) {
                        console.log(`检测到 ${completeness.pending} 个镜头未分析，自动恢复分析`);
                        await API.resumeAnalysis();
                        startBgTaskPolling();
                    }
                } catch (e) {
                    console.warn('检查分析完成度失败:', e);
                }
            }
        } catch (e) {
            console.warn('检查后台分析状态失败:', e);
        }

    } catch (err) {
        console.error('加载项目信息失败:', err);
        showEmptyProjectView();
    }
}

/**
 * 显示无项目状态
 */
function showNoProjectState() {
    const content = document.getElementById('contentArea');

    content.innerHTML = `
        <div class="no-project-state">
            <div style="font-size:48px;opacity:0.3">🎬</div>
            <h2>开始使用 Nice Cut</h2>
            <p>创建一个项目来管理你的视频素材</p>
            <button class="btn-primary" onclick="showCreateProjectModal()">创建项目</button>
        </div>
    `;
}

/**
 * 显示空项目视图（有项目但无视频）
 */
function showEmptyProjectView() {
    const content = document.getElementById('contentArea');

    content.innerHTML = `
        <div class="empty-guide">
            <div class="empty-guide-icon">🎞</div>
            <div class="empty-guide-text">拖入视频文件，或点击选择</div>
            <div class="empty-guide-sub">支持 MP4、MOV、AVI 等格式</div>
            <button class="btn-primary" onclick="triggerFileSelect()">选择视频文件</button>
        </div>
    `;
}

/**
 * 显示镜头列表视图
 */
function showShotsView() {
    const content = document.getElementById('contentArea');

    // 确保内容区有网格容器
    if (!content.querySelector('.shots-grid')) {
        content.innerHTML = `<div class="shots-grid grid-${gridSize}" id="shotsGrid"></div>`;
    }
}

/**
 * 显示分析进度（简洁版 — 仅加载动画 + 预估时间）
 */
function showAnalyzeProgress(text = '正在分析视频…', estSeconds = 0) {
    const content = document.getElementById('contentArea');

    const estText = estSeconds > 0 ? `<div class="analyze-est-time">预计 ${estSeconds} 秒</div>` : '';

    content.innerHTML = `
        <div class="analyze-progress">
            <div class="spinner"></div>
            <div class="analyze-progress-text">${text}</div>
            ${estText}
            <button class="btn-cancel-analyze" onclick="cancelAnalyze()">取消分析</button>
        </div>
    `;
}

/**
 * 切换项目下拉
 */
function toggleProjectDropdown() {
    projectDropdownOpen = !projectDropdownOpen;
    const btn = document.getElementById('projectSelectorBtn');

    if (projectDropdownOpen) {
        btn.classList.add('open');
        renderProjectDropdown();
    } else {
        btn.classList.remove('open');
        const dropdown = document.body.querySelector('.project-dropdown');
        if (dropdown) dropdown.remove();
        document.removeEventListener('click', closeDropdownOnClickOutside);
    }
}

/**
 * 渲染项目下拉列表（含设置内容）
 */
function renderProjectDropdown() {
    const selector = document.getElementById('projectSelector');
    // 移除已有下拉
    const old = document.body.querySelector('.project-dropdown');
    if (old) old.remove();

    const dropdown = document.createElement('div');
    dropdown.className = 'project-dropdown';

    let html = '<div class="project-dropdown-list">';
    allProjects.forEach(proj => {
        const isActive = proj.id === currentProjectId;
        const meta = `${proj.shot_count || 0} 个镜头 · ${proj.video_count || 0} 个视频`;
        html += `
            <div class="project-dropdown-item ${isActive ? 'active' : ''}" onclick="switchToProject('${proj.id}')">
                <div style="flex:1;min-width:0">
                    <div class="proj-item-name">${escapeHtml(proj.name)}</div>
                    <div class="proj-item-meta">${meta}</div>
                </div>
                <span class="proj-item-delete" onclick="event.stopPropagation();deleteProject('${proj.id}', '${escapeHtml(proj.name).replace(/'/g, "\\'")}')" title="删除项目">✕</span>
            </div>
        `;
    });
    html += '</div>';
    html += '<div class="project-dropdown-divider"></div>';
    html += `<div class="project-dropdown-create" onclick="showCreateProjectModal()">＋ 新建项目</div>`;

    // 设置区域：视频路径导入 + 视频管理
    html += '<div class="project-dropdown-divider"></div>';
    html += `
        <div class="project-dropdown-settings">
            <div class="dropdown-settings-section">
                <div class="dropdown-settings-title">视频路径导入</div>
                <div style="display:flex;gap:8px">
                    <input type="text" id="videoPathInput" placeholder="输入本地视频路径" style="flex:1;height:32px;font-size:12px">
                    <button class="btn-primary" onclick="analyzeFromPath()" style="height:32px;font-size:12px;padding:0 12px">分析</button>
                </div>
            </div>
            <div class="dropdown-settings-section">
                <div class="dropdown-settings-title">视频管理</div>
                <div id="videoList">
                    <p style="font-size:12px;color:var(--text-tertiary)">暂无视频</p>
                </div>
                <button class="btn-text hidden" style="color:var(--red);margin-top:4px;font-size:11px" id="clearVideosBtn" onclick="clearAllVideos()">清空全部视频</button>
            </div>
        </div>
    `;

    dropdown.innerHTML = html;
    // 使用 body 作为容器（固定定位），避免被 sidebar overflow 裁剪
    document.body.appendChild(dropdown);

    // 加载视频管理列表
    loadVideoList();

    // 点击外部关闭
    setTimeout(() => {
        document.addEventListener('click', closeDropdownOnClickOutside);
    }, 10);
}

function closeDropdownOnClickOutside(e) {
    const selector = document.getElementById('projectSelector');
    const dropdown = document.body.querySelector('.project-dropdown');
    if (!selector.contains(e.target) && (!dropdown || !dropdown.contains(e.target))) {
        projectDropdownOpen = false;
        document.getElementById('projectSelectorBtn').classList.remove('open');
        if (dropdown) dropdown.remove();
        document.removeEventListener('click', closeDropdownOnClickOutside);
    }
}

/**
 * 切换项目
 */
async function switchToProject(projectId) {
    if (projectId === currentProjectId) {
        toggleProjectDropdown();
        return;
    }

    try {
        await API.switchProject(projectId);
        currentProjectId = projectId;
        const proj = allProjects.find(p => p.id === projectId);
        currentProjectName = proj ? proj.name : '';
        document.getElementById('currentProjectName').textContent = currentProjectName;
        // 同步更新 topbar 项目名
        const topbarName = document.getElementById('topbarProjectName');
        if (topbarName) topbarName.textContent = currentProjectName;

        // 关闭下拉
        projectDropdownOpen = false;
        document.getElementById('projectSelectorBtn').classList.remove('open');
        const dropdown = document.body.querySelector('.project-dropdown');
        if (dropdown) dropdown.remove();
        document.removeEventListener('click', closeDropdownOnClickOutside);

        // 重新加载视图
        await initProjectView();
    } catch (err) {
        showToast('切换项目失败', 'error');
    }
}

/**
 * 显示创建项目弹窗
 */
function showCreateProjectModal() {
    // 关闭下拉
    if (projectDropdownOpen) toggleProjectDropdown();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-box create-project-modal">
            <h3>新建项目</h3>
            <div class="form-group">
                <label>项目名称</label>
                <input type="text" id="newProjectName" placeholder="如：白日提灯" autofocus>
            </div>
            <div class="form-group">
                <label>备注说明（可选）</label>
                <input type="text" id="newProjectDesc" placeholder="第一集宣发素材">
            </div>
            <div class="form-actions">
                <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
                <button class="btn-primary" onclick="doCreateProject()">创建</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    // 回车提交
    const nameInput = overlay.querySelector('#newProjectName');
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doCreateProject();
    });
    setTimeout(() => nameInput.focus(), 100);
}

/**
 * 执行创建项目
 */
async function doCreateProject() {
    const nameEl = document.getElementById('newProjectName');
    const descEl = document.getElementById('newProjectDesc');
    const name = nameEl.value.trim();

    if (!name) {
        showToast('请输入项目名称', 'error');
        nameEl.focus();
        return;
    }

    try {
        const result = await API.createProject(name, descEl.value.trim());
        if (result.success) {
            // 关闭弹窗
            document.querySelector('.modal-overlay').remove();
            showToast(`项目「${name}」创建成功`, 'success');

            // 刷新项目列表并切换到新项目
            await loadProjects();
            await switchToProject(result.project.id);
        }
    } catch (err) {
        showToast('创建项目失败', 'error');
    }
}

/**
 * 删除项目
 */
function deleteProject(projectId, projectName) {
    showConfirm(
        '删除项目',
        `确定要删除项目「${escapeHtml(projectName)}」吗？<br>所有关联的视频、镜头数据都将被永久删除。`,
        '删除',
        async () => {
            try {
                const result = await API.deleteProject(projectId);
                if (result.success) {
                    showToast('项目已删除', 'success');
                    // 关闭下拉菜单
                    if (projectDropdownOpen) {
                        projectDropdownOpen = false;
                        document.getElementById('projectSelectorBtn').classList.remove('open');
                        const dropdown = document.body.querySelector('.project-dropdown');
                        if (dropdown) dropdown.remove();
                        document.removeEventListener('click', closeDropdownOnClickOutside);
                    }
                    await loadProjects();
                }
            } catch (err) {
                showToast('删除项目失败', 'error');
            }
        },
        true
    );
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 设置面板开关（已整合到项目下拉中）
 */
function toggleSettings() {
    // 设置已整合到项目下拉面板中，打开项目下拉即可
    if (!projectDropdownOpen) {
        toggleProjectDropdown();
    }
}

/**
 * 加载视频管理列表
 */
async function loadVideoList() {
    try {
        const [data, bgStatus] = await Promise.all([
            API.getVideos(),
            API.getBgTaskStatus(),
        ]);
        const list = document.getElementById('videoList');

        if (!data.videos || data.videos.length === 0) {
            list.innerHTML = '<p style="font-size:13px;color:var(--text-tertiary)">暂无视频</p>';
            document.getElementById('clearVideosBtn').classList.add('hidden');
            return;
        }

        document.getElementById('clearVideosBtn').classList.remove('hidden');
        list.innerHTML = data.videos.map(v => {
            // 判断当前视频是否正在拆分
            const isCurrentlySplitting = bgStatus.stage === 'splitting' &&
                bgStatus.current_video === v.filename;
            const statusBadge = isCurrentlySplitting
                ? '<span class="video-status-badge splitting">拆分中</span>'
                : '';

            return `
                <div class="video-list-item">
                    <span class="video-filename" title="${escapeHtml(v.path)}">${escapeHtml(v.filename)}</span>
                    ${statusBadge}
                    <span class="video-meta">${formatFileSize(v.size_mb)} · ${v.shot_count} 镜头</span>
                    <span class="video-delete-btn" onclick="deleteVideoItem('${escapeHtml(v.path)}', '${escapeHtml(v.filename)}')">删除</span>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('加载视频列表失败:', err);
    }
}

/**
 * 删除单个视频
 */
function deleteVideoItem(videoPath, filename) {
    showConfirm(
        '删除视频',
        `确定要删除「${filename}」及其关联的所有镜头数据吗？`,
        '删除',
        async () => {
            try {
                const result = await API.deleteVideo(videoPath);
                if (result.success) {
                    showToast('视频已删除', 'success');
                    // 刷新项目列表数据（更新 shot_count / video_count）
                    const projData = await API.getProjects();
                    allProjects = projData.projects || [];
                    loadVideoList();
                    await initProjectView();
                }
            } catch (err) {
                showToast('删除视频失败', 'error');
            }
        },
        true
    );
}

/**
 * 清空全部视频
 */
function clearAllVideos() {
    showConfirm(
        '清空所有视频',
        '确定要清空当前项目的全部视频吗？已收藏的镜头会保留。',
        '清空全部',
        async () => {
            try {
                const result = await API.clearVideos();
                if (result.success) {
                    let msg = '已清空所有视频';
                    if (result.favorites_kept > 0) {
                        msg += `，已保留 ${result.favorites_kept} 个收藏镜头`;
                    }
                    showToast(msg, 'success');
                    // 刷新项目列表数据（更新 shot_count / video_count）
                    const projData = await API.getProjects();
                    allProjects = projData.projects || [];
                    loadVideoList();
                    await initProjectView();
                }
            } catch (err) {
                showToast('清空失败', 'error');
            }
        },
        true
    );
}

/**
 * 灵敏度阈值变更
 */
function onThresholdChange(value) {
    threshold = parseInt(value);
    document.getElementById('thresholdValue').textContent = value;

    // 如果当前项目已有镜头，显示「重新分析」按钮
    if (totalShots > 0) {
        thresholdChanged = true;
        showReanalyzeBtn();
    }
}

/**
 * 显示/隐藏「重新分析」按钮
 */
function showReanalyzeBtn() {
    let btn = document.getElementById('reanalyzeBtn');
    if (!btn) {
        const container = document.querySelector('.sidebar-sensitivity');
        if (!container) return;
        btn = document.createElement('button');
        btn.id = 'reanalyzeBtn';
        btn.className = 'btn-reanalyze';
        btn.textContent = '🔄 重新分析';
        btn.onclick = doReanalyze;
        container.appendChild(btn);
    }
    btn.style.display = '';
}

function hideReanalyzeBtn() {
    const btn = document.getElementById('reanalyzeBtn');
    if (btn) btn.style.display = 'none';
    thresholdChanged = false;
}

/**
 * 执行重新分析 — 用新灵敏度重新切分所有视频
 */
async function doReanalyze() {
    if (isAnalyzing) {
        showToast('正在分析中，请稍候', 'error');
        return;
    }

    isAnalyzing = true;
    _analysisCancelled = false;

    // 重置景别/人脸检测状态，因为重新分析后需要重新检测
    shotTypeDetected = false;
    faceDetected = false;

    showAnalyzeProgress('正在以新灵敏度重新分析…');
    showProgress(30);

    try {
        const result = await API.reanalyze(threshold);

        if (result.cancelled || _analysisCancelled) {
            showToast('重新分析已取消', 'success');
        } else if (result.success) {
            totalShots = result.total_shots || 0;
            fps = result.fps || fps;
            showProgress(100);

            let msg = `重新分析完成，检测到 ${result.total_shots} 个镜头`;
            if (result.favorites_restored > 0) {
                msg += `，已恢复 ${result.favorites_restored} 个收藏`;
            }
            showToast(msg, 'success');
            hideReanalyzeBtn();

            if (result.bg_analyzing) {
                startBgTaskPolling();
            }
        } else {
            showToast('重新分析失败', 'error');
        }
    } catch (err) {
        if (!_analysisCancelled) {
            showToast(`重新分析失败: ${err.message}`, 'error');
        }
    }

    hideProgress();
    isAnalyzing = false;

    // 刷新视图
    const projData = await API.getProjects();
    allProjects = projData.projects || [];
    await initProjectView();
}

/* ═══════════════════════════════════════════════════
   后台分析轮询 — 分阶段感知 + 灰色小字提示 + Toast
   ═══════════════════════════════════════════════════ */

/**
 * 启动后台分析状态轮询
 * 分阶段感知：splitting（镜头拆分）→ analyzing（深度分析）→ done
 */
function startBgTaskPolling() {
    if (bgTaskPolling) return;
    bgTaskPolling = true;

    let lastSplitDone = 0; // 记录上次已完成拆分数
    let enteredFromSplitting = false; // 标记是否从拆分阶段开始

    // 显示灰色小字提示
    updateBgAnalyzingHint(true, '后台分析中');

    bgTaskPollTimer = setInterval(async () => {
        try {
            const status = await API.getBgTaskStatus();

            if (status.done || !status.running) {
                stopBgTaskPolling();

                // 分析完成，刷新数据
                showToast('镜头分析完成', 'success');
                updateBgAnalyzingHint(false);

                // 重新加载镜头数据（封面帧可能已更新、标签已就位）
                await loadShots();

                // 刷新项目列表数据
                const projData = await API.getProjects();
                allProjects = projData.projects || [];
                updateVideoSourceTags();
                return;
            }

            // ── 拆分阶段 ──
            if (status.stage === 'splitting') {
                enteredFromSplitting = true;
                const totalVids = status.split_done + status.split_queue;
                const hint = status.current_video
                    ? `正在拆分 ${status.current_video}（${status.split_done}/${totalVids}）`
                    : `拆分中（${status.split_done}/${totalVids}）`;
                updateBgAnalyzingHint(true, hint);

                // 每完成一个视频的拆分 → 刷新镜头列表（追加显示新镜头）
                if (status.split_done > lastSplitDone) {
                    lastSplitDone = status.split_done;
                    await loadShots();
                    showToast('新视频拆分完成，已追加镜头', 'success');
                    // 更新项目列表数据
                    const projData = await API.getProjects();
                    allProjects = projData.projects || [];
                    updateVideoSourceTags();
                    // 刷新视频管理列表（如果下拉已打开）
                    if (document.getElementById('videoList')) {
                        loadVideoList();
                    }
                }
            }

            // ── 深度分析阶段 ──
            if (status.stage === 'analyzing') {
                if (enteredFromSplitting) {
                    // 从拆分阶段过渡过来，Toast 通知一下
                    enteredFromSplitting = false;
                    showToast('镜头拆分全部完成，正在分析镜头', 'success');
                }
                const analyzed = status.analyzed_count || 0;
                const total = status.total_count || 0;
                const hintText = total > 0
                    ? `镜头分析中 ${analyzed}/${total}（人像 · 景别 · 动态）`
                    : `镜头分析中 ${status.progress}%（人像 · 景别 · 动态）`;
                updateBgAnalyzingHint(true, hintText);

                // 进度过半时刷新一次（拿到部分新标签+新封面）
                if (status.progress >= 50 && !window._bgStage1Refreshed) {
                    window._bgStage1Refreshed = true;
                    await loadShots();
                }
            }

        } catch (err) {
            console.error('轮询后台状态失败:', err);
        }
    }, 2000); // 2秒轮询（拆分阶段需要更及时）
}

/**
 * 停止后台分析轮询
 */
function stopBgTaskPolling() {
    bgTaskPolling = false;
    window._bgStage1Refreshed = false;
    if (bgTaskPollTimer) {
        clearInterval(bgTaskPollTimer);
        bgTaskPollTimer = null;
    }
}

/**
 * 更新镜头计数旁的灰色小字提示
 */
function updateBgAnalyzingHint(show, text = '分析中') {
    let hint = document.getElementById('bgAnalyzingHint');

    if (!show) {
        if (hint) hint.remove();
        return;
    }

    if (!hint) {
        hint = document.createElement('span');
        hint.id = 'bgAnalyzingHint';
        hint.className = 'bg-analyzing-hint';
        const topbarTitle = document.getElementById('topbarTitle');
        if (topbarTitle) topbarTitle.appendChild(hint);
    }

    hint.innerHTML = `<span class="bg-analyzing-dot"></span>${text}`;
}

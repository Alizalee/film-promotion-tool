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
    thresholdChanged = false;
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
    document.getElementById('toolbar').classList.add('hidden');

    content.innerHTML = `
        <div class="no-project-state">
            <div style="font-size:48px;opacity:0.3">🎬</div>
            <h2>开始使用拉片工具</h2>
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
    document.getElementById('toolbar').classList.add('hidden');

    content.innerHTML = `
        <div class="empty-guide">
            <div class="empty-guide-icon">🎞</div>
            <div class="empty-guide-text">拖入视频文件，或点击选择</div>
            <div class="empty-guide-sub">支持 MP4、MOV、AVI 等格式</div>
            <button class="btn-primary" onclick="triggerFileSelect()">选择视频文件</button>
            <input type="file" id="fileInput" accept="video/*" multiple style="display:none" onchange="handleFileSelect(event)">
        </div>
    `;
}

/**
 * 显示镜头列表视图
 */
function showShotsView() {
    const content = document.getElementById('contentArea');
    document.getElementById('toolbar').classList.remove('hidden');

    // 确保内容区有网格容器
    if (!content.querySelector('.shots-grid')) {
        content.innerHTML = '<div class="shots-grid" id="shotsGrid"></div>';
    }
}

/**
 * 显示分析进度（步骤进度条）
 */
function showAnalyzeProgress(text = '正在检测场景…', step = 1) {
    const content = document.getElementById('contentArea');
    document.getElementById('toolbar').classList.add('hidden');

    const steps = [
        { label: '上传中', icon: '📤' },
        { label: '场景检测', icon: '🎬' },
        { label: '提取封面帧', icon: '🖼' },
        { label: '计算动态值', icon: '📊' },
        { label: '完成', icon: '✅' },
    ];

    const stepsHtml = steps.map((s, i) => {
        const idx = i + 1;
        let cls = 'step-item';
        if (idx < step) cls += ' completed';
        else if (idx === step) cls += ' active';
        return `<div class="${cls}">
            <div class="step-dot">${idx < step ? '✓' : idx}</div>
            <div class="step-label">${s.label}</div>
        </div>`;
    }).join('<div class="step-connector"></div>');

    content.innerHTML = `
        <div class="analyze-progress">
            <div class="spinner"></div>
            <div class="analyze-progress-text">${text}</div>
            <div class="analyze-steps">${stepsHtml}</div>
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
    const selector = document.getElementById('projectSelector');

    if (projectDropdownOpen) {
        btn.classList.add('open');
        renderProjectDropdown();
    } else {
        btn.classList.remove('open');
        const dropdown = selector.querySelector('.project-dropdown');
        if (dropdown) dropdown.remove();
    }
}

/**
 * 渲染项目下拉列表（含设置内容）
 */
function renderProjectDropdown() {
    const selector = document.getElementById('projectSelector');
    // 移除已有下拉
    const old = selector.querySelector('.project-dropdown');
    if (old) old.remove();

    const dropdown = document.createElement('div');
    dropdown.className = 'project-dropdown';

    let html = '<div class="project-dropdown-list">';
    allProjects.forEach(proj => {
        const isActive = proj.id === currentProjectId;
        const meta = `${proj.shot_count || 0} 个镜头 · ${proj.video_count || 0} 个视频`;
        html += `
            <div class="project-dropdown-item ${isActive ? 'active' : ''}" onclick="switchToProject('${proj.id}')">
                <div>
                    <div class="proj-item-name">${escapeHtml(proj.name)}</div>
                    <div class="proj-item-meta">${meta}</div>
                </div>
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
    selector.appendChild(dropdown);

    // 加载视频管理列表
    loadVideoList();

    // 点击外部关闭
    setTimeout(() => {
        document.addEventListener('click', closeDropdownOnClickOutside);
    }, 10);
}

function closeDropdownOnClickOutside(e) {
    const selector = document.getElementById('projectSelector');
    if (!selector.contains(e.target)) {
        projectDropdownOpen = false;
        document.getElementById('projectSelectorBtn').classList.remove('open');
        const dropdown = selector.querySelector('.project-dropdown');
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

        // 关闭下拉
        projectDropdownOpen = false;
        document.getElementById('projectSelectorBtn').classList.remove('open');
        const dropdown = document.querySelector('.project-dropdown');
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
        const data = await API.getVideos();
        const list = document.getElementById('videoList');

        if (!data.videos || data.videos.length === 0) {
            list.innerHTML = '<p style="font-size:13px;color:var(--text-tertiary)">暂无视频</p>';
            document.getElementById('clearVideosBtn').classList.add('hidden');
            return;
        }

        document.getElementById('clearVideosBtn').classList.remove('hidden');
        list.innerHTML = data.videos.map(v => `
            <div class="video-list-item">
                <span class="video-filename" title="${escapeHtml(v.path)}">${escapeHtml(v.filename)}</span>
                <span class="video-meta">${formatFileSize(v.size_mb)} · ${v.shot_count} 镜头</span>
                <span class="video-delete-btn" onclick="deleteVideoItem('${escapeHtml(v.path)}', '${escapeHtml(v.filename)}')">删除</span>
            </div>
        `).join('');
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
        '确定要删除当前项目的全部视频、镜头和帧数据吗？此操作不可恢复。',
        '清空全部',
        async () => {
            try {
                const result = await API.clearVideos();
                if (result.success) {
                    showToast('已清空所有视频', 'success');
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
        const container = document.querySelector('.toolbar-threshold');
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

    showAnalyzeProgress('正在以新灵敏度重新分析…', 2);
    showProgress(30);

    try {
        const result = await API.reanalyze(threshold);

        if (result.cancelled || _analysisCancelled) {
            showToast('重新分析已取消', 'success');
        } else if (result.success) {
            totalShots = result.total_shots || 0;
            fps = result.fps || fps;
            showAnalyzeProgress('重新分析完成！', 5);
            showProgress(100);

            let msg = `重新分析完成，检测到 ${result.total_shots} 个镜头`;
            if (result.favorites_restored > 0) {
                msg += `，已恢复 ${result.favorites_restored} 个收藏`;
            }
            showToast(msg, 'success');
            hideReanalyzeBtn();
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

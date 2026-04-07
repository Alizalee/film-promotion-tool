/* ═══════════════════════════════════════════════════
   镜头列表 — 加载、渲染、筛选、排序、Hover 预览
   ═══════════════════════════════════════════════════ */

/**
 * 加载镜头数据
 */
async function loadShots() {
    try {
        const params = {
            sort: currentSort,
        };
        if (favoriteOnly) params.favorite_only = true;
        if (searchQuery) params.search = searchQuery;
        if (sourceVideoFilter) params.source_video = sourceVideoFilter;
        if (shotTypeFilter) params.shot_type = shotTypeFilter;

        const data = await API.getShots(params);
        allShots = data.shots || [];
        totalShots = data.total || 0;

        renderGrid();
        updateShotCount();
    } catch (err) {
        console.error('加载镜头失败:', err);
        showToast('加载镜头失败', 'error');
    }
}

/**
 * 渲染镜头网格
 */
function renderGrid() {
    showShotsView();
    const grid = document.getElementById('shotsGrid');
    if (!grid) return;

    // 清除旧的 hover video 引用
    hoverVideoElements.clear();

    if (allShots.length === 0) {
        grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:80px 0">
                <p style="color:var(--text-tertiary);font-size:15px">没有匹配的镜头</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = allShots.map((shot, idx) => {
        const isFav = shot.favorite;
        const isSelected = selectedShots.has(shot.id);
        const duration = formatDuration(shot.duration || 0);
        const shotType = shot.shot_type || '';
        const shotTypeLabel = shotType ? `<span class="shot-type-badge">${shotType}</span>` : '';

        return `
            <div class="shot-card ${selectMode ? 'select-mode' : ''} ${isFav ? 'is-favorited' : ''} ${isSelected ? 'is-selected' : ''}" 
                 data-shot-id="${shot.id}" 
                 data-index="${idx}"
                 onclick="onShotCardClick(event, '${shot.id}', ${idx})"
                 onmouseenter="onShotHoverEnter(this, '${shot.id}')"
                 onmouseleave="onShotHoverLeave(this, '${shot.id}')"
                 draggable="false">
                <div class="shot-thumb">
                    <img src="${getFrameUrl(shot.frame_file)}" 
                         alt="Shot ${shot.index}" 
                         loading="lazy"
                         onerror="this.style.display='none'">

                    <!-- 常驻勾选框（左上角） -->
                    <div class="shot-check-persistent ${isSelected ? 'checked' : ''}" 
                         onclick="event.stopPropagation();toggleShotSelect('${shot.id}')">✓</div>

                    <!-- 常驻收藏按钮（右上角） -->
                    <button class="shot-fav-persistent ${isFav ? 'favorited' : ''}" 
                            onclick="event.stopPropagation();toggleFavorite('${shot.id}', ${!isFav})" 
                            title="${isFav ? '取消收藏' : '收藏'}">
                        ${isFav ? '♥' : '♡'}
                    </button>

                    <!-- 景别标签（hover 时出现） -->
                    ${shotTypeLabel}

                    <!-- Hover 浮层（仅底部时长） -->
                    <div class="shot-hover-overlay">
                        <div class="shot-hover-bottom">
                            <span class="shot-duration-label">${duration}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Hover 进入 — 开始静音预览
 */
function onShotHoverEnter(cardEl, shotId) {
    const shot = allShots.find(s => s.id === shotId);
    if (!shot || !shot.source_video) return;

    const thumbDiv = cardEl.querySelector('.shot-thumb');
    const img = thumbDiv.querySelector('img');

    // 创建 video 元素
    const video = document.createElement('video');
    video.src = `${getVideoUrl(shot.source_video)}#t=${shot.start_time},${shot.end_time}`;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.loop = false;

    thumbDiv.insertBefore(video, img.nextSibling);
    hoverVideoElements.set(shotId, video);

    video.addEventListener('loadeddata', () => {
        video.currentTime = shot.start_time;
        video.play().then(() => {
            video.classList.add('playing');
            if (img) img.classList.add('has-video');
        }).catch(() => {});
    }, { once: true });

    // 播放结束时回到开头循环
    video.addEventListener('timeupdate', () => {
        if (video.currentTime >= shot.end_time - 0.05) {
            video.currentTime = shot.start_time;
        }
    });
}

/**
 * Hover 离开 — 停止预览
 */
function onShotHoverLeave(cardEl, shotId) {
    const video = hoverVideoElements.get(shotId);
    if (video) {
        video.pause();
        video.remove();
        hoverVideoElements.delete(shotId);
    }

    const img = cardEl.querySelector('.shot-thumb img');
    if (img) img.classList.remove('has-video');
}

/**
 * 点击镜头卡片 — 始终打开预览（勾选框有 stopPropagation，不会到这里）
 */
function onShotCardClick(event, shotId, index) {
    openPreview(shotId, index);
}

/**
 * 更新镜头计数
 */
function updateShotCount() {
    const el = document.getElementById('shotCount');
    if (el) {
        el.textContent = `${allShots.length} 个镜头`;
    }
}

/**
 * 更新视频源下拉选择
 */
function updateVideoSourceTags() {
    const select = document.getElementById('videoSourceSelect');
    if (!select) return;

    // 保留第一个"全部视频"选项
    select.innerHTML = '<option value="">全部视频</option>';

    if (videoPaths.length > 1) {
        select.style.display = '';
        videoPaths.forEach((vpath) => {
            const filename = vpath.split('/').pop().split('\\').pop();
            const shortName = filename.length > 20 ? filename.substring(0, 17) + '...' : filename;
            const option = document.createElement('option');
            option.value = vpath;
            option.textContent = shortName;
            option.title = filename;
            if (sourceVideoFilter === vpath) option.selected = true;
            select.appendChild(option);
        });
    } else {
        select.style.display = 'none';
    }
}

/**
 * 视频源下拉变更
 */
function onVideoSourceChange(value) {
    sourceVideoFilter = value || null;
    loadShots();
}

/**
 * 排序切换
 */
function setSort(sort) {
    if (currentSort === sort) return;  // 防止重复点击
    currentSort = sort;
    document.querySelectorAll('#sortControl .seg-item').forEach(el => {
        el.classList.toggle('active', el.dataset.sort === sort);
    });
    showToast(sort === 'motion' ? '按动态差异排序' : '按时间顺序排序');
    loadShots();
}

/**
 * 收藏筛选切换
 */
function toggleFavoriteFilter() {
    favoriteOnly = !favoriteOnly;
    document.getElementById('filterFavorite').classList.toggle('active', favoriteOnly);
    loadShots();
}

/**
 * 景别筛选切换（分段控件：全部 / 近景 / 远景）
 */
async function setShotTypeFilter(type) {
    // 首次选择非"全部"时触发景别分析
    if (type && !shotTypeDetected) {
        shotTypeDetecting = true;
        showToast('正在分析景别，首次需要几秒钟…');

        try {
            const result = await API.detectShotTypes();
            shotTypeDetected = true;
            if (result.cached) {
                showToast('景别分析完成（缓存）', 'success');
            } else {
                showToast(`已分析 ${result.detected} 个镜头的景别`, 'success');
            }
        } catch (err) {
            console.error('景别分析失败:', err);
            showToast('景别分析失败', 'error');
            shotTypeDetecting = false;
            return;
        } finally {
            shotTypeDetecting = false;
        }
    }

    shotTypeFilter = type || null;

    // 更新分段控件视觉
    document.querySelectorAll('#shotTypeControl .seg-item').forEach(el => {
        el.classList.toggle('active', el.dataset.type === (shotTypeFilter || ''));
    });

    loadShots();
}

/**
 * 收藏/取消收藏（局部更新，不重渲染网格）
 */
async function toggleFavorite(shotId, favorite) {
    try {
        await API.toggleFavorite(shotId, favorite);
        const shot = allShots.find(s => s.id === shotId);
        if (shot) shot.favorite = favorite;

        // 局部更新当前卡片的收藏按钮
        const card = document.querySelector(`.shot-card[data-shot-id="${shotId}"]`);
        if (card) {
            // 更新卡片 class
            card.classList.toggle('is-favorited', favorite);

            // 更新常驻收藏按钮
            const btn = card.querySelector('.shot-fav-persistent');
            if (btn) {
                btn.classList.toggle('favorited', favorite);
                btn.innerHTML = favorite ? '♥' : '♡';
                btn.title = favorite ? '取消收藏' : '收藏';
                btn.setAttribute('onclick', `event.stopPropagation();toggleFavorite('${shotId}', ${!favorite})`);
            }
        }
    } catch (err) {
        showToast('操作失败', 'error');
    }
}

/**
 * 选择模式切换
 */
function toggleSelectMode() {
    selectMode = !selectMode;
    if (!selectMode) {
        selectedShots.clear();
        updateSelectionBar();
    }
    renderGrid();
}

/**
 * 单个镜头选中/取消（通过勾选框触发）
 */
function toggleShotSelect(shotId) {
    if (selectedShots.has(shotId)) {
        selectedShots.delete(shotId);
    } else {
        selectedShots.add(shotId);
    }

    // 自动进入/退出选择模式
    if (selectedShots.size > 0 && !selectMode) {
        selectMode = true;
    } else if (selectedShots.size === 0 && selectMode) {
        selectMode = false;
    }

    // 更新所有卡片的 select-mode class（控制勾选框可见性）
    document.querySelectorAll('.shot-card').forEach(card => {
        card.classList.toggle('select-mode', selectMode);
    });

    // 更新当前卡片的勾选状态和高亮描边
    const card = document.querySelector(`.shot-card[data-shot-id="${shotId}"]`);
    if (card) {
        const check = card.querySelector('.shot-check-persistent');
        if (check) check.classList.toggle('checked', selectedShots.has(shotId));
        card.classList.toggle('is-selected', selectedShots.has(shotId));
    }

    updateSelectionBar();
}

/**
 * 全选/全不选
 */
function selectAll() {
    if (selectedShots.size === allShots.length) {
        selectedShots.clear();
    } else {
        allShots.forEach(s => selectedShots.add(s.id));
    }
    renderGrid();
    updateSelectionBar();
}

/**
 * 清空选择
 */
function clearSelection() {
    selectedShots.clear();
    selectMode = false;
    updateSelectionBar();
    renderGrid();
}

/**
 * 更新底部选中操作栏
 */
function updateSelectionBar() {
    const bar = document.getElementById('selectionBar');
    const thumbsContainer = document.getElementById('selectionBarThumbs');
    const info = document.getElementById('selectionBarInfo');

    if (selectedShots.size === 0) {
        bar.classList.remove('visible');
        return;
    }

    bar.classList.add('visible');
    info.textContent = `已选 ${selectedShots.size} 个`;

    // 渲染已选缩略图
    const selectedArr = Array.from(selectedShots);
    thumbsContainer.innerHTML = selectedArr.map(shotId => {
        const shot = allShots.find(s => s.id === shotId);
        if (!shot) return '';
        return `
            <div class="selection-bar-thumb" title="#${shot.index + 1}">
                <img src="${getFrameUrl(shot.frame_file)}" alt="" loading="lazy">
                <div class="remove-btn" onclick="event.stopPropagation();toggleShotSelect('${shot.id}')">✕</div>
            </div>
        `;
    }).join('');
}

/**
 * 全部收藏选中的镜头
 */
async function favoriteAllSelected() {
    if (selectedShots.size === 0) return;

    try {
        showToast(`正在收藏 ${selectedShots.size} 个镜头…`);
        await API.batchFavorite(Array.from(selectedShots), true);
        
        // 更新本地数据
        selectedShots.forEach(id => {
            const shot = allShots.find(s => s.id === id);
            if (shot) shot.favorite = true;
        });
        
        showToast(`已收藏 ${selectedShots.size} 个镜头`, 'success');
        renderGrid();
    } catch (err) {
        showToast('批量收藏失败', 'error');
    }
}

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
        if (shotTypeFilter) params.shot_type = shotTypeFilter;

        const data = await API.getShots(params);
        let shots = data.shots || [];

        // ★ 前端多选过滤视频源（sourceVideoFilters 为空时显示全部）
        if (sourceVideoFilters.size > 0) {
            shots = shots.filter(s => sourceVideoFilters.has(s.source_video));
        }

        allShots = shots;
        totalShots = data.total || 0;
        totalFavorites = data.favorite_count || 0;

        // ★ total_all: 后端基于筛选条件（除景别外）的基准总数 → 用于右侧分类标签"全部"
        // ★ total_all_global: 后端全量总数（不受任何筛选影响）→ 用于侧边栏"全部镜头"
        let filteredTotalAll = data.total_all || data.total || 0;
        totalAllShots = data.total_all_global || data.total_all || data.total || 0;
        let filteredShotTypeCounts = data.shot_type_counts || {};

        // ★ 当有视频源筛选时，需要基于选中视频源重新计算各项计数
        if (sourceVideoFilters.size > 0) {
            // ★ 侧边栏"全部镜头"始终显示已勾选视频源的总镜头数（不受收藏/搜索/景别筛选影响）
            // 当有收藏/搜索筛选时，需要额外请求全量数据；否则可复用当前数据
            let globalFiltered;
            if (favoriteOnly || searchQuery) {
                const globalData = await API.getShots({ sort: currentSort });
                globalFiltered = (globalData.shots || []).filter(s => sourceVideoFilters.has(s.source_video));
            } else if (!shotTypeFilter) {
                // 无任何筛选 → 当前 data.shots 就是全量数据，直接复用
                globalFiltered = (data.shots || []).filter(s => sourceVideoFilters.has(s.source_video));
            } else {
                // 仅有景别筛选 → 后端 total_all_global 是全量，但需前端按视频源过滤
                // data.shots 受景别筛选影响不完整，需要额外请求
                const globalData = await API.getShots({ sort: currentSort });
                globalFiltered = (globalData.shots || []).filter(s => sourceVideoFilters.has(s.source_video));
            }
            totalAllShots = globalFiltered.length;
            totalFavorites = globalFiltered.filter(s => s.favorite).length;

            if (!shotTypeFilter) {
                // 没有景别筛选 → 当前请求的 shots 就是全量（仅受收藏/搜索筛选）
                // 前端过滤后直接统计
                const allFiltered = (data.shots || []).filter(s => sourceVideoFilters.has(s.source_video));
                filteredTotalAll = allFiltered.length;
                filteredShotTypeCounts = {};
                for (const s of allFiltered) {
                    const st = s.shot_type || '';
                    if (st) {
                        filteredShotTypeCounts[st] = (filteredShotTypeCounts[st] || 0) + 1;
                    }
                }
            } else {
                // 有景别筛选 → 需要额外请求不带景别筛选的全量数据来统计各分类计数
                const allParams = { sort: currentSort };
                if (favoriteOnly) allParams.favorite_only = true;
                if (searchQuery) allParams.search = searchQuery;
                const allData = await API.getShots(allParams);
                const allFiltered = (allData.shots || []).filter(s => sourceVideoFilters.has(s.source_video));
                filteredTotalAll = allFiltered.length;
                filteredShotTypeCounts = {};
                for (const s of allFiltered) {
                    const st = s.shot_type || '';
                    if (st) {
                        filteredShotTypeCounts[st] = (filteredShotTypeCounts[st] || 0) + 1;
                    }
                }
            }
        }

        renderGrid();
        updateShotCount();
        updateSidebarCounts();
        updateShotTypeCounts(filteredShotTypeCounts, filteredTotalAll);

        // ★ 排序/分类数据就绪检查 — 给准确提示
        if (currentSort === 'motion' && !bgTaskPolling) {
            if (data.motion_data_ready === false) {
                showToast('动态值尚未计算，请等待分析完成后再排序', 'error');
            } else {
                showToast('按动态差异排序');
            }
        }
        if (shotTypeFilter && data.shot_type_data_ready === false && !bgTaskPolling) {
            showToast('部分镜头分类尚未完成，筛选结果可能不完整', 'error');
        }

        // ★ 检查是否有收藏镜头缺少 clip_file（需要补偿裁剪）
        const needsClip = allShots.some(s => s.favorite && !s.clip_file);
        if (needsClip) {
            // 后台补偿裁剪（不阻塞 UI）
            API.ensureFavoriteClips().then(result => {
                if (result.clipped > 0) {
                    console.log(`已补偿裁剪 ${result.clipped} 个收藏镜头`);
                    // 重新加载镜头数据以获取更新的 clip_file 字段
                    API.getShots(params).then(freshData => {
                        allShots = freshData.shots || [];
                        totalShots = freshData.total || 0;
                        renderGrid();
                    });
                }
            }).catch(err => {
                console.warn('收藏镜头补偿裁剪失败:', err);
            });
        }
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
        const shotTypeLabel = shotType ? `<span class="shot-hover-tag shot-type-label">${shotType}</span>` : '';
        const frameUrl = getFrameUrl(shot.frame_file);

        return `
            <div class="shot-card ${selectMode ? 'select-mode' : ''} ${isFav ? 'is-favorited' : ''} ${isSelected ? 'is-selected' : ''}" 
                 data-shot-id="${shot.id}" 
                 data-index="${idx}"
                 onclick="onShotCardClick(event, '${shot.id}', ${idx})"
                 onmouseenter="onShotHoverEnter(this, '${shot.id}')"
                 onmouseleave="onShotHoverLeave(this, '${shot.id}')"
                 draggable="false">
                <div class="shot-thumb">
                    <!-- 高斯模糊背景层 -->
                    <div class="shot-thumb-blur">
                        <img src="${frameUrl}" alt="" loading="lazy">
                    </div>
                    <!-- 主缩略图（contain 不裁剪） -->
                    <img src="${frameUrl}" 
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

                    <!-- Hover 浮层（底部：时长 + 景别标签） -->
                    <div class="shot-hover-overlay">
                        <div class="shot-hover-bottom">
                            <span class="shot-hover-tag shot-duration-label">${duration}</span>
                            ${shotTypeLabel}
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
    // ★ 选主缩略图（直接子 img），而非 blur 层内的 img
    const img = thumbDiv.querySelector(':scope > img');

    // ★ 判断是否使用 clip 模式（源视频不存在但有预裁剪文件时，时间从 0 开始）
    const useClipMode = !!shot.clip_file && !shot.source_video_exists;

    // 创建 video 元素
    const video = document.createElement('video');
    // 如果有 clip_file（源视频已删除的收藏镜头），clip 本身就是裁剪后的完整镜头，不需要 #t 时间片段
    if (useClipMode) {
        video.src = getVideoUrl(shot.source_video, shot.id);
    } else {
        video.src = `${getVideoUrl(shot.source_video, shot.id)}#t=${shot.start_time},${shot.end_time}`;
    }
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.loop = false;

    // ★ 将 video 插在主缩略图之后（而非 blur 层内部）
    if (img) {
        thumbDiv.insertBefore(video, img.nextSibling);
    } else {
        thumbDiv.appendChild(video);
    }
    hoverVideoElements.set(shotId, video);

    video.addEventListener('loadeddata', () => {
        video.currentTime = useClipMode ? 0 : shot.start_time;
        video.play().then(() => {
            video.classList.add('playing');
            if (img) img.classList.add('has-video');
        }).catch(() => {});
    }, { once: true });

    // 使用 rAF 高频检测出点，避免 timeupdate 延迟导致播放到下一个镜头
    const hoverEndTime = useClipMode ? shot.duration : shot.end_time;
    const hoverStartTime = useClipMode ? 0 : shot.start_time;
    let hoverRAF = null;
    function checkHoverBoundary() {
        if (!hoverVideoElements.has(shotId)) {
            hoverRAF = null;
            return;
        }
        if (!video.paused) {
            const halfFrame = 1 / (fps * 2);
            if (video.currentTime >= hoverEndTime - halfFrame) {
                video.currentTime = hoverStartTime;
            }
        }
        hoverRAF = requestAnimationFrame(checkHoverBoundary);
    }

    video.addEventListener('play', () => {
        if (hoverRAF === null) {
            hoverRAF = requestAnimationFrame(checkHoverBoundary);
        }
    });
    video.addEventListener('pause', () => {
        if (hoverRAF !== null) {
            cancelAnimationFrame(hoverRAF);
            hoverRAF = null;
        }
    });

    // 存储 rAF ID 以便在 hover 离开时清理
    video._hoverRAF = hoverRAF;
    video._hoverRAFCheck = checkHoverBoundary;
}

/**
 * Hover 离开 — 停止预览
 */
function onShotHoverLeave(cardEl, shotId) {
    const video = hoverVideoElements.get(shotId);
    if (video) {
        // 清理 rAF 循环
        if (video._hoverRAF) {
            cancelAnimationFrame(video._hoverRAF);
        }
        video.pause();
        video.remove();
        hoverVideoElements.delete(shotId);
    }

    const img = cardEl.querySelector('.shot-thumb > img');
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
    // 同步更新 sidebar 计数
    const sidebarCount = document.getElementById('sidebarShotCount');
    if (sidebarCount) {
        sidebarCount.textContent = totalAllShots;
    }
}

/**
 * 更新视频源 Checkbox 列表（sidebar）
 */
function updateVideoSourceTags() {
    const container = document.getElementById('videoSourceList');
    if (!container) return;

    if (videoPaths.length === 0) {
        container.innerHTML = '<div style="padding:4px 10px;font-size:11px;color:var(--text-tertiary)">暂无视频</div>';
        return;
    }

    container.innerHTML = videoPaths.map((vpath) => {
        const filename = vpath.split('/').pop().split('\\').pop();
        const shortName = filename.length > 18 ? filename.substring(0, 15) + '...' : filename;
        const isChecked = sourceVideoFilters.size === 0 || sourceVideoFilters.has(vpath);
        return `
            <div class="sidebar-item ${isChecked ? 'checked' : ''}" 
                 data-video-path="${escapeHtml(vpath)}"
                 onclick="toggleVideoSourceFilter('${escapeHtml(vpath).replace(/'/g, "\\'")}')" 
                 title="${escapeHtml(filename)}">
                <div class="sidebar-checkbox">✓</div>
                <span class="sidebar-label">${escapeHtml(shortName)}</span>
                <span class="sidebar-item-delete" onclick="event.stopPropagation();deleteVideoItem('${escapeHtml(vpath).replace(/'/g, "\\'")}', '${escapeHtml(filename).replace(/'/g, "\\'")}')" title="删除此视频">✕</span>
            </div>
        `;
    }).join('');
}

/**
 * 切换视频源筛选（多选 checkbox）
 */
function toggleVideoSourceFilter(vpath) {
    if (sourceVideoFilters.size === 0) {
        // 当前显示全部 → 反转为只取消勾选此项（即选中其它全部）
        videoPaths.forEach(p => {
            if (p !== vpath) sourceVideoFilters.add(p);
        });
    } else if (sourceVideoFilters.has(vpath)) {
        sourceVideoFilters.delete(vpath);
        // 如果取消后为空，恢复为全部
        if (sourceVideoFilters.size === 0) {
            // 显示全部 → set 保持为空
        }
    } else {
        sourceVideoFilters.add(vpath);
        // 如果全部选中，恢复为空（=全部）
        if (sourceVideoFilters.size === videoPaths.length) {
            sourceVideoFilters.clear();
        }
    }
    updateVideoSourceTags();
    loadShots();
}

/**
 * 更新侧边栏各处计数
 */
function updateSidebarCounts() {
    // 全部镜头数（项目全量，不受筛选条件影响）
    const shotCountBadge = document.getElementById('sidebarShotCount');
    if (shotCountBadge) shotCountBadge.textContent = totalAllShots;

    // 已收藏数（项目全量收藏数，不受筛选条件影响）
    const favCountBadge = document.getElementById('sidebarFavCount');
    if (favCountBadge) favCountBadge.textContent = totalFavorites;
}

/**
 * 更新景别筛选标签上的计数
 * @param counts - 各分类的计数对象
 * @param filteredTotal - 当前筛选上下文下的基准总数（用于"全部"标签）
 */
function updateShotTypeCounts(counts, filteredTotal) {
    // "全部" 标签显示当前筛选上下文的总数（如收藏模式下只显示收藏的镜头总数）
    const displayTotal = filteredTotal !== undefined ? filteredTotal : totalAllShots;
    const countAll = document.getElementById('countAll');
    if (countAll) countAll.textContent = displayTotal > 0 ? displayTotal : '';

    // 各分类计数
    const mapping = {
        'countCloseUp': '近景人像',
        'countGolden': '黄金人像',
        'countWidePortrait': '远景人像',
        'countEmpty': '空镜',
    };
    for (const [elemId, typeName] of Object.entries(mapping)) {
        const el = document.getElementById(elemId);
        if (el) {
            const n = counts[typeName] || 0;
            el.textContent = n > 0 ? n : '';
        }
    }
}

/**
 * 排序切换
 */
function setSort(sort) {
    currentSort = sort;
    document.querySelectorAll('#sortControl .filter-chip').forEach(el => {
        el.classList.toggle('active', el.dataset.sort === sort);
    });

    if (sort === 'motion' && bgTaskPolling) {
        // 后台分析进行中，动态值尚未就绪
        showToast('镜头分析中，完成后自动生效', 'info');
    } else if (sort === 'motion') {
        // 分析完成，但检查数据是否真的有效（延迟到 loadShots 回调）
        // toast 先不显示，在 loadShots 中根据 motion_data_ready 判断
    } else {
        showToast('按时间顺序排序');
    }
    loadShots();
}

/**
 * 设置收藏筛选（sidebar 中全部/已收藏互斥）
 */
function setFavoriteFilter(onlyFav) {
    favoriteOnly = onlyFav;
    
    // 更新 sidebar 视觉
    const filterAll = document.getElementById('filterAll');
    const filterFav = document.getElementById('filterFavorite');
    if (filterAll) filterAll.classList.toggle('active', !favoriteOnly);
    if (filterFav) filterFav.classList.toggle('active', favoriteOnly);
    
    loadShots();
}

/**
 * 兼容旧的 toggleFavoriteFilter 调用
 */
function toggleFavoriteFilter() {
    setFavoriteFilter(!favoriteOnly);
}

/**
 * 镜头分类筛选切换（分段控件：全部 / 近景人像 / 黄金人像 / 远景人像 / 空镜）
 */
async function setShotTypeFilter(type) {
    // 首次选择非"全部"时触发分类分析
    if (type && !shotTypeDetected) {
        // ★ 后台分析进行中 → 不触发同步 detectShotTypes，给提示
        if (bgTaskPolling) {
            showToast('镜头分析中，完成后自动生效', 'info');
            shotTypeFilter = type || null;
            document.querySelectorAll('#shotTypeControl .filter-chip').forEach(el => {
                el.classList.toggle('active', el.dataset.type === (shotTypeFilter || ''));
            });
            loadShots();
            return;
        }

        shotTypeDetecting = true;
        showToast('正在分析镜头分类，首次需要几秒钟…');

        try {
            const result = await API.detectShotTypes();
            shotTypeDetected = true;
            if (result.cached) {
                showToast('分类分析完成（缓存）', 'success');
            } else {
                showToast(`已分析 ${result.detected} 个镜头`, 'success');
            }
        } catch (err) {
            console.error('分类分析失败:', err);
            showToast('分类分析失败', 'error');
            shotTypeDetecting = false;
            return;
        } finally {
            shotTypeDetecting = false;
        }
    }

    shotTypeFilter = type || null;

    // 更新分段控件视觉
    document.querySelectorAll('#shotTypeControl .filter-chip').forEach(el => {
        el.classList.toggle('active', el.dataset.type === (shotTypeFilter || ''));
    });

    loadShots();
}

/**
 * 收藏/取消收藏（局部更新，不重渲染网格）
 */
async function toggleFavorite(shotId, favorite) {
    try {
        const result = await API.toggleFavorite(shotId, favorite);
        const shot = allShots.find(s => s.id === shotId);
        if (shot) {
            shot.favorite = favorite;
            // ★ 更新 clip_file（收藏时后端会自动预裁剪）
            if (result.clip_file) {
                shot.clip_file = result.clip_file;
            }
        }

        // ★ 即时更新收藏计数
        totalFavorites += favorite ? 1 : -1;
        if (totalFavorites < 0) totalFavorites = 0;
        updateSidebarCounts();

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
    updateSelectionBarPosition();
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
        let newlyFavorited = 0;
        selectedShots.forEach(id => {
            const shot = allShots.find(s => s.id === id);
            if (shot && !shot.favorite) {
                shot.favorite = true;
                newlyFavorited++;
            }
        });
        
        // ★ 更新收藏计数
        totalFavorites += newlyFavorited;
        updateSidebarCounts();

        showToast(`已收藏 ${selectedShots.size} 个镜头`, 'success');
        renderGrid();
    } catch (err) {
        showToast('批量收藏失败', 'error');
    }
}

/**
 * 视图大小切换（大/中/小）
 */
function setGridSize(size) {
    gridSize = size;
    // 更新控件高亮
    document.querySelectorAll('#gridSizeControl .filter-chip').forEach(el => {
        el.classList.toggle('active', el.dataset.size === size);
    });
    // 更新网格 class
    const grid = document.getElementById('shotsGrid');
    if (grid) {
        grid.classList.remove('grid-sm', 'grid-md', 'grid-lg');
        grid.classList.add('grid-' + size);
    }
}

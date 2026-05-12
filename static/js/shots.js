/* ═══════════════════════════════════════════════════
   镜头列表 — 加载、渲染、筛选、排序、Hover 预览
   ═══════════════════════════════════════════════════ */

/* ── 帧图片 404 自动修复 ── */
const _frameRetrySet = new Set();
let _frameRefreshQueue = [];
let _frameRefreshRunning = 0;
const MAX_CONCURRENT_REFRESH = 3;

/**
 * 帧图片加载失败时自动触发重新提取
 * - 每个 shot 最多自动重试 1 次，避免死循环
 * - 并发控制：同时最多 3 个刷新请求
 */
function handleFrameError(imgEl, shotId, frameFile) {
    if (_frameRetrySet.has(shotId)) {
        imgEl.style.display = 'none';
        return;
    }
    _frameRetrySet.add(shotId);

    _frameRefreshQueue.push(async () => {
        _frameRefreshRunning++;
        try {
            const result = await API.refreshFrame(shotId);
            if (result.success && result.frame_file) {
                bumpFrameVersion(result.frame_file);
                const newUrl = getFrameUrl(result.frame_file, result._cacheBust);
                imgEl.src = newUrl;
                imgEl.style.display = '';

                // 同步刷新高斯模糊背景层
                const thumbContainer = imgEl.closest('.shot-thumb');
                if (thumbContainer) {
                    const blurImg = thumbContainer.querySelector('.shot-thumb-blur img');
                    if (blurImg) blurImg.src = newUrl;
                }
            } else {
                imgEl.style.display = 'none';
            }
        } catch (e) {
            console.warn('自动重新提取帧失败:', shotId, e);
            imgEl.style.display = 'none';
        }
        _frameRefreshRunning--;
        _processRefreshQueue();
    });
    _processRefreshQueue();
}

function _processRefreshQueue() {
    while (_frameRefreshRunning < MAX_CONCURRENT_REFRESH && _frameRefreshQueue.length > 0) {
        const task = _frameRefreshQueue.shift();
        task();
    }
}

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

        // ★ 前端人数过滤（peopleFilter 非 null 时激活，单选）
        if (peopleFilter !== null) {
            shots = shots.filter(s => {
                const count = Math.min(s.face_count || 0, 3);
                return count === peopleFilter;
            });
        }

        allShots = shots;
        totalShots = data.total || 0;
        totalFavorites = data.favorite_count || 0;

        // ★ total_all: 后端基于筛选条件（除景别外）的基准总数 → 用于右侧分类标签"全部"
        // ★ total_all_global: 后端全量总数（不受任何筛选影响）→ 用于侧边栏"全部镜头"
        let filteredTotalAll = data.total_all || data.total || 0;
        totalAllShots = data.total_all_global || data.total_all || data.total || 0;
        let filteredShotTypeCounts = data.shot_type_counts || {};

        // ★ 当有视频源筛选时，利用后端返回的 per_video_counts 重新计算各项计数
        // 不再额外发起 API 请求
        if (sourceVideoFilters.size > 0) {
            const pvc = data.per_video_counts || {};
            let videoTotal = 0;
            let videoFavTotal = 0;
            const videoTypeCounts = {};

            for (const vpath of sourceVideoFilters) {
                const counts = pvc[vpath];
                if (!counts) continue;
                videoTotal += counts.total || 0;
                videoFavTotal += counts.favorite || 0;
                if (counts.types) {
                    for (const [st, n] of Object.entries(counts.types)) {
                        videoTypeCounts[st] = (videoTypeCounts[st] || 0) + n;
                    }
                }
            }

            // 侧边栏"全部镜头"= 已勾选视频源的镜头总数
            totalAllShots = videoTotal;
            totalFavorites = videoFavTotal;

            // 分类标签计数（基于已选视频源的全量数据）
            // 如果有收藏/搜索筛选，则 filteredTotalAll 用当前 shots 长度（已由后端筛选）
            if (favoriteOnly || searchQuery) {
                filteredTotalAll = shots.length;
                filteredShotTypeCounts = {};
                for (const s of shots) {
                    const st = s.shot_type || '';
                    if (st) {
                        filteredShotTypeCounts[st] = (filteredShotTypeCounts[st] || 0) + 1;
                    }
                }
            } else if (!shotTypeFilter) {
                filteredTotalAll = videoTotal;
                filteredShotTypeCounts = videoTypeCounts;
            } else {
                // 有景别筛选 → 分类标签基准应不受景别筛选影响
                filteredTotalAll = videoTotal;
                filteredShotTypeCounts = videoTypeCounts;
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
        // ★ 传 shot 对象而非字符串，保留 _cacheBust 字段，确保缓存版本号不丢失
        const frameUrl = getFrameUrl(shot);

        return `
            <div class="shot-card ${selectMode ? 'select-mode' : ''} ${isFav ? 'is-favorited' : ''} ${isSelected ? 'is-selected' : ''}" 
                 data-shot-id="${shot.id}" 
                 data-index="${idx}"
                 onclick="onShotCardClick(event, '${shot.id}', ${idx})"
                 onmousedown="onShotCardMouseDown(event, '${shot.id}')"
                 onmouseenter="onShotHoverEnter(this, '${shot.id}')"
                 onmouseleave="onShotHoverLeave(this, '${shot.id}')"
                 draggable="false">
                <div class="shot-thumb">
                    <!-- 高斯模糊背景层 -->
                    <div class="shot-thumb-blur">
                        <img src="${frameUrl}" alt="" loading="lazy" onerror="this.style.opacity='0'">
                    </div>
                    <!-- 主缩略图（contain 不裁剪） -->
                    <img src="${frameUrl}" 
                         alt="Shot ${shot.index}" 
                         loading="lazy"
                         onerror="handleFrameError(this, '${shot.id}', '${shot.frame_file}')">

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

                    <!-- 拖拽合并提示浮层 -->
                    <div class="merge-hint">释放合并</div>
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
        video.playbackRate = 2;  // 外部 hover 预览固定 2 倍速
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
 * 点击镜头卡片 — 打开预览（拖拽结束后不触发，勾选框有 stopPropagation）
 */
let _mergeDragJustEnded = false;
function onShotCardClick(event, shotId, index) {
    // 拖拽刚结束时跳过此次点击
    if (_mergeDragJustEnded) {
        _mergeDragJustEnded = false;
        return;
    }
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
 * hover 时在鼠标旁显示 tooltip：时长 · 镜头数 · 文件大小
 */
async function updateVideoSourceTags() {
    const container = document.getElementById('videoSourceList');
    if (!container) return;

    // 获取视频详情（大小、镜头数、时长）
    let videoDetails = {};
    try {
        const data = await API.getVideos();
        (data.videos || []).forEach(v => {
            videoDetails[v.path] = v;
        });
    } catch (e) { /* 静默失败 */ }

    // ★ 用后端全量数据检查是否有孤儿 shots（不受 sourceVideoFilters 影响）
    // 避免前端过滤后 orphan 被隐藏导致"其他片段"选项消失
    let orphanCount = 0;
    try {
        const globalData = await API.getShots({ sort: 'time' });
        orphanCount = (globalData.shots || []).filter(s => s.source_video === '__orphan__').length;
    } catch (e) { /* 静默失败 */ }

    if (videoPaths.length === 0 && orphanCount === 0) {
        container.innerHTML = '<div style="padding:4px 10px;font-size:11px;color:var(--text-tertiary)">暂无视频</div>';
        return;
    }

    let html = videoPaths.map((vpath) => {
        const filename = vpath.split('/').pop().split('\\').pop();
        const shortName = filename.length > 18 ? filename.substring(0, 15) + '...' : filename;
        const isChecked = sourceVideoFilters.size === 0 || sourceVideoFilters.has(vpath);
        // ★ 排他性选中态：sourceVideoFilters 仅含此一项时高亮
        const isSoloActive = sourceVideoFilters.size === 1 && sourceVideoFilters.has(vpath);

        // 构建 tooltip 信息
        const detail = videoDetails[vpath];
        const shotCount = detail ? detail.shot_count : 0;
        const sizeMB = detail ? detail.size_mb : 0;
        const durationSec = detail ? (detail.duration_sec || 0) : 0;
        const tooltipText = `${escapeHtml(filename)}\n${formatDuration(durationSec)} · ${shotCount} 个镜头 · ${formatFileSize(sizeMB)}`;

        // ★ 使用 escapeJsString 安全转义，防止 Windows 反斜杠破坏内联 JS 字符串
        const safeVpath = escapeJsString(vpath);
        const safeFilename = escapeJsString(filename);
        const safeTooltip = escapeJsString(tooltipText);

        return `
            <div class="sidebar-item ${isChecked ? 'checked' : ''} ${isSoloActive ? 'solo-active' : ''}" 
                 data-video-path="${escapeHtml(vpath)}"
                 onmouseenter="showVideoTooltip(event, '${safeTooltip}')"
                 onmouseleave="hideVideoTooltip()">
                <div class="sidebar-checkbox" onclick="event.stopPropagation();toggleVideoSourceFilter('${safeVpath}')">✓</div>
                <span class="sidebar-label" onclick="event.stopPropagation();selectSingleVideoSource('${safeVpath}')" ondblclick="event.stopPropagation();renameVideoItem('${safeVpath}', '${safeFilename}', this)">${escapeHtml(shortName)}</span>
                <span class="sidebar-item-delete" onclick="event.stopPropagation();deleteVideoItem('${safeVpath}', '${safeFilename}')" title="删除此视频">✕</span>
            </div>
        `;
    }).join('');

    // ★ 孤儿片段分组（使用全量数据判断，确保取消勾选后选项不会消失）
    if (orphanCount > 0) {
        const isOrphanChecked = sourceVideoFilters.size === 0 || sourceVideoFilters.has('__orphan__');
        const isOrphanSolo = sourceVideoFilters.size === 1 && sourceVideoFilters.has('__orphan__');
        html += `
            <div class="sidebar-item ${isOrphanChecked ? 'checked' : ''} ${isOrphanSolo ? 'solo-active' : ''}" 
                 data-video-path="__orphan__">
                <div class="sidebar-checkbox" onclick="event.stopPropagation();toggleVideoSourceFilter('__orphan__')">✓</div>
                <span class="sidebar-label" onclick="event.stopPropagation();selectSingleVideoSource('__orphan__')">其他片段</span>
                <span class="sidebar-badge">${orphanCount}</span>
            </div>
        `;
    }

    container.innerHTML = html;
    updateToggleButtonState();
}

/**
 * 重命名视频源 — 双击文件名触发内联编辑
 */
function renameVideoItem(vpath, currentFilename, labelEl) {
    // 防止重复触发
    if (labelEl.querySelector('.video-rename-input')) return;

    // 隐藏 tooltip
    hideVideoTooltip();

    // 获取不含扩展名的文件名主体
    const dotIdx = currentFilename.lastIndexOf('.');
    const baseName = dotIdx > 0 ? currentFilename.substring(0, dotIdx) : currentFilename;
    const ext = dotIdx > 0 ? currentFilename.substring(dotIdx) : '';

    // 禁用父级 sidebar-item 的 tooltip 事件（避免 DOM 操作导致 blur）
    const sidebarItem = labelEl.closest('.sidebar-item');
    if (sidebarItem) {
        sidebarItem.removeAttribute('onmouseenter');
        sidebarItem.removeAttribute('onmouseleave');
        sidebarItem.removeAttribute('onclick');
    }

    // 创建输入框
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'video-rename-input';
    input.value = baseName;
    input.setAttribute('data-ext', ext);

    // 替换 label 内容
    const originalText = labelEl.textContent;
    labelEl.textContent = '';
    labelEl.appendChild(input);

    // 阻止点击事件冒泡（防止触发 toggleVideoSourceFilter）
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('dblclick', e => e.stopPropagation());
    input.addEventListener('mousedown', e => e.stopPropagation());

    // 延迟 focus，确保 DOM 稳定后再聚焦，避免立即 blur
    requestAnimationFrame(() => {
        input.focus();
        input.select();
    });

    let submitted = false;
    // 保护期：进入编辑后 500ms 内忽略 blur，防止自动退出
    let blurProtected = true;
    setTimeout(() => { blurProtected = false; }, 500);

    async function submitRename() {
        if (submitted) return;
        submitted = true;

        const newName = input.value.trim();
        if (!newName || newName === baseName) {
            // 未修改，恢复原文本
            restoreLabel();
            return;
        }

        // 前端基本校验
        const illegal = /[/\\:*?"<>|]/;
        if (illegal.test(newName)) {
            showToast('文件名包含非法字符', 'error');
            restoreLabel();
            return;
        }

        // 调用 API
        try {
            const result = await API.renameVideo(vpath, newName);
            if (result.success) {
                // 更新前端状态
                const oldPath = result.old_path;
                const newPath = result.new_path;

                // 更新 videoPaths
                const idx = videoPaths.indexOf(oldPath);
                if (idx !== -1) videoPaths[idx] = newPath;

                // 更新 sourceVideoFilters
                if (sourceVideoFilters.has(oldPath)) {
                    sourceVideoFilters.delete(oldPath);
                    sourceVideoFilters.add(newPath);
                }

                showToast('重命名成功', 'success');
                updateVideoSourceTags();
                loadShots();
            } else {
                showToast(result.detail || '重命名失败', 'error');
                restoreLabel();
            }
        } catch (e) {
            showToast('重命名失败: ' + e.message, 'error');
            restoreLabel();
        }
    }

    function cancelRename() {
        if (submitted) return;
        submitted = true;
        restoreLabel();
    }

    function restoreLabel() {
        labelEl.textContent = originalText;
        // 重新渲染整个视频源列表以恢复事件绑定
        updateVideoSourceTags();
    }

    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            submitRename();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename();
        }
    });

    input.addEventListener('blur', () => {
        // 保护期内忽略 blur，防止刚进入编辑就自动退出
        if (blurProtected) return;
        // 短延迟防止 blur 和 keydown 冲突
        setTimeout(() => { if (!submitted) cancelRename(); }, 150);
    });
}

/**
 * 显示视频源 hover tooltip（跟随鼠标）
 */
function showVideoTooltip(event, text) {
    let tip = document.getElementById('videoTooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'videoTooltip';
        tip.className = 'video-tooltip';
        document.body.appendChild(tip);
    }
    tip.innerHTML = text.replace(/\n/g, '<br>');
    tip.style.display = 'block';

    // 跟随鼠标位置，偏移避免遮挡
    const x = event.clientX + 14;
    const y = event.clientY + 14;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';

    // 监听鼠标移动，tooltip 跟随
    event.target.closest('.sidebar-item')._tooltipMove = function(e) {
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top = (e.clientY + 14) + 'px';
    };
    event.target.closest('.sidebar-item').addEventListener('mousemove', event.target.closest('.sidebar-item')._tooltipMove);
}

/**
 * 隐藏视频源 hover tooltip
 */
function hideVideoTooltip() {
    const tip = document.getElementById('videoTooltip');
    if (tip) tip.style.display = 'none';

    // 移除 mousemove 监听
    document.querySelectorAll('.sidebar-item').forEach(item => {
        if (item._tooltipMove) {
            item.removeEventListener('mousemove', item._tooltipMove);
            delete item._tooltipMove;
        }
    });
}

/**
 * 切换视频源筛选（多选 checkbox）
 */
function toggleVideoSourceFilter(vpath) {
    // ★ 从 DOM 中检查是否有"其他片段"项，而非依赖已过滤的 allShots
    const hasOrphans = !!document.querySelector('.sidebar-item[data-video-path="__orphan__"]');
    const allPaths = [...videoPaths];
    if (hasOrphans) allPaths.push('__orphan__');

    if (sourceVideoFilters.size === 0) {
        // 当前显示全部 → 反转为只取消勾选此项（即选中其它全部）
        allPaths.forEach(p => {
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
        if (sourceVideoFilters.size === allPaths.length) {
            sourceVideoFilters.clear();
        }
    }
    updateVideoSourceTags();
    loadShots();
}

/**
 * 排他性筛选 — 只显示指定视频的镜头（点击视频名触发）
 */
function selectSingleVideoSource(vpath) {
    // 如果当前已经是排他选中该视频，则恢复全选
    if (sourceVideoFilters.size === 1 && sourceVideoFilters.has(vpath)) {
        sourceVideoFilters.clear();
    } else {
        sourceVideoFilters.clear();
        sourceVideoFilters.add(vpath);
    }
    updateVideoSourceTags();
    loadShots();
}

/**
 * 切换全选/全不选（智能判断当前状态）
 */
function toggleAllVideoSources() {
    if (sourceVideoFilters.size === 0) {
        // 当前全选 → 全不选
        sourceVideoFilters.clear();
        sourceVideoFilters.add('__none__');
    } else {
        // 当前非全选 → 全选
        sourceVideoFilters.clear();
    }
    updateVideoSourceTags();
    loadShots();
}

/**
 * 更新全选/全不选按钮的文字状态
 */
function updateToggleButtonState() {
    const btn = document.getElementById('videoSourceToggleBtn');
    if (!btn) return;
    if (sourceVideoFilters.size === 0) {
        btn.textContent = '全不选';
        btn.title = '取消所有勾选';
    } else {
        btn.textContent = '全选';
        btn.title = '勾选所有视频源';
    }
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

        try {
            const result = await API.detectShotTypes();
            shotTypeDetected = true;
        } catch (err) {
            console.error('分类分析失败:', err);
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

    // ★ 空镜 → 重置并隐藏人数选择器；其他 → 恢复显示
    const peopleControl = document.getElementById('peopleFilterControl');
    const peopleDivider = peopleControl ? peopleControl.previousElementSibling : null; // .filter-divider-v
    if (shotTypeFilter === '空镜') {
        peopleFilter = null;
        updatePeopleFilterVisual();
        if (peopleControl) peopleControl.style.display = 'none';
        if (peopleDivider && peopleDivider.classList.contains('filter-divider-v')) peopleDivider.style.display = 'none';
    } else {
        if (peopleControl) peopleControl.style.display = '';
        if (peopleDivider && peopleDivider.classList.contains('filter-divider-v')) peopleDivider.style.display = '';
    }

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
    const actionsContainer = document.getElementById('selectionBarActions');

    if (selectedShots.size === 0) {
        bar.classList.remove('visible');
        return;
    }

    bar.classList.add('visible');
    updateSelectionBarPosition();
    info.textContent = `已选 ${selectedShots.size} 个`;

    // ★ 动态渲染操作按钮
    if (actionsContainer) {
        // 检查选中镜头中是否有已收藏的
        const hasAnyfavorited = Array.from(selectedShots).some(id => {
            const s = allShots.find(x => x.id === id);
            return s && s.favorite;
        });

        let btns = `<button class="btn-secondary selection-bar-btn" onclick="favoriteAllSelected()">全部收藏</button>`;
        if (hasAnyfavorited) {
            btns += `<button class="btn-secondary selection-bar-btn" onclick="unfavoriteAllSelected()">取消收藏</button>`;
        }
        btns += `<button class="btn-primary selection-bar-btn" onclick="openExportPanel()">导出镜头</button>`;
        btns += `<button class="btn-text-danger selection-bar-btn" onclick="deleteSelectedShots()">删除</button>`;
        btns += `<span class="selection-bar-divider">·</span>`;
        btns += `<button class="btn-text selection-bar-btn" onclick="clearSelection()">取消</button>`;
        actionsContainer.innerHTML = btns;
    }

    // 渲染已选缩略图
    const selectedArr = Array.from(selectedShots);
    thumbsContainer.innerHTML = selectedArr.map(shotId => {
        const shot = allShots.find(s => s.id === shotId);
        if (!shot) return '';
        return `
            <div class="selection-bar-thumb" title="#${shot.index + 1}">
                <img src="${getFrameUrl(shot)}" alt="" loading="lazy">
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
 * 批量取消收藏选中的镜头
 */
async function unfavoriteAllSelected() {
    if (selectedShots.size === 0) return;

    // 只取消已收藏的
    const favIds = Array.from(selectedShots).filter(id => {
        const s = allShots.find(x => x.id === id);
        return s && s.favorite;
    });

    if (favIds.length === 0) {
        showToast('选中的镜头均未收藏', 'info');
        return;
    }

    try {
        showToast(`正在取消收藏 ${favIds.length} 个镜头…`);
        await API.batchFavorite(favIds, false);

        // 更新本地数据
        favIds.forEach(id => {
            const shot = allShots.find(s => s.id === id);
            if (shot) shot.favorite = false;
        });

        totalFavorites = Math.max(0, totalFavorites - favIds.length);
        updateSidebarCounts();

        showToast(`已取消收藏 ${favIds.length} 个镜头`, 'success');
        renderGrid();
        updateSelectionBar();
    } catch (err) {
        showToast('批量取消收藏失败', 'error');
    }
}

/**
 * 批量删除选中的镜头
 */
async function deleteSelectedShots() {
    if (selectedShots.size === 0) return;

    const count = selectedShots.size;
    showConfirm(
        '删除镜头',
        `确定要删除选中的 ${count} 个镜头吗？<br>此操作不可恢复。`,
        '删除',
        async () => {
            try {
                showToast(`正在删除 ${count} 个镜头…`);
                const result = await API.deleteShots(Array.from(selectedShots));
                if (result.success) {
                    showToast(`已删除 ${result.deleted} 个镜头`, 'success');
                    // 清空选择并刷新
                    selectedShots.clear();
                    selectMode = false;
                    updateSelectionBar();
                    await loadShots();
                    updateVideoSourceTags();
                    // 刷新项目列表数据
                    const projData = await API.getProjects();
                    allProjects = projData.projects || [];
                } else {
                    showToast('删除失败', 'error');
                }
            } catch (err) {
                showToast('删除镜头失败', 'error');
            }
        },
        true
    );
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

/* ═══════════════════════════════════════════════════
   人数单选标签 — 点击切换
   ═══════════════════════════════════════════════════ */

/**
 * 切换人数筛选标签（单选：再次点击取消）
 * @param {number} val - 人数值 (1/2/3, 3 代表 ≥3)
 */
function togglePeopleFilter(val) {
    peopleFilter = (peopleFilter === val) ? null : val;
    updatePeopleFilterVisual();
    loadShots();
}

/**
 * 更新人数标签的视觉状态（active class）
 */
function updatePeopleFilterVisual() {
    document.querySelectorAll('#peopleFilterControl .filter-chip').forEach(chip => {
        const v = parseInt(chip.dataset.people);
        chip.classList.toggle('active', peopleFilter === v);
    });
}

/* ═══════════════════════════════════════════════════
   拖拽合并 — 长按镜头卡片启动拖拽，释放到同源镜头完成合并
   ═══════════════════════════════════════════════════ */

/** 长按计时器 */
let _mergeLongPressTimer = null;
/** 拖拽中的幽灵元素 */
let _mergeGhostEl = null;
/** 当前 hover 的目标卡片元素 */
let _mergeTargetCard = null;

/**
 * 卡片 mousedown — 启动长按计时（300ms）
 * 排除勾选框、收藏按钮等交互元素
 */
function onShotCardMouseDown(event, shotId) {
    // 排除：勾选框、收藏按钮、右键
    if (event.button !== 0) return;
    const tag = event.target.closest('.shot-check-persistent, .shot-fav-persistent');
    if (tag) return;

    const card = event.target.closest('.shot-card');
    if (!card) return;

    const startX = event.clientX;
    const startY = event.clientY;

    _mergeLongPressTimer = setTimeout(() => {
        _mergeLongPressTimer = null;
        startMergeDrag(card, shotId, startX, startY);
    }, 300);

    // 如果鼠标在 300ms 内移动过多或松开，取消长按
    const cancelLongPress = () => {
        if (_mergeLongPressTimer) {
            clearTimeout(_mergeLongPressTimer);
            _mergeLongPressTimer = null;
        }
        document.removeEventListener('mouseup', onEarlyUp);
        document.removeEventListener('mousemove', onEarlyMove);
    };
    const onEarlyUp = () => cancelLongPress();
    const onEarlyMove = (e) => {
        if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) {
            cancelLongPress();
        }
    };
    document.addEventListener('mouseup', onEarlyUp, { once: true });
    document.addEventListener('mousemove', onEarlyMove);
}

/**
 * 进入拖拽模式
 */
function startMergeDrag(card, shotId, startX, startY) {
    const shot = allShots.find(s => s.id === shotId);
    if (!shot) return;

    isDraggingForMerge = true;
    mergeSourceShot = shot;

    // 源卡片添加拖拽样式
    card.classList.add('dragging');

    // 创建跟随鼠标的幽灵缩略图
    _mergeGhostEl = document.createElement('div');
    _mergeGhostEl.className = 'merge-ghost';
    const frameUrl = getFrameUrl(shot);
    _mergeGhostEl.innerHTML = `<img src="${frameUrl}" alt="">`;
    _mergeGhostEl.style.left = startX + 'px';
    _mergeGhostEl.style.top = startY + 'px';
    document.body.appendChild(_mergeGhostEl);

    // 监听全局 mousemove / mouseup / keydown
    document.addEventListener('mousemove', onMergeDragMove);
    document.addEventListener('mouseup', onMergeDragEnd);
    document.addEventListener('keydown', onMergeDragKeyDown);
}

/**
 * 拖拽中 — 幽灵跟随鼠标 + 检测目标卡片
 */
function onMergeDragMove(event) {
    if (!isDraggingForMerge) return;

    // 幽灵跟随
    if (_mergeGhostEl) {
        _mergeGhostEl.style.left = event.clientX + 'px';
        _mergeGhostEl.style.top = event.clientY + 'px';
    }

    // 检测鼠标下方的卡片
    // 先暂时隐藏幽灵，使 elementFromPoint 能穿透
    if (_mergeGhostEl) _mergeGhostEl.style.pointerEvents = 'none';
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (_mergeGhostEl) _mergeGhostEl.style.pointerEvents = '';

    const targetCard = el ? el.closest('.shot-card') : null;
    const sourceCard = document.querySelector('.shot-card.dragging');

    // 清除上一个目标的样式
    if (_mergeTargetCard && _mergeTargetCard !== targetCard) {
        _mergeTargetCard.classList.remove('merge-target', 'merge-forbidden');
    }

    if (targetCard && targetCard !== sourceCard) {
        const targetShotId = targetCard.dataset.shotId;
        const targetShot = allShots.find(s => s.id === targetShotId);

        if (targetShot && mergeSourceShot) {
            const sameSource = targetShot.source_video === mergeSourceShot.source_video;
            if (sameSource) {
                targetCard.classList.add('merge-target');
                targetCard.classList.remove('merge-forbidden');
            } else {
                targetCard.classList.add('merge-forbidden');
                targetCard.classList.remove('merge-target');
            }
        }
        _mergeTargetCard = targetCard;
    } else {
        _mergeTargetCard = null;
    }
}

/**
 * 拖拽释放 — 判断目标并弹出确认
 */
function onMergeDragEnd(event) {
    if (!isDraggingForMerge) return;

    // 先检测最终目标
    if (_mergeGhostEl) _mergeGhostEl.style.pointerEvents = 'none';
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (_mergeGhostEl) _mergeGhostEl.style.pointerEvents = '';

    const targetCard = el ? el.closest('.shot-card') : null;
    const sourceCard = document.querySelector('.shot-card.dragging');

    let targetShot = null;
    if (targetCard && targetCard !== sourceCard) {
        const targetShotId = targetCard.dataset.shotId;
        targetShot = allShots.find(s => s.id === targetShotId);
    }

    // 清理拖拽状态
    cleanupMergeDrag();

    // 判断是否可合并
    if (targetShot && mergeSourceShot && targetShot.id !== mergeSourceShot.id) {
        if (targetShot.source_video === mergeSourceShot.source_video) {
            showMergeConfirm(mergeSourceShot, targetShot);
        } else {
            showToast('不同视频来源的镜头无法合并', 'error');
        }
    }

    mergeSourceShot = null;
}

/**
 * ESC 取消拖拽
 */
function onMergeDragKeyDown(event) {
    if (event.key === 'Escape') {
        cleanupMergeDrag();
        mergeSourceShot = null;
    }
}

/**
 * 清理拖拽 DOM 和事件
 */
function cleanupMergeDrag() {
    isDraggingForMerge = false;

    // 标记拖拽刚结束，防止 click 事件穿透打开预览
    _mergeDragJustEnded = true;
    setTimeout(() => { _mergeDragJustEnded = false; }, 50);

    // 移除源卡片样式
    const dragCard = document.querySelector('.shot-card.dragging');
    if (dragCard) dragCard.classList.remove('dragging');

    // 移除目标卡片样式
    if (_mergeTargetCard) {
        _mergeTargetCard.classList.remove('merge-target', 'merge-forbidden');
        _mergeTargetCard = null;
    }
    // 清理所有残留的 merge 样式
    document.querySelectorAll('.shot-card.merge-target, .shot-card.merge-forbidden').forEach(c => {
        c.classList.remove('merge-target', 'merge-forbidden');
    });

    // 移除幽灵
    if (_mergeGhostEl) {
        _mergeGhostEl.remove();
        _mergeGhostEl = null;
    }

    // 移除全局监听
    document.removeEventListener('mousemove', onMergeDragMove);
    document.removeEventListener('mouseup', onMergeDragEnd);
    document.removeEventListener('keydown', onMergeDragKeyDown);
}

/**
 * 显示合并确认弹窗
 */
function showMergeConfirm(shotA, shotB) {
    // 确保 A 在前（按时间顺序）
    if (shotA.start_time > shotB.start_time) {
        [shotA, shotB] = [shotB, shotA];
    }

    const frameA = getFrameUrl(shotA);
    const frameB = getFrameUrl(shotB);
    const mergedDur = formatDuration(shotB.end_time - shotA.start_time);
    const timeRange = `${formatTimecode(shotA.start_time)} → ${formatTimecode(shotB.end_time)}`;

    // 检查是否不相邻（中间有其他镜头）
    const idxA = allShots.findIndex(s => s.id === shotA.id);
    const idxB = allShots.findIndex(s => s.id === shotB.id);
    const notAdjacent = Math.abs(idxA - idxB) > 1;

    const overlayDiv = document.createElement('div');
    overlayDiv.className = 'modal-overlay';
    overlayDiv.id = 'mergeConfirmOverlay';
    overlayDiv.innerHTML = `
        <div class="modal merge-modal" onclick="event.stopPropagation()">
            <h3>合并镜头</h3>
            <div class="merge-preview">
                <div class="merge-preview-shot">
                    <img src="${frameA}" alt="镜头 A">
                </div>
                <span class="merge-preview-arrow">→</span>
                <div class="merge-preview-shot">
                    <img src="${frameB}" alt="镜头 B">
                </div>
            </div>
            <div class="merge-info">
                合并后时间范围：${timeRange}<br>
                合并后时长：${mergedDur}
            </div>
            ${notAdjacent ? '<div class="merge-warning">⚠ 这两个镜头不相邻，合并后将覆盖中间的时间段</div>' : ''}
            <div class="merge-actions">
                <button class="btn-secondary" onclick="closeMergeConfirm()">取消</button>
                <button class="btn-primary" onclick="executeMerge('${shotA.id}', '${shotB.id}')">确认合并</button>
            </div>
        </div>
    `;
    overlayDiv.addEventListener('click', closeMergeConfirm);
    document.body.appendChild(overlayDiv);
}

/**
 * 关闭合并确认弹窗
 */
function closeMergeConfirm() {
    const overlay = document.getElementById('mergeConfirmOverlay');
    if (overlay) overlay.remove();
}

/**
 * 执行合并
 */
async function executeMerge(shotIdA, shotIdB) {
    closeMergeConfirm();
    showToast('正在合并镜头…');

    try {
        const result = await API.mergeShots(shotIdA, shotIdB);
        if (result.success) {
            // ★ 写入全局版本号，破除合并后新封面的浏览器缓存
            const mergedFrameFile = result.merged_shot && result.merged_shot.frame_file;
            if (mergedFrameFile && typeof bumpFrameVersion === 'function') {
                bumpFrameVersion(mergedFrameFile);
            }
            showToast('镜头合并成功', 'success');
            await loadShots();
            updateVideoSourceTags();
        } else {
            showToast(result.detail || '合并失败', 'error');
        }
    } catch (err) {
        console.error('合并镜头失败:', err);
        showToast('合并镜头失败', 'error');
    }
}

/**
 * 格式化时间码为 MM:SS.ms（用于合并弹窗）
 */
function formatTimecode(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

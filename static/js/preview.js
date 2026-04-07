/* ═══════════════════════════════════════════════════
   预览弹窗 — 参照 prototype 弹窗悬浮版
   布局：居中卡片 + 外置镜头时间轴
   ═══════════════════════════════════════════════════ */

let previewVideo = null;

/**
 * 打开预览弹窗
 */
function openPreview(shotId, index) {
    const shot = allShots.find(s => s.id === shotId);
    if (!shot) return;

    currentPreviewShot = shot;
    currentPreviewIndex = index;
    previewMode = 'play';

    const overlay = document.createElement('div');
    overlay.className = 'pv-overlay';
    overlay.id = 'previewOverlay';

    const duration = formatDuration(shot.duration || 0);
    const sourceFile = shot.source_video ? shot.source_video.split('/').pop() : '';

    overlay.innerHTML = `
        <!-- 预览容器 -->
        <div class="pv-container" onclick="event.stopPropagation()">
            <!-- 预览主窗口 -->
            <div class="pv-window">
                <!-- 关闭按钮 -->
                <button class="pv-close-btn" onclick="closePreview()">×</button>

                <!-- 播放器区域 -->
                <div class="pv-player-section">
                    <video id="previewVideoEl"
                           src="${getVideoUrl(shot.source_video)}#t=${shot.start_time},${shot.end_time}"
                           preload="metadata"
                           onclick="togglePreviewPlay()">
                    </video>

                    <!-- 镜头信息浮层 -->
                    <div class="pv-shot-info">
                        <div class="pv-shot-id">#${shot.index + 1}</div>
                        <div class="pv-shot-details">
                            <span class="pv-detail-item">⏱ ${duration}</span>
                            <span class="pv-detail-item">${shot.shot_type || ''}</span>
                            <span class="pv-detail-item" id="pvTimecodeOverlay">${shot.timecode_display || ''}</span>
                        </div>
                    </div>
                </div>

                <!-- 控制栏区域 -->
                <div class="pv-control-section">
                    <!-- 源视频进度条 -->
                    <div class="pv-progress-area">
                        <div class="pv-source-label">
                            <span>${sourceFile}</span>
                            <span class="pv-source-time" id="pvSourceTime">${secondsToTimecode(shot.start_time, fps)}</span>
                        </div>
                        <div class="pv-progressbar" id="pvProgressbar" onmousedown="onPvProgressDown(event)">
                            <!-- 当前镜头高亮范围 -->
                            <div class="pv-shot-range" id="pvShotRange"></div>
                            <!-- 入点标记 -->
                            <div class="pv-in-point" id="pvInPoint" title="入点"></div>
                            <!-- 出点标记 -->
                            <div class="pv-out-point" id="pvOutPoint" title="出点"></div>
                            <!-- 播放头 -->
                            <div class="pv-playhead" id="pvPlayhead"></div>
                        </div>
                    </div>

                    <!-- 控制按钮三栏布局 -->
                    <div class="pv-controls-grid">
                        <!-- 左栏: 播放控制 -->
                        <div class="pv-ctrl-group">
                            <button class="pv-play-btn" id="pvPlayBtn" onclick="event.stopPropagation();togglePreviewPlay()">▶</button>
                            <span class="pv-timecode" id="pvTimecode">${secondsToTimecode(shot.start_time, fps)}</span>
                        </div>

                        <!-- 中栏: 编辑操作 -->
                        <div class="pv-ctrl-group pv-ctrl-center">
                            <button class="pv-edit-btn" onclick="event.stopPropagation();setPlayheadAsIn()">⟦ 入点</button>
                            <button class="pv-edit-btn" onclick="event.stopPropagation();seekPreview(-0.5)">⏮ -0.5s</button>
                            <button class="pv-edit-btn" onclick="event.stopPropagation();copyCurrentFrame()">📋 复制静帧</button>
                            <button class="pv-edit-btn" onclick="event.stopPropagation();seekPreview(0.5)">+0.5s ⏭</button>
                            <button class="pv-edit-btn" onclick="event.stopPropagation();setPlayheadAsOut()">出点 ⟧</button>
                        </div>

                        <!-- 右栏: 操作 -->
                        <div class="pv-ctrl-group pv-ctrl-right">
                            <button class="pv-action-btn" id="pvFavBtn" onclick="event.stopPropagation();togglePreviewFavorite()">
                                ${shot.favorite ? '♥ 已收藏' : '♡ 收藏'}
                            </button>
                            <button class="pv-action-btn pv-action-primary" onclick="event.stopPropagation();exportCurrentShot()">⬇ 导出镜头</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 外置镜头时间轴 -->
            <div class="pv-timeline">
                <div class="pv-timeline-header">
                    <span class="pv-timeline-title" id="pvTimelineTitle">全部镜头 · ${index + 1} / ${allShots.length}</span>
                    <div class="pv-timeline-nav">
                        <button class="pv-nav-btn" onclick="event.stopPropagation();navigatePreview(-1)">‹</button>
                        <button class="pv-nav-btn" onclick="event.stopPropagation();navigatePreview(1)">›</button>
                    </div>
                </div>
                <div class="pv-timeline-track" id="pvTimelineTrack">
                    ${buildTimelineHTML(index)}
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // 获取视频元素
    previewVideo = document.getElementById('previewVideoEl');

    // 初始化裁剪点（默认 = 镜头入出点）
    trimStart = shot.start_time;
    trimEnd = shot.end_time;

    // 视频加载后设置进度条
    previewVideo.addEventListener('loadedmetadata', () => {
        previewVideo.currentTime = shot.start_time;
        updatePvProgress();
    });

    previewVideo.addEventListener('canplay', () => {
        previewVideo.play().catch(() => {});
    }, { once: true });

    // 更新进度
    previewVideo.addEventListener('timeupdate', onPvTimeUpdate);
    previewVideo.addEventListener('pause', () => updatePvPlayBtn(false));
    previewVideo.addEventListener('play', () => updatePvPlayBtn(true));
    previewVideo.addEventListener('ended', () => updatePvPlayBtn(false));

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePreview();
    });

    // 键盘事件
    document.addEventListener('keydown', onPreviewKeyDown);

    // 滚动时间轴使当前镜头居中
    requestAnimationFrame(() => {
        const track = document.getElementById('pvTimelineTrack');
        const activeItem = track?.querySelector('.pv-tl-frame.active');
        if (activeItem && track) {
            activeItem.scrollIntoView({ inline: 'center', behavior: 'instant' });
        }
    });
}

/**
 * 构建时间轴 HTML
 */
function buildTimelineHTML(currentIndex) {
    // 显示当前镜头前后各 8 个
    const start = Math.max(0, currentIndex - 8);
    const end = Math.min(allShots.length, currentIndex + 9);

    let html = '';
    for (let i = start; i < end; i++) {
        const s = allShots[i];
        const isActive = i === currentIndex;
        html += `
            <div class="pv-tl-frame ${isActive ? 'active' : ''}" 
                 onclick="event.stopPropagation();jumpToShot(${i})"
                 data-index="${i}">
                <div class="pv-tl-thumb">
                    <img src="${getFrameUrl(s.frame_file)}" alt="" loading="lazy">
                </div>
                <div class="pv-tl-info">
                    <div class="pv-tl-number">#${s.index + 1}</div>
                    <div class="pv-tl-tc">${s.timecode_display || ''}</div>
                </div>
            </div>
        `;
    }
    return html;
}

/**
 * 关闭预览
 */
function closePreview() {
    const overlay = document.getElementById('previewOverlay');
    if (overlay) {
        if (previewVideo) {
            previewVideo.pause();
            previewVideo = null;
        }
        overlay.remove();
    }

    currentPreviewShot = null;
    currentPreviewIndex = -1;
    previewMode = 'play';
    document.removeEventListener('keydown', onPreviewKeyDown);
}

/* ═══════════════════════════════════════════════════
   播放控制
   ═══════════════════════════════════════════════════ */

function togglePreviewPlay() {
    if (!previewVideo) return;

    if (previewVideo.paused) {
        if (currentPreviewShot && previewVideo.currentTime >= currentPreviewShot.end_time - 0.1) {
            previewVideo.currentTime = currentPreviewShot.start_time;
        }
        previewVideo.play().catch(() => {});
    } else {
        previewVideo.pause();
    }
}

function updatePvPlayBtn(isPlaying) {
    const btn = document.getElementById('pvPlayBtn');
    if (btn) btn.textContent = isPlaying ? '⏸' : '▶';
}

function seekPreview(offset) {
    if (!previewVideo || !currentPreviewShot) return;
    const newTime = Math.max(
        currentPreviewShot.start_time,
        Math.min(currentPreviewShot.end_time, previewVideo.currentTime + offset)
    );
    previewVideo.currentTime = newTime;
}

/* ═══════════════════════════════════════════════════
   进度条 & 时间更新
   ═══════════════════════════════════════════════════ */

function onPvTimeUpdate() {
    if (!previewVideo || !currentPreviewShot) return;

    const shot = currentPreviewShot;
    const current = previewVideo.currentTime;

    // 如果播放超过出点，暂停
    if (current >= shot.end_time) {
        previewVideo.pause();
        previewVideo.currentTime = shot.end_time;
        updatePvPlayBtn(false);
    }

    updatePvProgress();
}

function updatePvProgress() {
    if (!previewVideo || !currentPreviewShot) return;

    const shot = currentPreviewShot;
    const current = previewVideo.currentTime;
    const duration = shot.end_time - shot.start_time;

    if (duration <= 0) return;

    const percent = ((current - shot.start_time) / duration) * 100;
    const clampedPercent = Math.max(0, Math.min(100, percent));

    // 更新播放头
    const playhead = document.getElementById('pvPlayhead');
    if (playhead) playhead.style.left = `${clampedPercent}%`;

    // 更新镜头范围高亮（全宽，因为进度条就是这一个镜头的范围）
    const range = document.getElementById('pvShotRange');
    if (range) {
        range.style.left = '0%';
        range.style.width = '100%';
    }

    // 更新入出点标记位置
    const inPointPercent = ((trimStart - shot.start_time) / duration) * 100;
    const outPointPercent = ((trimEnd - shot.start_time) / duration) * 100;
    const inPoint = document.getElementById('pvInPoint');
    const outPoint = document.getElementById('pvOutPoint');
    if (inPoint) inPoint.style.left = `${Math.max(0, inPointPercent)}%`;
    if (outPoint) outPoint.style.left = `${Math.min(100, outPointPercent)}%`;

    // 更新时间码
    const tc = document.getElementById('pvTimecode');
    if (tc) tc.textContent = secondsToTimecode(current, fps);

    const srcTime = document.getElementById('pvSourceTime');
    if (srcTime) srcTime.textContent = secondsToTimecode(current, fps);
}

/**
 * 进度条拖拽
 */
function onPvProgressDown(e) {
    if (!previewVideo || !currentPreviewShot) return;
    e.preventDefault();

    const bar = document.getElementById('pvProgressbar');
    const rect = bar.getBoundingClientRect();

    function seek(clientX) {
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const shot = currentPreviewShot;
        const duration = shot.end_time - shot.start_time;
        previewVideo.currentTime = shot.start_time + ratio * duration;
    }

    seek(e.clientX);

    const onMove = (me) => seek(me.clientX);
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

/* ═══════════════════════════════════════════════════
   入出点 & 裁剪
   ═══════════════════════════════════════════════════ */

function setPlayheadAsIn() {
    if (!previewVideo || !currentPreviewShot) return;
    trimStart = Math.max(currentPreviewShot.start_time, Math.min(previewVideo.currentTime, trimEnd - 1/fps));
    updatePvProgress();
    showToast(`入点设为 ${secondsToTimecode(trimStart, fps)}`);
}

function setPlayheadAsOut() {
    if (!previewVideo || !currentPreviewShot) return;
    trimEnd = Math.max(trimStart + 1/fps, Math.min(previewVideo.currentTime, currentPreviewShot.end_time));
    updatePvProgress();
    showToast(`出点设为 ${secondsToTimecode(trimEnd, fps)}`);
}

/**
 * 保存裁剪（如果入出点有变化）
 */
async function saveTrimIfNeeded() {
    if (!currentPreviewShot) return;
    const shot = currentPreviewShot;
    // 只在入出点有变化时保存
    if (Math.abs(trimStart - shot.start_time) < 0.01 && Math.abs(trimEnd - shot.end_time) < 0.01) {
        return;
    }

    try {
        const result = await API.trimShot(shot.id, trimStart, trimEnd);
        if (result.success) {
            shot.start_time = result.start_time;
            shot.end_time = result.end_time;
            shot.duration = result.duration;

            const listShot = allShots.find(s => s.id === shot.id);
            if (listShot) {
                listShot.start_time = result.start_time;
                listShot.end_time = result.end_time;
                listShot.duration = result.duration;
            }
            showToast('裁剪已保存', 'success');
        }
    } catch (err) {
        showToast('保存裁剪失败', 'error');
    }
}

/* ═══════════════════════════════════════════════════
   复制静帧
   ═══════════════════════════════════════════════════ */

async function copyCurrentFrame() {
    if (!previewVideo) return;

    // 先暂停
    if (!previewVideo.paused) {
        previewVideo.pause();
    }

    try {
        const canvas = document.createElement('canvas');
        canvas.width = previewVideo.videoWidth;
        canvas.height = previewVideo.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(previewVideo, 0, 0);

        if (navigator.clipboard && navigator.clipboard.write) {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
            ]);
            showToast('静帧已复制到剪贴板', 'success');
        } else {
            const url = canvas.toDataURL('image/png');
            const a = document.createElement('a');
            a.href = url;
            a.download = `frame_${secondsToTimecode(previewVideo.currentTime, fps).replace(/:/g, '-')}.png`;
            a.click();
            showToast('已下载静帧（剪贴板不可用）', 'success');
        }
    } catch (err) {
        console.error('复制静帧失败:', err);
        showToast('复制静帧失败', 'error');
    }
}

/* ═══════════════════════════════════════════════════
   导航 & 收藏 & 导出
   ═══════════════════════════════════════════════════ */

function navigatePreview(direction) {
    const newIndex = currentPreviewIndex + direction;
    if (newIndex < 0 || newIndex >= allShots.length) return;

    // 先保存裁剪（如有变化）
    saveTrimIfNeeded();

    const newShot = allShots[newIndex];
    closePreview();
    setTimeout(() => openPreview(newShot.id, newIndex), 50);
}

function jumpToShot(index) {
    if (index === currentPreviewIndex) return;
    if (index < 0 || index >= allShots.length) return;

    saveTrimIfNeeded();

    const shot = allShots[index];
    closePreview();
    setTimeout(() => openPreview(shot.id, index), 50);
}

async function togglePreviewFavorite() {
    if (!currentPreviewShot) return;
    const newFav = !currentPreviewShot.favorite;
    await API.toggleFavorite(currentPreviewShot.id, newFav);
    currentPreviewShot.favorite = newFav;

    const btn = document.getElementById('pvFavBtn');
    if (btn) {
        btn.innerHTML = newFav ? '♥ 已收藏' : '♡ 收藏';
        btn.classList.toggle('pv-fav-active', newFav);
    }

    // 更新列表中的状态
    const shot = allShots.find(s => s.id === currentPreviewShot.id);
    if (shot) shot.favorite = newFav;

    // 局部更新网格中的卡片
    const card = document.querySelector(`.shot-card[data-shot-id="${currentPreviewShot.id}"]`);
    if (card) {
        card.classList.toggle('is-favorited', newFav);
        const cardBtn = card.querySelector('.shot-fav-btn');
        if (cardBtn) {
            cardBtn.classList.toggle('favorited', newFav);
            cardBtn.innerHTML = newFav ? '♥' : '♡';
        }
        // 常驻收藏标记
        const thumb = card.querySelector('.shot-thumb');
        const existingBadge = card.querySelector('.shot-fav-badge');
        if (newFav && !existingBadge && thumb) {
            const badge = document.createElement('div');
            badge.className = 'shot-fav-badge';
            badge.textContent = '♥';
            thumb.insertBefore(badge, thumb.querySelector('.shot-hover-overlay'));
        } else if (!newFav && existingBadge) {
            existingBadge.remove();
        }
    }
}

function exportCurrentShot() {
    if (!currentPreviewShot) return;
    // 选中当前镜头并打开导出
    selectedShots.clear();
    selectedShots.add(currentPreviewShot.id);
    closePreview();
    openExportPanel();
}

/* ═══════════════════════════════════════════════════
   键盘事件
   ═══════════════════════════════════════════════════ */

function onPreviewKeyDown(e) {
    switch (e.key) {
        case 'Escape':
            saveTrimIfNeeded();
            closePreview();
            break;
        case ' ':
            e.preventDefault();
            togglePreviewPlay();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            navigatePreview(-1);
            break;
        case 'ArrowRight':
            e.preventDefault();
            navigatePreview(1);
            break;
        case ',':
            e.preventDefault();
            seekPreview(-1 / fps);
            break;
        case '.':
            e.preventDefault();
            seekPreview(1 / fps);
            break;
        case 'i':
        case 'I':
            e.preventDefault();
            setPlayheadAsIn();
            break;
        case 'o':
        case 'O':
            e.preventDefault();
            setPlayheadAsOut();
            break;
    }
}

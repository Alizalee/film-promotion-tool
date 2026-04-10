/* ═══════════════════════════════════════════════════
   预览弹窗 — 参照 prototype 弹窗悬浮版
   布局：居中卡片 + 外置镜头时间轴
   ═══════════════════════════════════════════════════ */

let previewVideo = null;

/**
 * ★ 构图信息 HTML（裁头/安全区/头顶余量/黑边）
 */
function buildCompositionHTML(shot) {
    if (shot.face_count === undefined || shot.face_count === 0) return '';
    const cropped = shot.face_cropped ? '<span style="color:#e74c3c">裁头 ✗</span>' : '<span style="color:#2ecc71">裁头 ✓</span>';
    const safe = shot.face_in_safe_zone === false ? '<span style="color:#e74c3c">安全区 ✗</span>' : '<span style="color:#2ecc71">安全区 ✓</span>';
    const margin = shot.head_margin_ratio !== undefined ? `头顶余量 ${shot.head_margin_ratio.toFixed(2)}` : '';
    const blackBars = shot.has_black_bars ? '黑边: 是' : '黑边: 否';
    const issue = shot.composition_issue ? `<span style="color:#e67e22;margin-left:6px">⚠ ${shot.composition_issue}</span>` : '';
    return `<span class="pv-debug-label">构图:</span> ${cropped} &nbsp; ${safe} &nbsp; ${margin} &nbsp; ${blackBars}${issue}`;
}

/**
 * ★ 分类推理行 — 前端反推分类逻辑，生成可读推理文案
 * 阈值与 constants.py 保持一致：0.07% / 0.7% / 7%
 */
function buildClassifyReason(shot) {
    if (shot.face_ratio === undefined) return '';
    const fr = shot.face_ratio;
    const frPct = (fr * 100).toFixed(2);
    const fc = shot.face_count || 0;
    const cropped = shot.face_cropped || false;
    const safe = shot.face_in_safe_zone !== false;

    // 阈值（与 Python 端一致）
    const DISTANT_MIN = 0.0007;  // 0.07%
    const TIER_LOW = 0.007;      // 0.7%
    const TIER_HIGH = 0.07;      // 7%

    let reason = `FR最优帧 ${frPct}%`;

    if (fr > TIER_HIGH) {
        reason += ` > 7% → 近景人像`;
    } else if (fr >= TIER_LOW) {
        reason += ` ∈ 黄金区间[0.7%, 7%]`;
        if (cropped || !safe) {
            const issues = [];
            if (cropped) issues.push('裁头');
            if (!safe) issues.push('贴边');
            reason += ` → 构图${issues.join('+')}升级 → 近景人像`;
        } else {
            reason += ` + 构图合格 → 黄金人像`;
        }
    } else if (fr >= DISTANT_MIN) {
        reason += ` ∈ [0.07%, 0.7%) → 远景人像`;
    } else {
        if (fc > 0) {
            reason += ` < 0.07% 但有脸 → 远景人像`;
        } else {
            reason += ` < 0.07% 且无脸 → 空镜`;
        }
    }

    return `<span class="pv-debug-label">推理:</span> <span class="pv-debug-value">${reason}</span>`;
}

/**
 * ★ 差异标注 HTML — 比较两个数值，返回带箭头的差异标签
 */
function buildDiffTag(current, prev, isPercent) {
    if (prev === undefined || prev === null || current === undefined || current === null) return '';
    const diff = current - prev;
    if (Math.abs(diff) < 0.0001) return '<span class="pv-debug-diff pv-debug-diff-same">＝</span>';
    const arrow = diff > 0 ? '↑' : '↓';
    const cls = diff > 0 ? 'pv-debug-diff-up' : 'pv-debug-diff-down';
    const val = isPercent ? (Math.abs(diff) * 100).toFixed(2) + '%' : Math.abs(diff);
    return `<span class="pv-debug-diff ${cls}">${arrow}${val}</span>`;
}

/**
 * ★ 构建调试面板完整 HTML（含差异标注）
 */
function buildDebugPanelBodyHTML(shot, prevShot) {
    const fc = shot.face_count !== undefined ? shot.face_count : '?';
    const fr = shot.face_ratio !== undefined ? (shot.face_ratio * 100).toFixed(2) + '%' : '?';
    const hasPerson = shot.has_person ? '是' : '否';

    const diffFC = prevShot ? buildDiffTag(shot.face_count, prevShot.face_count, false) : '';
    const diffFR = prevShot ? buildDiffTag(shot.face_ratio, prevShot.face_ratio, true) : '';

    const composition = buildCompositionHTML(shot);
    const reason = buildClassifyReason(shot);

    let perFrameHTML = '';
    if (shot.per_frame_debug && Object.keys(shot.per_frame_debug).length > 0) {
        const entries = Object.entries(shot.per_frame_debug);
        perFrameHTML = entries.map(([fn, info]) => {
            return `<span class="pv-debug-frame">F${fn}: 脸${info.face_count} FR${(info.face_ratio * 100).toFixed(1)}%</span>`;
        }).join('');
    }

    return `
        <div class="pv-debug-row">
            <span class="pv-debug-label">分类:</span>
            <span class="pv-debug-value pv-debug-highlight">${shot.shot_type || '未分类'}</span>
            <span class="pv-debug-label">有人:</span>
            <span class="pv-debug-value">${hasPerson}</span>
        </div>
        <div class="pv-debug-row">
            <span class="pv-debug-label">人脸数:</span>
            <span class="pv-debug-value">${fc}${diffFC}</span>
            <span class="pv-debug-label">人脸占比:</span>
            <span class="pv-debug-value">${fr}${diffFR}</span>
        </div>
        ${composition ? `<div class="pv-debug-row">${composition}</div>` : ''}
        ${reason ? `<div class="pv-debug-row pv-debug-reason">${reason}</div>` : ''}
        ${perFrameHTML ? `<div class="pv-debug-section-title">逐帧详情</div><div class="pv-debug-row pv-debug-per-frame">${perFrameHTML}</div>` : ''}
    `;
}

/**
 * ★ 切换调试面板显示/隐藏
 */
function toggleDebugPanel() {
    debugPanelVisible = !debugPanelVisible;
    localStorage.setItem('pv_debug_visible', debugPanelVisible ? 'true' : 'false');
    const panel = document.querySelector('.pv-debug-panel');
    if (panel) {
        panel.classList.toggle('visible', debugPanelVisible);
    }
    if (debugPanelVisible) {
        showToast('调试面板已开启', 'success');
    } else {
        showToast('调试面板已关闭');
    }
}

/**
 * ★ 三连击标题检测 — 500ms 内点击 3 次触发
 */
function onDebugTitleClick() {
    const now = Date.now();
    titleClickTimestamps.push(now);
    // 只保留最近 3 次
    if (titleClickTimestamps.length > 3) {
        titleClickTimestamps = titleClickTimestamps.slice(-3);
    }
    if (titleClickTimestamps.length === 3) {
        const span = titleClickTimestamps[2] - titleClickTimestamps[0];
        if (span <= 500) {
            toggleDebugPanel();
            titleClickTimestamps = [];
        }
    }
}

// 同源视频镜头列表（按时间排序），用于时间轴展示
let sameSourceShots = [];
let sameSourceIndex = -1;  // 当前镜头在 sameSourceShots 中的索引

/**
 * 获取同源视频的所有镜头（按时间排序）
 */
async function loadSameSourceShots(sourceVideo, currentShotId) {
    try {
        const data = await API.getShots({ sort: 'time', source_video: sourceVideo });
        sameSourceShots = data.shots || [];
        sameSourceIndex = sameSourceShots.findIndex(s => s.id === currentShotId);
    } catch (err) {
        console.error('加载同源镜头失败:', err);
        // fallback：从 allShots 中筛选同源镜头
        sameSourceShots = allShots
            .filter(s => s.source_video === sourceVideo)
            .sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
        sameSourceIndex = sameSourceShots.findIndex(s => s.id === currentShotId);
    }
}

/**
 * 打开预览弹窗
 */
async function openPreview(shotId, index) {
    const shot = allShots.find(s => s.id === shotId);
    if (!shot) return;

    currentPreviewShot = shot;
    currentPreviewIndex = index;
    previewMode = 'play';

    // 加载同源视频镜头（异步，先用空时间轴，加载完后刷新）
    sameSourceShots = [];
    sameSourceIndex = -1;

    const overlay = document.createElement('div');
    overlay.className = 'pv-overlay';
    overlay.id = 'previewOverlay';

    const duration = formatDuration(shot.duration || 0);
    const sourceFile = shot.source_video ? shot.source_video.split('/').pop() : '';

    // 重置差异对比的前一镜头
    prevDebugShot = null;

    // 判断列表导航是否可用
    const navPrevDisabled = index <= 0;
    const navNextDisabled = index < 0 || index >= allShots.length - 1;

    overlay.innerHTML = `
        <!-- 弹窗外左箭头 -->
        <button class="pv-outer-nav pv-outer-prev" id="pvNavPrev" onclick="event.stopPropagation();navigatePreview(-1)" title="上一镜头 (←)" ${navPrevDisabled ? 'disabled' : ''}>‹</button>

        <!-- 预览容器 -->
        <div class="pv-container" onclick="event.stopPropagation()">
            <div class="pv-window" id="pvWindow">
                <!-- 关闭按钮 -->
                <button class="pv-close-btn" onclick="closePreview()">×</button>

                <!-- 顶部标题（视频左上角浮动标签） -->
                <div class="pv-header">
                    <div class="pv-header-title" id="pvHeaderTitle">
                        <span class="shot-num">#${shot.index + 1}</span>
                        <span style="color:var(--text-tertiary)">·</span>
                        <span class="shot-dur">${duration}</span>
                        <span style="color:var(--text-tertiary)">·</span>
                        <span class="shot-label">${shot.shot_type || ''}</span>
                        <span class="edit-badge">编辑中</span>
                    </div>
                    <button class="pv-btn-mute" id="pvMuteBtn" onclick="event.stopPropagation();togglePreviewMute()" title="静音 (M)">${pvMuted ? '🔇' : '🔊'}</button>
                    <button class="pv-btn-speed ${pvPlaybackRate !== 1 ? 'is-speed-changed' : ''}" id="pvSpeedBtn" onclick="event.stopPropagation();cyclePlaybackRate()" title="倍速 (R)">${pvPlaybackRate === 1 ? '1x' : pvPlaybackRate + 'x'}</button>
                </div>

                <!-- 播放器区域 -->
                <div class="pv-player-section" id="pvPlayerSection" onclick="togglePreviewPlay()">
                    <video id="previewVideoEl"
                           src="${getVideoUrl(shot.source_video, shot.id)}"
                           preload="metadata">
                    </video>

                    <!-- 播放覆盖图标 -->
                    <div class="pv-play-overlay" id="pvPlayOverlay">▶</div>
                </div>

                <!-- 控制栏区域 -->
                <div class="pv-control-section">

                    <!-- 固定高度时间轴容器 -->
                    <div class="pv-timeline-area">

                        <!-- 缩略图条 -->
                        <div class="pv-thumb-strip" id="pvTimelineTrack"></div>

                        <!-- 信息行 -->
                        <div class="pv-info-row">
                            <span class="filename">${sourceFile}</span>
                            <span class="nav-label" id="pvNavLabel">${index + 1} / ${allShots.length}</span>
                            <span class="timecode" id="pvTimecode"><span class="tc-current">${secondsToTimecode(shot.start_time, fps)}</span><span class="tc-sep">/</span><span class="tc-total">00:00:00:00</span></span>
                        </div>

                        <!-- 进度条（固定高度容器） -->
                        <div class="pv-progress-wrap">
                            <div class="pv-progressbar" id="pvProgressbar" onmousedown="onPvProgressDown(event)">
                                <div class="pv-timeline-ticks" id="pvTimelineTicks"></div>
                                <div class="pv-shot-range" id="pvShotRange"></div>
                                <div class="pv-trim-range" id="pvTrimRange"></div>
                                <div class="pv-trim-handle pv-trim-handle-in" id="pvTrimIn" onmousedown="onTrimHandleDown(event,'in')"></div>
                                <div class="pv-trim-handle pv-trim-handle-out" id="pvTrimOut" onmousedown="onTrimHandleDown(event,'out')"></div>
                                <div class="pv-playhead" id="pvPlayhead"></div>
                            </div>
                        </div>

                    </div><!-- /.pv-timeline-area -->

                    <!-- 操作栏：三栏 grid，叠层切换 -->
                    <div class="pv-toolbar">
                        <!-- 左栏 — 叠层切换 -->
                        <div class="pv-toolbar-group pv-toolbar-left">
                            <div class="pv-layer pv-layer-preview">
                                <button class="pv-btn pv-btn-edit-entry" onclick="event.stopPropagation();enterEditMode()">✎ 编辑镜头</button>
                                <button class="pv-btn pv-btn-fav" id="pvFavBtn" onclick="event.stopPropagation();togglePreviewFavorite()">${shot.favorite ? '♥ 已收藏' : '♡ 收藏'}</button>
                            </div>
                            <div class="pv-layer pv-layer-edit">
                                <button class="pv-btn pv-btn-ghost" onclick="event.stopPropagation();exitEditMode(false)">取消</button>
                                <button class="pv-btn pv-btn-danger" onclick="event.stopPropagation();splitCurrentShot()">✂ 拆分</button>
                            </div>
                        </div>

                        <!-- 中栏 — 播控固定不动 -->
                        <div class="pv-toolbar-group pv-toolbar-center">
                            <button class="pv-btn pv-btn-inout pv-edit-only" onclick="event.stopPropagation();setPlayheadAsIn()">⟦ 入点</button>
                            <button class="pv-btn" onclick="event.stopPropagation();seekPreview(-0.5)">-0.5s</button>
                            <button class="pv-btn" onclick="event.stopPropagation();seekPreview(-1/fps)">◀1帧</button>
                            <button class="pv-play-btn" id="pvPlayBtn" onclick="event.stopPropagation();togglePreviewPlay()">▶</button>
                            <button class="pv-btn" onclick="event.stopPropagation();seekPreview(1/fps)">1帧▶</button>
                            <button class="pv-btn" onclick="event.stopPropagation();seekPreview(0.5)">+0.5s</button>
                            <button class="pv-btn pv-btn-inout pv-edit-only" onclick="event.stopPropagation();setPlayheadAsOut()">出点 ⟧</button>
                        </div>

                        <!-- 右栏 — 叠层切换 -->
                        <div class="pv-toolbar-group pv-toolbar-right">
                            <div class="pv-layer pv-layer-preview">
                                <button class="pv-btn" onclick="event.stopPropagation();copyCurrentFrame()">📋 复制帧</button>
                                <button class="pv-btn pv-btn-primary" onclick="event.stopPropagation();exportCurrentShot()">⬇ 导出镜头</button>
                            </div>
                            <div class="pv-layer pv-layer-edit">
                                <button class="pv-btn pv-btn-save" onclick="event.stopPropagation();saveEdit()">保存镜头</button>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>

        <!-- 弹窗外右箭头 -->
        <button class="pv-outer-nav pv-outer-next" id="pvNavNext" onclick="event.stopPropagation();navigatePreview(1)" title="下一镜头 (→)" ${navNextDisabled ? 'disabled' : ''}>›</button>

        <!-- 调试信息侧边面板 -->
        <div class="pv-debug-panel ${debugPanelVisible ? 'visible' : ''}" onclick="event.stopPropagation()">
            <div class="pv-debug-panel-header">
                <span class="pv-debug-panel-title">调试信息</span>
                <button class="pv-debug-panel-close" onclick="toggleDebugPanel()">×</button>
            </div>
            <div class="pv-debug-panel-body">
                ${buildDebugPanelBodyHTML(shot, null)}
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // 绑定三连击标题开关调试面板
    const headerTitle = document.getElementById('pvHeaderTitle');
    if (headerTitle) {
        headerTitle.addEventListener('click', onDebugTitleClick);
        headerTitle.style.cursor = 'default';  // 不暴露可点击暗示
    }

    // 获取视频元素
    previewVideo = document.getElementById('previewVideoEl');

    // 应用静音状态
    previewVideo.muted = pvMuted;

    // 应用倍速
    previewVideo.playbackRate = pvPlaybackRate;

    // 初始化裁剪点（默认 = 镜头入出点）
    // ★ 只有当源视频不存在时才走 clip 模式（clip 时间从 0 开始）
    // 源视频存在时，后端 /api/video 返回源视频，必须用源视频时间体系
    const isClip = !!shot.clip_file && !shot.source_video_exists;
    trimStart = isClip ? 0 : shot.start_time;
    trimEnd = isClip ? shot.duration : shot.end_time;

    // 视频加载后设置进度条窗口范围
    previewVideo.addEventListener('loadedmetadata', () => {
        const totalDur = previewVideo.duration || 1;
        if (isClip) {
            viewStart = 0;
            viewEnd = totalDur;
        } else {
            viewStart = Math.max(0, shot.start_time - 5);
            viewEnd = Math.min(totalDur, shot.end_time + 5);
            // 确保窗口至少有一定宽度
            if (viewEnd - viewStart < 1) {
                viewStart = Math.max(0, shot.start_time - 0.5);
                viewEnd = Math.min(totalDur, shot.end_time + 0.5);
            }
        }
        previewVideo.currentTime = isClip ? 0 : shot.start_time;
        // 更新总时长时间码
        const tcTotal = document.querySelector('#pvTimecode .tc-total');
        if (tcTotal) tcTotal.textContent = secondsToTimecode(totalDur, fps);
        updatePvProgress();
    });

    previewVideo.addEventListener('canplay', () => {
        previewVideo.play().catch(() => {});
    }, { once: true });

    // ★ 视频加载失败时显示提示（源视频和 clip 都不可用）
    previewVideo.addEventListener('error', () => {
        const playerSection = document.querySelector('.pv-player-section');
        if (playerSection && !playerSection.querySelector('.pv-video-error')) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'pv-video-error';
            errorDiv.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);color:var(--text-secondary);font-size:14px;text-align:center;padding:20px;';
            errorDiv.innerHTML = '视频文件不可用<br><span style="font-size:12px;color:var(--text-tertiary)">源视频已删除且预裁剪文件丢失</span>';
            playerSection.appendChild(errorDiv);
        }
    }, { once: true });

    // 更新进度
    previewVideo.addEventListener('timeupdate', onPvTimeUpdate);
    previewVideo.addEventListener('pause', () => {
        updatePvPlayBtn(false);
        stopBoundaryWatch();
    });
    previewVideo.addEventListener('play', () => {
        updatePvPlayBtn(true);
        startBoundaryWatch();
    });
    previewVideo.addEventListener('ended', () => {
        updatePvPlayBtn(false);
        stopBoundaryWatch();
    });

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePreview();
    });

    // 键盘事件
    document.addEventListener('keydown', onPreviewKeyDown);

    // 异步加载同源视频镜头并刷新时间轴
    if (shot.source_video) {
        loadSameSourceShots(shot.source_video, shot.id).then(() => {
            refreshTimeline();
        });
    }

    // 滚动缩略图条使当前镜头居中
    requestAnimationFrame(() => {
        const track = document.getElementById('pvTimelineTrack');
        const activeItem = track?.querySelector('.pv-strip-thumb.active');
        if (activeItem && track) {
            activeItem.scrollIntoView({ inline: 'center', behavior: 'instant' });
        }
    });

    // 初始化缩略图条拖拽滚动
    initThumbDrag();
}

/**
 * 构建缩略图条 HTML（基于同源视频镜头，按时间顺序，只展示缩略图）
 */
function buildTimelineHTML() {
    if (sameSourceShots.length === 0) {
        return '';
    }

    const currentIdx = sameSourceIndex;

    let html = '';
    // 前置占位 spacer，使第一个镜头也能通过 scrollIntoView 居中
    html += '<div class="pv-strip-spacer"></div>';

    for (let i = 0; i < sameSourceShots.length; i++) {
        const s = sameSourceShots[i];
        const isActive = i === currentIdx;
        html += `
            <div class="pv-strip-thumb ${isActive ? 'active' : ''}" 
                 onclick="event.stopPropagation();jumpToSameSourceShot(${i})"
                 data-index="${i}"
                 title="#${s.index + 1} · ${s.timecode_display || ''}">
                <img src="${getFrameUrl(s.frame_file)}" alt="" loading="lazy">
            </div>
        `;
    }

    // 后置占位 spacer
    html += '<div class="pv-strip-spacer"></div>';
    return html;
}

/**
 * 刷新缩略图条内容
 */
function refreshTimeline() {
    const track = document.getElementById('pvTimelineTrack');

    if (track) {
        track.innerHTML = buildTimelineHTML();
    }

    // 滚动缩略图条使当前镜头居中
    requestAnimationFrame(() => {
        const track = document.getElementById('pvTimelineTrack');
        const activeItem = track?.querySelector('.pv-strip-thumb.active');
        if (activeItem && track) {
            activeItem.scrollIntoView({ inline: 'center', behavior: 'smooth' });
        }
    });
}

/**
 * 关闭预览
 */
function closePreview() {
    stopBoundaryWatch();
    // 如果在编辑模式，先退出（不保存）
    if (pvEditMode) {
        pvEditMode = false;
        const pvWindow = document.getElementById('pvWindow');
        if (pvWindow) pvWindow.classList.remove('edit-mode');
    }
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
    pvEditMode = false;
    sameSourceShots = [];
    sameSourceIndex = -1;
    ticksInitialized = false;
    prevDebugShot = null;
    titleClickTimestamps = [];
    document.removeEventListener('keydown', onPreviewKeyDown);
}

/* ═══════════════════════════════════════════════════
   播放控制
   ═══════════════════════════════════════════════════ */

function togglePreviewPlay() {
    if (!previewVideo) return;

    if (previewVideo.paused) {
        // 如果当前位置在出点附近或之后，回到入点重新播放
        if (previewVideo.currentTime >= trimEnd - 0.1) {
            previewVideo.currentTime = trimStart;
        }
        previewVideo.play().catch(() => {});
    } else {
        previewVideo.pause();
    }
}

/* ═══════════════════════════════════════════════════
   倍速控制
   ═══════════════════════════════════════════════════ */

const SPEED_OPTIONS = [1, 1.5, 2, 0.5];

/**
 * 循环切换倍速
 */
function cyclePlaybackRate() {
    const currentIdx = SPEED_OPTIONS.indexOf(pvPlaybackRate);
    const nextIdx = (currentIdx + 1) % SPEED_OPTIONS.length;
    pvPlaybackRate = SPEED_OPTIONS[nextIdx];
    localStorage.setItem('pv_playback_rate', pvPlaybackRate);

    if (previewVideo) {
        previewVideo.playbackRate = pvPlaybackRate;
    }
    updateSpeedBtn();
    showToast(`播放倍速: ${pvPlaybackRate}x`);
}

/**
 * 更新倍速按钮显示
 */
function updateSpeedBtn() {
    const btn = document.getElementById('pvSpeedBtn');
    if (btn) {
        btn.textContent = pvPlaybackRate === 1 ? '1x' : pvPlaybackRate + 'x';
        btn.classList.toggle('is-speed-changed', pvPlaybackRate !== 1);
    }
}

/**
 * 切换预览静音
 */
function togglePreviewMute() {
    if (!previewVideo) return;
    pvMuted = !pvMuted;
    previewVideo.muted = pvMuted;
    updateMuteBtn();
}

/**
 * 更新静音按钮图标
 */
function updateMuteBtn() {
    const btn = document.getElementById('pvMuteBtn');
    if (btn) {
        btn.textContent = pvMuted ? '🔇' : '🔊';
        btn.classList.toggle('is-muted', pvMuted);
        btn.title = pvMuted ? '取消静音 (M)' : '静音 (M)';
    }
}

function updatePvPlayBtn(isPlaying) {
    const btn = document.getElementById('pvPlayBtn');
    const text = isPlaying ? '⏸' : '▶';
    if (btn) {
        btn.textContent = text;
        btn.classList.toggle('is-playing', isPlaying);
    }

    // 播放覆盖图标联动
    const overlay = document.getElementById('pvPlayOverlay');
    if (overlay) overlay.textContent = text;

    // playerSection playing class
    const player = document.getElementById('pvPlayerSection');
    if (player) player.classList.toggle('playing', isPlaying);
}

function seekPreview(offset) {
    if (!previewVideo) return;
    // 点击步进按钮时先暂停播放
    if (!previewVideo.paused) {
        previewVideo.pause();
    }
    const totalDur = previewVideo.duration || 1;
    const newTime = Math.max(0, Math.min(totalDur, previewVideo.currentTime + offset));
    previewVideo.currentTime = newTime;
    updatePvProgress();
}

/* ═══════════════════════════════════════════════════
   进度条 & 时间更新
   ═══════════════════════════════════════════════════ */

function onPvTimeUpdate() {
    if (!previewVideo || !currentPreviewShot) return;
    updatePvProgress();
}

/**
 * 使用 requestAnimationFrame 高频检测出点边界
 * timeupdate 事件约 4Hz，不够精确，容易播放到下一个镜头的帧
 * rAF 约 60Hz，可以在出点前及时暂停
 */
function startBoundaryWatch() {
    stopBoundaryWatch();

    function check() {
        if (!previewVideo || !currentPreviewShot) {
            pvBoundaryRAF = null;
            return;
        }

        // 仅在播放状态下检测
        if (!previewVideo.paused && !isSeeking) {
            const current = previewVideo.currentTime;
            // 提前半帧的时间量暂停，避免解码出下一帧
            const halfFrame = 1 / (fps * 2);
            if (current >= trimEnd - halfFrame) {
                previewVideo.pause();
                // 精确停在出点前最后一帧
                previewVideo.currentTime = Math.max(trimStart, trimEnd - 1 / fps);
                updatePvPlayBtn(false);
                updatePvProgress();
                pvBoundaryRAF = null;
                return;
            }
        }

        pvBoundaryRAF = requestAnimationFrame(check);
    }

    pvBoundaryRAF = requestAnimationFrame(check);
}

function stopBoundaryWatch() {
    if (pvBoundaryRAF !== null) {
        cancelAnimationFrame(pvBoundaryRAF);
        pvBoundaryRAF = null;
    }
}

function updatePvProgress() {
    if (!previewVideo || !currentPreviewShot) return;

    const shot = currentPreviewShot;
    const current = previewVideo.currentTime;
    const windowDur = viewEnd - viewStart;

    if (windowDur <= 0) return;

    // 辅助函数：将绝对时间转为窗口内百分比
    function toPercent(t) {
        return ((t - viewStart) / windowDur) * 100;
    }

    // 播放头 — 相对窗口范围
    const playheadPercent = toPercent(current);
    const playhead = document.getElementById('pvPlayhead');
    if (playhead) playhead.style.left = `${Math.max(0, Math.min(100, playheadPercent))}%`;

    // 镜头高亮区域 — 相对窗口范围
    // ★ 只有源视频不存在时才用 clip 模式的时间体系（0 到 duration）
    const isClipShot = !!shot.clip_file && !shot.source_video_exists;
    const shotStart = isClipShot ? 0 : shot.start_time;
    const shotEnd = isClipShot ? shot.duration : shot.end_time;
    const shotLeftPercent = toPercent(shotStart);
    const shotRightPercent = toPercent(shotEnd);
    const shotWidthPercent = shotRightPercent - shotLeftPercent;
    const range = document.getElementById('pvShotRange');
    if (range) {
        range.style.left = `${Math.max(0, shotLeftPercent)}%`;
        range.style.width = `${Math.min(100, shotWidthPercent)}%`;
    }

    // 入出点之间的裁剪范围高亮 — 相对窗口范围
    const trimLeftPercent = toPercent(trimStart);
    const trimRightPercent = toPercent(trimEnd);
    const trimWidthPercent = trimRightPercent - trimLeftPercent;
    const trimRange = document.getElementById('pvTrimRange');
    if (trimRange) {
        trimRange.style.left = `${Math.max(0, trimLeftPercent)}%`;
        trimRange.style.width = `${Math.min(100 - Math.max(0, trimLeftPercent), trimWidthPercent)}%`;
    }

    // 入出点拉手位置 — 相对窗口范围
    const inPercent = toPercent(trimStart);
    const outPercent = toPercent(trimEnd);
    const trimIn = document.getElementById('pvTrimIn');
    const trimOut = document.getElementById('pvTrimOut');
    if (trimIn) trimIn.style.left = `${Math.max(0, Math.min(100, inPercent))}%`;
    if (trimOut) trimOut.style.left = `${Math.max(0, Math.min(100, outPercent))}%`;

    // 更新时间码（统一入口：信息行中 tc-current）
    const tcCurrent = document.querySelector('#pvTimecode .tc-current');
    if (tcCurrent) tcCurrent.textContent = secondsToTimecode(current, fps);
}

/**
 * 进度条拖拽
 */
function onPvProgressDown(e) {
    if (!previewVideo || !currentPreviewShot) return;
    // 如果点击的是拉手，不处理（由 onTrimHandleDown 处理）
    if (e.target.classList.contains('pv-trim-handle') ||
        e.target.classList.contains('pv-trim-handle-in') ||
        e.target.classList.contains('pv-trim-handle-out')) return;
    e.preventDefault();

    isSeeking = true;

    const bar = document.getElementById('pvProgressbar');
    const rect = bar.getBoundingClientRect();

    function seek(clientX) {
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        // 映射到窗口范围 [viewStart, viewEnd]
        previewVideo.currentTime = viewStart + ratio * (viewEnd - viewStart);
        updatePvProgress();
    }

    seek(e.clientX);

    const onMove = (me) => seek(me.clientX);
    const onUp = () => {
        isSeeking = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

/* ═══════════════════════════════════════════════════
   编辑模式：入出点 & 裁剪 & 拆分
   ═══════════════════════════════════════════════════ */

/**
 * 进入编辑模式 — CSS class 驱动
 */
function enterEditMode() {
    if (!currentPreviewShot || pvEditMode) return;

    pvEditMode = true;
    // 记录原始入出点，取消时恢复
    pvEditOrigTrimStart = trimStart;
    pvEditOrigTrimEnd = trimEnd;

    // ★ CSS class 驱动模式切换
    const pvWindow = document.getElementById('pvWindow');
    if (pvWindow) pvWindow.classList.add('edit-mode');

    // 初始化时间轴刻度线（只生成一次）
    initTimelineTicks();

    updatePvProgress();
    showToast('已进入编辑模式 — 可调整入出点或拆分镜头');
}

/**
 * 退出编辑模式 — CSS class 驱动
 * @param {boolean} saved - 是否已保存（false = 取消，恢复原始值）
 */
function exitEditMode(saved) {
    if (!pvEditMode) return;

    pvEditMode = false;

    if (!saved) {
        // 取消 → 恢复原始入出点
        trimStart = pvEditOrigTrimStart;
        trimEnd = pvEditOrigTrimEnd;
    }

    // ★ CSS class 驱动模式切换
    const pvWindow = document.getElementById('pvWindow');
    if (pvWindow) pvWindow.classList.remove('edit-mode');

    updatePvProgress();
}

/**
 * 保存编辑（入出点裁剪）
 */
async function saveEdit() {
    if (!currentPreviewShot) return;

    const shot = currentPreviewShot;
    const isClipShot = !!shot.clip_file && !shot.source_video_exists;
    const baseStart = isClipShot ? 0 : shot.start_time;
    const baseEnd = isClipShot ? shot.duration : shot.end_time;

    // 检查是否有变化
    if (Math.abs(trimStart - baseStart) < 0.01 && Math.abs(trimEnd - baseEnd) < 0.01) {
        showToast('入出点未修改');
        exitEditMode(true);
        return;
    }

    // clip_file 镜头不支持二次裁剪
    if (isClipShot) {
        showToast('独立片段不支持二次裁剪', 'error');
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

            // 更新标题栏时长
            const shotDur = document.querySelector('.pv-header-title .shot-dur');
            if (shotDur) shotDur.textContent = formatDuration(result.duration);

            showToast('裁剪已保存 ✓', 'success');
            exitEditMode(true);
        }
    } catch (err) {
        showToast('保存裁剪失败', 'error');
    }
}

/**
 * 设置入点
 */
function setPlayheadAsIn() {
    if (!previewVideo) return;
    trimStart = Math.max(0, Math.min(previewVideo.currentTime, trimEnd - 1/fps));
    updatePvProgress();
    showToast(`入点设为 ${secondsToTimecode(trimStart, fps)}`);
}

/**
 * 设置出点
 */
function setPlayheadAsOut() {
    if (!previewVideo) return;
    const totalDur = previewVideo.duration || 1;
    trimEnd = Math.max(trimStart + 1/fps, Math.min(previewVideo.currentTime, totalDur));
    updatePvProgress();
    showToast(`出点设为 ${secondsToTimecode(trimEnd, fps)}`);
}

/**
 * 保存裁剪（兼容旧的调用入口，如导出前自动保存）
 */
async function saveTrimIfNeeded() {
    if (!currentPreviewShot) return;
    const shot = currentPreviewShot;

    const isClipShot = !!shot.clip_file && !shot.source_video_exists;
    const baseStart = isClipShot ? 0 : shot.start_time;
    const baseEnd = isClipShot ? shot.duration : shot.end_time;

    if (Math.abs(trimStart - baseStart) < 0.01 && Math.abs(trimEnd - baseEnd) < 0.01) {
        return;
    }

    if (isClipShot) {
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
   拆分镜头
   ═══════════════════════════════════════════════════ */

/**
 * 拆分当前镜头：在当前播放头位置将镜头一分为二
 */
async function splitCurrentShot() {
    if (!currentPreviewShot || !previewVideo) return;

    const shot = currentPreviewShot;
    const splitTime = previewVideo.currentTime;

    // 校验：播放头必须在镜头范围内（且不在起止点附近）
    const minGap = 2 / fps; // 至少 2 帧
    if (splitTime <= shot.start_time + minGap || splitTime >= shot.end_time - minGap) {
        showToast('播放头需在镜头范围内（且距头尾至少2帧）', 'error');
        return;
    }

    // clip 模式镜头不支持拆分
    const isClipShot = !!shot.clip_file && !shot.source_video_exists;
    if (isClipShot) {
        showToast('独立片段不支持拆分', 'error');
        return;
    }

    // 显示确认弹窗
    const splitTimeStr = secondsToTimecode(splitTime, fps);
    const partADur = formatDuration(splitTime - shot.start_time);
    const partBDur = formatDuration(shot.end_time - splitTime);

    const confirmed = confirm(
        `确认在 ${splitTimeStr} 处拆分镜头？\n\n` +
        `镜头A: ${secondsToTimecode(shot.start_time, fps)} → ${splitTimeStr}（${partADur}）\n` +
        `镜头B: ${splitTimeStr} → ${secondsToTimecode(shot.end_time, fps)}（${partBDur}）`
    );

    if (!confirmed) return;

    try {
        showToast('正在拆分镜头…');
        const result = await API.splitShot(shot.id, splitTime);

        if (result.success) {
            // ★ 拆分闪烁动画
            const player = document.getElementById('pvPlayerSection');
            if (player) {
                const flash = document.createElement('div');
                flash.className = 'split-flash';
                player.appendChild(flash);
                setTimeout(() => flash.remove(), 600);
            }

            // 更新全局镜头列表
            const removedId = result.removed_id;
            const shotA = result.shot_a;
            const shotB = result.shot_b;

            // 从 allShots 中移除原镜头
            const origIdx = allShots.findIndex(s => s.id === removedId);
            if (origIdx >= 0) {
                allShots.splice(origIdx, 1, shotA, shotB);
            }

            // 重建索引
            allShots.forEach((s, i) => s.index = i);

            // 退出编辑模式
            pvEditMode = false;
            const pvWindow = document.getElementById('pvWindow');
            if (pvWindow) pvWindow.classList.remove('edit-mode');

            // 切换预览到拆分后的第一个镜头
            const newIndex = allShots.findIndex(s => s.id === shotA.id);
            await switchPreviewTo(shotA, newIndex >= 0 ? newIndex : origIdx);

            // 刷新网格
            if (typeof loadShots === 'function') {
                loadShots();
            }

            showToast('镜头已拆分 ✓', 'success');
        } else {
            showToast(result.detail || '拆分失败', 'error');
        }
    } catch (err) {
        console.error('拆分镜头失败:', err);
        showToast('拆分镜头失败', 'error');
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

/**
 * 原位切换到新镜头（不销毁/重建弹窗 DOM）
 * 只更新视频源、信息文字、时间轴等
 */
async function switchPreviewTo(shot, listIndex) {
    if (!shot) return;

    // 如果在编辑模式，先退出（不保存）
    if (pvEditMode) {
        exitEditMode(false);
    }

    // 先保存之前的裁剪（如果有修改）
    await saveTrimIfNeeded();

    // 停止当前播放和边界监听
    stopBoundaryWatch();
    if (previewVideo && !previewVideo.paused) {
        previewVideo.pause();
    }

    // 更新状态
    currentPreviewShot = shot;
    currentPreviewIndex = listIndex;
    previewMode = 'play';

    // 初始化裁剪点
    // ★ 只有源视频不存在时才走 clip 模式
    const isClip = !!shot.clip_file && !shot.source_video_exists;
    trimStart = isClip ? 0 : shot.start_time;
    trimEnd = isClip ? shot.duration : shot.end_time;

    const sourceFile = shot.source_video ? shot.source_video.split('/').pop() : '';
    const duration = formatDuration(shot.duration || 0);

    // —— 更新视频源（同源视频可复用，只需 seek；不同源需换 src） ——
    const newVideoUrl = getVideoUrl(shot.source_video, shot.id);
    const isSameSource = !isClip && previewVideo && previewVideo.src && previewVideo.src.includes(encodeURIComponent(shot.source_video?.split('/').pop() || '___none___'));

    if (isSameSource) {
        // 同源视频：直接 seek 到新镜头位置
        const totalDur = previewVideo.duration || 1;
        viewStart = Math.max(0, shot.start_time - 5);
        viewEnd = Math.min(totalDur, shot.end_time + 5);
        if (viewEnd - viewStart < 1) {
            viewStart = Math.max(0, shot.start_time - 0.5);
            viewEnd = Math.min(totalDur, shot.end_time + 0.5);
        }
        // 更新总时长时间码
        const tcTotal = document.querySelector('#pvTimecode .tc-total');
        if (tcTotal) tcTotal.textContent = secondsToTimecode(totalDur, fps);
        previewVideo.currentTime = shot.start_time;
        updatePvProgress();
        previewVideo.muted = pvMuted;
        previewVideo.playbackRate = pvPlaybackRate;
        previewVideo.play().catch(() => {});
    } else {
        // 不同源视频（或 clip_file）：需要更换 src
        // ★ 先清除之前的错误提示
        const existingError = document.querySelector('.pv-video-error');
        if (existingError) existingError.remove();

        previewVideo.src = newVideoUrl;

        // ★ 视频加载失败时显示提示
        previewVideo.addEventListener('error', () => {
            const playerSection = document.querySelector('.pv-player-section');
            if (playerSection && !playerSection.querySelector('.pv-video-error')) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'pv-video-error';
                errorDiv.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);color:var(--text-secondary);font-size:14px;text-align:center;padding:20px;';
                errorDiv.innerHTML = '视频文件不可用<br><span style="font-size:12px;color:var(--text-tertiary)">源视频已删除且预裁剪文件丢失</span>';
                playerSection.appendChild(errorDiv);
            }
        }, { once: true });

        // 用一次性事件处理加载
        const onMeta = () => {
            const totalDur = previewVideo.duration || 1;
            if (isClip) {
                viewStart = 0;
                viewEnd = totalDur;
            } else {
                viewStart = Math.max(0, shot.start_time - 5);
                viewEnd = Math.min(totalDur, shot.end_time + 5);
                if (viewEnd - viewStart < 1) {
                    viewStart = Math.max(0, shot.start_time - 0.5);
                    viewEnd = Math.min(totalDur, shot.end_time + 0.5);
                }
            }
            previewVideo.currentTime = isClip ? 0 : shot.start_time;
            // 更新总时长时间码
            const tcTotal = document.querySelector('#pvTimecode .tc-total');
            if (tcTotal) tcTotal.textContent = secondsToTimecode(totalDur, fps);
            updatePvProgress();
        };
        previewVideo.addEventListener('loadedmetadata', onMeta, { once: true });
        previewVideo.addEventListener('canplay', () => {
            previewVideo.muted = pvMuted;
            previewVideo.playbackRate = pvPlaybackRate;
            previewVideo.play().catch(() => {});
        }, { once: true });
    }

    // —— 更新顶部标题栏 ——
    const headerTitle = document.getElementById('pvHeaderTitle');
    if (headerTitle) {
        const shotNum = headerTitle.querySelector('.shot-num');
        const shotDur = headerTitle.querySelector('.shot-dur');
        const shotLabel = headerTitle.querySelector('.shot-label');
        if (shotNum) shotNum.textContent = `#${shot.index + 1}`;
        if (shotDur) shotDur.textContent = duration;
        if (shotLabel) shotLabel.textContent = shot.shot_type || '';
    }

    // —— 更新调试面板（侧边面板 + 差异数据） ——
    const debugBody = document.querySelector('.pv-debug-panel-body');
    if (debugBody) {
        debugBody.innerHTML = buildDebugPanelBodyHTML(shot, prevDebugShot);
    }
    // 记录当前镜头为下次的"前一镜头"
    prevDebugShot = {
        face_count: shot.face_count,
        face_ratio: shot.face_ratio,
    };

    // —— 更新信息行文件名 ——
    const filenameEl = document.querySelector('.pv-info-row .filename');
    if (filenameEl) filenameEl.textContent = sourceFile;

    // —— 更新收藏按钮 ——
    const favBtn = document.getElementById('pvFavBtn');
    if (favBtn) {
        favBtn.innerHTML = shot.favorite ? '♥ 已收藏' : '♡ 收藏';
        favBtn.classList.toggle('active', !!shot.favorite);
    }

    // —— 更新导航标签和按钮状态 ——
    updateNavLabels();

    // —— 更新播放按钮状态 ——
    updatePvPlayBtn(false);

    // —— 更新时间码 ——
    const tcCurrent = document.querySelector('#pvTimecode .tc-current');
    if (tcCurrent) tcCurrent.textContent = secondsToTimecode(shot.start_time, fps);

    // —— 重置刻度线，下次编辑时重新生成 ——
    ticksInitialized = false;

    // —— 异步加载同源镜头并刷新时间轴（如果源视频变了） ——
    if (shot.source_video) {
        // 如果同源列表已有且源一样，只需更新索引
        const currentSource = sameSourceShots.length > 0 ? sameSourceShots[0]?.source_video : null;
        if (currentSource === shot.source_video) {
            sameSourceIndex = sameSourceShots.findIndex(s => s.id === shot.id);
            refreshTimeline();
        } else {
            sameSourceShots = [];
            sameSourceIndex = -1;
            loadSameSourceShots(shot.source_video, shot.id).then(() => {
                refreshTimeline();
            });
        }
    }
}

/**
 * 更新导航标签和按钮禁用状态
 */
function updateNavLabels() {
    const navLabel = document.getElementById('pvNavLabel');
    const navPrev = document.getElementById('pvNavPrev');
    const navNext = document.getElementById('pvNavNext');

    if (navLabel) {
        navLabel.textContent = currentPreviewIndex >= 0
            ? `${currentPreviewIndex + 1} / ${allShots.length}`
            : '';
    }
    if (navPrev) navPrev.disabled = currentPreviewIndex <= 0;
    if (navNext) navNext.disabled = currentPreviewIndex < 0 || currentPreviewIndex >= allShots.length - 1;
}

/**
 * 列表导航：在当前列表（allShots）中切换上一个/下一个镜头
 * 由左右箭头按钮和键盘左右方向键触发
 */
function navigatePreview(direction) {
    const newIndex = currentPreviewIndex + direction;
    if (newIndex < 0 || newIndex >= allShots.length) return;

    const newShot = allShots[newIndex];
    // 弹窗已存在时原位切换
    if (document.getElementById('previewOverlay')) {
        switchPreviewTo(newShot, newIndex);
    } else {
        openPreview(newShot.id, newIndex);
    }
}

/**
 * 时间轴导航：在同源视频的镜头之间跳转（按时间顺序）
 * 由时间轴上的镜头缩略图点击触发
 */
function jumpToSameSourceShot(sameSourceIdx) {
    if (sameSourceIdx === sameSourceIndex) return;
    if (sameSourceIdx < 0 || sameSourceIdx >= sameSourceShots.length) return;

    const targetShot = sameSourceShots[sameSourceIdx];
    // 在当前列表中找到对应索引
    const listIndex = allShots.findIndex(s => s.id === targetShot.id);

    // 弹窗已存在时原位切换
    if (document.getElementById('previewOverlay')) {
        switchPreviewTo(targetShot, listIndex >= 0 ? listIndex : -1);
    } else {
        if (listIndex >= 0) {
            openPreview(targetShot.id, listIndex);
        }
    }
}

/**
 * 同源时间轴中前后镜头导航（键盘上下方向键）
 */
function navigateSameSource(direction) {
    const newIdx = sameSourceIndex + direction;
    if (newIdx < 0 || newIdx >= sameSourceShots.length) return;
    jumpToSameSourceShot(newIdx);
}

function jumpToShot(index) {
    if (index === currentPreviewIndex) return;
    if (index < 0 || index >= allShots.length) return;

    const shot = allShots[index];
    // 弹窗已存在时原位切换
    if (document.getElementById('previewOverlay')) {
        switchPreviewTo(shot, index);
    } else {
        openPreview(shot.id, index);
    }
}

async function togglePreviewFavorite() {
    if (!currentPreviewShot) return;
    const newFav = !currentPreviewShot.favorite;
    const result = await API.toggleFavorite(currentPreviewShot.id, newFav);
    currentPreviewShot.favorite = newFav;

    // ★ 更新 clip_file（收藏时后端会自动预裁剪）
    if (result.clip_file) {
        currentPreviewShot.clip_file = result.clip_file;
    }

    const btn = document.getElementById('pvFavBtn');
    if (btn) {
        btn.innerHTML = newFav ? '♥ 已收藏' : '♡ 收藏';
        btn.classList.toggle('active', newFav);
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

async function exportCurrentShot() {
    if (!currentPreviewShot) return;
    // 先保存入出点裁剪（如果用户手动调整过）
    await saveTrimIfNeeded();
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
            if (pvEditMode) {
                exitEditMode(false);  // 编辑模式下 ESC 取消编辑
            } else {
                closePreview();
            }
            break;
        case ' ':
            e.preventDefault();
            togglePreviewPlay();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            if (!pvEditMode) navigatePreview(-1);  // 编辑模式下禁用导航
            break;
        case 'ArrowRight':
            e.preventDefault();
            if (!pvEditMode) navigatePreview(1);
            break;
        case 'ArrowUp':
            e.preventDefault();
            if (!pvEditMode) navigateSameSource(-1);
            break;
        case 'ArrowDown':
            e.preventDefault();
            if (!pvEditMode) navigateSameSource(1);
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
            if (pvEditMode) setPlayheadAsIn();  // 只在编辑模式下生效
            break;
        case 'o':
        case 'O':
            e.preventDefault();
            if (pvEditMode) setPlayheadAsOut();
            break;
        case 'e':
        case 'E':
            e.preventDefault();
            if (!pvEditMode) enterEditMode();  // E 键进入编辑模式
            break;
        case 's':
        case 'S':
            e.preventDefault();
            if (pvEditMode) saveEdit();  // S 键保存（编辑模式下）
            break;
        case 'm':
        case 'M':
            e.preventDefault();
            togglePreviewMute();
            break;
        case 'r':
        case 'R':
            e.preventDefault();
            cyclePlaybackRate();
            break;
    }
}

/* ═══════════════════════════════════════════════════
   时间轴刻度线（编辑模式下显示）
   ═══════════════════════════════════════════════════ */

let ticksInitialized = false;

/**
 * 初始化时间轴刻度线（只生成一次）
 */
function initTimelineTicks() {
    if (ticksInitialized) return;
    const container = document.getElementById('pvTimelineTicks');
    if (!container) return;

    let html = '';
    for (let i = 0; i <= 20; i++) {
        const pct = i * 5;
        const isMajor = i % 5 === 0;
        const h = isMajor ? 36 : 12;
        html += `<div class="pv-tick" style="left:${pct}%;height:${h}px">`;
        if (isMajor) {
            const sec = viewStart + (pct / 100) * (viewEnd - viewStart);
            html += `<span class="pv-tick-label">${sec.toFixed(1)}s</span>`;
        }
        html += `</div>`;
    }
    container.innerHTML = html;
    ticksInitialized = true;
}

/* ═══════════════════════════════════════════════════
   缩略图条拖拽滚动
   ═══════════════════════════════════════════════════ */

function initThumbDrag() {
    const strip = document.getElementById('pvTimelineTrack');
    if (!strip) return;

    let isDragging = false;
    let startX = 0;
    let scrollStart = 0;

    strip.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.pageX;
        scrollStart = strip.scrollLeft;
        strip.classList.add('dragging');
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const dx = e.pageX - startX;
        strip.scrollLeft = scrollStart - dx;
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        strip.classList.remove('dragging');
    });
}

/* ═══════════════════════════════════════════════════
   入出点拉手拖拽
   ═══════════════════════════════════════════════════ */

function onTrimHandleDown(e, type) {
    if (!previewVideo || !currentPreviewShot) return;
    e.preventDefault();
    e.stopPropagation();

    const bar = document.getElementById('pvProgressbar');
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const windowDur = viewEnd - viewStart;

    function drag(clientX) {
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const time = viewStart + ratio * windowDur;

        if (type === 'in') {
            trimStart = Math.max(0, Math.min(time, trimEnd - 1 / fps));
        } else {
            const totalDur = previewVideo.duration || 1;
            trimEnd = Math.max(trimStart + 1 / fps, Math.min(time, totalDur));
        }
        updatePvProgress();
    }

    drag(e.clientX);

    const onMove = (me) => drag(me.clientX);
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

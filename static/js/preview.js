/* ═══════════════════════════════════════════════════
   预览弹窗 — 参照 prototype 弹窗悬浮版
   布局：居中卡片 + 外置镜头时间轴
   ═══════════════════════════════════════════════════ */

let previewVideo = null;

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

    // 构建调试信息
    const debugFaceCount = shot.face_count !== undefined ? shot.face_count : '?';
    const debugPersonCount = shot.person_count !== undefined ? shot.person_count : '?';
    const debugFaceRatio = shot.face_ratio !== undefined ? (shot.face_ratio * 100).toFixed(2) + '%' : '?';
    const debugPersonRatio = shot.person_ratio !== undefined ? (shot.person_ratio * 100).toFixed(2) + '%' : '?';
    const debugHasPerson = shot.has_person ? '是' : '否';

    // 每帧详情
    let perFrameDebugHTML = '';
    if (shot.per_frame_debug && Object.keys(shot.per_frame_debug).length > 0) {
        const entries = Object.entries(shot.per_frame_debug);
        perFrameDebugHTML = entries.map(([fn, info]) => {
            return `<span class="pv-debug-frame">F${fn}: 脸${info.face_count} 体${info.person_count} FR${(info.face_ratio * 100).toFixed(1)}% PR${(info.person_ratio * 100).toFixed(1)}%</span>`;
        }).join('');
    }

    // 判断列表导航是否可用
    const navPrevDisabled = index <= 0;
    const navNextDisabled = index < 0 || index >= allShots.length - 1;

    overlay.innerHTML = `
        <!-- 弹窗外左箭头 -->
        <button class="pv-outer-nav pv-outer-prev" id="pvNavPrev" onclick="event.stopPropagation();navigatePreview(-1)" title="上一镜头 (←)" ${navPrevDisabled ? 'disabled' : ''}>‹</button>

        <!-- 预览容器 -->
        <div class="pv-container" onclick="event.stopPropagation()">
            <!-- 预览主窗口 -->
            <div class="pv-window">
                <!-- 关闭按钮 -->
                <button class="pv-close-btn" onclick="closePreview()">×</button>

                <!-- 播放器区域 -->
                <div class="pv-player-section">
                    <video id="previewVideoEl"
                           src="${getVideoUrl(shot.source_video, shot.id)}"
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

                    <!-- 调试信息浮层（检测标签详情） -->
                    <div class="pv-debug-info">
                        <div class="pv-debug-row">
                            <span class="pv-debug-label">分类:</span>
                            <span class="pv-debug-value pv-debug-highlight">${shot.shot_type || '未分类'}</span>
                            <span class="pv-debug-label">有人:</span>
                            <span class="pv-debug-value">${debugHasPerson}</span>
                        </div>
                        <div class="pv-debug-row">
                            <span class="pv-debug-label">人脸数:</span>
                            <span class="pv-debug-value">${debugFaceCount}</span>
                            <span class="pv-debug-label">人体数:</span>
                            <span class="pv-debug-value">${debugPersonCount}</span>
                        </div>
                        <div class="pv-debug-row">
                            <span class="pv-debug-label">人脸占比:</span>
                            <span class="pv-debug-value">${debugFaceRatio}</span>
                            <span class="pv-debug-label">人体占比:</span>
                            <span class="pv-debug-value">${debugPersonRatio}</span>
                        </div>
                        ${perFrameDebugHTML ? `<div class="pv-debug-row pv-debug-per-frame">${perFrameDebugHTML}</div>` : ''}
                    </div>
                </div>

                <!-- 控制栏区域 -->
                <div class="pv-control-section">
                    <!-- 同源镜头缩略图条（进度条上方） -->
                    <div class="pv-thumb-strip" id="pvTimelineTrack">
                        <!-- 等待同源镜头加载 -->
                    </div>

                    <!-- 源视频进度条 -->
                    <div class="pv-progress-area">
                        <div class="pv-source-label">
                            <span>${sourceFile}</span>
                            <span class="pv-nav-label" id="pvNavLabel">${index + 1} / ${allShots.length}</span>
                            <span class="pv-source-time" id="pvSourceTime">${secondsToTimecode(shot.start_time, fps)}</span>
                        </div>
                        <div class="pv-progressbar" id="pvProgressbar" onmousedown="onPvProgressDown(event)">
                            <!-- 当前镜头高亮范围 -->
                            <div class="pv-shot-range" id="pvShotRange"></div>
                            <!-- 入出点之间的裁剪范围 -->
                            <div class="pv-trim-range" id="pvTrimRange"></div>
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
                            <button class="pv-edit-btn" onclick="event.stopPropagation();seekPreview(-1/fps)">◀ 1帧</button>
                            <button class="pv-edit-btn" onclick="event.stopPropagation();copyCurrentFrame()">📋 复制静帧</button>
                            <button class="pv-edit-btn" onclick="event.stopPropagation();seekPreview(1/fps)">1帧 ▶</button>
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
        </div>

        <!-- 弹窗外右箭头 -->
        <button class="pv-outer-nav pv-outer-next" id="pvNavNext" onclick="event.stopPropagation();navigatePreview(1)" title="下一镜头 (→)" ${navNextDisabled ? 'disabled' : ''}>›</button>
    `;

    document.body.appendChild(overlay);

    // 获取视频元素
    previewVideo = document.getElementById('previewVideoEl');

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
}

/**
 * 构建缩略图条 HTML（基于同源视频镜头，按时间顺序，只展示缩略图）
 */
function buildTimelineHTML() {
    if (sameSourceShots.length === 0) {
        return '';
    }

    const currentIdx = sameSourceIndex;
    // 显示当前镜头前后各 10 个
    const start = Math.max(0, currentIdx - 10);
    const end = Math.min(sameSourceShots.length, currentIdx + 11);

    let html = '';
    for (let i = start; i < end; i++) {
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
    sameSourceShots = [];
    sameSourceIndex = -1;
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

function updatePvPlayBtn(isPlaying) {
    const btn = document.getElementById('pvPlayBtn');
    if (btn) btn.textContent = isPlaying ? '⏸' : '▶';
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

    // 入出点标记 — 相对窗口范围
    const inPercent = toPercent(trimStart);
    const outPercent = toPercent(trimEnd);
    const inPoint = document.getElementById('pvInPoint');
    const outPoint = document.getElementById('pvOutPoint');
    if (inPoint) inPoint.style.left = `${Math.max(0, Math.min(100, inPercent))}%`;
    if (outPoint) outPoint.style.left = `${Math.max(0, Math.min(100, outPercent))}%`;

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
   入出点 & 裁剪
   ═══════════════════════════════════════════════════ */

function setPlayheadAsIn() {
    if (!previewVideo) return;
    trimStart = Math.max(0, Math.min(previewVideo.currentTime, trimEnd - 1/fps));
    updatePvProgress();
    showToast(`入点设为 ${secondsToTimecode(trimStart, fps)}`);
}

function setPlayheadAsOut() {
    if (!previewVideo) return;
    const totalDur = previewVideo.duration || 1;
    trimEnd = Math.max(trimStart + 1/fps, Math.min(previewVideo.currentTime, totalDur));
    updatePvProgress();
    showToast(`出点设为 ${secondsToTimecode(trimEnd, fps)}`);
}

/**
 * 保存裁剪（如果入出点有变化）
 */
async function saveTrimIfNeeded() {
    if (!currentPreviewShot) return;
    const shot = currentPreviewShot;

    // ★ 只有源视频不存在时才用 clip 模式的基准时间
    const isClipShot = !!shot.clip_file && !shot.source_video_exists;
    const baseStart = isClipShot ? 0 : shot.start_time;
    const baseEnd = isClipShot ? shot.duration : shot.end_time;

    // 只在入出点有变化时保存
    if (Math.abs(trimStart - baseStart) < 0.01 && Math.abs(trimEnd - baseEnd) < 0.01) {
        return;
    }

    // ★ clip_file 镜头目前不支持二次裁剪（已经是独立片段）
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

    // 先保存之前的裁剪
    saveTrimIfNeeded();

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
        previewVideo.currentTime = shot.start_time;
        updatePvProgress();
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
            updatePvProgress();
        };
        previewVideo.addEventListener('loadedmetadata', onMeta, { once: true });
        previewVideo.addEventListener('canplay', () => {
            previewVideo.play().catch(() => {});
        }, { once: true });
    }

    // —— 更新信息浮层 ——
    const shotIdEl = document.querySelector('.pv-shot-id');
    if (shotIdEl) shotIdEl.textContent = `#${shot.index + 1}`;

    const shotDetails = document.querySelector('.pv-shot-details');
    if (shotDetails) {
        shotDetails.innerHTML = `
            <span class="pv-detail-item">⏱ ${duration}</span>
            <span class="pv-detail-item">${shot.shot_type || ''}</span>
            <span class="pv-detail-item" id="pvTimecodeOverlay">${shot.timecode_display || ''}</span>
        `;
    }

    // —— 更新调试信息 ——
    const debugInfo = document.querySelector('.pv-debug-info');
    if (debugInfo) {
        const debugFaceCount = shot.face_count !== undefined ? shot.face_count : '?';
        const debugPersonCount = shot.person_count !== undefined ? shot.person_count : '?';
        const debugFaceRatio = shot.face_ratio !== undefined ? (shot.face_ratio * 100).toFixed(2) + '%' : '?';
        const debugPersonRatio = shot.person_ratio !== undefined ? (shot.person_ratio * 100).toFixed(2) + '%' : '?';
        const debugHasPerson = shot.has_person ? '是' : '否';

        let perFrameDebugHTML = '';
        if (shot.per_frame_debug && Object.keys(shot.per_frame_debug).length > 0) {
            const entries = Object.entries(shot.per_frame_debug);
            perFrameDebugHTML = entries.map(([fn, info]) => {
                return `<span class="pv-debug-frame">F${fn}: 脸${info.face_count} 体${info.person_count} FR${(info.face_ratio * 100).toFixed(1)}% PR${(info.person_ratio * 100).toFixed(1)}%</span>`;
            }).join('');
        }

        debugInfo.innerHTML = `
            <div class="pv-debug-row">
                <span class="pv-debug-label">分类:</span>
                <span class="pv-debug-value pv-debug-highlight">${shot.shot_type || '未分类'}</span>
                <span class="pv-debug-label">有人:</span>
                <span class="pv-debug-value">${debugHasPerson}</span>
            </div>
            <div class="pv-debug-row">
                <span class="pv-debug-label">人脸数:</span>
                <span class="pv-debug-value">${debugFaceCount}</span>
                <span class="pv-debug-label">人体数:</span>
                <span class="pv-debug-value">${debugPersonCount}</span>
            </div>
            <div class="pv-debug-row">
                <span class="pv-debug-label">人脸占比:</span>
                <span class="pv-debug-value">${debugFaceRatio}</span>
                <span class="pv-debug-label">人体占比:</span>
                <span class="pv-debug-value">${debugPersonRatio}</span>
            </div>
            ${perFrameDebugHTML ? `<div class="pv-debug-row pv-debug-per-frame">${perFrameDebugHTML}</div>` : ''}
        `;
    }

    // —— 更新源文件名 ——
    const sourceLabel = document.querySelector('.pv-source-label > span:first-child');
    if (sourceLabel) sourceLabel.textContent = sourceFile;

    // —— 更新收藏按钮 ——
    const favBtn = document.getElementById('pvFavBtn');
    if (favBtn) {
        favBtn.innerHTML = shot.favorite ? '♥ 已收藏' : '♡ 收藏';
        favBtn.classList.toggle('pv-fav-active', !!shot.favorite);
    }

    // —— 更新导航标签和按钮状态 ——
    updateNavLabels();

    // —— 更新播放按钮状态 ——
    updatePvPlayBtn(false);

    // —— 更新时间码 ——
    const tc = document.getElementById('pvTimecode');
    if (tc) tc.textContent = secondsToTimecode(shot.start_time, fps);

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
            saveTrimIfNeeded();
            closePreview();
            break;
        case ' ':
            e.preventDefault();
            togglePreviewPlay();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            navigatePreview(-1);  // 列表中上一镜头
            break;
        case 'ArrowRight':
            e.preventDefault();
            navigatePreview(1);   // 列表中下一镜头
            break;
        case 'ArrowUp':
            e.preventDefault();
            navigateSameSource(-1);  // 同源视频中时间线上一镜头
            break;
        case 'ArrowDown':
            e.preventDefault();
            navigateSameSource(1);   // 同源视频中时间线下一镜头
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

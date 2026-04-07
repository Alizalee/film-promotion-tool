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
 */
async function handleVideoFiles(files) {
    // 如果没有活跃项目，先创建一个
    if (!currentProjectId) {
        showToast('请先创建一个项目', 'error');
        showCreateProjectModal();
        return;
    }

    isAnalyzing = true;
    _analysisCancelled = false;

    for (let i = 0; i < files.length; i++) {
        if (_analysisCancelled) break;

        const file = files[i];
        showAnalyzeProgress(`正在上传 ${file.name}（${i + 1}/${files.length}）…`, 1);

        try {
            // 上传
            const uploadResult = await API.uploadVideo(file, (percent) => {
                showProgress(percent * 0.4); // 上传占 40%
            });

            if (!uploadResult.success) {
                showToast(`上传 ${file.name} 失败`, 'error');
                continue;
            }

            if (_analysisCancelled) break;

            // 场景检测
            showAnalyzeProgress(`正在检测 ${file.name} 的场景…`, 2);
            showProgress(50);

            const isFirstVideo = totalShots === 0 && i === 0;
            let analyzeResult;

            if (isFirstVideo) {
                analyzeResult = await API.analyze(uploadResult.video_path, threshold);
            } else {
                analyzeResult = await API.analyzeAppend(uploadResult.video_path, threshold);
            }

            // 提取封面帧
            showAnalyzeProgress(`正在提取封面帧…`, 3);
            showProgress(70);

            // 计算动态值
            showAnalyzeProgress(`正在计算动态值…`, 4);
            showProgress(90);

            // 检查是否被取消
            if (analyzeResult.cancelled || _analysisCancelled) {
                showToast('分析已取消', 'success');
                break;
            }

            if (analyzeResult.success) {
                totalShots = analyzeResult.total_shots || totalShots;
                fps = analyzeResult.fps || fps;
                showAnalyzeProgress('分析完成！', 5);
                showProgress(100);
                showToast(`${file.name} 分析完成，检测到 ${analyzeResult.total_shots || analyzeResult.new_shots || 0} 个镜头`, 'success');
            } else {
                showToast(`分析 ${file.name} 失败`, 'error');
            }

        } catch (err) {
            console.error('处理视频失败:', err);
            if (!_analysisCancelled) {
                showToast(`处理 ${file.name} 失败: ${err.message}`, 'error');
            }
        }
    }

    hideProgress();
    isAnalyzing = false;

    // 刷新项目列表和视图
    const projData = await API.getProjects();
    allProjects = projData.projects || [];

    await initProjectView();
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

    isAnalyzing = true;
    _analysisCancelled = false;

    // 关闭项目下拉
    if (projectDropdownOpen) toggleProjectDropdown();

    showAnalyzeProgress('正在分析视频…', 2);
    showProgress(30);

    try {
        const isFirst = totalShots === 0;
        let result;

        if (isFirst) {
            result = await API.analyze(path, threshold);
        } else {
            result = await API.analyzeAppend(path, threshold);
        }

        if (result.cancelled || _analysisCancelled) {
            showToast('分析已取消', 'success');
        } else if (result.success) {
            showAnalyzeProgress('分析完成！', 5);
            showProgress(100);
            showToast(`分析完成，检测到 ${result.total_shots || result.new_shots || 0} 个镜头`, 'success');
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
}

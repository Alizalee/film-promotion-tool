/* ═══════════════════════════════════════════════════
   API 调用封装
   ═══════════════════════════════════════════════════ */

const API = {
    // ── 项目管理 ──
    async getProjects() {
        const res = await fetch('/api/projects');
        return res.json();
    },

    async createProject(name, description = '') {
        const res = await fetch('/api/projects/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description }),
        });
        return res.json();
    },

    async switchProject(projectId) {
        const res = await fetch('/api/projects/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId }),
        });
        return res.json();
    },

    async renameProject(projectId, name, description) {
        const res = await fetch('/api/projects/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId, name, description }),
        });
        return res.json();
    },

    async deleteProject(projectId) {
        const res = await fetch('/api/projects/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId }),
        });
        return res.json();
    },

    async getProjectInfo() {
        const res = await fetch('/api/project_info');
        return res.json();
    },

    // ── 视频 ──
    async checkDuplicateVideos(filenames) {
        const res = await fetch('/api/check_duplicate_videos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames }),
        });
        return res.json();
    },

    async uploadVideo(file, onProgress) {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('file', file);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload_video');

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(Math.round((e.loaded / e.total) * 100));
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(JSON.parse(xhr.responseText));
                } else {
                    reject(new Error(xhr.responseText));
                }
            };

            xhr.onerror = () => reject(new Error('网络错误'));
            xhr.send(formData);
        });
    },

    async analyze(videoPath, threshold) {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_path: videoPath, threshold }),
        });
        return res.json();
    },

    async analyzeAppend(videoPath, threshold) {
        const res = await fetch('/api/analyze_append', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_path: videoPath, threshold }),
        });
        return res.json();
    },

    async analyzeBatchBg(videoPaths, threshold) {
        const res = await fetch('/api/analyze_batch_bg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_paths: videoPaths, threshold }),
        });
        return res.json();
    },

    async cancelAnalyze() {
        const res = await fetch('/api/cancel_analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        return res.json();
    },

    async reanalyze(threshold) {
        const res = await fetch('/api/reanalyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threshold }),
        });
        return res.json();
    },

    async getVideos() {
        const res = await fetch('/api/videos');
        return res.json();
    },

    async deleteVideo(videoPath, keepFavorites = true) {
        const res = await fetch('/api/videos/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_path: videoPath, keep_favorites: keepFavorites }),
        });
        return res.json();
    },

    async clearVideos() {
        const res = await fetch('/api/videos/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        return res.json();
    },

    // ── 镜头 ──
    async getShots(params = {}) {
        const query = new URLSearchParams();
        if (params.sort) query.set('sort', params.sort);
        if (params.has_person) query.set('has_person', 'true');
        if (params.favorite_only) query.set('favorite_only', 'true');
        if (params.search) query.set('search', params.search);
        if (params.source_video) query.set('source_video', params.source_video);
        if (params.shot_type) query.set('shot_type', params.shot_type);

        const res = await fetch(`/api/shots?${query.toString()}`);
        return res.json();
    },

    async detectFaces() {
        const res = await fetch('/api/detect_faces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        return res.json();
    },

    async detectShotTypes() {
        const res = await fetch('/api/detect_shot_types', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        return res.json();
    },

    async toggleFavorite(shotId, favorite) {
        const res = await fetch('/api/favorite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shot_id: shotId, favorite }),
        });
        return res.json();
    },

    async batchFavorite(shotIds, favorite) {
        // 批量收藏 — 逐个调用
        const results = [];
        for (const id of shotIds) {
            const r = await this.toggleFavorite(id, favorite);
            results.push(r);
        }
        return results;
    },

    async deleteShots(shotIds) {
        const res = await fetch('/api/shots/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shot_ids: shotIds }),
        });
        return res.json();
    },

    async trimShot(shotId, newStart, newEnd) {
        const res = await fetch('/api/trim_shot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shot_id: shotId, new_start: newStart, new_end: newEnd }),
        });
        return res.json();
    },

    async saveFrame(shotId) {
        const res = await fetch('/api/save_frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shot_id: shotId }),
        });
        return res.json();
    },

    async mergeShots(shotIdA, shotIdB) {
        const res = await fetch('/api/merge_shots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shot_id_a: shotIdA, shot_id_b: shotIdB }),
        });
        return res.json();
    },

    async splitShot(shotId, splitTime) {
        const res = await fetch('/api/split_shot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shot_id: shotId, split_time: splitTime }),
        });
        return res.json();
    },

    // ── 导出（已改为浏览器下载方式，逻辑在 export.js 中） ──

    // ── 后台分析状态 ──
    async getBgTaskStatus() {
        const res = await fetch('/api/bg_task_status');
        return res.json();
    },

    async getAnalysisCompleteness() {
        const res = await fetch('/api/analysis_completeness');
        return res.json();
    },

    async resumeAnalysis() {
        const res = await fetch('/api/resume_analysis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        return res.json();
    },

    // ── 收藏镜头 clip 补偿 ──
    async ensureFavoriteClips() {
        const res = await fetch('/api/ensure_favorite_clips', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        return res.json();
    },
};

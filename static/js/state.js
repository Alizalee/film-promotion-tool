/* ═══════════════════════════════════════════════════
   全局状态变量
   ═══════════════════════════════════════════════════ */

// 项目
let allProjects = [];
let currentProjectId = null;
let currentProjectName = '';

// 镜头
let allShots = [];
let currentSort = 'time';
let personFilter = false;
let favoriteOnly = false;
let searchQuery = '';
let sourceVideoFilters = new Set(); // 多选视频源筛选（空 = 全部）
let shotTypeFilter = null;    // 景别筛选: 近景人像/黄金人像/远景人像/空镜
let peopleFilter = null;  // 人数筛选：null = 不筛选，1/2/3 = 只显示对应人数（3 代表 ≥3）
let faceDetected = false;   // 当前项目是否已完成人脸检测
let faceDetecting = false;  // 正在检测中
let shotTypeDetected = false;  // 景别是否已分析
let shotTypeDetecting = false; // 正在分析景别

// 选择模式
let selectMode = false;
let selectedShots = new Set();

// 预览
let currentPreviewShot = null;
let currentPreviewIndex = -1;
let previewMode = 'play'; // play | freeze | trim

// 裁剪
let trimStart = 0;
let trimEnd = 0;
let trimMode = false;

// 预览进度条窗口范围
let viewStart = 0;   // 进度条左端对应的视频时间
let viewEnd = 0;     // 进度条右端对应的视频时间
let isSeeking = false; // 用户正在拖拽/点击进度条时为 true，防止 timeupdate 回弹

// 合并
let mergeSourceShot = null;
let isDraggingForMerge = false;

// 视频信息
let videoPath = null;
let videoPaths = [];
let totalShots = 0;
let totalAllShots = 0;
let totalFavorites = 0;
let fps = 24;

// UI 状态
let settingsOpen = false;
let projectDropdownOpen = false;
let isAnalyzing = false;
let threshold = 27;
let thresholdChanged = false;  // 灵敏度是否被修改过（用于显示重新分析按钮）
let searchDebounceTimer = null;
let sidebarCollapsed = false;  // 侧边栏是否折叠
let gridSize = 'md';  // 视图大小: 'sm' | 'md' | 'lg'

// Hover 预览管理
let hoverVideoElements = new Map(); // shotId -> video element

// 预览出点精确监控
let pvBoundaryRAF = null; // requestAnimationFrame ID，用于精确出点检测

// 后台分析
let bgTaskPolling = false;      // 是否正在轮询后台状态
let bgTaskPollTimer = null;     // 轮询定时器

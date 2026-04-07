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
let sourceVideoFilter = null;
let shotTypeFilter = null;    // 景别筛选: 特写/近景/中景/远景/全景
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

// 合并
let mergeSourceShot = null;
let isDraggingForMerge = false;

// 视频信息
let videoPath = null;
let videoPaths = [];
let totalShots = 0;
let fps = 24;

// UI 状态
let settingsOpen = false;
let projectDropdownOpen = false;
let isAnalyzing = false;
let threshold = 27;
let thresholdChanged = false;  // 灵敏度是否被修改过（用于显示重新分析按钮）
let searchDebounceTimer = null;

// Hover 预览管理
let hoverVideoElements = new Map(); // shotId -> video element

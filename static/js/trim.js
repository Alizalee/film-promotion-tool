/* ═══════════════════════════════════════════════════
   裁剪编辑器 — 入口函数（实际逻辑在 preview.js 中）
   ═══════════════════════════════════════════════════ */

/**
 * 从外部调用裁剪编辑器的入口
 * 实际实现在 preview.js 的 enterTrimMode / closeTrimMode / saveTrim 中
 */
function openTrimEditor() {
    if (currentPreviewShot) {
        enterTrimMode();
    } else {
        showToast('请先打开镜头预览', '');
    }
}

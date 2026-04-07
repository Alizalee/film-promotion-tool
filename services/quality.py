"""画面质量评分算法 — 清晰度 + 对比度 + 色彩丰富度 + 亮度合理性"""
import cv2
import numpy as np

from models.constants import (
    QUALITY_SHARPNESS_MAX,
    QUALITY_CONTRAST_MAX,
    QUALITY_COLOR_MAX,
    QUALITY_BRIGHTNESS_MAX,
)


def score_quality(frame: np.ndarray) -> float:
    """
    对一帧画面进行质量评分。

    算法公式：
        总分 = 清晰度(0~3) + 对比度(0~2.5) + 色彩丰富度(0~2.5) + 亮度合理性(0~2)

    Args:
        frame: BGR 格式的 numpy 数组

    Returns:
        质量评分 0.0 ~ 10.0，保留 1 位小数
    """
    if frame is None or frame.size == 0:
        return 0.0

    # 转换为灰度和 HSV
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

    # 1. 清晰度 — Laplacian 方差（值越高越清晰）
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    sharpness = min(laplacian_var / 500.0, 1.0) * QUALITY_SHARPNESS_MAX

    # 2. 对比度 — 灰度标准差（值越高对比度越强）
    contrast = min(gray.std() / 128.0, 1.0) * QUALITY_CONTRAST_MAX

    # 3. 色彩丰富度 — HSV 中 S 通道均值（饱和度越高色彩越丰富）
    s_mean = hsv[:, :, 1].mean()
    color_richness = min(s_mean / 255.0 * 2.0, 1.0) * QUALITY_COLOR_MAX

    # 4. 亮度合理性 — 灰度均值接近 0.45 最佳
    gray_mean = gray.mean() / 255.0
    brightness = max(0.0, 1.0 - abs(gray_mean - 0.45) * 2.0) * QUALITY_BRIGHTNESS_MAX

    total = sharpness + contrast + color_richness + brightness
    return round(min(total, 10.0), 1)

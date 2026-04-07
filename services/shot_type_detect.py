"""景别检测服务 — 综合人脸面积比 + 人体面积比推断景别

景别分类规则（二分类：近景/远景）：
  - 近景: 人体占画面 >= 30%（半身以上），或人脸占比 >= 3%，
          或人体占比 >= 12% 且检测到脸（中近景过渡区）
  - 远景: 其余情况（无人、人很小、只占小部分）
"""
import cv2
import numpy as np
from typing import Optional


def classify_shot_type(
    has_person: bool,
    face_ratio: float,
    frame: Optional[np.ndarray] = None,
    person_ratio: float = 0.0,
) -> str:
    """
    综合人脸 + 人体面积比推断景别（二分类：近景/远景）。

    判断优先级：
    1. 没有检测到任何人 → 远景
    2. 人体占比 >= 30% → 近景（半身以上人像，含背影/侧身）
    3. 人脸占比 >= 3% → 近景（脸大 = 近景）
    4. 人体占比 >= 12% 且人脸可见 → 近景（中近景过渡区）
    5. 多个人体框总占比 >= 25% → 近景（群戏近景）
    6. 其余 → 远景

    Args:
        has_person: 是否检测到人（人脸或人体）
        face_ratio: 最大人脸占画面比例 (0~1)
        frame: 可选的帧图像（预留扩展）
        person_ratio: 最大人体占画面比例 (0~1)

    Returns:
        景别字符串: "近景" | "远景"
    """
    if not has_person:
        return "远景"

    # 人体占比 >= 30% → 近景（半身以上，含背影/侧身等无脸情况）
    if person_ratio >= 0.30:
        return "近景"

    # 人脸占比 >= 3% → 近景（脸大 = 近景）
    if face_ratio >= 0.03:
        return "近景"

    # 人体占比 >= 12% 且检测到脸 → 近景（中近景过渡区）
    if person_ratio >= 0.12 and face_ratio > 0:
        return "近景"

    # 人体可见但占比较小 → 远景
    return "远景"


def detect_shot_type_for_frame(
    frame: np.ndarray,
    has_person: bool = False,
    face_ratio: float = 0.0,
    person_ratio: float = 0.0,
) -> str:
    """
    对单帧图像进行景别分类。
    """
    return classify_shot_type(has_person, face_ratio, frame, person_ratio)

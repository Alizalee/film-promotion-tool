"""镜头分类服务 — 宣发导向的人像分类（四档）

基于最大人脸占画面比例 (face_ratio) 进行分类：
  - 空镜:     face_count == 0 且 face_ratio < 0.07%
  - 远景人像: 0.07% ≤ face_ratio < 0.7%（含 face_count=0 但有小人脸的兜底）
  - 黄金人像: 0.7% ≤ face_ratio ≤ 3.7% — 最佳构图比例，适合破窗/海报
  - 近景人像: face_ratio > 3.7%  — 脸部占比大，特写/框内用
"""
from models.constants import FACE_RATIO_DISTANT_MIN, FACE_RATIO_TIER_LOW, FACE_RATIO_TIER_HIGH


def classify_shot_label(face_count: int, face_ratio: float = 0.0, **kwargs) -> str:
    """
    基于人脸数量 + 最大人脸占比的镜头分类（宣发导向，四档）。

    Args:
        face_count: 可辨识人脸数量（face_ratio >= MIN_FACE_RATIO 的人脸数）
        face_ratio: 最大人脸框面积占画面面积的比例 (0~1)
        **kwargs: 兼容旧调用传入的 has_person / person_count（忽略）

    Returns:
        镜头标签: "近景人像" | "黄金人像" | "远景人像" | "空镜"
    """
    # 优先用 face_ratio 判断（兜底 face_count=0 但 YuNet 仍检测到小人脸的情况）
    if face_ratio > FACE_RATIO_TIER_HIGH:
        return "近景人像"
    elif face_ratio >= FACE_RATIO_TIER_LOW:
        return "黄金人像"
    elif face_ratio >= FACE_RATIO_DISTANT_MIN:
        # face_ratio >= 0.07% — 即使 face_count=0（被 MIN_FACE_RATIO 过滤），仍判定远景人像
        return "远景人像"

    # face_count > 0 但 face_ratio 极小（理论上不太可能，保险起见）
    if face_count > 0:
        return "远景人像"

    return "空镜"


def classify_shot_type(
    has_person: bool = False,
    face_ratio: float = 0.0,
    frame=None,
    person_ratio: float = 0.0,
    face_count: int = 0,
    person_count: int = 0,
) -> str:
    """
    兼容旧接口的分类函数 — 内部调用 classify_shot_label。
    """
    return classify_shot_label(face_count=face_count, face_ratio=face_ratio)


def detect_shot_type_for_frame(
    frame=None,
    has_person: bool = False,
    face_ratio: float = 0.0,
    person_ratio: float = 0.0,
    face_count: int = 0,
    person_count: int = 0,
) -> str:
    """
    对单帧图像进行镜头分类。
    """
    return classify_shot_label(face_count=face_count, face_ratio=face_ratio)

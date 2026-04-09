"""镜头分类服务 — 宣发导向的人像分类（四档）

基于最大人脸占【有效画面】比例 (face_ratio) + 构图安全性进行分类：
  - 空镜:     face_count == 0 且 face_ratio < 0.07%
  - 远景人像: 0.07% ≤ face_ratio < 0.7%（含 face_count=0 但有小人脸的兜底）
  - 黄金人像: 0.7% ≤ face_ratio ≤ 7% 且构图合格（未裁头 + 在安全区内）
  - 近景人像: face_ratio > 7%，或黄金区间但构图不合格（裁头/贴边）

构图不合格的黄金区间镜头升级为近景人像（脸不小，只是构图有瑕疵）。
"""
from models.constants import FACE_RATIO_DISTANT_MIN, FACE_RATIO_TIER_LOW, FACE_RATIO_TIER_HIGH


def classify_shot_label(
    face_count: int,
    face_ratio: float = 0.0,
    face_cropped: bool = False,
    face_in_safe_zone: bool = True,
    **kwargs,
) -> str:
    """
    基于人脸数量 + 最大人脸占比 + 构图安全性的镜头分类（宣发导向，四档）。

    Args:
        face_count: 可辨识人脸数量（face_ratio >= MIN_FACE_RATIO 的人脸数）
        face_ratio: 最大人脸框面积占【有效画面】面积的比例 (0~1)
        face_cropped: 人脸是否被裁头（头顶被画面上边缘截断）
        face_in_safe_zone: 人脸中心是否在安全区域内
        **kwargs: 兼容旧调用传入的 has_person / person_count（忽略）

    Returns:
        镜头标签: "近景人像" | "黄金人像" | "远景人像" | "空镜"
    """
    # 优先用 face_ratio 判断
    if face_ratio > FACE_RATIO_TIER_HIGH:
        return "近景人像"
    elif face_ratio >= FACE_RATIO_TIER_LOW:
        # ★ 黄金人像候选 → 验证构图安全性
        if face_cropped or not face_in_safe_zone:
            return "近景人像"  # 构图不合格 → 升级到近景（脸不小，只是裁头/贴边）
        return "黄金人像"
    elif face_ratio >= FACE_RATIO_DISTANT_MIN:
        return "远景人像"

    # face_count > 0 但 face_ratio 极小（保险起见）
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
    face_cropped: bool = False,
    face_in_safe_zone: bool = True,
) -> str:
    """
    兼容旧接口的分类函数 — 内部调用 classify_shot_label。
    """
    return classify_shot_label(
        face_count=face_count,
        face_ratio=face_ratio,
        face_cropped=face_cropped,
        face_in_safe_zone=face_in_safe_zone,
    )


def detect_shot_type_for_frame(
    frame=None,
    has_person: bool = False,
    face_ratio: float = 0.0,
    person_ratio: float = 0.0,
    face_count: int = 0,
    person_count: int = 0,
    face_cropped: bool = False,
    face_in_safe_zone: bool = True,
) -> str:
    """
    对单帧图像进行镜头分类。
    """
    return classify_shot_label(
        face_count=face_count,
        face_ratio=face_ratio,
        face_cropped=face_cropped,
        face_in_safe_zone=face_in_safe_zone,
    )

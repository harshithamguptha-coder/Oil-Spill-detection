"""Combined detection controller for SLICKTRACE.

This module intentionally combines the existing preprocessing, thresholding, and
mask cleanup stages into one reusable detection function. It does not add any
geometry, AIS, confidence, UI, or ML logic beyond a simple status summary.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import numpy as np
import rasterio

from .mask_cleanup import clean_mask
from .preprocessor import preprocess_sentinel1
from .threshold_detector import detect_dark_regions


def _load_fallback_mask(mask_path: str) -> np.ndarray:
    """Load a fallback binary mask from disk.

    The fallback is treated as a validated mask source, not as an AI prediction.
    """
    with rasterio.open(mask_path) as src:
        array = src.read()
    if array.size == 0:
        raise ValueError(f"Fallback mask '{mask_path}' is empty.")
    candidate = np.asarray(array)
    if candidate.ndim == 3:
        candidate = candidate[0]
    mask = np.asarray(candidate > 0, dtype=np.uint8)
    return mask.astype(np.uint8, copy=False)


def detect_slick(
    image_path: str,
    sensitivity: float = 0.5,
    fallback_mask_path: Optional[str] = None,
    min_component_pixels: int = 50,
    open_kernel_size: int = 3,
    close_kernel_size: int = 3,
) -> Dict[str, Any]:
    """Run the Step 1->Step 2->Step 3 detection pipeline.

    Returns a documented dictionary with the final cleaned mask and a simple status
    message indicating whether a suspected slick was detected.
    """
    fallback_used = False
    status = "preprocessing_failed"
    contrast_score = 0.0
    mask = np.zeros((0, 0), dtype=np.uint8)

    try:
        processed, _ = preprocess_sentinel1(
            image_path,
            smoothing="gaussian",
            kernel_size=3,
            sigma=1.0,
            normalize=True,
        )
        if processed is None or processed.size == 0:
            raise ValueError("Preprocessing returned no image data.")

        raw_mask, metrics = detect_dark_regions(processed, sensitivity=sensitivity)
        if raw_mask is None or raw_mask.size == 0:
            raise ValueError("Thresholding did not produce a mask.")

        mask, cleanup_stats = clean_mask(
            raw_mask,
            min_component_pixels=min_component_pixels,
            open_kernel_size=open_kernel_size,
            close_kernel_size=close_kernel_size,
        )
        contrast_score = float(metrics["contrast_score"])

        if np.any(mask):
            status = "suspected_slick_detected"
        else:
            status = "no_slick_detected"

    except Exception:
        if fallback_mask_path is not None:
            try:
                mask = _load_fallback_mask(fallback_mask_path)
                fallback_used = True
                contrast_score = 0.0
                status = "fallback_mask_used"
            except Exception:
                mask = np.zeros((0, 0), dtype=np.uint8)
                status = "fallback_failed"
        else:
            mask = np.zeros((0, 0), dtype=np.uint8)
            status = "preprocessing_failed"

    result = {
        "mask": np.asarray(mask, dtype=np.uint8),
        "contrast_score": float(contrast_score),
        "status": status,
        "sensitivity": float(sensitivity),
        "fallback_used": bool(fallback_used),
    }
    return result


__all__ = ["detect_slick"]

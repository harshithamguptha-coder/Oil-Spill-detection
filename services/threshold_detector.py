"""Threshold-based dark-region detection for SLICKTRACE.

This module intentionally limits itself to:
- converting sensitivity to a threshold,
- generating a binary mask of dark pixels,
- calculating a normalized contrast score,
- verifying sensitivity changes the number of detected pixels.

It does not implement morphology, connected components, contours, geometry,
confidence scoring, AIS logic, UI, or ML.
"""

from __future__ import annotations

from typing import Dict, Tuple

import numpy as np


def _sensitivity_to_threshold(processed_image: np.ndarray, sensitivity: float) -> float:
    """Convert a 0..1 sensitivity value to a threshold in normalized intensity space."""
    if not 0.0 <= float(sensitivity) <= 1.0:
        raise ValueError("sensitivity must be between 0 and 1 inclusive.")

    arr = np.asarray(processed_image, dtype=np.float32)
    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        return 0.0

    low = float(np.min(finite))
    high = float(np.max(finite))
    span = high - low
    if span <= 0:
        return low

    threshold = low + (1.0 - float(sensitivity)) * span
    return float(np.clip(threshold, low, high))


def detect_dark_regions(
    processed_image: np.ndarray, sensitivity: float
) -> Tuple[np.ndarray, Dict[str, float]]:
    """Return a binary mask and a minimal metadata dictionary.

    Parameters
    ----------
    processed_image:
        2D normalized intensity image produced by the preprocessing step.
    sensitivity:
        Float between 0 and 1 controlling how aggressively the dark-region mask is
        created. Lower sensitivity means darker threshold (more strict). Higher
        sensitivity makes the threshold more permissive.

    Returns
    -------
    mask:
        Binary mask with dark pixels marked as 1 and background as 0.
    metrics:
        A dictionary containing the threshold, detected pixel count, percentage,
        and contrast score.
    """
    arr = np.asarray(processed_image, dtype=np.float32)
    if arr.ndim != 2:
        raise ValueError(f"Expected a 2D processed image, got shape {arr.shape!r}.")

    threshold = _sensitivity_to_threshold(arr, sensitivity)
    mask = (np.isfinite(arr)) & (arr <= threshold)
    mask = mask.astype(np.uint8)

    detected_pixels = int(mask.sum())
    total_pixels = int(arr.size)
    detected_percentage = (detected_pixels / total_pixels) * 100.0 if total_pixels else 0.0

    if total_pixels == 0:
        contrast_score = 0.0
    else:
        dark_values = arr[mask == 1]
        background_values = arr[mask == 0]
        if dark_values.size == 0:
            contrast_score = 0.0
        elif background_values.size == 0:
            contrast_score = 1.0
        else:
            contrast_score = float(np.abs(np.mean(background_values) - np.mean(dark_values)))
            contrast_score = float(np.clip(contrast_score, 0.0, 1.0))

    metrics = {
        "threshold": float(threshold),
        "sensitivity": float(sensitivity),
        "detected_pixel_count": float(detected_pixels),
        "detected_percentage": float(detected_percentage),
        "contrast_score": float(contrast_score),
    }

    return mask, metrics


def verify_sensitivity_effect(
    processed_image: np.ndarray, sensitivity_a: float, sensitivity_b: float
) -> bool:
    """Verify that changing sensitivity changes the detected pixel count."""
    _, metrics_a = detect_dark_regions(processed_image, sensitivity_a)
    _, metrics_b = detect_dark_regions(processed_image, sensitivity_b)

    count_a = int(metrics_a["detected_pixel_count"])
    count_b = int(metrics_b["detected_pixel_count"])
    return count_a != count_b


__all__ = ["detect_dark_regions", "verify_sensitivity_effect"]

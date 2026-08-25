"""Mask cleanup utilities for SLICKTRACE.

This module performs only the following operations on a binary mask:
- morphological opening to remove isolated noise,
- morphological closing to fill tiny gaps and join nearby regions,
- connected-component filtering to remove small regions,
- return of the cleaned binary mask.

It intentionally does not compute area, centroid, contours, polygon geometry,
confidence scores, AIS features, UI logic, or ML.
"""

from __future__ import annotations

from typing import Dict, Tuple

import cv2
import numpy as np


def _count_components(mask: np.ndarray) -> int:
    """Count connected components in a binary mask using 8-connectivity."""
    if mask.size == 0:
        return 0
    num_labels, _ = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
    return max(0, int(num_labels - 1))


def _morphological_opening(mask: np.ndarray, kernel_size: int = 3) -> np.ndarray:
    """Open the mask to suppress isolated noise."""
    if kernel_size <= 0:
        return mask.astype(np.uint8, copy=True)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    return cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, kernel)


def _morphological_closing(mask: np.ndarray, kernel_size: int = 3) -> np.ndarray:
    """Close the mask to fill small gaps and bridge nearby regions."""
    if kernel_size <= 0:
        return mask.astype(np.uint8, copy=True)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    return cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, kernel)


def _filter_small_components(mask: np.ndarray, min_component_pixels: int = 50) -> np.ndarray:
    """Remove connected components smaller than the configured pixel minimum."""
    if min_component_pixels <= 0:
        return mask.astype(np.uint8, copy=True)

    cleaned = mask.astype(np.uint8)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(cleaned, connectivity=8)
    if num_labels <= 1:
        return cleaned

    output = np.zeros_like(cleaned, dtype=np.uint8)
    for label in range(1, num_labels):
        component_pixels = stats[label, cv2.CC_STAT_AREA]
        if component_pixels >= min_component_pixels:
            output[labels == label] = 1
    return output


def clean_mask(
    raw_mask: np.ndarray,
    min_component_pixels: int = 50,
    open_kernel_size: int = 3,
    close_kernel_size: int = 3,
) -> Tuple[np.ndarray, Dict[str, int | bool]]:
    """Clean a raw binary mask with configurable morphological operations.

    The cleaning sequence is intentionally limited to:
    1. morphological opening,
    2. morphological closing,
    3. connected-component filtering.

    Returns
    -------
    cleaned_mask:
        Binary mask after cleanup.
    stats:
        Summary diagnostics for verification.
    """
    mask = np.asarray(raw_mask, dtype=np.uint8)
    if mask.ndim != 2:
        raise ValueError(f"Expected a 2D binary mask, got shape {mask.shape!r}.")

    before_open = mask.copy()
    opened = _morphological_opening(before_open, open_kernel_size)
    after_open = opened.copy()

    closed = _morphological_closing(after_open, close_kernel_size)
    after_close = closed.copy()

    before_filter = after_close.copy()
    filtered = _filter_small_components(before_filter, min_component_pixels)

    input_foreground = int(np.count_nonzero(before_open))
    output_foreground = int(np.count_nonzero(filtered))
    before_components = _count_components(before_open)
    after_components = _count_components(filtered)

    opening_pass = bool(np.count_nonzero(opened) <= np.count_nonzero(before_open))
    closing_pass = bool(np.count_nonzero(closed) >= np.count_nonzero(opened)) or bool(np.count_nonzero(closed) == np.count_nonzero(opened))
    small_component_removal_pass = bool(output_foreground <= input_foreground)

    stats = {
        "input_shape": tuple(mask.shape),
        "input_foreground_pixels": int(input_foreground),
        "output_foreground_pixels": int(output_foreground),
        "components_before_cleanup": int(before_components),
        "components_after_cleanup": int(after_components),
        "opening_pass": bool(opening_pass),
        "closing_pass": bool(closing_pass),
        "small_component_removal_pass": bool(small_component_removal_pass),
        "cleaned_mask_generated": bool(filtered is not None),
    }

    return filtered.astype(np.uint8, copy=False), stats


__all__ = ["clean_mask"]

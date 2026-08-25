"""Pixel-space geometry helpers for a cleaned SLICKTRACE detection mask.

All coordinates returned here are image pixel coordinates: ``x`` is the column
and ``y`` is the row.  This module deliberately does not infer geographic
coordinates or calibrated scientific confidence from an unreferenced mask.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import cv2
import numpy as np


def _binary_mask(mask: np.ndarray) -> np.ndarray:
    """Return *mask* as a two-dimensional uint8 mask containing 0 and 1."""
    array = np.asarray(mask)
    if array.ndim != 2:
        raise ValueError(f"Expected a 2D binary mask, got shape {array.shape!r}.")
    return (array > 0).astype(np.uint8)


def calculate_pixel_count(mask: np.ndarray) -> int:
    """Count foreground (non-zero) pixels in a clean binary mask."""
    return int(np.count_nonzero(_binary_mask(mask)))


def calculate_area(
    mask: np.ndarray,
    pixel_size_x: Optional[float] = None,
    pixel_size_y: Optional[float] = None,
) -> Dict[str, Any]:
    """Calculate area only when both pixel dimensions, in metres, are supplied.

    Without both valid dimensions, physical area is unavailable rather than an
    estimated value.  When available, this is a raster-pixel approximation:
    ``pixel_count * pixel_size_x * pixel_size_y``.
    """
    pixel_count = calculate_pixel_count(mask)
    dimensions = (pixel_size_x, pixel_size_y)
    available = all(
        value is not None and np.isfinite(value) and float(value) > 0
        for value in dimensions
    )
    if not available:
        return {
            "pixel_count": pixel_count,
            "area_m2": None,
            "area_km2": None,
            "area_available": False,
            "area_is_approximate": False,
            "area_status": "unavailable_without_pixel_dimensions",
        }

    area_m2 = float(pixel_count * float(pixel_size_x) * float(pixel_size_y))
    return {
        "pixel_count": pixel_count,
        "area_m2": area_m2,
        "area_km2": area_m2 / 1_000_000.0,
        "area_available": True,
        "area_is_approximate": True,
        "area_status": "approximate_from_pixel_dimensions",
    }


def calculate_centroid(mask: np.ndarray) -> Optional[list[float]]:
    """Return the foreground centroid as pixel coordinates ``[x, y]``.

    ``None`` is returned for an empty mask.  These are not latitude/longitude
    values and cannot be converted without image georeferencing.
    """
    binary = _binary_mask(mask)
    moments = cv2.moments(binary, binaryImage=True)
    if moments["m00"] == 0:
        return None
    return [float(moments["m10"] / moments["m00"]), float(moments["m01"] / moments["m00"])]


def extract_contour(mask: np.ndarray) -> Optional[np.ndarray]:
    """Find the largest non-tiny external foreground contour.

    Contours smaller than 10 enclosed pixel-square units are ignored as noise;
    among the remaining contours, the largest is the main spill contour.
    """
    binary = _binary_mask(mask)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    meaningful = [contour for contour in contours if cv2.contourArea(contour) >= 10.0]
    if not meaningful:
        return None
    return max(meaningful, key=cv2.contourArea)


def contour_to_polygon(contour: Optional[np.ndarray]) -> Optional[Dict[str, Any]]:
    """Convert a pixel contour to a closed, GeoJSON-shaped pixel polygon.

    The ``coordinate_space`` field makes explicit that the coordinates are not
    geographic and therefore must be transformed before direct Folium mapping.
    """
    if contour is None or len(contour) < 3:
        return None

    perimeter = cv2.arcLength(contour, True)
    simplified = cv2.approxPolyDP(contour, 0.005 * perimeter, True)
    points = [[float(point[0][0]), float(point[0][1])] for point in simplified]
    if len(points) < 3:
        return None
    if points[0] != points[-1]:
        points.append(points[0].copy())
    return {
        "type": "Polygon",
        "coordinates": [points],
        "coordinate_space": "pixel",
    }


def calculate_shape_score(contour: Optional[np.ndarray], mask: np.ndarray) -> float:
    """Score compactness from 0 to 1 using circularity.

    The exact heuristic is ``clip(4 * pi * contour_area / perimeter**2, 0, 1)``.
    A compact circular contour scores near 1; long, fragmented, or jagged shapes
    score lower.  This is an interpretable prototype feature, not a validation of
    an oil-spill shape.
    """
    _binary_mask(mask)  # Validate the companion input even though contour supplies geometry.
    if contour is None or len(contour) < 3:
        return 0.0
    area = float(cv2.contourArea(contour))
    perimeter = float(cv2.arcLength(contour, True))
    if area <= 0.0 or perimeter <= 0.0:
        return 0.0
    return float(np.clip((4.0 * np.pi * area) / (perimeter * perimeter), 0.0, 1.0))


def calculate_area_score(
    pixel_count: int,
    min_pixels: int = 100,
    max_pixels: int = 10_000,
) -> float:
    """Return a transparent, uncalibrated 0--1 size heuristic.

    The exact formula is ``clip((pixel_count - min_pixels) /
    (max_pixels - min_pixels), 0, 1)``.  Defaults give 0 at 100 pixels and 1 at
    10,000 pixels, with linear interpolation between them.  They are prototype
    defaults, not scientifically calibrated spill-area thresholds.
    """
    if max_pixels <= min_pixels:
        raise ValueError("max_pixels must be greater than min_pixels.")
    return float(np.clip((int(pixel_count) - min_pixels) / (max_pixels - min_pixels), 0.0, 1.0))


def calculate_prototype_confidence(
    contrast_score: float, shape_score: float, area_score: float
) -> float:
    """Combine prototype features: 0.50 contrast + 0.30 shape + 0.20 area."""
    confidence = 0.50 * float(contrast_score) + 0.30 * float(shape_score) + 0.20 * float(area_score)
    return float(np.clip(confidence, 0.0, 1.0))


def analyze_geometry(
    mask: np.ndarray,
    contrast_score: float = 0.0,
    pixel_size_x: Optional[float] = None,
    pixel_size_y: Optional[float] = None,
) -> Dict[str, Any]:
    """Analyze a cleaned detection mask and return pixel-space geometry.

    ``area_available`` remains false unless both supplied pixel dimensions are in
    metres.  ``prototype_confidence`` is an explicitly uncalibrated weighted
    prototype score, not a scientific probability or confirmation of an oil spill.
    """
    binary = _binary_mask(mask)
    area = calculate_area(binary, pixel_size_x, pixel_size_y)
    contour = extract_contour(binary)
    shape_score = calculate_shape_score(contour, binary)
    area_score = calculate_area_score(area["pixel_count"])

    return {
        **area,
        "centroid_pixel": calculate_centroid(binary),
        "contour": contour,
        "polygon": contour_to_polygon(contour),
        "shape_score": shape_score,
        "area_score": area_score,
        "prototype_confidence": calculate_prototype_confidence(
            contrast_score, shape_score, area_score
        ),
    }


__all__ = [
    "calculate_pixel_count",
    "calculate_area",
    "calculate_centroid",
    "extract_contour",
    "contour_to_polygon",
    "calculate_shape_score",
    "calculate_area_score",
    "calculate_prototype_confidence",
    "analyze_geometry",
]

"""SAR preprocessing utilities for SLICKTRACE AI.

This module is intentionally limited to data preparation for Sentinel-1 SAR GeoTIFF
inputs. It does not perform thresholding, mask generation, morphology, contours,
area calculation, centroid detection, polygon generation, confidence scoring,
AIS interpretation, or any UI logic.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import numpy as np
import rasterio

try:  # pragma: no cover - optional dependency
    from scipy.ndimage import gaussian_filter, median_filter
except Exception:  # pragma: no cover
    gaussian_filter = None
    median_filter = None


def _as_single_channel(array: np.ndarray, band_index: Optional[int] = None) -> np.ndarray:
    """Collapse a multi-band image to a single-channel array.

    Sentinel-1 rasters may include more than one band (for example, VV/VH, or
    multiple raster layers). This helper converts them to a single intensity map
    by either selecting a requested band or averaging across all bands when no
    specific band is requested.
    """
    if array.ndim == 2:
        return array.astype(np.float32, copy=False)

    if array.ndim != 3:
        raise ValueError(f"Expected 2D or 3D raster data, got shape {array.shape!r}.")

    if band_index is not None:
        if band_index < 0 or band_index >= array.shape[0]:
            raise IndexError(
                f"band_index={band_index} is out of range for raster with {array.shape[0]} bands."
            )
        return array[band_index].astype(np.float32, copy=False)

    return np.mean(array, axis=0, dtype=np.float32)


def _repair_invalid_values(array: np.ndarray) -> np.ndarray:
    """Replace NaN and Inf values with finite estimates.

    Invalid pixels are replaced using the median of valid values, with a fallback to
    zero if the image contains no finite values.
    """
    cleaned = np.asarray(array, dtype=np.float32)
    cleaned = np.where(np.isfinite(cleaned), cleaned, np.nan)

    valid = cleaned[np.isfinite(cleaned)]
    if valid.size == 0:
        return np.zeros_like(cleaned, dtype=np.float32)

    fill_value = float(np.median(valid))
    cleaned = np.where(~np.isfinite(cleaned), fill_value, cleaned)
    return cleaned.astype(np.float32, copy=False)


def _normalize_intensities(array: np.ndarray, eps: float = 1e-8) -> np.ndarray:
    """Normalize pixel values to the range [0, 1]."""
    finite = np.asarray(array, dtype=np.float32)
    min_value = float(np.min(finite))
    max_value = float(np.max(finite))

    if max_value <= min_value:
        return np.zeros_like(finite, dtype=np.float32)

    normalized = (finite - min_value) / (max_value - min_value + eps)
    return np.clip(normalized, 0.0, 1.0).astype(np.float32, copy=False)


def _apply_light_smoothing(
    array: np.ndarray,
    method: str = "gaussian",
    kernel_size: int = 3,
    sigma: float = 1.0,
) -> np.ndarray:
    """Apply a light smoothing filter to reduce noise without heavy processing."""
    if method is None or method.lower() == "none":
        return array.astype(np.float32, copy=False)

    method_name = method.lower()
    kernel_size = max(1, int(kernel_size))
    if kernel_size % 2 == 0:
        kernel_size += 1

    if method_name == "median":
        if median_filter is not None:
            return median_filter(array, size=(kernel_size, kernel_size)).astype(np.float32, copy=False)

        pad = kernel_size // 2
        padded = np.pad(array, ((pad, pad), (pad, pad)), mode="edge")
        processed = np.empty_like(array, dtype=np.float32)
        for row in range(array.shape[0]):
            for col in range(array.shape[1]):
                window = padded[row : row + kernel_size, col : col + kernel_size]
                processed[row, col] = np.median(window)
        return processed.astype(np.float32, copy=False)

    if method_name == "gaussian":
        if gaussian_filter is not None:
            return gaussian_filter(array, sigma=sigma, mode="reflect").astype(np.float32, copy=False)

        sigma = max(float(sigma), 0.5)
        radius = kernel_size // 2
        x = np.arange(-radius, radius + 1, dtype=np.float32)
        y = np.arange(-radius, radius + 1, dtype=np.float32)
        xx, yy = np.meshgrid(x, y, indexing="ij")
        kernel = np.exp(-(xx ** 2 + yy ** 2) / (2.0 * sigma ** 2))
        kernel /= kernel.sum() + 1e-8

        pad = radius
        padded = np.pad(array, ((pad, pad), (pad, pad)), mode="reflect")
        filtered = np.empty_like(array, dtype=np.float32)
        for row in range(array.shape[0]):
            for col in range(array.shape[1]):
                window = padded[row : row + kernel_size, col : col + kernel_size]
                filtered[row, col] = np.sum(window * kernel)
        return filtered.astype(np.float32, copy=False)

    raise ValueError(f"Unsupported smoothing method: {method!r}. Use 'gaussian', 'median', or None.")


def load_sar_raster(
    image_path: str,
    band_index: Optional[int] = None,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Load a Sentinel-1 SAR GeoTIFF and expose the raw array with metadata.

    Returns the raw 2D NumPy array and a dictionary containing file-level metadata,
    without performing model-specific post-processing.
    """
    with rasterio.open(image_path) as src:
        raw = src.read()
        metadata = {
            "path": image_path,
            "driver": src.driver,
            "width": int(src.width),
            "height": int(src.height),
            "band_count": int(src.count),
            "dtype": str(src.dtypes[0]) if src.dtypes else "unknown",
            "crs": str(src.crs) if src.crs else None,
            "bounds": tuple(src.bounds),
            "transform": src.transform,
            "nodata": src.nodata,
            "count": int(src.count),
        }

    if raw.size == 0:
        raise ValueError(f"Raster file '{image_path}' contains no pixel data.")

    array = _as_single_channel(raw, band_index=band_index)
    return array.astype(np.float32, copy=False), metadata


def preprocess_sentinel1(
    image_path: str,
    band_index: Optional[int] = None,
    smoothing: str = "gaussian",
    kernel_size: int = 3,
    sigma: float = 1.0,
    normalize: bool = True,
    eps: float = 1e-8,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Preprocess a Sentinel-1 SAR GeoTIFF for downstream analysis.

    Pipeline:
      1. Open the image and inspect dimensions/bands dynamically.
      2. Collapse multi-band rasters into a single intensity layer if needed.
      3. Repair NaN and Inf values.
      4. Normalize intensity values to [0, 1].
      5. Apply a light median or Gaussian smoothing filter.

    Parameters
    ----------
    image_path:
        Path to a Sentinel-1 SAR GeoTIFF.
    band_index:
        Optional band index to select when the raster contains more than one band.
        If omitted, the mean across all bands is used.
    smoothing:
        One of {"gaussian", "median", "none"}.
    kernel_size:
        Window size used by the smoothing filter.
    sigma:
        Gaussian standard deviation used when smoothing='gaussian'.
    normalize:
        Whether to normalize intensities to [0, 1].
    eps:
        Small epsilon used during normalization to prevent division by zero.

    Returns
    -------
    processed_array:
        Single-channel processed NumPy array.
    metadata:
        Dictionary containing file and processing metadata.
    """
    raw_array, metadata = load_sar_raster(image_path, band_index=band_index)

    repaired = _repair_invalid_values(raw_array)
    if normalize:
        repaired = _normalize_intensities(repaired, eps=eps)

    smoothed = _apply_light_smoothing(
        repaired,
        method=smoothing,
        kernel_size=kernel_size,
        sigma=sigma,
    )

    metadata.update(
        {
            "processed_shape": smoothed.shape,
            "processed_dtype": str(smoothed.dtype),
            "channels": 1,
            "single_channel_mode": "selected_band" if band_index is not None else "mean_across_bands",
            "smoothing": smoothing,
            "kernel_size": int(kernel_size),
            "sigma": float(sigma),
            "normalization_applied": bool(normalize),
            "invalid_pixels_before_repair": int(np.logical_not(np.isfinite(raw_array)).sum()),
            "invalid_pixels_after_repair": int(np.logical_not(np.isfinite(smoothed)).sum()),
        }
    )

    return smoothed.astype(np.float32, copy=False), metadata


__all__ = ["load_sar_raster", "preprocess_sentinel1"]

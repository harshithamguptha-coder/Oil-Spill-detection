"""Service-layer utilities for SLICKTRACE AI."""

# Keep unrelated offline modules (such as the AIS demo) usable before optional
# raster-processing dependencies are installed. Direct detector imports retain
# their normal dependency requirements.
try:
    from .preprocessor import preprocess_sentinel1
except ModuleNotFoundError:  # rasterio is intentionally optional for AIS-only use
    preprocess_sentinel1 = None

__all__ = ["preprocess_sentinel1"]

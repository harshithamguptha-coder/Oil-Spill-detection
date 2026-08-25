"""Adapter from the existing detector output to attribution-ready spill context."""
from __future__ import annotations
from pathlib import Path
from .config import DEMO_SPILL_CONTEXT

def get_spill_context(image_path: str | Path | None = None) -> dict:
    """Return geographic spill context.

    `geometry.analyze_geometry` returns *pixel* centroid/polygon. The supplied
    case_01 TIFF is unreferenced, so lat/lon cannot be honestly derived from it.
    We still run the detector where dependencies are present and expose its
    confidence/area only as supplemental detection metadata; geographic fields
    retain their explicit DEMO label.
    """
    context = dict(DEMO_SPILL_CONTEXT)
    context["detector_status"] = "not_run"
    if image_path:
        try:
            from services.detector import detect_slick
            from services.geometry import analyze_geometry
            result = detect_slick(str(image_path))
            geom = analyze_geometry(result["mask"], contrast_score=result["contrast_score"])
            context.update({"detector_status": result["status"], "detector_confidence": round(geom["prototype_confidence"], 3), "detected_pixels": geom["pixel_count"]})
        except Exception as exc:
            context["detector_status"] = f"unavailable: {type(exc).__name__}"
    return context

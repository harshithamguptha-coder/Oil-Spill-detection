"""Offline SlickTrace AIS attribution API with connected investigation workflow."""
from __future__ import annotations

import base64
import json
import struct
import zlib
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import rasterio

from services.ais import get_spill_context, load_local_tracks, rank_vessels
from services.ais.config import DEMO_SPILL_CONTEXT, SEARCH_RADIUS_KM, TIME_WINDOW_MINUTES, WEIGHTS
from services.ais.replay import replay_payload

ROOT = Path(__file__).parent


def _normalize_uint8(array: np.ndarray) -> np.ndarray:
    """Convert numeric arrays to uint8 for PNG export."""
    arr = np.asarray(array)
    if arr.dtype == np.uint8:
        return arr
    if arr.dtype.kind in {"f", "i", "u"}:
        arr = arr.astype(np.float64)
        finite = np.isfinite(arr)
        if finite.all():
            if arr.max() > 1.0:
                arr = arr / max(float(arr.max()), 1.0)
            arr = np.clip(arr, 0.0, 1.0)
            arr = (arr * 255.0).astype(np.uint8)
            return arr
    return np.asarray(arr, dtype=np.uint8)


def _encode_png_data_url(array: np.ndarray) -> str:
    """Encode an array as a PNG data URL without adding external dependencies."""
    rgb = np.asarray(array)
    if rgb.ndim == 2:
        rgb = np.repeat(rgb[:, :, None], 3, axis=2)
    elif rgb.ndim == 3 and rgb.shape[2] == 1:
        rgb = np.repeat(rgb, 3, axis=2)
    if rgb.ndim == 3 and rgb.shape[2] == 4:
        rgb = rgb[:, :, :3]
    if rgb.dtype != np.uint8:
        rgb = _normalize_uint8(rgb)
    height, width, channels = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack("!I", len(data))
            + tag
            + data
            + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(png).decode("utf-8")


def _tif_to_data_url(image_path: str | Path) -> str:
    """Convert a TIFF to a displayable PNG data URL."""
    with rasterio.open(str(image_path)) as src:
        array = src.read()

    if array.ndim == 2:
        image = array
    elif array.shape[0] >= 3:
        image = np.moveaxis(array[:3], 0, -1)
    elif array.shape[0] == 1:
        image = np.repeat(array[0][None, :, :], 3, axis=0).transpose(1, 2, 0)
    else:
        image = np.zeros((array.shape[1], array.shape[2], 3), dtype=np.uint8)

    if np.issubdtype(image.dtype, np.floating):
        image = _normalize_uint8(image)
    elif image.dtype != np.uint8:
        image = image.astype(np.uint8)
    return _encode_png_data_url(image)


def _mask_to_data_url(mask: np.ndarray) -> str:
    """Convert a binary mask into a red-highlight PNG data URL."""
    binary = np.asarray(mask) > 0
    color = np.zeros((binary.shape[0], binary.shape[1], 3), dtype=np.uint8)
    color[binary] = [255, 70, 70]
    return _encode_png_data_url(color)


class InvestigationSession:
    """Manages the lifecycle of an offline oil spill investigation."""

    def __init__(self, root: Path):
        self.root = root
        self.case_id = "SAR-2026-01339"
        self.image_path = self.root / "data/case_01/01339.tif"
        self.ais_path = self.root / "data/ais_demo_tracks.csv"
        self.reset()
        # Initialize pipeline on startup for immediate endpoint population
        self.run_investigation()

    def reset(self) -> dict:
        self.stage = "NOT_STARTED"
        self.sar_meta = None
        self.detection_result = None
        self.geometry_result = None
        self.spill_context = dict(DEMO_SPILL_CONTEXT)
        self.spill_context["detector_status"] = "not_run"
        self.tracks = {}
        self.candidates = []
        self.top_candidate = None
        self.error_message = None
        return self.to_dict()

    def process_uploaded_image(self, image_path: str | Path, original_name: str | None = None) -> dict:
        """Run the existing detector pipeline on an uploaded .tif/.tiff image."""
        file_path = Path(image_path)
        if not file_path.exists():
            raise FileNotFoundError(f"Uploaded image '{file_path}' was not found.")
        if file_path.suffix.lower() not in {".tif", ".tiff"}:
            raise ValueError("Only .tif and .tiff files are supported.")

        from services.detector import detect_slick
        from services.geometry import analyze_geometry

        self.image_path = file_path
        self.case_id = original_name or self.case_id
        _, meta = __import__("services.preprocessor", fromlist=["load_sar_raster"]).load_sar_raster(str(file_path))
        self.sar_meta = {
            "case_id": self.case_id,
            "filename": file_path.name,
            "width": meta["width"],
            "height": meta["height"],
            "band_count": meta["band_count"],
            "dtype": meta["dtype"],
            "sensor": "Uploaded SAR image",
            "acquisition_timestamp": self.spill_context.get("timestamp", "unknown"),
            "status": "uploaded",
        }

        result = detect_slick(str(file_path))
        geom = analyze_geometry(result["mask"], contrast_score=result["contrast_score"])
        pixel_count = int(geom.get("pixel_count", 0))
        confidence = round(float(geom.get("prototype_confidence", 0.0)), 3)

        area_label = "N/A"
        if geom.get("area_available"):
            area_km2 = geom.get("area_km2")
            if area_km2 is not None:
                area_label = f"{float(area_km2):.4f} km²"
        elif pixel_count:
            area_label = f"{pixel_count} pixels"

        self.detection_result = {
            "status": result["status"],
            "contrast_score": float(result["contrast_score"]),
            "sensitivity": float(result["sensitivity"]),
            "fallback_used": bool(result["fallback_used"]),
        }
        self.geometry_result = {
            "pixel_count": pixel_count,
            "centroid_pixel": geom.get("centroid_pixel"),
            "shape_score": geom.get("shape_score"),
            "area_score": geom.get("area_score"),
            "prototype_confidence": confidence,
            "area_available": bool(geom.get("area_available", False)),
            "area_label": area_label,
        }
        self.spill_context.update({
            "detector_status": result["status"],
            "detector_confidence": confidence,
            "confidence": confidence,
            "detected_pixels": pixel_count,
            "centroid_pixel": geom.get("centroid_pixel"),
            "spill_area": area_label,
            "area_label": area_label,
        })
        self.stage = "SLICK_DETECTED"

        payload = {
            "status": "ok",
            "filename": file_path.name,
            "detector_status": result["status"],
            "detector_confidence": confidence,
            "detected_pixels": pixel_count,
            "contrast_score": float(result["contrast_score"]),
            "detection_sensitivity": float(result["sensitivity"]),
            "confidence": confidence,
            "spill_area": area_label,
            "mask_pixels": pixel_count,
            "fallback_used": bool(result["fallback_used"]),
            "original_image": _tif_to_data_url(file_path),
            "mask_image": _mask_to_data_url(result["mask"]),
            "centroid_pixel": geom.get("centroid_pixel"),
            "shape_score": float(geom.get("shape_score", 0.0)),
            "area_score": float(geom.get("area_score", 0.0)),
            "message": result["status"].replace("_", " ").title(),
        }
        return payload

    def step_1_sar_ingest(self) -> dict:
        from services.preprocessor import load_sar_raster
        _, meta = load_sar_raster(str(self.image_path))
        self.sar_meta = {
            "case_id": self.case_id,
            "filename": self.image_path.name,
            "width": meta["width"],
            "height": meta["height"],
            "band_count": meta["band_count"],
            "dtype": meta["dtype"],
            "sensor": "Sentinel-1 SAR C-Band",
            "acquisition_timestamp": self.spill_context["timestamp"],
            "status": "loaded",
        }
        self.stage = "SAR_INGESTED"
        return self.to_dict()

    def step_2_slick_mask(self) -> dict:
        if self.stage == "NOT_STARTED":
            self.step_1_sar_ingest()
        from services.detector import detect_slick
        from services.geometry import analyze_geometry

        res = detect_slick(str(self.image_path))
        geom = analyze_geometry(res["mask"], contrast_score=res["contrast_score"])

        self.detection_result = {
            "status": res["status"],
            "contrast_score": float(res["contrast_score"]),
            "sensitivity": float(res["sensitivity"]),
            "fallback_used": bool(res["fallback_used"]),
        }
        self.geometry_result = {
            "pixel_count": geom["pixel_count"],
            "centroid_pixel": geom["centroid_pixel"],
            "shape_score": geom["shape_score"],
            "area_score": geom["area_score"],
            "prototype_confidence": round(geom["prototype_confidence"], 3),
        }
        self.spill_context.update({
            "detector_status": res["status"],
            "detector_confidence": round(geom["prototype_confidence"], 3),
            "confidence": round(geom["prototype_confidence"], 3),
            "detected_pixels": geom["pixel_count"],
            "centroid_pixel": geom["centroid_pixel"],
        })
        self.stage = "SLICK_DETECTED"
        return self.to_dict()

    def step_3_ais_intercept(self) -> dict:
        if self.stage in ("NOT_STARTED", "SAR_INGESTED"):
            self.step_2_slick_mask()
        self.tracks = load_local_tracks(self.ais_path)
        self.stage = "AIS_CORRELATED"
        return self.to_dict()

    def step_4_attribution_rank(self) -> dict:
        if self.stage not in ("AIS_CORRELATED", "VESSELS_RANKED"):
            self.step_3_ais_intercept()
        self.candidates = rank_vessels(self.tracks, self.spill_context)
        self.top_candidate = self.candidates[0] if self.candidates else None
        self.stage = "VESSELS_RANKED"
        return self.to_dict()

    def run_investigation(self) -> dict:
        self.step_1_sar_ingest()
        self.step_2_slick_mask()
        self.step_3_ais_intercept()
        self.step_4_attribution_rank()
        return self.to_dict()

    def to_dict(self) -> dict:
        return {
            "stage": self.stage,
            "case_id": self.case_id,
            "sar_meta": self.sar_meta,
            "detection": self.detection_result,
            "geometry": self.geometry_result,
            "spill": self.spill_context,
            "candidates_count": len(self.candidates),
            "tracks_count": len(self.tracks),
            "top_candidate": self.top_candidate,
            "config": {
                "search_radius_km": SEARCH_RADIUS_KM,
                "time_window_minutes": TIME_WINDOW_MINUTES,
                "weights": WEIGHTS,
            },
        }


SESSION = InvestigationSession(ROOT)


class Handler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _send_json(self, data: dict | list, status_code: int = 200):
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            self._send_json(SESSION.to_dict())
            return
        if path == "/api/context":
            self._send_json(SESSION.spill_context)
            return
        if path == "/api/candidates":
            self._send_json(SESSION.candidates)
            return
        if path == "/api/tracks":
            self._send_json(replay_payload(SESSION.tracks))
            return
        if path == "/api/config":
            self._send_json({
                "search_radius_km": SEARCH_RADIUS_KM,
                "time_window_minutes": TIME_WINDOW_MINUTES,
                "weights": WEIGHTS,
            })
            return

        self._send_json({
            "error": "Not found",
            "available_endpoints": [
                "/api/state",
                "/api/context",
                "/api/candidates",
                "/api/tracks",
                "/api/config",
                "/api/workflow/run",
                "/api/workflow/step",
                "/api/workflow/reset",
                "/api/detect-image",
            ],
        }, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        payload = {}
        request_body = self.rfile.read(length) if path == "/api/detect-image" else None
        if length > 0 and request_body is None:
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                payload = {}

        if path == "/api/workflow/run":
            self._send_json(SESSION.run_investigation())
            return
        if path == "/api/workflow/reset":
            self._send_json(SESSION.reset())
            return
        if path == "/api/workflow/step":
            step = payload.get("step")
            if step == 1:
                self._send_json(SESSION.step_1_sar_ingest())
                return
            elif step == 2:
                if SESSION.stage == "NOT_STARTED":
                    self._send_json({"error": "Prerequisite not met: Execute Step 1 (SAR Ingest) first."}, 400)
                    return
                self._send_json(SESSION.step_2_slick_mask())
                return
            elif step == 3:
                if SESSION.stage not in ("SLICK_DETECTED", "AIS_CORRELATED", "VESSELS_RANKED"):
                    self._send_json({"error": "Prerequisite not met: Execute Step 2 (Slick Mask) first."}, 400)
                    return
                self._send_json(SESSION.step_3_ais_intercept())
                return
            elif step == 4:
                if SESSION.stage not in ("AIS_CORRELATED", "VESSELS_RANKED"):
                    self._send_json({"error": "Prerequisite not met: Execute Step 3 (AIS Intercept) first."}, 400)
                    return
                self._send_json(SESSION.step_4_attribution_rank())
                return
            else:
                self._send_json({"error": f"Invalid step {step}. Valid steps are 1, 2, 3, 4."}, 400)
                return

        if path == "/api/detect-image":
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self._send_json({"error": "Please upload a TIFF using multipart/form-data."}, 400)
                return
            try:
                message = BytesParser(policy=default).parsebytes(
                    f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
                    + (request_body or b"")
                )
                file_field = next(
                    (part for part in message.iter_attachments() if part.get_param("name", header="content-disposition") == "file"),
                    None,
                )
                filename = file_field.get_filename() if file_field else None
                if file_field is None or not filename:
                    self._send_json({"error": "No TIFF file was provided."}, 400)
                    return
                if not filename.lower().endswith((".tif", ".tiff")):
                    self._send_json({"error": "Only .tif and .tiff files are supported."}, 400)
                    return
                upload_dir = ROOT / "tmp_uploads"
                upload_dir.mkdir(exist_ok=True)
                upload_path = upload_dir / Path(filename).name
                with open(upload_path, "wb") as handle:
                    handle.write(file_field.get_payload(decode=True) or b"")
                response = SESSION.process_uploaded_image(upload_path, filename)
                self._send_json(response)
                return
            except Exception as exc:
                self._send_json({"error": f"Detection failed: {exc}"}, 400)
                return

        self._send_json({"error": "Not found"}, 404)


if __name__ == "__main__":
    print("SlickTrace AI API running at http://localhost:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()

"""Offline SlickTrace AIS attribution API with connected investigation workflow."""
from __future__ import annotations
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from services.ais import get_spill_context, load_local_tracks, rank_vessels
from services.ais.config import DEMO_SPILL_CONTEXT, SEARCH_RADIUS_KM, TIME_WINDOW_MINUTES, WEIGHTS
from services.ais.replay import replay_payload

ROOT = Path(__file__).parent


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
            ],
        }, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        payload = {}
        if length > 0:
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

        self._send_json({"error": "Not found"}, 404)


if __name__ == "__main__":
    print("SlickTrace AI API running at http://localhost:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()

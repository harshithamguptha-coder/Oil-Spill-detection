"""Offline SlickTrace AIS attribution API. Run: python app.py"""
from __future__ import annotations
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from services.ais import get_spill_context, load_local_tracks, rank_vessels
from services.ais.config import SEARCH_RADIUS_KM, TIME_WINDOW_MINUTES, WEIGHTS
from services.ais.replay import replay_payload

ROOT = Path(__file__).parent
SPILL = get_spill_context(ROOT / "data/case_01/01339.tif")
TRACKS = load_local_tracks(ROOT / "data/ais_demo_tracks.csv")
CANDIDATES = rank_vessels(TRACKS, SPILL)

class Handler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        data = {"/api/context": SPILL, "/api/candidates": CANDIDATES, "/api/tracks": replay_payload(TRACKS), "/api/config": {"search_radius_km":SEARCH_RADIUS_KM,"time_window_minutes":TIME_WINDOW_MINUTES,"weights":WEIGHTS}}.get(path)
        if data is not None:
            body=json.dumps(data, default=str).encode(); self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body); return
        body=json.dumps({"error":"Not found","available_endpoints":["/api/context","/api/candidates","/api/tracks","/api/config"]}).encode()
        self.send_response(404); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)

if __name__ == "__main__":
    print("SlickTrace AI API running at http://localhost:8000")
    ThreadingHTTPServer(("127.0.0.1",8000), Handler).serve_forever()

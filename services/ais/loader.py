"""Local AIS data source. Replace this adapter with a real provider later."""
from __future__ import annotations
import csv
from datetime import datetime
from pathlib import Path
from typing import Any

REQUIRED_COLUMNS = {"vessel_id", "vessel_name", "timestamp", "latitude", "longitude", "speed", "heading"}

def load_local_tracks(path: str | Path) -> dict[str, list[dict[str, Any]]]:
    with open(path, newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if not rows or not REQUIRED_COLUMNS.issubset(rows[0]):
        raise ValueError(f"AIS CSV must contain {sorted(REQUIRED_COLUMNS)}")
    tracks: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        item = {**row, "latitude": float(row["latitude"]), "longitude": float(row["longitude"]), "speed": float(row["speed"]), "heading": float(row["heading"]), "timestamp": datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))}
        tracks.setdefault(item["vessel_id"], []).append(item)
    for positions in tracks.values(): positions.sort(key=lambda p: p["timestamp"])
    return tracks
